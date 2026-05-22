#!/usr/bin/env node
/**
 * Verification agent using Anthropic API directly (Haiku).
 * Faster than claude -p (no CLI startup overhead).
 * Supports tool_use natively.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... node scripts/crawl-verify-api.js "hypothesis"
 *
 * Reads API key from ANTHROPIC_API_KEY env or ~/providers/keys.env
 */

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const PROJECT_ROOT = '/Users/vadimr/grafema';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TURNS = 6;

let API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  const keysFile = `${process.env.HOME}/providers/keys.env`;
  if (existsSync(keysFile)) {
    const match = readFileSync(keysFile, 'utf-8').match(/ANTHROPIC=(.+)/);
    if (match) API_KEY = match[1].trim();
  }
}
if (!API_KEY) { console.error('No ANTHROPIC_API_KEY'); process.exit(1); }

const hypothesis = process.argv[2];
if (!hypothesis) { console.error('Usage: node crawl-verify-api.js "hypothesis"'); process.exit(1); }

const tools = [
  {
    name: 'grep_code',
    description: 'Search for a pattern in source files. Returns matching lines with file:line prefix.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern' },
        path: { type: 'string', description: 'Subdirectory to search (default: packages/)' },
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
    description: 'List all function/struct/class definitions in a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
      },
      required: ['path'],
    },
  },
];

function executeTool(name, input) {
  try {
    switch (name) {
      case 'grep_code': {
        const p = `${PROJECT_ROOT}/${input.path || 'packages/'}`;
        const cmd = `grep -rn "${input.pattern.replace(/"/g, '\\"')}" "${p}" --include="*.ts" --include="*.rs" --include="*.hs" --include="*.yaml" --include="*.cabal" 2>/dev/null | head -20`;
        return execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim() || 'No matches';
      }
      case 'read_file': {
        const full = `${PROJECT_ROOT}/${input.path}`;
        if (!existsSync(full)) return `File not found: ${input.path}`;
        const lines = readFileSync(full, 'utf-8').split('\n');
        const start = (input.start_line || 1) - 1;
        const end = input.end_line || Math.min(start + 100, lines.length);
        return lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join('\n');
      }
      case 'file_overview': {
        const full = `${PROJECT_ROOT}/${input.path}`;
        const cmd = `grep -n "^pub fn\\|^fn\\|^pub struct\\|^struct\\|^pub enum\\|^impl\\|^pub trait\\|^export function\\|^export class\\|^export const\\|^export async\\|^export interface" "${full}" 2>/dev/null | head -40`;
        return execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim() || 'No definitions found';
      }
    }
  } catch (e) { return `Error: ${e.message?.slice(0, 200)}`; }
}

async function callAPI(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      tools,
      messages,
      system: `You verify hypotheses about the Grafema codebase by examining source code.
Tools: grep_code (search), read_file (read lines), file_overview (list definitions).
Start with grep_code to find relevant files, then read_file for details.
After gathering evidence, respond with a JSON verdict:
{"verdict":"confirmed|refuted|unclear","evidence":"file:line","confidence":0.0-1.0,"notes":"..."}
Output ONLY the JSON.`,
    }),
  });
  return res.json();
}

async function verify() {
  const messages = [
    { role: 'user', content: `Verify: "${hypothesis}"` },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await callAPI(messages);

    if (response.error) {
      console.log(JSON.stringify({ verdict: 'unclear', evidence: `API error: ${response.error.message}`, confidence: 0 }));
      return;
    }

    const content = response.content || [];
    messages.push({ role: 'assistant', content });

    const toolUses = content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = content.find(b => b.type === 'text')?.text || '';
      const jsonMatch = text.match(/\{[^}]*"verdict"[^}]*\}/);
      if (jsonMatch) {
        console.log(jsonMatch[0]);
      } else {
        console.log(JSON.stringify({ verdict: 'unclear', evidence: text.slice(0, 200), confidence: 0 }));
      }
      return;
    }

    const toolResults = [];
    for (const tu of toolUses) {
      process.stderr.write(`  [${turn + 1}] ${tu.name}(${JSON.stringify(tu.input).slice(0, 80)})\n`);
      const result = executeTool(tu.name, tu.input);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result.slice(0, 4000) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  console.log(JSON.stringify({ verdict: 'unclear', evidence: 'Max turns exhausted', confidence: 0 }));
}

verify().catch(e => {
  console.log(JSON.stringify({ verdict: 'unclear', evidence: e.message, confidence: 0 }));
});
