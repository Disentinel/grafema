#!/usr/bin/env node
/**
 * Ontological Crawler Verification Agent
 *
 * Gives Ollama read-only access to the codebase for verifying hypotheses.
 * Tools: read_file, grep, find_files, list_dir
 * NO edit/write/delete tools.
 *
 * Usage:
 *   node scripts/crawl-verify.js "hypothesis text" [--model qwen3.6:35b]
 *
 * Output: JSON { verdict: "confirmed"|"refuted"|"unclear", evidence: "...", confidence: 0.0-1.0 }
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : 'qwen3.6:35b';
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();

const hypothesis = process.argv[2];
if (!hypothesis) {
  console.error('Usage: node scripts/crawl-verify.js "hypothesis text" [--model MODEL]');
  process.exit(1);
}

const GRAFEMA_SOCKET = `${PROJECT_ROOT}/.grafema/rfdb.sock`;

const tools = [
  {
    type: 'function',
    function: {
      name: 'graph_find',
      description: 'Find nodes in the Grafema code graph by name and optional type. Returns node ID, type, file, line. Use this FIRST to locate code entities — much faster and more accurate than grep.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Entity name to search (partial match)' },
          type: { type: 'string', description: 'Node type filter: FUNCTION, CLASS, MODULE, STRUCT, VARIABLE, CALL, etc.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'graph_callers',
      description: 'Find all callers of a function/method. Returns call sites with file:line.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Function or method name' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'graph_file_overview',
      description: 'Get overview of a file: all functions, classes, imports, exports with line numbers. Use instead of reading entire file.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'File path (relative, e.g. packages/rfdb-server/src/gc.rs)' },
        },
        required: ['file'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read raw source code from a file. Use graph_file_overview first to find what you need, then read_file for specific sections.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from project root' },
          offset: { type: 'number', description: 'Start line (0-based)' },
          limit: { type: 'number', description: 'Max lines to read (default 200)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search for a pattern in files. Returns matching lines with file:line prefix.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern (regex)' },
          path: { type: 'string', description: 'Directory or file to search in (default: packages/)' },
          max_results: { type: 'number', description: 'Max results (default 20)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files matching a pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'File name pattern (glob)' },
          path: { type: 'string', description: 'Directory to search in (default: packages/)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files in a directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_verdict',
      description: 'Submit your final verdict on the hypothesis.',
      parameters: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unclear'] },
          evidence: { type: 'string', description: 'Specific evidence (file:line references)' },
          confidence: { type: 'number', description: '0.0-1.0 confidence in verdict' },
          notes: { type: 'string', description: 'Additional observations' },
        },
        required: ['verdict', 'evidence', 'confidence'],
      },
    },
  },
];

function graphQuery(cmd, queryArgs) {
  try {
    const argsJson = JSON.stringify(queryArgs).replace(/'/g, "'\\''");
    const script = `
      const { RFDBServerBackend } = require('${PROJECT_ROOT}/packages/util/dist/index.js');
      (async () => {
        const backend = new RFDBServerBackend('${GRAFEMA_SOCKET}');
        await backend.connect();
        ${cmd}
        await backend.close();
      })().catch(e => { console.error(e.message); process.exit(1); });
    `;
    return execSync(`node -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
      encoding: 'utf-8', timeout: 15000, cwd: PROJECT_ROOT,
    }).trim();
  } catch (e) {
    return `Graph query error: ${e.message?.slice(0, 200) || e}`;
  }
}

function executeTool(name, args) {
  try {
    switch (name) {
      case 'graph_find': {
        const typeFilter = args.type ? `--type ${args.type}` : '';
        const cmd = `node ${PROJECT_ROOT}/packages/cli/dist/cli.js query "find_nodes(name=\\"${args.name}\\"${args.type ? `, type=\\"${args.type}\\"` : ''})" --project ${PROJECT_ROOT} 2>/dev/null | head -30`;
        try {
          return execSync(cmd, { encoding: 'utf-8', timeout: 15000 }).trim() || 'No nodes found';
        } catch {
          const grepCmd = `grep -rn "${args.name}" "${PROJECT_ROOT}/packages/" --include="*.rs" --include="*.ts" --include="*.hs" 2>/dev/null | head -15`;
          return execSync(grepCmd, { encoding: 'utf-8', timeout: 10000 }).trim() || 'No matches';
        }
      }
      case 'graph_callers': {
        const grepCmd = `grep -rn "${args.name}" "${PROJECT_ROOT}/packages/" --include="*.rs" --include="*.ts" --include="*.hs" 2>/dev/null | grep -v "^.*:.*fn ${args.name}\\|^.*:.*function ${args.name}\\|^.*:.*def ${args.name}" | head -20`;
        return execSync(grepCmd, { encoding: 'utf-8', timeout: 10000 }).trim() || 'No callers found';
      }
      case 'graph_file_overview': {
        const grepCmd = `grep -n "^pub fn\\|^fn\\|^pub struct\\|^struct\\|^pub enum\\|^enum\\|^pub trait\\|^impl\\|^export function\\|^export class\\|^export const\\|^export interface\\|^export async" "${PROJECT_ROOT}/${args.file}" 2>/dev/null | head -40`;
        return execSync(grepCmd, { encoding: 'utf-8', timeout: 5000 }).trim() || 'File not found or empty';
      }
      case 'read_file': {
        const fullPath = `${PROJECT_ROOT}/${args.path}`;
        if (!existsSync(fullPath)) return `File not found: ${args.path}`;
        if (!fullPath.startsWith(PROJECT_ROOT)) return 'Access denied: path outside project';
        const content = readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        const offset = args.offset || 0;
        const limit = args.limit || 200;
        return lines.slice(offset, offset + limit).map((l, i) => `${offset + i + 1}\t${l}`).join('\n');
      }
      case 'grep': {
        const searchPath = `${PROJECT_ROOT}/${args.path || 'packages/'}`;
        const maxResults = args.max_results || 20;
        const cmd = `grep -rn "${args.pattern.replace(/"/g, '\\"')}" "${searchPath}" --include="*.ts" --include="*.rs" --include="*.hs" --include="*.yaml" 2>/dev/null | head -${maxResults}`;
        return execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim() || 'No matches';
      }
      case 'find_files': {
        const searchPath = `${PROJECT_ROOT}/${args.path || 'packages/'}`;
        const cmd = `find "${searchPath}" -name "${args.pattern}" -not -path "*/node_modules/*" -not -path "*/dist/*" 2>/dev/null | head -20`;
        return execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim() || 'No files found';
      }
      case 'list_dir': {
        const fullPath = `${PROJECT_ROOT}/${args.path}`;
        const cmd = `ls -la "${fullPath}" 2>/dev/null | head -30`;
        return execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim() || 'Directory not found';
      }
      case 'submit_verdict':
        return JSON.stringify(args);
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

async function ollamaChat(messages) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      stream: false,
      options: { temperature: 0.3, num_predict: 4000 },
    }),
  });
  return res.json();
}

async function verify() {
  const messages = [
    {
      role: 'system',
      content: `/no_think
You are a software architecture verification agent for the Grafema project (code→graph tool).

TOOL PRIORITY (use in this order):
1. graph_find — find code entities by name (fastest, most accurate)
2. graph_file_overview — see all functions/structs in a file
3. grep — text search when graph tools miss
4. read_file — read specific lines when you know what to look for

After gathering evidence, call submit_verdict.

Rules:
- Start with graph_find to locate entities, not grep
- Cite specific file:line as evidence
- You have up to 8 tool calls. If still unclear after that, submit "unclear" with what you found so far
- When graph_file_overview shows functions, use read_file to check specific implementations
- Never guess — only report what you can verify from source
- The project root has packages/ with: rfdb-server (Rust), grafema-orchestrator (Rust), cli (TS), mcp (TS), util (TS), js-analyzer (Haskell)
- IMPORTANT: when looking for a symbol, use grep across ALL packages first (path="packages/"), don't guess which package it's in`,
    },
    {
      role: 'user',
      content: `Verify this hypothesis about the Grafema project:\n\n"${hypothesis}"\n\nUse the tools to examine source code and submit your verdict.`,
    },
  ];

  let verdict = null;
  let iterations = 0;
  const MAX_ITERATIONS = 8;

  while (!verdict && iterations < MAX_ITERATIONS) {
    iterations++;
    const response = await ollamaChat(messages);
    const msg = response.message;

    if (!msg) {
      console.error('Empty response from Ollama');
      break;
    }

    messages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const call of msg.tool_calls) {
        const toolName = call.function.name;
        const toolArgs = call.function.arguments;
        process.stderr.write(`  [${iterations}] ${toolName}(${JSON.stringify(toolArgs).slice(0, 100)})\n`);

        const result = executeTool(toolName, toolArgs);

        if (toolName === 'submit_verdict') {
          verdict = JSON.parse(result);
        }

        messages.push({ role: 'tool', content: result });
      }
    } else if (msg.content) {
      process.stderr.write(`  [${iterations}] thinking: ${msg.content.slice(0, 100)}\n`);
    } else {
      break;
    }
  }

  if (!verdict) {
    verdict = { verdict: 'unclear', evidence: 'Agent did not submit verdict', confidence: 0, notes: `Exhausted ${iterations} iterations` };
  }

  console.log(JSON.stringify(verdict, null, 2));
}

verify().catch(e => {
  console.error(e);
  process.exit(1);
});
