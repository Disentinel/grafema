/**
 * Extract structured knowledge from Claude Code session logs.
 *
 * Reads JSONL session files, extracts user+assistant messages,
 * sends to Haiku for entity extraction.
 *
 * Usage:
 *   node scripts/extract-session-knowledge.mjs <session.jsonl>
 *   node scripts/extract-session-knowledge.mjs --recent 5
 *   node scripts/extract-session-knowledge.mjs --all
 */

import { readFileSync, appendFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';

const PROJECT = process.env.GRAFEMA_PROJECT || process.cwd();
const SESSIONS_DIR = `${process.env.HOME}/.claude/projects/-Users-vadimr-grafema`;
const OUTPUT = process.env.EXTRACTION_OUTPUT || `${PROJECT}/.grafema/session-knowledge.jsonl`;
const MODEL = 'claude-haiku-4-5-20251001';

let API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  try {
    const match = readFileSync(`${process.env.HOME}/providers/keys.env`, 'utf-8').match(/ANTHROPIC=(.+)/);
    if (match) API_KEY = match[1].trim();
  } catch {}
}

const EXTRACTION_PROMPT = `You extract structured knowledge from a Claude Code work session transcript.

Extract ONLY non-obvious knowledge — things you cannot derive by reading the code or git history.

ENTITY TYPES (strict — use only these):
- DECISION: architectural choice with explicit rationale ("chose X because Y")
- INCIDENT: something broke, root cause identified, fix applied
- PIVOT: moment where approach fundamentally changed direction
- REJECTED_ALTERNATIVE: option considered and deliberately rejected (with reason)
- COGNITIVE_DEBT: known gap in understanding that affects future work
- CONTRADICTION: two findings or decisions that conflict with each other

DO NOT EXTRACT:
- Code structure facts, file paths, function names (those are in the code graph)
- Task completions ("implemented X", "added Y") — that's in git history
- Debugging steps without a conclusion
- Routine operations (build, test, deploy)

CRITICAL RULES:
1. DO NOT assert what the user did outside the terminal (browser testing, manual checks, external conversations). You can only see terminal activity.
2. If you suspect the user took an action you cannot verify, mark it as type "QUESTION" with confidence 0.5 and phrase as a question: "Did the user verify X in browser?"
3. Every entity MUST have evidence from the transcript — quote or paraphrase the specific exchange.
4. Confidence: 1.0 = explicit in transcript, 0.7 = strongly implied, 0.5 = inferred/uncertain.

For each entity:
- type: one of the types above
- name: short descriptive name (3-8 words)
- content: full description (1-3 sentences) with evidence from transcript
- projection: semantic|operational|causal|contractual|intentional|organizational|temporal|epistemic|security|financial|behavioral|risk
- confidence: 0.0-1.0
- relations: [{to: "entity name", type: "relation_type"}]

Relation types: caused_by, resulted_in, motivated, blocked_by, supersedes, depends_on, enables, contradicts, validates, relates_to

Output as JSON array. Quality over quantity — 3 solid entities beat 15 weak ones.`;

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
        const parts = [];
        for (const c of msg.content) {
          if (c.type === 'text') parts.push(c.text);
          else if (c.type === 'tool_use') {
            const inp = typeof c.input === 'string' ? c.input : JSON.stringify(c.input || '');
            parts.push(`[tool:${c.name}] ${inp.slice(0, 200)}`);
          }
          else if (c.type === 'tool_result') {
            const r = Array.isArray(c.content) ? c.content.filter(x => x.type === 'text').map(x => x.text).join('\n') : String(c.content || '');
            if (r.length > 20) parts.push(`[result] ${r.slice(0, 300)}`);
          }
        }
        text = parts.join('\n');
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
