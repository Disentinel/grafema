#!/usr/bin/env node
/**
 * Load Enox knowledge graph (v3 extraction) into RFDB.
 *
 * Nodes: entities from papers (methods, models, datasets, concepts...)
 * Edges: decision-support relations (outperforms, fails_on, extends, etc.)
 *
 * Usage:
 *   node enox/load-to-rfdb.js [--db-path /path/to/enox.rfdb]
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';

// Dynamic import of @grafema/util (built package)
const { RFDBServerBackend } = await import(
  resolve(import.meta.dirname, '../packages/util/dist/index.js')
);

const dataDir = join(import.meta.dirname, 'data');

// Parse args
const args = process.argv.slice(2);
const dbPathIdx = args.indexOf('--db-path');
const dbPath = dbPathIdx >= 0
  ? args[dbPathIdx + 1]
  : join(import.meta.dirname, 'enox-knowledge.rfdb');

console.log(`=== Enox → RFDB Loader ===`);
console.log(`DB path: ${dbPath}`);

// 1. Collect all v3 raw extraction files
const { readdirSync } = await import('fs');
const rawFiles = readdirSync(dataDir).filter(f => f.startsWith('v3-raw-batch'));
console.log(`Found ${rawFiles.length} v3 extraction files`);

// 2. Parse all extractions, normalize field names, deduplicate
const entityMap = new Map();  // name → entity
const edges = [];

for (const f of rawFiles) {
  const lines = readFileSync(join(dataDir, f), 'utf-8')
    .split('\n').filter(l => l.trim());

  for (const line of lines) {
    const record = JSON.parse(line);
    const arxivId = record.arxiv_id;

    // Add paper node
    entityMap.set(`paper:${arxivId}`, {
      id: `paper:${arxivId}`,
      nodeType: 'PAPER',
      name: record.title,
      file: `arxiv:${arxivId}`,
      arxiv_id: arxivId,
    });

    // Add entity nodes (handle both {name:...} and {id:...} formats)
    for (const ent of (record.entities || [])) {
      const entName = ent.name || ent.id || '';
      if (!entName) continue;
      const key = entName.toLowerCase().trim();
      if (!entityMap.has(key)) {
        entityMap.set(key, {
          id: `enox:${ent.type || 'concept'}/${key.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
          nodeType: (ent.type || 'concept').toUpperCase(),
          name: entName,
          entity_type: ent.type || 'concept',
        });
      }
    }

    // Add edges (normalize from/rel/to vs source/relation/target)
    for (const rel of (record.relations || [])) {
      const fromName = (rel.from || rel.source || '').toLowerCase().trim();
      const toName = (rel.to || rel.target || '').toLowerCase().trim();
      const relType = (rel.rel || rel.relation || '').toUpperCase().replace(/\s+/g, '_');

      if (!fromName || !toName || !relType) continue;

      // Resolve entity IDs
      const fromEnt = entityMap.get(fromName);
      const toEnt = entityMap.get(toName);

      if (!fromEnt || !toEnt) {
        // Create missing entities on the fly
        if (!fromEnt) {
          entityMap.set(fromName, {
            id: `enox:concept/${fromName.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
            nodeType: 'CONCEPT',
            name: rel.from || rel.source,
            entity_type: 'concept',
          });
        }
        if (!toEnt) {
          entityMap.set(toName, {
            id: `enox:concept/${toName.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
            nodeType: 'CONCEPT',
            name: rel.to || rel.target,
            entity_type: 'concept',
          });
        }
      }

      edges.push({
        src: entityMap.get(fromName).id,
        dst: entityMap.get(toName).id,
        edgeType: relType,
        confidence: rel.confidence || 0.2,
        condition: rel.condition || '',
        note: rel.note || '',
        source_paper: `arxiv:${arxivId}`,
      });
    }
  }
}

const nodes = [...entityMap.values()];

console.log(`\nParsed:`);
console.log(`  Nodes: ${nodes.length} (${nodes.filter(n => n.nodeType === 'PAPER').length} papers + ${nodes.filter(n => n.nodeType !== 'PAPER').length} entities)`);
console.log(`  Edges: ${edges.length}`);

// 3. Deduplicate edges
const edgeKey = (e) => `${e.src}|${e.edgeType}|${e.dst}`;
const uniqueEdges = [...new Map(edges.map(e => [edgeKey(e), e])).values()];
console.log(`  Unique edges: ${uniqueEdges.length} (deduped from ${edges.length})`);

// 4. Print node type distribution
const typeDist = {};
for (const n of nodes) {
  typeDist[n.nodeType] = (typeDist[n.nodeType] || 0) + 1;
}
console.log(`\nNode types:`);
for (const [t, c] of Object.entries(typeDist).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t}: ${c}`);
}

// 5. Print edge type distribution
const edgeDist = {};
for (const e of uniqueEdges) {
  edgeDist[e.edgeType] = (edgeDist[e.edgeType] || 0) + 1;
}
console.log(`\nEdge types:`);
for (const [t, c] of Object.entries(edgeDist).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t}: ${c}`);
}

// 6. Connect to RFDB and load
console.log(`\nConnecting to RFDB...`);
const backend = new RFDBServerBackend({
  dbPath,
  autoStart: true,
});
await backend.connect();
console.log(`Connected. Protocol: ${backend._protocolVersion || 'unknown'}`);

// Load via batch
backend.beginBatch();
for (const node of nodes) {
  backend.batchNode(node);
}
for (const edge of uniqueEdges) {
  backend.batchEdge(edge);
}

const delta = await backend.commitBatch(['enox-v3'], false);
console.log(`\nCommitted:`, JSON.stringify(delta));

// Verify
const nodeCount = await backend.nodeCount();
const edgeCount = await backend.edgeCount();
console.log(`\nVerification: ${nodeCount} nodes, ${edgeCount} edges in RFDB`);

// Show some sample queries
console.log(`\n=== Sample Queries ===`);

const countsByType = await backend.countNodesByType();
console.log(`\nNode counts by type:`, JSON.stringify(countsByType));

// Find DistMult and show its edges
const distmult = nodes.find(n => n.name === 'DistMult');
if (distmult) {
  const outgoing = await backend.getOutgoingEdges(distmult.id);
  const incoming = await backend.getIncomingEdges(distmult.id);
  console.log(`\nDistMult (${distmult.id}):`);
  console.log(`  Outgoing: ${outgoing.length} edges`);
  for (const e of outgoing.slice(0, 10)) {
    const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : (e.metadata || {});
    console.log(`    --[${e.type}]--> ${e.dst} ${meta.condition ? `[${meta.condition}]` : ''}`);
  }
  console.log(`  Incoming: ${incoming.length} edges`);
  for (const e of incoming.slice(0, 10)) {
    const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : (e.metadata || {});
    console.log(`    <--[${e.type}]-- ${e.src} ${meta.condition ? `[${meta.condition}]` : ''}`);
  }
}

// Find all FAILS_ON edges (most valuable)
const allNodes = await backend.getAllNodes();
console.log(`\n=== All FAILS_ON relations (decision-critical) ===`);
for (const n of allNodes) {
  const out = await backend.getOutgoingEdges(n.id);
  for (const e of out) {
    if (e.type === 'FAILS_ON') {
      const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : (e.metadata || {});
      const targetNode = allNodes.find(nn => nn.id === e.dst);
      console.log(`  ${n.name} ⚠️  ${targetNode?.name || e.dst} [${meta.condition || ''}]`);
    }
  }
}

// Cleanup
await backend.close();
console.log(`\nDone. Database: ${dbPath}`);
