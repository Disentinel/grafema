/**
 * Snapshot Coverage Verification (REG-421)
 *
 * Reports which node and edge types are covered by existing snapshot
 * golden files. Useful for identifying gaps in fixture coverage.
 *
 * Usage:
 *   node scripts/verify-snapshot-coverage.js
 *
 * Exit code is always 0 — coverage gaps are informational, not blockers.
 * Some types may only be created by specific domain analyzers not
 * exercised by the current fixture set.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_TYPE, NAMESPACED_TYPE } from '../packages/types/dist/nodes.js';
import { EDGE_TYPE } from '../packages/types/dist/edges.js';

const ALL_NODE_TYPES = [...Object.values(NODE_TYPE), ...Object.values(NAMESPACED_TYPE)];
const ALL_EDGE_TYPES = Object.values(EDGE_TYPE);

const snapshotDir = join(process.cwd(), 'test/snapshots');

let files;
try {
  files = readdirSync(snapshotDir).filter(f => f.endsWith('.json'));
} catch {
  console.log('No snapshot directory found. Run UPDATE_SNAPSHOTS=true to generate golden files.');
  process.exit(0);
}

if (files.length === 0) {
  console.log('No snapshot files found. Run UPDATE_SNAPSHOTS=true to generate golden files.');
  process.exit(0);
}

const coveredNodes = new Set();
const coveredEdges = new Set();

for (const file of files) {
  const snapshot = JSON.parse(readFileSync(join(snapshotDir, file), 'utf-8'));
  for (const node of snapshot.nodes) coveredNodes.add(node.type);
  for (const edge of snapshot.edges) coveredEdges.add(edge.type);
}

const missingNodes = ALL_NODE_TYPES.filter(t => !coveredNodes.has(t));
const missingEdges = ALL_EDGE_TYPES.filter(t => !coveredEdges.has(t));

console.log(`Node types: ${coveredNodes.size}/${ALL_NODE_TYPES.length} covered`);
console.log(`Edge types: ${coveredEdges.size}/${ALL_EDGE_TYPES.length} covered`);

if (missingNodes.length > 0) {
  console.log(`\nMissing node types (${missingNodes.length}):`);
  missingNodes.forEach(t => console.log(`  - ${t}`));
}
if (missingEdges.length > 0) {
  console.log(`\nMissing edge types (${missingEdges.length}):`);
  missingEdges.forEach(t => console.log(`  - ${t}`));
}

process.exit(0);
