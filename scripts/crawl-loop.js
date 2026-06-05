#!/usr/bin/env node
/**
 * Autonomous Ontological Crawl Loop
 *
 * Generates hypotheses via Ollama, verifies them via a separate Ollama agent
 * with read-only tools, outputs verified findings as JSONL for ingestion
 * into Enox knowledge graph.
 *
 * Usage:
 *   node scripts/crawl-loop.js --entity "compactionEnricher" --context "TypeScript enricher..."
 *   node scripts/crawl-loop.js --backlog .grafema/crawl-backlog.json
 *
 * Output: JSONL to stdout, each line:
 *   {"entity":"...","hypothesis":"...","verdict":"confirmed|refuted|unclear","evidence":"...","confidence":0.9,"type":"DEP|FRAGILE|CONCEPT"}
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const GEN_MODEL = process.env.GEN_MODEL || 'qwen3.6:35b';
const VERIFY_MODEL = process.env.VERIFY_MODEL || 'qwen3.6:35b';
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();

const args = process.argv.slice(2);
const entityIdx = args.indexOf('--entity');
const contextIdx = args.indexOf('--context');

const entity = entityIdx >= 0 ? args[entityIdx + 1] : null;
const context = contextIdx >= 0 ? args[contextIdx + 1] : '';

if (!entity) {
  console.error('Usage: node scripts/crawl-loop.js --entity "name" --context "description"');
  process.exit(1);
}

async function generateHypotheses(entity, context) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GEN_MODEL,
      prompt: `/no_think
Architecture mapping of Grafema (code→graph tool).

Entity: ${entity}
Context: ${context}

Generate exactly 5 hypotheses about this entity:
Format: TYPE|HYPOTHESIS
Types: DEP (dependency), FRAGILE (fragility), CONCEPT (CS concept), UNEXPECTED (surprise), PATTERN (convention)

One per line, no numbering, no extra text.`,
      stream: false,
      options: { temperature: 0.7, num_predict: 4000 },
    }),
  });
  const data = await res.json();
  const lines = (data.response || '').split('\n').filter(l => l.includes('|'));
  return lines.map(l => {
    const [type, ...rest] = l.split('|');
    return { type: type.trim(), hypothesis: rest.join('|').trim() };
  }).filter(h => h.hypothesis);
}

async function verifyHypothesis(hypothesis) {
  const useHaiku = process.env.VERIFY_WITH_HAIKU === '1' || VERIFY_MODEL === 'haiku';
  try {
    let result;
    if (useHaiku) {
      result = execSync(
        `${PROJECT_ROOT}/scripts/crawl-verify-haiku.sh ${JSON.stringify(hypothesis)}`,
        { encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } else {
      result = execSync(
        `node ${PROJECT_ROOT}/scripts/crawl-verify.js ${JSON.stringify(hypothesis)} --model ${VERIFY_MODEL}`,
        { encoding: 'utf-8', timeout: 180000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    }
    return JSON.parse(result.trim());
  } catch (e) {
    return { verdict: 'unclear', evidence: `Verification failed: ${e.message?.slice(0, 200)}`, confidence: 0 };
  }
}

async function crawlEntity() {
  process.stderr.write(`\n=== Crawling: ${entity} ===\n`);

  process.stderr.write(`Generating hypotheses via ${GEN_MODEL}...\n`);
  const hypotheses = await generateHypotheses(entity, context);
  process.stderr.write(`Generated ${hypotheses.length} hypotheses\n`);

  for (const h of hypotheses) {
    process.stderr.write(`\n  [${h.type}] ${h.hypothesis.slice(0, 80)}...\n`);
    process.stderr.write(`  Verifying via ${VERIFY_MODEL}...\n`);

    const verdict = await verifyHypothesis(h.hypothesis);
    process.stderr.write(`  → ${verdict.verdict} (conf: ${verdict.confidence})\n`);

    const result = {
      entity,
      type: h.type,
      hypothesis: h.hypothesis,
      ...verdict,
    };

    console.log(JSON.stringify(result));
  }

  process.stderr.write(`\n=== Done: ${entity} ===\n`);
}

crawlEntity().catch(e => {
  console.error(e);
  process.exit(1);
});
