#!/usr/bin/env node
/**
 * Autoresearch eval runner.
 *
 * Spawns `claude -p` for each question in baseline or grafema mode,
 * parses stream-json output, writes answers.jsonl.
 *
 * Usage:
 *   node autoresearch/harness/run.mjs \
 *     --mode baseline|grafema \
 *     --model sonnet \
 *     [--questions autoresearch/questions.yaml] \
 *     [--question-id Q03] \
 *     [--run-id custom-name]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { execFileSync, spawn } from 'child_process';
import { tmpdir } from 'os';
import { createRequire } from 'module';

// yaml is available via pnpm workspace — resolve from a package that depends on it
const _require = createRequire(join(resolve(new URL('../../', import.meta.url).pathname), 'packages', 'util', 'package.json'));
const { parse: parseYAML, stringify: stringifyYAML } = _require('yaml');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(new URL('../../', import.meta.url).pathname);
const DEFAULT_QUESTIONS = join(PROJECT_ROOT, 'autoresearch', 'questions.yaml');
const PROMPTS_DIR = join(PROJECT_ROOT, 'autoresearch', 'prompts');
const RESULTS_BASE = join(PROJECT_ROOT, 'autoresearch', 'results');
const MCP_CONFIG = join(PROJECT_ROOT, '.mcp.json');

const MODEL_MAP = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

// ---------------------------------------------------------------------------
// CLI arg parsing (no external deps)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    mode: null,
    model: 'sonnet',
    questions: DEFAULT_QUESTIONS,
    questionId: null,
    runId: null,
    repeats: 1,
    projectRoot: PROJECT_ROOT,
    mcpConfig: null,
  };
  let i = 2; // skip node + script
  while (i < argv.length) {
    switch (argv[i]) {
      case '--mode':
        args.mode = argv[++i];
        break;
      case '--model':
        args.model = argv[++i];
        break;
      case '--questions':
        args.questions = resolve(argv[++i]);
        break;
      case '--question-id':
        args.questionId = argv[++i];
        break;
      case '--run-id':
        args.runId = argv[++i];
        break;
      case '--repeats':
        args.repeats = parseInt(argv[++i], 10);
        break;
      case '--project-root':
        args.projectRoot = resolve(argv[++i]);
        break;
      case '--mcp-config':
        args.mcpConfig = resolve(argv[++i]);
        break;
      case '--help':
      case '-h':
        console.error('Usage: node run.mjs --mode <mode> --model sonnet [--questions path] [--question-id Q03] [--run-id name] [--repeats 3] [--project-root /path]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
    i++;
  }
  if (!args.mode) {
    console.error('Error: --mode is required');
    process.exit(1);
  }
  // Validate: must be baseline, grafema, or have a matching prompt file
  const knownModes = ['baseline', 'grafema'];
  if (!knownModes.includes(args.mode)) {
    const promptPath = join(PROMPTS_DIR, `${args.mode}.md`);
    if (!existsSync(promptPath)) {
      console.error(`Error: --mode "${args.mode}" has no prompt template at ${promptPath}`);
      process.exit(1);
    }
  }
  if (!MODEL_MAP[args.model]) {
    console.error(`Error: --model must be one of: ${Object.keys(MODEL_MAP).join(', ')}`);
    process.exit(1);
  }
  return args;
}

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

function loadQuestions(path) {
  const raw = readFileSync(path, 'utf8');
  const data = parseYAML(raw);
  // Support both top-level array and { questions: [...] }
  return Array.isArray(data) ? data : data.questions;
}

// ---------------------------------------------------------------------------
// Session JSONL parsing
//
// stream-json format: one JSON object per line.
//  - { type: "assistant", message: { content: [{type:"text",text:"..."},{type:"tool_use",name:"Read",...}] } }
//  - { type: "result", result: "...", ... } — may contain usage at top level
//  - Usage can appear at top level of events too (usage: {input_tokens, output_tokens, ...})
// ---------------------------------------------------------------------------

function parseSessionOutput(raw) {
  const lines = raw.split('\n').filter(Boolean);

  let textParts = [];
  const toolCounts = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  // Ordered trace: reasoning → tool call → tool result → reasoning → ...
  const trace = [];
  // Pending tool calls waiting for results (keyed by tool_use id)
  const pendingTools = {};

  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }

    // Accumulate usage from top-level usage blocks
    const u = ev.usage || {};
    inputTokens += u.input_tokens || 0;
    outputTokens += u.output_tokens || 0;
    cacheReadTokens += u.cache_read_input_tokens || 0;
    cacheCreationTokens += u.cache_creation_input_tokens || 0;

    // Assistant messages contain text and tool_use content blocks
    if (ev.type === 'assistant') {
      const content = ev.message?.content || [];
      for (const block of content) {
        if (block.type === 'text') {
          textParts.push(block.text);
          const text = block.text.trim();
          if (text) {
            trace.push({ step: 'reasoning', text: text.slice(0, 500) });
          }
        } else if (block.type === 'tool_use') {
          const name = block.name || '?';
          toolCounts[name] = (toolCounts[name] || 0) + 1;
          const entry = {
            step: 'tool_call',
            name,
            input: truncateToolInput(block.input),
            id: block.id,
          };
          trace.push(entry);
          if (block.id) {
            pendingTools[block.id] = entry;
          }
        } else if (block.type === 'tool_result') {
          const resultText = extractToolResultText(block.content);
          const resultEntry = {
            step: 'tool_result',
            tool_use_id: block.tool_use_id,
            result: resultText.slice(0, 1000),
            is_error: block.is_error || false,
          };
          trace.push(resultEntry);
          // Link result back to the call
          if (block.tool_use_id && pendingTools[block.tool_use_id]) {
            pendingTools[block.tool_use_id].result_preview = resultText.slice(0, 300);
            pendingTools[block.tool_use_id].is_error = block.is_error || false;
            delete pendingTools[block.tool_use_id];
          }
        }
      }
    }

    // Tool results come as "user" events with tool_result content blocks
    if (ev.type === 'user') {
      const content = ev.message?.content || [];
      for (const block of content) {
        if (block.type === 'tool_result') {
          const resultText = extractToolResultText(block.content);
          const resultEntry = {
            step: 'tool_result',
            tool_use_id: block.tool_use_id,
            result: resultText.slice(0, 1000),
            is_error: block.is_error || false,
          };
          trace.push(resultEntry);
          if (block.tool_use_id && pendingTools[block.tool_use_id]) {
            pendingTools[block.tool_use_id].result_preview = resultText.slice(0, 300);
            pendingTools[block.tool_use_id].is_error = block.is_error || false;
            delete pendingTools[block.tool_use_id];
          }
        }
      }
    }

    // Result event may also carry usage (already counted above)
    if (ev.type === 'result') {
      // noop — usage already captured
    }
  }

  const toolCallsList = Object.entries(toolCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const mcpCalls = toolCallsList
    .filter(t => t.name.startsWith('mcp__grafema'))
    .reduce((sum, t) => sum + t.count, 0);

  const rawText = textParts.join('\n');

  // Build grafema-specific trace (only MCP tool calls with their results)
  const grafemaTrace = trace.filter(t =>
    (t.step === 'tool_call' && t.name?.startsWith('mcp__grafema')) ||
    (t.step === 'tool_result' && pendingTools[t.tool_use_id] === undefined)
  );

  // Build fallback chain: find patterns where MCP returned empty → agent used Grep/Read
  const fallbacks = detectFallbacks(trace);

  return {
    rawText,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    toolCalls: toolCallsList,
    mcpCalls,
    trace,
    fallbacks,
  };
}

/** Truncate tool input for logging — keep args readable but bounded */
function truncateToolInput(input) {
  if (!input) return {};
  const s = JSON.stringify(input);
  if (s.length <= 300) return input;
  // Keep first-level keys with truncated values
  const result = {};
  for (const [k, v] of Object.entries(input)) {
    const vs = typeof v === 'string' ? v.slice(0, 100) : v;
    result[k] = vs;
  }
  return result;
}

/** Extract text from tool_result content (may be string, array of blocks, or object) */
function extractToolResultText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(b => (typeof b === 'string' ? b : b.text || b.content || JSON.stringify(b)))
      .join('\n');
  }
  return content.text || content.content || JSON.stringify(content);
}

/**
 * Detect fallback patterns: MCP tool → empty/error → file tool on same topic.
 * Returns array of { mcp_call, mcp_result, fallback_tool, reasoning }.
 */
function detectFallbacks(trace) {
  const fallbacks = [];
  for (let i = 0; i < trace.length - 2; i++) {
    const step = trace[i];
    if (step.step !== 'tool_call' || !step.name?.startsWith('mcp__grafema')) continue;

    // Look for result
    const resultIdx = trace.findIndex((t, j) => j > i && t.step === 'tool_result' && t.tool_use_id === step.id);
    if (resultIdx === -1) continue;

    const result = trace[resultIdx];
    const resultText = result.result || '';
    const isEmpty = resultText.includes('No nodes found') || resultText.includes('0 node') ||
                    resultText.includes('No calls found') || resultText.includes('0 call') ||
                    result.is_error;

    if (!isEmpty) continue;

    // Look for file tool fallback within next 3 steps
    for (let j = resultIdx + 1; j < Math.min(resultIdx + 4, trace.length); j++) {
      const next = trace[j];
      if (next.step === 'tool_call' && ['Grep', 'Read', 'Glob', 'Bash'].includes(next.name)) {
        // Found fallback: reasoning between result and fallback
        const reasoning = trace.slice(resultIdx + 1, j)
          .filter(t => t.step === 'reasoning')
          .map(t => t.text)
          .join(' ');
        fallbacks.push({
          mcp_tool: step.name.replace('mcp__grafema__', ''),
          mcp_input: step.input,
          mcp_result_preview: resultText.slice(0, 200),
          fallback_tool: next.name,
          fallback_input: next.input,
          reasoning: reasoning.slice(0, 200),
        });
        break;
      }
    }
  }
  return fallbacks;
}

// ---------------------------------------------------------------------------
// Extract <answer>...</answer>
// ---------------------------------------------------------------------------

function extractAnswer(text) {
  const match = text.match(/<answer>([\s\S]*?)<\/answer>/);
  return match ? match[1].trim() : '';
}

// ---------------------------------------------------------------------------
// Run claude for a single question
// ---------------------------------------------------------------------------

async function runQuestion(question, mode, modelId, promptTemplate, projectRoot, mcpConfigPath = MCP_CONFIG) {
  const prompt = promptTemplate
    .replace('{{question}}', question.question)
    .replace(/\{\{project_root\}\}/g, projectRoot);

  // Write prompt to temp file (avoid shell escaping)
  const tmpFile = join(tmpdir(), `autoresearch-prompt-${process.pid}-${Date.now()}.txt`);
  writeFileSync(tmpFile, prompt, 'utf8');

  const startMs = Date.now();

  return new Promise((resolvePromise) => {
    const promptText = readFileSync(tmpFile, 'utf8');
    const directArgs = [
      '-p', promptText,
      '--output-format', 'stream-json',
      '--max-turns', '30',
      '--model', modelId,
      '--verbose',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
    ];

    // Attach MCP for grafema and ablation modes (any non-baseline mode)
    if (mode !== 'baseline' && existsSync(mcpConfigPath)) {
      directArgs.push('--mcp-config', mcpConfigPath);
    }

    // Run from temp dir to avoid loading CLAUDE.md from project root.
    // Agent accesses code via explicit path in the prompt.
    const cleanCwd = join(tmpdir(), `autoresearch-clean-${process.pid}`);
    mkdirSync(cleanCwd, { recursive: true });

    const child = spawn('claude', directArgs, {
      cwd: cleanCwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      console.error(`  Error spawning claude: ${err.message}`);
      cleanup();
      resolvePromise({ error: err.message });
    });

    child.on('close', (code) => {
      cleanup();
      const latencyMs = Date.now() - startMs;

      if (code !== 0 && !stdout) {
        console.error(`  claude exited with code ${code}`);
        if (stderr) console.error(`  stderr: ${stderr.slice(0, 500)}`);
        resolvePromise({ error: `exit code ${code}`, stderr });
        return;
      }

      const parsed = parseSessionOutput(stdout);
      const answerText = extractAnswer(parsed.rawText);

      resolvePromise({
        question_id: question.id,
        answer_text: answerText,
        raw_text: parsed.rawText,
        input_tokens: parsed.inputTokens,
        output_tokens: parsed.outputTokens,
        cache_read_tokens: parsed.cacheReadTokens,
        cache_creation_tokens: parsed.cacheCreationTokens,
        tool_calls: parsed.toolCalls,
        mcp_calls: parsed.mcpCalls,
        trace: parsed.trace,
        fallbacks: parsed.fallbacks,
        latency_ms: latencyMs,
        model: modelId,
      });
    });

    function cleanup() {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const modelId = MODEL_MAP[args.model];

  // Load questions
  let questions = loadQuestions(args.questions);
  if (args.questionId) {
    questions = questions.filter(q => q.id === args.questionId);
    if (questions.length === 0) {
      console.error(`Error: question "${args.questionId}" not found`);
      process.exit(1);
    }
  }

  // Load prompt template
  const templatePath = join(PROMPTS_DIR, `${args.mode}.md`);
  if (!existsSync(templatePath)) {
    console.error(`Error: prompt template not found: ${templatePath}`);
    process.exit(1);
  }
  const promptTemplate = readFileSync(templatePath, 'utf8');

  // Create results directory
  const now = new Date();
  const ts = now.toISOString().replace(/[T:]/g, '-').replace(/\..+/, '').replace(/-/g, (m, i) => i < 10 ? '-' : '');
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0'),
  ].join('-');
  const runId = args.runId || `${args.mode}-${datePart}`;
  const runDir = join(RESULTS_BASE, runId);
  mkdirSync(runDir, { recursive: true });

  // Save config
  const config = {
    mode: args.mode,
    model: modelId,
    model_alias: args.model,
    date: now.toISOString(),
    question_count: questions.length,
    questions_file: args.questions,
    run_id: runId,
  };
  writeFileSync(join(runDir, 'config.yaml'), stringifyYAML(config), 'utf8');

  const answersPath = join(runDir, 'answers.jsonl');

  console.error(`=== Autoresearch Run ===`);
  console.error(`Mode:      ${args.mode}`);
  console.error(`Model:     ${modelId}`);
  console.error(`Questions: ${questions.length}`);
  console.error(`Run ID:    ${runId}`);
  console.error(`Results:   ${runDir}`);
  console.error('');

  const effectiveMcpConfig = args.mcpConfig || MCP_CONFIG;

  // Preflight: verify Grafema MCP is working for non-baseline modes
  if (args.mode !== 'baseline' && existsSync(effectiveMcpConfig)) {
    console.error('Preflight: checking Grafema MCP...');
    const preflightResult = await runQuestion(
      { id: 'PREFLIGHT', question: 'Call get_stats and report the nodeCount. Reply with ONLY the number.' },
      args.mode, modelId,
      'You have access to a code graph via MCP tools. {{question}}\nPut your answer inside <answer></answer> tags.',
      args.projectRoot, effectiveMcpConfig
    );
    const answer = (preflightResult.answer_text || '').trim();
    const nodeCount = parseInt(answer.replace(/[^0-9]/g, ''), 10);
    if (preflightResult.error || preflightResult.mcp_calls === 0) {
      console.error(`Preflight FAILED: MCP not reachable (mcp_calls=${preflightResult.mcp_calls}, error=${preflightResult.error || 'none'})`);
      console.error('Fix: ensure rfdb-server is running and .mcp.json points to correct grafema MCP');
      process.exit(1);
    }
    if (!isNaN(nodeCount) && nodeCount === 0) {
      console.error(`Preflight FAILED: graph is empty (nodeCount=0). Run 'grafema analyze' first.`);
      process.exit(1);
    }
    console.error(`Preflight OK: MCP reachable, ${preflightResult.mcp_calls} MCP calls, answer="${answer.slice(0, 50)}"`);
    console.error('');
  }

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    console.error(`[${i + 1}/${questions.length}] ${q.id}: ${q.question.slice(0, 80)}...`);

    const result = await runQuestion(q, args.mode, modelId, promptTemplate, args.projectRoot, effectiveMcpConfig);

    if (result.error) {
      console.error(`  ${q.id}: ERROR — ${result.error}`);
      // Write error entry
      const errorEntry = {
        question_id: q.id,
        answer_text: '',
        raw_text: '',
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        tool_calls: [],
        mcp_calls: 0,
        latency_ms: 0,
        model: modelId,
        error: result.error,
      };
      writeFileSync(answersPath, JSON.stringify(errorEntry) + '\n', { flag: 'a' });
      continue;
    }

    // Append to answers.jsonl
    writeFileSync(answersPath, JSON.stringify(result) + '\n', { flag: 'a' });

    const secs = Math.round(result.latency_ms / 1000);
    const totalTokens = result.input_tokens + result.output_tokens;
    console.error(`  ${q.id}: done (${totalTokens} tokens, ${secs}s)`);
  }

  console.error('');
  console.error(`=== Run complete: ${runDir} ===`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
