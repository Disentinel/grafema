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
const PROJECT_ROOT = process.env.PROJECT_ROOT || '/Users/vadimr/grafema';

const hypothesis = process.argv[2];
if (!hypothesis) {
  console.error('Usage: node scripts/crawl-verify.js "hypothesis text" [--model MODEL]');
  process.exit(1);
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the project. Returns first 200 lines.',
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

function executeTool(name, args) {
  try {
    switch (name) {
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
You are a software architecture verification agent. Your job is to verify or refute a hypothesis about the Grafema codebase by examining source code.

You have read-only tools: read_file, grep, find_files, list_dir.
Use them to find evidence. Then call submit_verdict with your conclusion.

Rules:
- ONLY look at code, not documentation or comments
- Cite specific file:line as evidence
- If you can't find evidence after 3 tool calls, submit "unclear"
- Never guess — only report what you can verify from source`,
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
