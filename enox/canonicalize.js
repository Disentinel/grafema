#!/usr/bin/env node
/**
 * Phase 2: Canonicalize raw triples into Enox edge format.
 * Follows EDC Define+Canonicalize phases.
 *
 * Input: data/phase1-raw-*.jsonl (raw extractions from Phase 1 Haiku agents)
 * Output: data/phase2-canonical.jsonl (clean Enox edges + new nodes)
 *
 * This phase:
 * 1. Deduplicates entities across papers (sameAs detection)
 * 2. Maps entity names to existing graph node IDs
 * 3. Creates new concept nodes for genuinely new entities
 * 4. Validates relation types against schema
 * 5. Merges with existing graph
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const mergedDir = join(import.meta.dirname, 'merged');
const dataDir = join(import.meta.dirname, 'data');

// Load existing graph
const nodesFile = join(mergedDir, 'nodes.jsonl');
const existingNodes = new Map();
readFileSync(nodesFile, 'utf-8')
  .split('\n')
  .filter(l => l.trim())
  .forEach(l => {
    const n = JSON.parse(l);
    existingNodes.set(n.id, n);
    // Also index by title for matching
    if (n.title) existingNodes.set(n.title.toLowerCase(), n);
    if (n.label) existingNodes.set(n.label.toLowerCase(), n);
    // Index aliases
    if (n.aliases) {
      for (const a of n.aliases) {
        existingNodes.set(a.toLowerCase(), n);
      }
    }
  });

const VALID_RELATIONS = new Set([
  'implements', 'extends', 'outperforms', 'fails_on', 'requires',
  'introduces', 'supports', 'refutes', 'is_based_on', 'applies_to',
  'supersedes', 'surveys', 'enables', 'uses', 'formalizes',
  'isomorphic_to', 'sameAs', 'overlaps_with',
]);

/**
 * Try to resolve an entity name to an existing graph node.
 */
function resolveEntity(name) {
  const lower = name.toLowerCase().trim();

  // Direct match
  if (existingNodes.has(lower)) {
    return existingNodes.get(lower).id;
  }

  // Fuzzy: check if name is substring of any existing node title
  for (const [key, node] of existingNodes) {
    if (typeof key === 'string' && key.includes(lower)) {
      return node.id;
    }
  }

  // Not found — will need a new concept node
  return null;
}

/**
 * Create a concept ID from a name.
 */
function makeConceptId(name) {
  return 'enox:concept/' + name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Process raw extraction output from a Phase 1 agent.
 */
function processRawFile(filepath) {
  if (!existsSync(filepath)) {
    console.log(`  Skipping ${filepath} (not found)`);
    return { edges: [], newNodes: [] };
  }

  const lines = readFileSync(filepath, 'utf-8').split('\n').filter(l => l.trim());
  const edges = [];
  const newNodes = new Map();

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const arxivId = record.arxiv_id;

      if (!record.entities || !record.relations) continue;

      // Build entity map for this paper
      const entityMap = new Map();
      for (const ent of record.entities) {
        const resolved = resolveEntity(ent.name);
        if (resolved) {
          entityMap.set(ent.name, resolved);
        } else {
          const conceptId = makeConceptId(ent.name);
          entityMap.set(ent.name, conceptId);
          if (!newNodes.has(conceptId)) {
            newNodes.set(conceptId, {
              _type: 'node',
              id: conceptId,
              node_type: 'concept',
              label: ent.name,
              domain: 'cs',
              entity_type: ent.type,
              discovered_in: `arxiv:${arxivId}`,
            });
          }
        }
      }

      // Process relations
      for (const rel of record.relations) {
        const fromId = entityMap.get(rel.from);
        const toId = entityMap.get(rel.to);
        const relType = rel.rel;

        if (!fromId || !toId) continue;
        if (!VALID_RELATIONS.has(relType)) continue;

        edges.push({
          _type: 'edge',
          from: fromId,
          rel: relType,
          to: toId,
          confidence: Math.min(0.3, rel.confidence || 0.2),
          condition: rel.condition || '',
          source: `arxiv:${arxivId}`,
          extracted: '2026-03-14',
          status: 'extracted',
          note: rel.note || '',
          _phase: 'phase2-canonical',
        });
      }
    } catch (e) {
      // Skip malformed lines
    }
  }

  return { edges, newNodes: [...newNodes.values()] };
}

// Process all phase1 raw files
const { readdirSync } = await import('fs');
const rawFiles = readdirSync(dataDir).filter(f => f.startsWith('phase1-raw-'));

console.log(`Found ${rawFiles.length} raw extraction files`);

let totalEdges = 0;
let totalNewNodes = 0;

const allEdges = [];
const allNewNodes = [];

for (const f of rawFiles) {
  const { edges, newNodes } = processRawFile(join(dataDir, f));
  allEdges.push(...edges);
  allNewNodes.push(...newNodes);
  totalEdges += edges.length;
  totalNewNodes += newNodes.length;
  console.log(`  ${f}: ${edges.length} edges, ${newNodes.length} new concepts`);
}

// Deduplicate edges
const edgeKey = (e) => `${e.from}|${e.rel}|${e.to}`;
const uniqueEdges = [...new Map(allEdges.map(e => [edgeKey(e), e])).values()];

// Deduplicate new nodes
const uniqueNewNodes = [...new Map(allNewNodes.map(n => [n.id, n])).values()];

// Write outputs
const outputFile = join(dataDir, 'phase2-canonical.jsonl');
const output = [
  ...uniqueNewNodes.map(n => JSON.stringify(n)),
  ...uniqueEdges.map(e => JSON.stringify(e)),
].join('\n') + '\n';

writeFileSync(outputFile, output);

console.log(`\n=== CANONICALIZATION COMPLETE ===`);
console.log(`Unique edges: ${uniqueEdges.length} (from ${totalEdges} raw)`);
console.log(`New concept nodes: ${uniqueNewNodes.length} (from ${totalNewNodes} raw)`);
console.log(`Output: ${outputFile}`);
