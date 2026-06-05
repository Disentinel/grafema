#!/usr/bin/env node
/**
 * Migrate Enox JSONL data into RFDB knowledge database.
 *
 * Usage:
 *   node scripts/migrate-enox-data.js <data-dir> [--socket <path>] [--project <path>]
 *
 * Example:
 *   node scripts/migrate-enox-data.js ~/grafema-cloud/enox/merged --project .
 *
 * Reads nodes.jsonl and edges.jsonl from <data-dir>,
 * loads them into RFDB "knowledge" database in batches.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { RFDBClient } from '../packages/rfdb/dist/client.js';

const args = process.argv.slice(2);
const dataDir = args[0];
if (!dataDir) {
  console.error('Usage: node scripts/migrate-enox-data.js <data-dir> [--socket <path>] [--project <path>]');
  process.exit(1);
}

const socketIdx = args.indexOf('--socket');
const projectIdx = args.indexOf('--project');
const projectPath = projectIdx >= 0 ? args[projectIdx + 1] : '.';

function deriveSocket() {
  if (socketIdx >= 0) return args[socketIdx + 1];
  const dbPath = join(projectPath, '.grafema', 'graph.rfdb');
  const localSocket = join(dirname(dbPath), 'rfdb.sock');
  const SUN_LEN = process.platform === 'darwin' ? 104 : 108;
  if (Buffer.byteLength(localSocket) < SUN_LEN) return localSocket;
  const hash = createHash('md5').update(dirname(dbPath)).digest('hex').slice(0, 12);
  return join('/tmp', `grafema-${hash}.sock`);
}

const socketPath = deriveSocket();
console.log(`Connecting to RFDB at ${socketPath}`);

const client = new RFDBClient(socketPath, 'enox-migrate');
await client.connect();
await client.hello();

try {
  await client.createDatabase('knowledge');
  console.log('Created "knowledge" database');
} catch {
  console.log('"knowledge" database already exists');
}
await client.openDatabase('knowledge', 'rw');

// Clear existing data
await client.clear();
console.log('Cleared existing knowledge data');

// Load nodes
const nodesFile = join(dataDir, 'nodes.jsonl');
const nodesLines = readFileSync(nodesFile, 'utf-8').split('\n').filter(l => l.trim());
console.log(`Loading ${nodesLines.length} nodes...`);

const BATCH_SIZE = 500;
let nodeCount = 0;

for (let i = 0; i < nodesLines.length; i += BATCH_SIZE) {
  const batch = nodesLines.slice(i, i + BATCH_SIZE);
  const nodes = batch.map(line => {
    const obj = JSON.parse(line);
    const id = (obj.id || obj.label || '').toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      id: id || `node-${nodeCount++}`,
      nodeType: (obj.node_type || 'concept').toUpperCase(),
      name: obj.label || obj.id || '',
      file: obj.domain || 'general',
      metadata: JSON.stringify({
        domain: obj.domain || '',
        aliases: obj.aliases || [],
        source_file: obj._source_file || '',
        original_id: obj.id || '',
      }),
    };
  });

  await client.addNodes(nodes);
  nodeCount += batch.length;
  if (nodeCount % 1000 === 0 || i + BATCH_SIZE >= nodesLines.length) {
    process.stdout.write(`\r  Nodes: ${nodeCount}/${nodesLines.length}`);
  }
}
console.log(`\n  ${nodeCount} nodes loaded`);

// Load edges
const edgesFile = join(dataDir, 'edges.jsonl');
const edgesLines = readFileSync(edgesFile, 'utf-8').split('\n').filter(l => l.trim());
console.log(`Loading ${edgesLines.length} edges...`);

let edgeCount = 0;
let skipped = 0;

for (let i = 0; i < edgesLines.length; i += BATCH_SIZE) {
  const batch = edgesLines.slice(i, i + BATCH_SIZE);
  const edges = [];

  for (const line of batch) {
    const obj = JSON.parse(line);
    const from = (obj.from || '').toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    const to = (obj.to || '').toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    const rel = (obj.rel || 'related_to').toUpperCase().replace(/\s+/g, '_');

    if (!from || !to) { skipped++; continue; }

    const factId = createHash('sha256').update(`${from}|${rel}|${to}`).digest('hex');
    edges.push({
      src: from,
      dst: to,
      edgeType: rel,
      metadata: JSON.stringify({
        fact_id: factId,
        confidence: obj.confidence || 0.5,
        note: obj.note || '',
        source: obj.source || '',
        extracted: obj.extracted || '',
        condition: obj.condition || '',
      }),
    });
  }

  if (edges.length > 0) {
    await client.addEdges(edges, true);
  }
  edgeCount += edges.length;
  if (edgeCount % 1000 === 0 || i + BATCH_SIZE >= edgesLines.length) {
    process.stdout.write(`\r  Edges: ${edgeCount}/${edgesLines.length} (skipped: ${skipped})`);
  }
}
console.log(`\n  ${edgeCount} edges loaded, ${skipped} skipped`);

// Flush and compact
console.log('Flushing...');
await client.flush();
console.log('Compacting...');
await client.compact();

// Stats
const stats = await client.getStats();
console.log(`\nDone. Knowledge DB: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);

await client.close();
process.exit(0);
