#!/usr/bin/env node --input-type=module
/**
 * Extract structured knowledge from Claude Code session logs.
 *
 * Reads JSONL session files, extracts user+assistant messages,
 * sends to Haiku for entity extraction across 12 projections.
 *
 * Output: JSONL with extracted entities and relations.
 *
 * Usage:
 *   node --input-type=module scripts/extract-session-knowledge.js <session.jsonl>
 *   node --input-type=module scripts/extract-session-knowledge.js --recent 5
 *   node --input-type=module scripts/extract-session-knowledge.js --all
 */

import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';

const PROJECT = '/Users/vadimr/grafema';
const SESSIONS_DIR = `${process.env.HOME}/.claude/projects/-Users-vadimr-grafema`;
const OUTPUT = `${PROJECT}/.grafema/session-knowledge.jsonl`;
const MODEL = 'claude-haiku-4-5-20251001';

let API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  try {
    const match = readFileSync(`${process.env.HOME}/providers/keys.env`, 'utf-8').match(/ANTHROPIC=(.+)/);
    if (match) API_KEY = match[1].trim();
  } catch {}
}

const EXTRACTION_PROMPT = `You extract structured knowledge from a Claude Code work session transcript.

Extract entities and relations that represent NON-OBVIOUS knowledge — things you can't derive by reading the code:

ENTITY TYPES TO EXTRACT:
- DECISION: architectural choice with rationale ("chose X because Y")
- TASK: work item discussed/completed (with REG-/RFD- IDs if mentioned)
- INCIDENT: something went wrong, root cause, fix
- PATTERN: discovered convention or anti-pattern
- ANOMALY: unexpected finding about the codebase
- CONSTRAINT: discovered limitation or requirement
- HYPOTHESIS: theory proposed but not fully verified
- PIVOT: moment where approach fundamentally changed
- DEBT: technical debt acknowledged
- INSIGHT: non-obvious understanding gained

RELATION TYPES:
- caused_by, resulted_in, motivated, blocked_by, supersedes
- depends_on, enables, contradicts, validates
- relates_to (generic fallback)

For each extracted entity, include:
- type: one of the types above
- name: short descriptive name (3-8 words)
- content: full description (1-3 sentences)
- projection: which of the 12 projections it belongs to:
  semantic, operational, causal, contractual, intentional,
  organizational, temporal, epistemic, security, financial,
  behavioral, risk
- confidence: 0.0-1.0
- relations: [{to: "entity name", type: "relation_type"}]

Output as JSON array. Extract 5-15 entities per session chunk.
DO NOT extract: code structure facts, file paths, function names (those are in the code graph).
DO extract: WHY decisions were made, WHAT went wrong, HOW approaches evolved.`;

function extractMessages(jsonlPath) {
  const messages = [];
  for (const line of readFileSync(jsonlPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      const msg = entry.message;
      if (!msg || !msg.content) continue;

      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');
      }

      if (text.length > 20) {
        messages.push({ role: msg.role || entry.type, text: text.slice(0, 2000) });
      }
    } catch {}
  }
  return messages;
}

function chunkMessages(messages, maxChars = 15000) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const msg of messages) {
    if (currentLen + msg.text.length > maxChars && current.length > 0) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(msg);
    currentLen += msg.text.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function extractFromChunk(chunk, sessionId) {
  const transcript = chunk.map(m => `[${m.role}]: ${m.text}`).join('\n\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: `${EXTRACTION_PROMPT}\n\n---\nSESSION TRANSCRIPT:\n\n${transcript}` }],
    }),
  });

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const entities = JSON.parse(jsonMatch[0]);
      return entities.map(e => ({
        ...e,
        session_id: sessionId,
        extracted_at: new Date().toISOString(),
      }));
    }
  } catch {}
  return [];
}

async function processSession(sessionPath) {
  const sessionId = basename(sessionPath, '.jsonl');
  const messages = extractMessages(sessionPath);

  if (messages.length < 5) {
    console.error(`  Skip ${sessionId}: only ${messages.length} messages`);
    return 0;
  }

  const chunks = chunkMessages(messages);
  console.error(`  ${sessionId}: ${messages.length} messages, ${chunks.length} chunks`);

  let totalEntities = 0;
  for (let i = 0; i < chunks.length; i++) {
    const entities = await extractFromChunk(chunks[i], sessionId);
    for (const entity of entities) {
      appendFileSync(OUTPUT, JSON.stringify(entity) + '\n');
      totalEntities++;
    }
    if (entities.length > 0) {
      console.error(`    chunk ${i + 1}/${chunks.length}: ${entities.length} entities`);
    }
  }
  return totalEntities;
}

async function main() {
  const args = process.argv.slice(2);

  if (!API_KEY) {
    console.error('No ANTHROPIC_API_KEY');
    process.exit(1);
  }

  let sessionFiles = [];

  if (args[0] === '--recent') {
    const n = parseInt(args[1]) || 5;
    const all = readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: statSync(join(SESSIONS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, n);
    sessionFiles = all.map(f => join(SESSIONS_DIR, f.name));
  } else if (args[0] === '--all') {
    sessionFiles = readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => join(SESSIONS_DIR, f))
      .filter(f => statSync(f).size > 100000);
  } else if (args[0]) {
    sessionFiles = [args[0]];
  } else {
    console.error('Usage: node --input-type=module scripts/extract-session-knowledge.js [--recent N | --all | <file>]');
    process.exit(1);
  }

  console.error(`Processing ${sessionFiles.length} sessions...`);
  let total = 0;

  for (const f of sessionFiles) {
    const n = await processSession(f);
    total += n;
  }

  console.error(`\nDone. ${total} entities extracted to ${OUTPUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
