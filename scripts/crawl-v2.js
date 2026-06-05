/**
 * Grafema Ontological Crawl Pipeline v2
 *
 * Self-contained autonomous loop that discovers, generates, verifies, and records
 * architectural hypotheses about the Grafema codebase.
 *
 * Key improvements over v1:
 *   - JSONL-first: all findings append to .grafema/crawl-findings.jsonl before RFDB
 *   - Recall before generate: queries knowledge DB for existing facts
 *   - Merge-on-record: deduplicates entities via substring search
 *   - Auto-discovery: extracts new entities from verified findings
 *   - Dedup: SHA-256 hash of hypothesis text, skips if already in JSONL
 *   - Entity-specific prompts with existing facts as context
 *   - Stats tracking with periodic summary
 *
 * Usage:
 *   node scripts/crawl-v2.js
 *   node scripts/crawl-v2.js --continuous
 *   node scripts/crawl-v2.js --model qwen3:30b-a3b --verify haiku
 *   node scripts/crawl-v2.js --sync-rfdb   # replay JSONL to RFDB
 *   node scripts/crawl-v2.js --entity "compactionEnricher"
 *
 * Environment:
 *   GEN_MODEL          Generation model (default: qwen3.6:35b)
 *   VERIFY_MODEL       Verification model (default: qwen3:4b)
 *   VERIFY_WITH_HAIKU  Set to "1" for Anthropic API verification
 *   OLLAMA_URL         Ollama endpoint (default: http://localhost:11434)
 *   PROJECT_ROOT       Project root (default: auto-detected)
 *   ANTHROPIC_API_KEY  Required when VERIFY_WITH_HAIKU=1
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.PROJECT_ROOT || resolve(SCRIPT_DIR, '..');
const GRAFEMA_DIR = resolve(PROJECT_ROOT, '.grafema');
const JSONL_PATH = resolve(GRAFEMA_DIR, 'crawl-findings.jsonl');
const BACKLOG_PATH = resolve(GRAFEMA_DIR, 'crawl-backlog.json');
const RFDB_SOCKET = resolve(GRAFEMA_DIR, 'rfdb.sock');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function option(name, fallback) {
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : fallback;
}

const GEN_MODEL = option('model', process.env.GEN_MODEL || 'qwen3.6:35b');
const VERIFY_MODE = option('verify', process.env.VERIFY_WITH_HAIKU === '1' ? 'haiku' : 'ollama');
const VERIFY_MODEL = process.env.VERIFY_MODEL || 'qwen3:4b';
const CONTINUOUS = flag('continuous');
const SYNC_RFDB = flag('sync-rfdb');
const SINGLE_ENTITY = option('entity', null);
const BATCH_CAP = 50;
const MAX_VERIFY_TURNS = 8;

// ---------------------------------------------------------------------------
// Anthropic API key (lazy, only for haiku mode)
// ---------------------------------------------------------------------------

let _anthropicKey = null;
function getAnthropicKey() {
  if (_anthropicKey) return _anthropicKey;
  _anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!_anthropicKey) {
    const keysFile = resolve(process.env.HOME, 'providers/keys.env');
    if (existsSync(keysFile)) {
      const match = readFileSync(keysFile, 'utf-8').match(/ANTHROPIC=(.+)/);
      if (match) _anthropicKey = match[1].trim();
    }
  }
  if (!_anthropicKey) {
    log('ERROR', 'No ANTHROPIC_API_KEY found. Set env or ~/providers/keys.env');
    process.exit(1);
  }
  return _anthropicKey;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${ts}] ${level}: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

const stats = { generated: 0, confirmed: 0, refuted: 0, unclear: 0, skipped: 0, discovered: 0, errors: 0 };

function printStats() {
  const total = stats.confirmed + stats.refuted + stats.unclear;
  if (total === 0) return;
  const pct = (n) => ((n / total) * 100).toFixed(1);
  log('STATS', [
    `generated=${stats.generated}`,
    `confirmed=${stats.confirmed}(${pct(stats.confirmed)}%)`,
    `refuted=${stats.refuted}(${pct(stats.refuted)}%)`,
    `unclear=${stats.unclear}(${pct(stats.unclear)}%)`,
    `skipped=${stats.skipped}`,
    `discovered=${stats.discovered}`,
    `errors=${stats.errors}`,
  ].join(' '));
}

// ---------------------------------------------------------------------------
// Dedup: in-memory set of hypothesis hashes loaded from JSONL
// ---------------------------------------------------------------------------

const seenHashes = new Set();

function hashText(text) {
  return createHash('sha256').update(text.toLowerCase().trim()).digest('hex').slice(0, 16);
}

function loadSeenHashes() {
  if (!existsSync(JSONL_PATH)) return;
  const lines = readFileSync(JSONL_PATH, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // Hash from hypothesis field (v2 format) or name field (v1 format)
      const text = obj.hypothesis || obj.name || '';
      if (text) seenHashes.add(hashText(text));
    } catch { /* skip malformed lines */ }
  }
  log('DEDUP', `Loaded ${seenHashes.size} existing hashes from JSONL`);
}

function isDuplicate(hypothesisText) {
  return seenHashes.has(hashText(hypothesisText));
}

function markSeen(hypothesisText) {
  seenHashes.add(hashText(hypothesisText));
}

// ---------------------------------------------------------------------------
// Backlog management
// ---------------------------------------------------------------------------

function loadBacklog() {
  if (!existsSync(BACKLOG_PATH)) {
    return { queue: [], processed: [], stats: { total_processed: 0, total_in_queue: 0 } };
  }
  return JSON.parse(readFileSync(BACKLOG_PATH, 'utf-8'));
}

function saveBacklog(backlog) {
  backlog.stats = {
    total_processed: backlog.processed.length,
    total_in_queue: backlog.queue.length,
    ...stats,
  };
  writeFileSync(BACKLOG_PATH, JSON.stringify(backlog, null, 2) + '\n');
}

function popNextEntity(backlog) {
  const idx = backlog.queue.findIndex(e => e.status === 'inbox');
  if (idx < 0) return null;
  const entity = backlog.queue[idx];
  entity.status = 'processing';
  return entity;
}

function markDone(backlog, entityName) {
  const idx = backlog.queue.findIndex(e => e.entity === entityName);
  if (idx >= 0) backlog.queue.splice(idx, 1);
  if (!backlog.processed.includes(entityName)) {
    backlog.processed.push(entityName);
  }
}

function pushDiscovered(backlog, entityName, context, depth = 4) {
  const normalizedName = entityName.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Skip if already processed or queued
  if (backlog.processed.some(p => p.toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedName)) return false;
  if (backlog.queue.some(q => q.entity.toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedName)) return false;
  backlog.queue.push({ entity: entityName, context, depth, status: 'inbox' });
  stats.discovered++;
  return true;
}

// ---------------------------------------------------------------------------
// JSONL writer (append-only, write-ahead log)
// ---------------------------------------------------------------------------

function appendFinding(finding) {
  if (!existsSync(GRAFEMA_DIR)) mkdirSync(GRAFEMA_DIR, { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...finding,
  });
  appendFileSync(JSONL_PATH, line + '\n');
}

// ---------------------------------------------------------------------------
// RFDB recall: query knowledge DB for existing facts about entity
// ---------------------------------------------------------------------------

async function recallFromRFDB(entityName) {
  try {
    if (!existsSync(RFDB_SOCKET)) return [];
    const tmpScript = resolve(GRAFEMA_DIR, '.crawl-recall-tmp.mjs');
    const safeName = entityName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    writeFileSync(tmpScript, [
      `import { RFDBClient } from '${PROJECT_ROOT}/packages/rfdb/dist/client.js';`,
      `const c = new RFDBClient('${RFDB_SOCKET}', 'crawl-v2-recall');`,
      `await c.connect();`,
      `await c.hello();`,
      `try { await c.openDatabase('knowledge', 'ro'); } catch { await c.close(); process.exit(0); }`,
      `const nodes = await c.getAllNodes({ name: '${safeName}', substringMatch: true });`,
      `for (const n of nodes.slice(0, 10)) {`,
      `  const meta = typeof n.metadata === 'string' ? JSON.parse(n.metadata) : (n.metadata || {});`,
      `  console.log(JSON.stringify({ name: n.name, content: meta.content || n.name, domain: meta.domain || n.file }));`,
      `}`,
      `await c.close();`,
    ].join('\n'));
    const result = execSync(`node ${tmpScript}`, {
      encoding: 'utf-8', timeout: 10000, cwd: PROJECT_ROOT,
    }).trim();
    if (!result) return [];
    return result.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (e) {
    log('RECALL', `RFDB query failed (non-fatal): ${e.message?.slice(0, 120)}`);
    return [];
  }
}

/** Also recall from JSONL (cheaper, always available) */
function recallFromJSONL(entityName) {
  if (!existsSync(JSONL_PATH)) return [];
  const needle = entityName.toLowerCase();
  const results = [];
  const lines = readFileSync(JSONL_PATH, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const text = (obj.entity || obj.name || '').toLowerCase();
      if (text.includes(needle) || needle.includes(text)) {
        results.push({
          hypothesis: obj.hypothesis || obj.name,
          verdict: obj.verdict,
          domain: obj.domain,
        });
      }
    } catch { /* skip */ }
  }
  return results.slice(0, 15);
}

// ---------------------------------------------------------------------------
// Pre-compute codebase context for an entity
// ---------------------------------------------------------------------------

function precomputeContext(entityName) {
  const name = entityName.replace(/\.[a-z]+$/i, '');
  const parts = [];

  // grep for entity name across source
  try {
    const grep = execSync(
      `grep -rn "${name}" "${PROJECT_ROOT}/packages/" --include="*.rs" --include="*.ts" --include="*.hs" --include="*.yaml" 2>/dev/null | head -20`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    if (grep) parts.push(`=== grep "${name}" ===\n${grep}`);
  } catch { /* ignore */ }

  // Find main file and get overview
  try {
    const found = execSync(
      `find "${PROJECT_ROOT}/packages/" -name "${entityName}" -o -name "${name}.rs" -o -name "${name}.ts" -o -name "${name}.hs" 2>/dev/null | head -3`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    if (found) {
      const mainFile = found.split('\n')[0];
      const overview = execSync(
        `grep -n "^pub fn\\|^fn\\|^pub struct\\|^struct\\|^pub enum\\|^impl\\|^pub trait\\|^export function\\|^export class\\|^export const\\|^export async\\|^export interface\\|^export default" "${mainFile}" 2>/dev/null | head -30`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      if (overview) {
        const relPath = mainFile.replace(PROJECT_ROOT + '/', '');
        parts.push(`=== Definitions in ${relPath} ===\n${overview}`);
      }
    }
  } catch { /* ignore */ }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Ollama API helpers
// ---------------------------------------------------------------------------

async function ollamaGenerate(prompt, model, options = {}) {
  const body = {
    model,
    prompt,
    stream: false,
    options: { temperature: options.temperature ?? 0.7, num_predict: options.num_predict ?? 4000 },
  };
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama generate failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.response || '';
}

async function ollamaChat(messages, model, tools = undefined, options = {}) {
  const body = {
    model,
    messages,
    stream: false,
    options: { temperature: options.temperature ?? 0.3, num_predict: options.num_predict ?? 4000 },
  };
  if (tools) body.tools = tools;
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama chat failed: ${res.status} ${res.statusText}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Anthropic API helper (for Haiku verification)
// ---------------------------------------------------------------------------

async function anthropicChat(messages, system, tools) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': getAnthropicKey(),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system,
      tools,
      messages,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Step 3: Generate hypotheses (entity-specific prompts)
// ---------------------------------------------------------------------------

function buildGenerationPrompt(entity, context, existingFacts, codeContext) {
  const factsBlock = existingFacts.length > 0
    ? `\nALREADY KNOWN about "${entity.entity}":\n${existingFacts.map((f, i) => `  ${i + 1}. ${f.hypothesis || f.content || f.name}`).join('\n')}\n\nDo NOT repeat these facts. Generate NEW hypotheses only.\n`
    : '';

  const codeBlock = codeContext
    ? `\nCODE EVIDENCE:\n${codeContext.slice(0, 3000)}\n`
    : '';

  return `/no_think
You are mapping the architecture of Grafema, a tool that turns codebases into queryable graphs.

ENTITY: ${entity.entity}
CONTEXT: ${entity.context || 'No additional context provided.'}
${factsBlock}${codeBlock}
Generate exactly 5 NEW hypotheses about "${entity.entity}". Each hypothesis should be:
- Specific and verifiable (references concrete files, functions, or patterns)
- Non-obvious (not just restating the context)
- About architecture, dependencies, fragilities, invariants, or design patterns

Categories:
  DEP       — dependency on another component, hidden coupling
  FRAGILE   — fragility, crash risk, race condition, invariant violation
  INVARIANT — architectural invariant that must hold for correctness
  PATTERN   — design pattern, convention, or idiom used
  FLOW      — data flow, control flow, pipeline stage ordering

Format: CATEGORY|hypothesis text
One per line, no numbering, no extra text.`;
}

async function generateHypotheses(entity, existingFacts, codeContext) {
  const prompt = buildGenerationPrompt(entity, entity.context, existingFacts, codeContext);
  const response = await ollamaGenerate(prompt, GEN_MODEL, { temperature: 0.7, num_predict: 4000 });

  const lines = response.split('\n').filter(l => l.includes('|'));
  const hypotheses = [];

  for (const line of lines) {
    const pipeIdx = line.indexOf('|');
    if (pipeIdx < 0) continue;
    const category = line.slice(0, pipeIdx).trim().replace(/^[\s*\-\d.]+/, '').toUpperCase();
    const text = line.slice(pipeIdx + 1).trim();
    if (!text || text.length < 10) continue;

    const validCategories = ['DEP', 'FRAGILE', 'INVARIANT', 'PATTERN', 'FLOW', 'CONCEPT', 'UNEXPECTED'];
    const cat = validCategories.includes(category) ? category : 'PATTERN';

    hypotheses.push({ category: cat, hypothesis: text });
  }

  return hypotheses;
}

// ---------------------------------------------------------------------------
// Step 4: Verification (Ollama tool-use agent or Haiku API)
// ---------------------------------------------------------------------------

const VERIFY_TOOLS_OLLAMA = [
  {
    type: 'function',
    function: {
      name: 'graph_find',
      description: 'Find nodes in the Grafema code graph by name. Returns node ID, type, file, line.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Entity name (partial match)' },
          type: { type: 'string', description: 'Node type: FUNCTION, CLASS, MODULE, STRUCT, VARIABLE, CALL' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read source code from a file. Use after locating via grep.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from project root' },
          offset: { type: 'number', description: 'Start line (0-based)' },
          limit: { type: 'number', description: 'Max lines (default 150)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for a pattern in source files. Returns file:line matches.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern' },
          path: { type: 'string', description: 'Subdirectory (default: packages/)' },
          max_results: { type: 'number', description: 'Max results (default 15)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_overview',
      description: 'List all function/struct/class definitions in a file.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Relative file path' },
        },
        required: ['file'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_verdict',
      description: 'Submit your final verdict. MUST be called exactly once.',
      parameters: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unclear'] },
          evidence: { type: 'string', description: 'Specific file:line evidence' },
          confidence: { type: 'number', description: '0.0-1.0' },
          notes: { type: 'string', description: 'Additional observations' },
          discovered_entities: {
            type: 'array',
            description: 'New entity names worth investigating further',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                context: { type: 'string' },
              },
            },
          },
        },
        required: ['verdict', 'evidence', 'confidence'],
      },
    },
  },
];

const VERIFY_TOOLS_HAIKU = [
  {
    name: 'grep_code',
    description: 'Search for a pattern in source files.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern' },
        path: { type: 'string', description: 'Subdirectory (default: packages/)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_file',
    description: 'Read lines from a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
        start_line: { type: 'number', description: 'Start line (1-based)' },
        end_line: { type: 'number', description: 'End line' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_overview',
    description: 'List definitions (functions, structs, classes) in a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'submit_verdict',
    description: 'Submit final verdict. MUST be called exactly once at the end.',
    input_schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unclear'] },
        evidence: { type: 'string', description: 'Specific file:line evidence' },
        confidence: { type: 'number', description: '0.0-1.0' },
        notes: { type: 'string' },
        discovered_entities: {
          type: 'array',
          description: 'New entity names worth investigating',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              context: { type: 'string' },
            },
          },
        },
      },
      required: ['verdict', 'evidence', 'confidence'],
    },
  },
];

function executeVerifyTool(name, args) {
  try {
    switch (name) {
      case 'graph_find': {
        const grepCmd = `grep -rn "${args.name.replace(/"/g, '\\"')}" "${PROJECT_ROOT}/packages/" --include="*.rs" --include="*.ts" --include="*.hs" 2>/dev/null | head -15`;
        return execSync(grepCmd, { encoding: 'utf-8', timeout: 10000 }).trim() || 'No matches found';
      }
      case 'grep_code':
      case 'grep': {
        const searchPath = `${PROJECT_ROOT}/${args.path || 'packages/'}`;
        const max = args.max_results || 15;
        const cmd = `grep -rn "${(args.pattern || '').replace(/"/g, '\\"')}" "${searchPath}" --include="*.ts" --include="*.rs" --include="*.hs" --include="*.yaml" --include="*.cabal" 2>/dev/null | head -${max}`;
        return execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim() || 'No matches';
      }
      case 'read_file': {
        const fullPath = resolve(PROJECT_ROOT, args.path);
        if (!existsSync(fullPath)) return `File not found: ${args.path}`;
        if (!fullPath.startsWith(PROJECT_ROOT)) return 'Access denied: path outside project';
        const content = readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        const offset = args.offset ?? ((args.start_line || 1) - 1);
        const limit = args.limit || (args.end_line ? args.end_line - offset : 150);
        return lines.slice(offset, offset + limit).map((l, i) => `${offset + i + 1}\t${l}`).join('\n');
      }
      case 'file_overview': {
        const filePath = args.file || args.path;
        const fullPath = resolve(PROJECT_ROOT, filePath);
        const cmd = `grep -n "^pub fn\\|^fn\\|^pub struct\\|^struct\\|^pub enum\\|^impl\\|^pub trait\\|^export function\\|^export class\\|^export const\\|^export async\\|^export interface\\|^export default" "${fullPath}" 2>/dev/null | head -40`;
        return execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim() || 'No definitions found';
      }
      case 'submit_verdict':
        return JSON.stringify(args);
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error: ${e.message?.slice(0, 200)}`;
  }
}

async function verifyWithOllama(hypothesis, entityContext) {
  const messages = [
    {
      role: 'system',
      content: `/no_think
You are a software architecture verification agent for the Grafema project.
Grafema turns codebases into queryable graphs. It has:
- packages/rfdb-server (Rust) — graph database
- packages/grafema-orchestrator (Rust) — pipeline coordinator
- packages/js-analyzer (Haskell) — JS/TS static analysis
- packages/cli, packages/mcp, packages/util (TypeScript)

Context about the entity: ${entityContext || 'none'}

RULES:
1. Use grep FIRST to locate relevant files, then read_file for details
2. Cite specific file:line as evidence
3. You have up to ${MAX_VERIFY_TURNS} tool calls. If unclear after that, submit "unclear"
4. Call submit_verdict EXACTLY ONCE when done
5. Never guess — verify from source
6. In discovered_entities, list any NEW component names you encounter that seem worth crawling`,
    },
    {
      role: 'user',
      content: `Verify this hypothesis:\n\n"${hypothesis}"\n\nUse tools to examine source code, then submit_verdict.`,
    },
  ];

  let verdict = null;
  for (let turn = 0; turn < MAX_VERIFY_TURNS && !verdict; turn++) {
    let response;
    try {
      response = await ollamaChat(messages, VERIFY_MODEL, VERIFY_TOOLS_OLLAMA, {
        temperature: 0.3,
        num_predict: turn < 3 ? 2000 : 1000,
      });
    } catch (e) {
      log('VERIFY', `Ollama error on turn ${turn}: ${e.message?.slice(0, 100)}`);
      stats.errors++;
      break;
    }

    const msg = response.message;
    if (!msg) break;
    messages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const call of msg.tool_calls) {
        const toolName = call.function.name;
        const toolArgs = call.function.arguments;
        log('TOOL', `[${turn + 1}] ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)})`);

        const result = executeVerifyTool(toolName, toolArgs);

        if (toolName === 'submit_verdict') {
          try { verdict = JSON.parse(result); } catch { verdict = toolArgs; }
        }
        messages.push({ role: 'tool', content: result.slice(0, 4000) });
      }
    } else if (msg.content) {
      // Model didn't use tools — try to extract a verdict from text
      const jsonMatch = msg.content.match(/\{[^{}]*"verdict"\s*:\s*"[^"]+"/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0] + '}');
          verdict = { verdict: parsed.verdict, evidence: parsed.evidence || msg.content.slice(0, 200), confidence: parsed.confidence || 0.5 };
        } catch { /* continue loop */ }
      }
    } else {
      break;
    }
  }

  return verdict || { verdict: 'unclear', evidence: 'Agent exhausted turns without verdict', confidence: 0 };
}

async function verifyWithHaiku(hypothesis, entityContext) {
  const system = `You verify hypotheses about the Grafema codebase by examining source code.
Tools: grep_code (search), read_file (read lines), file_overview (list definitions), submit_verdict.
Start with grep_code to find relevant files. After gathering evidence, call submit_verdict.
Context about entity: ${entityContext || 'none'}
In discovered_entities of submit_verdict, list any new component names worth investigating.`;

  const messages = [
    { role: 'user', content: `Verify: "${hypothesis}"` },
  ];

  let verdict = null;
  for (let turn = 0; turn < MAX_VERIFY_TURNS && !verdict; turn++) {
    let response;
    try {
      response = await anthropicChat(messages, system, VERIFY_TOOLS_HAIKU);
    } catch (e) {
      log('VERIFY', `Haiku API error: ${e.message?.slice(0, 120)}`);
      stats.errors++;
      break;
    }

    if (response.error) {
      log('VERIFY', `API error: ${response.error.message}`);
      break;
    }

    const content = response.content || [];
    messages.push({ role: 'assistant', content });

    const toolUses = content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // Try to extract JSON verdict from text
      const text = content.find(b => b.type === 'text')?.text || '';
      const jsonMatch = text.match(/\{[^{}]*"verdict"\s*:\s*"[^"]+"/);
      if (jsonMatch) {
        try {
          const full = text.match(/\{[^{}]*"verdict"[^}]*\}/)?.[0];
          verdict = JSON.parse(full);
        } catch { /* fall through */ }
      }
      if (!verdict) {
        verdict = { verdict: 'unclear', evidence: text.slice(0, 200), confidence: 0 };
      }
      break;
    }

    const toolResults = [];
    for (const tu of toolUses) {
      log('TOOL', `[${turn + 1}] ${tu.name}(${JSON.stringify(tu.input).slice(0, 80)})`);
      const result = executeVerifyTool(tu.name, tu.input);

      if (tu.name === 'submit_verdict') {
        try { verdict = JSON.parse(result); } catch { verdict = tu.input; }
      }

      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result.slice(0, 4000) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return verdict || { verdict: 'unclear', evidence: 'Agent exhausted turns', confidence: 0 };
}

async function verify(hypothesis, entityContext) {
  if (VERIFY_MODE === 'haiku') {
    return verifyWithHaiku(hypothesis, entityContext);
  }
  return verifyWithOllama(hypothesis, entityContext);
}

// ---------------------------------------------------------------------------
// Step 6: Record finding to JSONL
// ---------------------------------------------------------------------------

function recordFinding(entity, hypothesis, verdict) {
  const finding = {
    entity: entity.entity,
    category: hypothesis.category,
    hypothesis: hypothesis.hypothesis,
    verdict: verdict.verdict,
    evidence: verdict.evidence || '',
    confidence: verdict.confidence || 0,
    notes: verdict.notes || '',
    hash: hashText(hypothesis.hypothesis),
  };

  appendFinding(finding);
  markSeen(hypothesis.hypothesis);

  // Track stats
  if (verdict.verdict === 'confirmed') stats.confirmed++;
  else if (verdict.verdict === 'refuted') stats.refuted++;
  else stats.unclear++;

  return finding;
}

// ---------------------------------------------------------------------------
// Step 7: Discover new entities from verified findings
// ---------------------------------------------------------------------------

function discoverEntities(backlog, verdict) {
  // From explicit discovered_entities field in verdict
  if (verdict.discovered_entities && Array.isArray(verdict.discovered_entities)) {
    for (const ent of verdict.discovered_entities) {
      if (ent.name && ent.name.length >= 3 && ent.name.length <= 80) {
        pushDiscovered(backlog, ent.name, ent.context || `Discovered during verification of another entity.`);
      }
    }
  }

  // Extract entity names from evidence/notes text (CamelCase or snake_case identifiers)
  const text = `${verdict.evidence || ''} ${verdict.notes || ''}`;
  const camelCase = text.match(/\b[A-Z][a-zA-Z]{4,30}\b/g) || [];
  const snakeCase = text.match(/\b[a-z][a-z_]{4,30}\b/g) || [];

  // Filter to likely code entity names
  const skipWords = new Set([
    'FUNCTION', 'MODULE', 'CLASS', 'STRUCT', 'ENTITY', 'VARIABLE',
    'Error', 'String', 'Number', 'Boolean', 'Object', 'Array',
    'Found', 'Could', 'Would', 'Should', 'About', 'After', 'Before',
    'Their', 'There', 'These', 'Those', 'Where', 'Which', 'While',
    'Based', 'Since', 'Under', 'Given', 'Using', 'Makes', 'Takes',
    'Returns', 'Calls', 'Creates', 'Handles', 'Checks', 'Serves',
    'Confirms', 'Refuted', 'Unclear', 'Evidence', 'Confidence',
    'Notes', 'Hypothesis', 'Verdict', 'Pattern', 'Convention',
  ]);

  for (const name of camelCase) {
    if (!skipWords.has(name) && name.length >= 5) {
      pushDiscovered(backlog, name, `Referenced in verification evidence.`);
    }
  }

  // Only discover snake_case if they look like Rust/TS module names
  for (const name of snakeCase) {
    if (name.includes('_') && name.length >= 6 && !name.startsWith('should') && !name.startsWith('could')) {
      pushDiscovered(backlog, name, `Referenced in verification evidence.`);
    }
  }
}

// ---------------------------------------------------------------------------
// RFDB sync: replay JSONL findings into knowledge DB
// ---------------------------------------------------------------------------

async function syncToRFDB() {
  if (!existsSync(JSONL_PATH)) {
    log('SYNC', 'No JSONL file to sync');
    return;
  }
  if (!existsSync(RFDB_SOCKET)) {
    log('SYNC', 'RFDB socket not available');
    return;
  }

  const lines = readFileSync(JSONL_PATH, 'utf-8').split('\n').filter(Boolean);
  const findings = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // Only sync v2 findings (have hypothesis + verdict)
      if (obj.hypothesis && obj.verdict) findings.push(obj);
    } catch { /* skip */ }
  }

  if (findings.length === 0) {
    log('SYNC', 'No v2 findings to sync');
    return;
  }

  log('SYNC', `Syncing ${findings.length} findings to RFDB knowledge DB...`);

  // Build nodes and edges
  const nodes = [];
  const edges = [];

  for (const f of findings) {
    const nodeId = hashText(f.hypothesis);
    const domain = f.category === 'DEP' ? 'dependencies'
      : f.category === 'FRAGILE' ? 'fragilities'
      : f.category === 'INVARIANT' ? 'invariants'
      : f.category === 'FLOW' ? 'dataflow'
      : 'architecture';

    nodes.push({
      id: nodeId,
      nodeType: f.verdict === 'confirmed' ? 'FACT' : 'ENTITY',
      name: f.hypothesis.slice(0, 120),
      file: domain,
      metadata: JSON.stringify({
        content: f.hypothesis,
        entity: f.entity,
        category: f.category,
        verdict: f.verdict,
        confidence: f.confidence,
        evidence: f.evidence,
        notes: f.notes,
        domain,
        created_at: f.ts,
      }),
    });
  }

  // Write in chunks via direct addNodes (NOT beginBatch/commitBatch, which
  // auto-populates changed_files and deletes existing nodes in those files).
  const chunkSize = BATCH_CAP;
  const tmpScript = resolve(GRAFEMA_DIR, '.crawl-sync-tmp.mjs');
  for (let i = 0; i < nodes.length; i += chunkSize) {
    const chunk = nodes.slice(i, i + chunkSize);
    writeFileSync(tmpScript, [
      `import { RFDBClient } from '${PROJECT_ROOT}/packages/rfdb/dist/client.js';`,
      `const c = new RFDBClient('${RFDB_SOCKET}', 'crawl-v2-sync');`,
      `await c.connect();`,
      `await c.hello();`,
      `try { await c.openDatabase('knowledge', 'rw'); } catch {`,
      `  await c.createDatabase('knowledge');`,
      `  await c.openDatabase('knowledge', 'rw');`,
      `}`,
      `const nodes = ${JSON.stringify(chunk)};`,
      `await c.addNodes(nodes);`,
      `console.log(JSON.stringify({ ok: true, added: nodes.length }));`,
      `await c.close();`,
    ].join('\n'));
    try {
      execSync(`node ${tmpScript}`, {
        encoding: 'utf-8', timeout: 15000, cwd: PROJECT_ROOT,
      });
      log('SYNC', `Wrote chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(nodes.length / chunkSize)} (${chunk.length} nodes)`);
    } catch (e) {
      log('SYNC', `ERROR writing chunk: ${e.message?.slice(0, 200)}`);
    }
  }

  log('SYNC', `Done. Synced ${nodes.length} findings.`);
}

// ---------------------------------------------------------------------------
// Main: process a single entity
// ---------------------------------------------------------------------------

async function processEntity(entity, backlog) {
  log('ENTITY', `=== ${entity.entity} ===`);

  // Step 1: Recall existing facts
  log('RECALL', `Querying for existing facts about "${entity.entity}"...`);
  const rfdbFacts = await recallFromRFDB(entity.entity);
  const jsonlFacts = recallFromJSONL(entity.entity);
  const existingFacts = [...rfdbFacts, ...jsonlFacts];
  log('RECALL', `Found ${rfdbFacts.length} RFDB + ${jsonlFacts.length} JSONL existing facts`);

  // Step 2: Pre-compute code context
  log('CONTEXT', 'Pre-computing codebase context...');
  const codeContext = precomputeContext(entity.entity);

  // Step 3: Generate hypotheses
  log('GENERATE', `Generating hypotheses via ${GEN_MODEL}...`);
  let hypotheses;
  try {
    hypotheses = await generateHypotheses(entity, existingFacts, codeContext);
  } catch (e) {
    log('GENERATE', `ERROR: ${e.message?.slice(0, 150)}`);
    stats.errors++;
    return;
  }

  if (hypotheses.length === 0) {
    log('GENERATE', 'No hypotheses generated, skipping entity');
    return;
  }
  log('GENERATE', `Generated ${hypotheses.length} hypotheses`);
  stats.generated += hypotheses.length;

  // Step 4+5: Verify each hypothesis
  for (const h of hypotheses) {
    // Dedup check
    if (isDuplicate(h.hypothesis)) {
      log('DEDUP', `Skipping duplicate: ${h.hypothesis.slice(0, 60)}...`);
      stats.skipped++;
      continue;
    }

    log('VERIFY', `[${h.category}] ${h.hypothesis.slice(0, 80)}...`);
    log('VERIFY', `Verifying via ${VERIFY_MODE === 'haiku' ? 'Haiku API' : VERIFY_MODEL}...`);

    let verdict;
    try {
      verdict = await verify(h.hypothesis, entity.context);
    } catch (e) {
      log('VERIFY', `ERROR: ${e.message?.slice(0, 150)}`);
      verdict = { verdict: 'unclear', evidence: `Verification error: ${e.message?.slice(0, 100)}`, confidence: 0 };
      stats.errors++;
    }

    log('VERDICT', `${verdict.verdict} (confidence: ${verdict.confidence})`);

    // Step 6: Record to JSONL
    recordFinding(entity, h, verdict);

    // Step 7: Discover new entities
    discoverEntities(backlog, verdict);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  log('START', `crawl-v2 | gen=${GEN_MODEL} verify=${VERIFY_MODE === 'haiku' ? 'haiku' : VERIFY_MODEL} continuous=${CONTINUOUS}`);

  // Handle --sync-rfdb mode
  if (SYNC_RFDB) {
    await syncToRFDB();
    return;
  }

  // Load dedup hashes
  loadSeenHashes();

  // Load backlog
  const backlog = loadBacklog();
  log('BACKLOG', `${backlog.queue.filter(e => e.status === 'inbox').length} entities in queue, ${backlog.processed.length} processed`);

  // Handle --entity mode (single entity, no backlog)
  if (SINGLE_ENTITY) {
    const entity = { entity: SINGLE_ENTITY, context: option('context', ''), depth: 1 };
    await processEntity(entity, backlog);
    saveBacklog(backlog);
    printStats();
    return;
  }

  // Main loop
  let entitiesProcessed = 0;
  do {
    const entity = popNextEntity(backlog);
    if (!entity) {
      if (CONTINUOUS) {
        log('BACKLOG', 'Queue empty. Waiting 30s for new entities...');
        await new Promise(r => setTimeout(r, 30000));
        continue;
      } else {
        log('BACKLOG', 'Queue empty. Done.');
        break;
      }
    }

    try {
      await processEntity(entity, backlog);
    } catch (e) {
      log('ERROR', `Failed processing "${entity.entity}": ${e.message?.slice(0, 200)}`);
      stats.errors++;
    }

    markDone(backlog, entity.entity);
    saveBacklog(backlog);
    entitiesProcessed++;

    // Print stats every 10 entities
    if (entitiesProcessed % 10 === 0) {
      printStats();
    }

    // Brief pause between entities to avoid overloading Ollama
    if (CONTINUOUS || backlog.queue.some(e => e.status === 'inbox')) {
      await new Promise(r => setTimeout(r, 2000));
    }

  } while (CONTINUOUS || backlog.queue.some(e => e.status === 'inbox'));

  // Final stats
  printStats();
  log('DONE', `Processed ${entitiesProcessed} entities`);
}

main().catch(e => {
  log('FATAL', e.stack || e.message);
  process.exit(1);
});
