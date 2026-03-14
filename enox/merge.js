#!/usr/bin/env node
/**
 * Merge all cluster JSONL files into unified graph.
 * Deduplicates nodes by id, preserves all edges.
 * Outputs: merged/nodes.jsonl, merged/edges.jsonl, merged/graph.jsonl (combined), merged/stats.json
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const dataDir = join(import.meta.dirname, 'data');
const mergedDir = join(import.meta.dirname, 'merged');

const files = readdirSync(dataDir).filter(f => f.endsWith('.jsonl'));
console.log(`Found ${files.length} cluster files: ${files.join(', ')}`);

const nodesMap = new Map();  // id -> node (dedup)
const edges = [];
const parseErrors = [];
let totalLines = 0;

for (const file of files) {
  const content = readFileSync(join(dataDir, file), 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  console.log(`  ${file}: ${lines.length} lines`);

  for (let i = 0; i < lines.length; i++) {
    totalLines++;
    try {
      const obj = JSON.parse(lines[i]);
      if (obj._type === 'node') {
        if (!nodesMap.has(obj.id)) {
          nodesMap.set(obj.id, { ...obj, _source_file: file });
        }
      } else if (obj._type === 'edge') {
        edges.push({ ...obj, _source_file: file });
      } else {
        parseErrors.push({ file, line: i + 1, error: `Unknown _type: ${obj._type}` });
      }
    } catch (e) {
      parseErrors.push({ file, line: i + 1, error: e.message, raw: lines[i].slice(0, 100) });
    }
  }
}

const nodes = [...nodesMap.values()];
const paperNodes = nodes.filter(n => n.node_type === 'paper');
const conceptNodes = nodes.filter(n => n.node_type === 'concept');

// Validate edges — check that from/to exist as nodes
const nodeIds = new Set(nodes.map(n => n.id));
const danglingEdges = edges.filter(e => !nodeIds.has(e.from) || !nodeIds.has(e.to));
const validEdges = edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));

// Relation type stats
const relCounts = {};
for (const e of edges) {
  relCounts[e.rel] = (relCounts[e.rel] || 0) + 1;
}

// Domain stats
const domainCounts = {};
for (const n of paperNodes) {
  const d = n.domain || 'unknown';
  domainCounts[d] = (domainCounts[d] || 0) + 1;
}

// Cross-cluster edges
const crossCluster = edges.filter(e => {
  const fromNode = nodesMap.get(e.from);
  const toNode = nodesMap.get(e.to);
  return fromNode && toNode && fromNode._source_file !== toNode._source_file;
});

// Write outputs
writeFileSync(
  join(mergedDir, 'nodes.jsonl'),
  nodes.map(n => JSON.stringify(n)).join('\n') + '\n'
);

writeFileSync(
  join(mergedDir, 'edges.jsonl'),
  edges.map(e => JSON.stringify(e)).join('\n') + '\n'
);

writeFileSync(
  join(mergedDir, 'graph.jsonl'),
  [...nodes, ...edges].map(x => JSON.stringify(x)).join('\n') + '\n'
);

const stats = {
  generated: new Date().toISOString(),
  cluster_files: files.length,
  total_lines_parsed: totalLines,
  parse_errors: parseErrors.length,
  nodes_total: nodes.length,
  paper_nodes: paperNodes.length,
  concept_nodes: conceptNodes.length,
  edges_total: edges.length,
  valid_edges: validEdges.length,
  dangling_edges: danglingEdges.length,
  cross_cluster_edges: crossCluster.length,
  relation_types: relCounts,
  domains: domainCounts,
  top_cited_papers: paperNodes
    .filter(p => p.citations_approx)
    .sort((a, b) => (b.citations_approx || 0) - (a.citations_approx || 0))
    .slice(0, 20)
    .map(p => ({ id: p.id, title: p.title, citations: p.citations_approx })),
  errors: parseErrors.slice(0, 20),
};

writeFileSync(join(mergedDir, 'stats.json'), JSON.stringify(stats, null, 2));

console.log('\n=== MERGE STATS ===');
console.log(`Papers: ${paperNodes.length}`);
console.log(`Concepts: ${conceptNodes.length}`);
console.log(`Edges: ${edges.length} (${validEdges.length} valid, ${danglingEdges.length} dangling)`);
console.log(`Cross-cluster edges: ${crossCluster.length}`);
console.log(`Parse errors: ${parseErrors.length}`);
console.log(`\nRelation types:`);
Object.entries(relCounts).sort((a, b) => b[1] - a[1]).forEach(([rel, count]) => {
  console.log(`  ${rel}: ${count}`);
});
console.log(`\nDomains:`);
Object.entries(domainCounts).sort((a, b) => b[1] - a[1]).forEach(([dom, count]) => {
  console.log(`  ${dom}: ${count}`);
});
console.log(`\nOutputs written to ${mergedDir}/`);
