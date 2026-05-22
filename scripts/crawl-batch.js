#!/usr/bin/env node
/**
 * Batch ontological crawl via Anthropic Batch API.
 *
 * Step 1: Generate hypotheses for all entities (batch)
 * Step 2: Verify all hypotheses (batch, with pre-computed context)
 * Step 3: Output verified JSONL
 *
 * Usage:
 *   node scripts/crawl-batch.js --entities entities.json
 *   node scripts/crawl-batch.js --backlog .grafema/crawl-backlog.json
 *
 * Uses pre-computed context pattern: grep results computed locally,
 * sent to Haiku for interpretation (no tool_use needed in batch).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const PROJECT = '/Users/vadimr/grafema';
const MODEL = 'claude-haiku-4-5-20251001';

let API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  const keysFile = `${process.env.HOME}/providers/keys.env`;
  if (existsSync(keysFile)) {
    const match = readFileSync(keysFile, 'utf-8').match(/ANTHROPIC=(.+)/);
    if (match) API_KEY = match[1].trim();
  }
}
if (!API_KEY) { console.error('No ANTHROPIC_API_KEY'); process.exit(1); }

// --- Load entities ---
const args = process.argv.slice(2);
let entities = [];

const backlogIdx = args.indexOf('--backlog');
if (backlogIdx >= 0) {
  const backlog = JSON.parse(readFileSync(args[backlogIdx + 1], 'utf-8'));
  entities = backlog.queue.filter(e => e.status === 'inbox');
} else {
  // Default: remaining entities
  entities = [
    { entity: 'SegmentWriter', context: 'Rust module rfdb-server/src/storage_v2/writer.rs. Serializes nodes/edges into immutable .seg files. Builds bloom filters zone maps string tables.' },
    { entity: 'ResourceManager', context: 'Rust module rfdb-server/src/storage_v2/resource.rs. Auto-tunes shard count and memory limits based on system RAM and CPU.' },
    { entity: 'session.rs', context: 'Rust module rfdb-server/src/session.rs. Client session state: current database, access mode, protocol version.' },
    { entity: 'deletion.rs', context: 'Rust module rfdb-server/src/deletion.rs. Handles node and edge deletion via tombstoning in V2 storage.' },
    { entity: 'Expressions.hs', context: 'Haskell Rules module packages/js-analyzer/src/Rules/Expressions.hs. Handles expression-level AST: function calls, member access, assignments, binary ops. Emits CALL, PROPERTY_ACCESS, ASSIGNED_FROM.' },
    { entity: 'Declarations.hs', context: 'Haskell Rules module packages/js-analyzer/src/Rules/Declarations.hs. Handles declaration-level AST: functions, classes, variables, imports, exports. Emits FUNCTION, CLASS, VARIABLE, IMPORT nodes.' },
    { entity: 'specedContractEnricher', context: 'TypeScript enricher packages/util/src/enrichers/specedContractEnricher.ts. Validates contracts against effects-db specifications. Checks inputs match declared args.' },
    { entity: 'mcpToolDefinitionEnricher', context: 'TypeScript enricher packages/util/src/enrichers/mcpToolDefinitionEnricher.ts. Detects MCP tool definitions from source code patterns. Creates mcp:tool domain nodes.' },
    { entity: 'packageApiEnricher', context: 'TypeScript enricher packages/util/src/enrichers/packageApiEnricher.ts. Identifies package public API surface from EXPORT_BINDING nodes.' },
    { entity: 'GraphFreshnessChecker', context: 'TypeScript class packages/util/src/core/GraphFreshnessChecker.ts. Validates whether code graph is stale relative to source files. Used by CLI/MCP before querying.' },
    { entity: 'container_hierarchy.rs', context: 'Rust module rfdb-server/src/container_hierarchy.rs. Builds hierarchical directory structure from flat file paths for visualization layout.' },
    { entity: 'hulls.rs', context: 'Rust module rfdb-server/src/hulls.rs. Computes convex hull boundaries around hex grid regions for visualization.' },
  ];
}

console.error(`Processing ${entities.length} entities`);

// --- Step 1: Pre-compute context for each entity ---
function precomputeContext(entity, context) {
  const name = entity.replace(/\.[a-z]+$/i, ''); // strip extension
  let evidence = '';
  try {
    const grep = execSync(
      `grep -rn "${name}" "${PROJECT}/packages/" --include="*.rs" --include="*.ts" --include="*.hs" 2>/dev/null | head -15`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    evidence += `\n=== grep "${name}" ===\n${grep}`;
  } catch {}

  // Try to find the main file and get overview
  try {
    const find = execSync(
      `find "${PROJECT}/packages/" -name "${entity}" -o -name "${name}.rs" -o -name "${name}.ts" -o -name "${name}.hs" 2>/dev/null | head -3`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    if (find) {
      const mainFile = find.split('\n')[0];
      const overview = execSync(
        `grep -n "^pub fn\\|^fn\\|^pub struct\\|^struct\\|^pub enum\\|^impl\\|^pub trait\\|^export function\\|^export class\\|^export const\\|^export async\\|^export interface" "${mainFile}" 2>/dev/null | head -30`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      if (overview) evidence += `\n=== File overview: ${mainFile.replace(PROJECT+'/', '')} ===\n${overview}`;
    }
  } catch {}

  return evidence;
}

// --- Step 2: Create batch requests ---
const requests = [];

for (const ent of entities) {
  const name = ent.entity;
  const ctx = ent.context;
  const evidence = precomputeContext(name, ctx);

  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');

  // Generation request
  requests.push({
    custom_id: `gen-${safeName}`,
    params: {
      model: MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are mapping the architecture of Grafema (code→graph tool).

Entity: ${name}
Context: ${ctx}

Pre-computed evidence from codebase:
${evidence}

Generate exactly 5 hypotheses about this entity.
Format: TYPE|HYPOTHESIS
Types: DEP (dependency), FRAGILE (fragility), CONCEPT (CS concept), UNEXPECTED (surprise), PATTERN (convention)
One per line, no numbering, no extra text.`,
      }],
    },
  });

  // Verification requests (we'll create these after gen results come back)
  // For now, create self-contained verify requests with pre-computed context
  const hypotheses = [
    `${name} depends on a specific serialization format that creates coupling`,
    `${name} has a fragility related to concurrent access or state management`,
    `${name} implements a well-known CS pattern or data structure concept`,
    `${name} has an unexpected architectural property not obvious from its name`,
    `${name} follows a project-wide convention shared with other similar components`,
  ];

  for (let i = 0; i < hypotheses.length; i++) {
    requests.push({
      custom_id: `verify-${safeName}-${i}`,
      params: {
        model: MODEL,
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `Verify this hypothesis about the Grafema codebase entity "${name}":

Hypothesis: "${hypotheses[i]}"

Context: ${ctx}

Pre-computed evidence from codebase:
${evidence}

Based on the evidence above, output a single JSON:
{"verdict":"confirmed|refuted|unclear","evidence":"specific file:line","confidence":0.0-1.0,"notes":"explanation"}`,
        }],
      },
    });
  }
}

console.error(`Created ${requests.length} batch requests (${entities.length} gen + ${entities.length * 5} verify)`);

// --- Step 3: Submit batch ---
async function submitBatch() {
  // Write JSONL request file
  const jsonl = requests.map(r => JSON.stringify(r)).join('\n');
  const requestFile = '/tmp/crawl-batch-requests.jsonl';
  writeFileSync(requestFile, jsonl);
  console.error(`Wrote ${requestFile} (${requests.length} requests)`);

  // Upload file
  const uploadRes = await fetch('https://api.anthropic.com/v1/files', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'message-batches-2024-09-24',
    },
    body: (() => {
      const form = new FormData();
      form.append('purpose', 'batch');
      form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'requests.jsonl');
      return form;
    })(),
  });

  if (!uploadRes.ok) {
    // Fallback: use inline requests
    console.error('File upload failed, using direct batch creation...');

    const batchRes = await fetch('https://api.anthropic.com/v1/messages/batches', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'message-batches-2024-09-24',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ requests }),
    });

    const batch = await batchRes.json();
    if (batch.error) {
      console.error('Batch creation failed:', JSON.stringify(batch.error));
      process.exit(1);
    }
    console.error(`Batch created: ${batch.id} (${batch.request_counts?.total || '?'} requests)`);
    console.log(JSON.stringify(batch, null, 2));
    return batch;
  }

  const file = await uploadRes.json();
  console.error(`Uploaded file: ${file.id}`);

  // Create batch from file
  const batchRes = await fetch('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'message-batches-2024-09-24',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ file_id: file.id }),
  });

  const batch = await batchRes.json();
  console.error(`Batch created: ${batch.id}`);
  console.log(JSON.stringify(batch, null, 2));
  return batch;
}

const batch = await submitBatch();
console.error(`\nBatch ID: ${batch.id}`);
console.error(`Status: ${batch.processing_status}`);
console.error(`\nPoll with: curl -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" -H "anthropic-beta: message-batches-2024-09-24" https://api.anthropic.com/v1/messages/batches/${batch.id}`);
