/**
 * Load session-knowledge JSONL entities into RFDB knowledge database.
 *
 * Converts DECISION/INCIDENT/PIVOT/etc entities into RFDB nodes + edges.
 * Each entity → 1 node. Relations → edges between nodes.
 *
 * Usage:
 *   node scripts/load-session-knowledge.mjs [--file <path>] [--socket <path>]
 *
 * Default file: .grafema/session-knowledge-v3.jsonl
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { RFDBClient } from '../packages/rfdb/dist/client.js';

const args = process.argv.slice(2);
const fileIdx = args.indexOf('--file');
const socketIdx = args.indexOf('--socket');
const noClear = args.includes('--no-clear');

const inputFile = fileIdx >= 0 ? args[fileIdx + 1] : '.grafema/session-knowledge-v3.jsonl';
const projectPath = '.';

function deriveSocket() {
  if (socketIdx >= 0) return args[socketIdx + 1];
  const dbPath = join(projectPath, '.grafema', 'graph.rfdb');
  const localSocket = join(dirname(dbPath), 'rfdb.sock');
  const SUN_LEN = process.platform === 'darwin' ? 104 : 108;
  if (Buffer.byteLength(localSocket) < SUN_LEN) return localSocket;
  const hash = createHash('md5').update(dirname(dbPath)).digest('hex').slice(0, 12);
  return join('/tmp', `grafema-${hash}.sock`);
}

function entityToNodeId(name) {
  if (!name) return 'unnamed-' + Math.random().toString(36).slice(2, 10);
  return name.toLowerCase().replace(/[^a-z0-9а-яё]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
}

const socketPath = deriveSocket();
console.log(`Connecting to RFDB at ${socketPath}`);
console.log(`Loading from ${inputFile}`);

const client = new RFDBClient(socketPath, 'session-knowledge-loader');
await client.connect();
await client.hello();

try {
  await client.createDatabase('knowledge');
  console.log('Created "knowledge" database');
} catch {
  console.log('"knowledge" database already exists');
}
await client.openDatabase('knowledge', 'rw');

if (!noClear) {
  await client.clear();
  console.log('Cleared existing knowledge data');
}

const lines = readFileSync(inputFile, 'utf-8').split('\n').filter(l => l.trim());
console.log(`${lines.length} entities to load`);

const nodes = [];
const edges = [];
const nodeIds = new Set();

for (const line of lines) {
  const entity = JSON.parse(line);
  const nodeId = entityToNodeId(entity.name);

  if (nodeIds.has(nodeId)) continue;
  nodeIds.add(nodeId);

  nodes.push({
    id: `knowledge->${entity.type}->${nodeId}`,
    nodeType: entity.type,
    name: entity.name,
    file: `session:${(entity.session_id || 'unknown').slice(0, 8)}`,
    metadata: JSON.stringify({
      content: entity.content,
      projection: entity.projection,
      confidence: entity.confidence,
      session_id: entity.session_id,
      extracted_at: entity.extracted_at,
    }),
  });

  if (entity.relations) {
    for (const rel of entity.relations) {
      const targetId = entityToNodeId(rel.to);
      const edgeType = (rel.type || 'relates_to').toUpperCase().replace(/[^A-Z_]/g, '_');
      edges.push({
        src: `knowledge->${entity.type}->${nodeId}`,
        dst: `knowledge->?->${targetId}`,
        edgeType,
        metadata: JSON.stringify({ source: 'session-extraction' }),
      });
    }
  }
}

console.log(`Loading ${nodes.length} nodes...`);
const BATCH = 100;
for (let i = 0; i < nodes.length; i += BATCH) {
  await client.addNodes(nodes.slice(i, i + BATCH));
}

console.log(`Loading ${edges.length} edges...`);
let edgeOk = 0, edgeSkip = 0;
for (let i = 0; i < edges.length; i += BATCH) {
  try {
    await client.addEdges(edges.slice(i, i + BATCH));
    edgeOk += Math.min(BATCH, edges.length - i);
  } catch {
    edgeSkip += Math.min(BATCH, edges.length - i);
  }
}

console.log(`Done: ${nodes.length} nodes, ${edgeOk} edges loaded (${edgeSkip} skipped)`);

await client.close();
