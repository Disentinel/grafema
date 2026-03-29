#!/usr/bin/env node
/**
 * Autoresearch Phase 3: end-to-end task runner.
 *
 * Checks out a base commit, gives the agent a bug description,
 * captures the resulting diff, and compares to the gold patch.
 *
 * Usage:
 *   node autoresearch/harness/run-task.mjs \
 *     --mode baseline|grafema \
 *     --model sonnet \
 *     --task-id T01 \
 *     [--tasks autoresearch/tasks.yaml] \
 *     [--run-id custom-name]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { execSync, execFileSync, spawn } from 'child_process';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const _require = createRequire(join(resolve(new URL('../../', import.meta.url).pathname), 'packages', 'util', 'package.json'));
const { parse: parseYAML, stringify: stringifyYAML } = _require('yaml');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(new URL('../../', import.meta.url).pathname);
const DEFAULT_TASKS = join(PROJECT_ROOT, 'autoresearch', 'tasks.yaml');
const PROMPTS_DIR = join(PROJECT_ROOT, 'autoresearch', 'prompts');
const RESULTS_BASE = join(PROJECT_ROOT, 'autoresearch', 'results');
const MCP_CONFIG = join(PROJECT_ROOT, '.mcp.json');

const MODEL_MAP = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    mode: null,
    model: 'sonnet',
    tasks: DEFAULT_TASKS,
    taskId: null,
    runId: null,
  };
  let i = 2;
  while (i < argv.length) {
    switch (argv[i]) {
      case '--mode': args.mode = argv[++i]; break;
      case '--model': args.model = argv[++i]; break;
      case '--tasks': args.tasks = resolve(argv[++i]); break;
      case '--task-id': args.taskId = argv[++i]; break;
      case '--run-id': args.runId = argv[++i]; break;
      case '--help': case '-h':
        console.error('Usage: node run-task.mjs --mode baseline|grafema --task-id T01 [--model sonnet] [--tasks path] [--run-id name]');
        process.exit(0); break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
    i++;
  }
  if (!args.mode || !['baseline', 'grafema'].includes(args.mode)) {
    console.error('Error: --mode must be "baseline" or "grafema"');
    process.exit(1);
  }
  if (!args.taskId) {
    console.error('Error: --task-id is required');
    process.exit(1);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function gitExec(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: opts.cwd || PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

function getCurrentBranch() {
  return gitExec('git rev-parse --abbrev-ref HEAD');
}

function stashIfNeeded() {
  const status = gitExec('git status --porcelain');
  if (status) {
    gitExec('git stash push -m "autoresearch-task-runner"');
    return true;
  }
  return false;
}

function getGoldPatch(commit) {
  return gitExec(`git diff ${commit}^..${commit} -- . ':!test/' ':!*.test.*'`);
}

// ---------------------------------------------------------------------------
// Session JSONL parsing (same as run.mjs)
// ---------------------------------------------------------------------------

function parseSessionOutput(raw) {
  const lines = raw.split('\n').filter(Boolean);
  let textParts = [];
  const toolCounts = {};
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;

  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }

    const u = ev.usage || {};
    inputTokens += u.input_tokens || 0;
    outputTokens += u.output_tokens || 0;
    cacheReadTokens += u.cache_read_input_tokens || 0;
    cacheCreationTokens += u.cache_creation_input_tokens || 0;

    if (ev.type === 'assistant') {
      for (const block of (ev.message?.content || [])) {
        if (block.type === 'text') textParts.push(block.text);
        else if (block.type === 'tool_use') {
          toolCounts[block.name] = (toolCounts[block.name] || 0) + 1;
        }
      }
    }
  }

  return {
    rawText: textParts.join('\n'),
    inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
    toolCalls: Object.entries(toolCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    mcpCalls: Object.entries(toolCounts).filter(([n]) => n.startsWith('mcp__grafema')).reduce((s, [, c]) => s + c, 0),
  };
}

// ---------------------------------------------------------------------------
// Run task
// ---------------------------------------------------------------------------

async function runTask(task, mode, modelId) {
  const originalBranch = getCurrentBranch();
  const stashed = stashIfNeeded();
  const worktreeDir = join(tmpdir(), `autoresearch-task-${task.id}-${Date.now()}`);

  try {
    // Create a worktree at the base commit
    console.error(`  Creating worktree at ${task.base_commit.slice(0, 8)}...`);
    gitExec(`git worktree add "${worktreeDir}" ${task.base_commit} --detach`);

    // Build prompt
    const prompt = `You are fixing a bug in the Grafema codebase.

PROJECT: ${worktreeDir}
${mode === 'grafema' ? 'You have access to Grafema graph tools via MCP (find_calls, find_nodes, describe, trace_dataflow, get_file_overview, get_context, query_graph).\n' : ''}
BUG DESCRIPTION:
${task.problem_statement}

INSTRUCTIONS:
1. Investigate the bug in the codebase
2. Fix the bug by editing the necessary files
3. Do NOT add tests — only fix the production code
4. Do NOT commit — just edit the files

The fix should be minimal and targeted. Only change what's necessary.`;

    // Spawn claude
    const claudeArgs = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--max-turns', '50',
      '--model', modelId,
      '--verbose',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
    ];

    if (mode === 'grafema' && existsSync(MCP_CONFIG)) {
      claudeArgs.push('--mcp-config', MCP_CONFIG);
    }

    console.error(`  Running claude (${mode})...`);
    const startMs = Date.now();

    const result = await new Promise((resolvePromise) => {
      const child = spawn('claude', claudeArgs, {
        cwd: worktreeDir,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });

      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      child.on('error', (err) => resolvePromise({ error: err.message }));
      child.on('close', (code) => {
        const latencyMs = Date.now() - startMs;
        if (code !== 0 && !stdout) {
          resolvePromise({ error: `exit code ${code}`, stderr });
          return;
        }
        const parsed = parseSessionOutput(stdout);
        resolvePromise({ ...parsed, latencyMs, code });
      });
    });

    if (result.error) {
      return { task_id: task.id, error: result.error, patch: '', gold_patch: '' };
    }

    // Capture diff (the agent's changes)
    const agentPatch = gitExec('git diff', { cwd: worktreeDir });
    const goldPatch = getGoldPatch(task.commit);

    // Run acceptance check if defined
    let accepted = null;
    let acceptanceOutput = '';
    if (task.acceptance_check) {
      try {
        acceptanceOutput = execSync(task.acceptance_check, {
          cwd: worktreeDir,
          encoding: 'utf8',
          timeout: 120000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        accepted = true;
        console.error(`  Acceptance check: PASS`);
      } catch (err) {
        acceptanceOutput = (err.stdout || '') + (err.stderr || '');
        accepted = false;
        console.error(`  Acceptance check: FAIL`);
      }
    }

    return {
      task_id: task.id,
      patch: agentPatch,
      gold_patch: goldPatch,
      accepted,
      acceptance_output: acceptanceOutput.slice(0, 1000),
      files_changed: agentPatch ? agentPatch.match(/^diff --git/gm)?.length || 0 : 0,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      cache_read_tokens: result.cacheReadTokens,
      cache_creation_tokens: result.cacheCreationTokens,
      tool_calls: result.toolCalls,
      mcp_calls: result.mcpCalls,
      latency_ms: result.latencyMs,
      model: modelId,
      raw_text: result.rawText?.slice(0, 2000),
    };
  } finally {
    // Cleanup worktree
    try {
      gitExec(`git worktree remove "${worktreeDir}" --force`);
    } catch {
      console.error(`  Warning: failed to remove worktree ${worktreeDir}`);
    }
    if (stashed) {
      try { gitExec('git stash pop'); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const modelId = MODEL_MAP[args.model];

  // Load tasks
  const raw = readFileSync(args.tasks, 'utf8');
  const data = parseYAML(raw);
  const tasks = Array.isArray(data) ? data : data.tasks;

  const task = tasks.find(t => t.id === args.taskId);
  if (!task) {
    console.error(`Error: task "${args.taskId}" not found`);
    process.exit(1);
  }

  // Create results directory
  const now = new Date();
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0'),
  ].join('-');
  const runId = args.runId || `task-${args.taskId}-${args.mode}-${datePart}`;
  const runDir = join(RESULTS_BASE, runId);
  mkdirSync(runDir, { recursive: true });

  // Save config
  const config = {
    mode: args.mode,
    model: modelId,
    date: now.toISOString(),
    task_id: task.id,
    task_title: task.title,
    base_commit: task.base_commit,
    gold_commit: task.commit,
    run_id: runId,
  };
  writeFileSync(join(runDir, 'config.yaml'), stringifyYAML(config), 'utf8');

  console.error(`=== Autoresearch Task Run ===`);
  console.error(`Task:  ${task.id}: ${task.title}`);
  console.error(`Mode:  ${args.mode}`);
  console.error(`Model: ${modelId}`);
  console.error(`Base:  ${task.base_commit.slice(0, 8)}`);
  console.error(`Run:   ${runDir}`);
  console.error('');

  const result = await runTask(task, args.mode, modelId);

  // Save results
  writeFileSync(join(runDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  if (result.patch) writeFileSync(join(runDir, 'agent.patch'), result.patch, 'utf8');
  if (result.gold_patch) writeFileSync(join(runDir, 'gold.patch'), result.gold_patch, 'utf8');

  if (result.error) {
    console.error(`ERROR: ${result.error}`);
  } else {
    const secs = Math.round(result.latency_ms / 1000);
    const acceptStr = result.accepted === true ? 'PASS' : result.accepted === false ? 'FAIL' : 'no check';
    console.error(`Done: ${result.files_changed} files changed, ${result.input_tokens + result.output_tokens} tokens, ${secs}s, acceptance: ${acceptStr}`);
    console.error(`Patch: ${runDir}/agent.patch`);
    console.error(`Gold:  ${runDir}/gold.patch (reference only — may not be optimal)`);
  }

  console.error(`\n=== Run complete: ${runDir} ===`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
