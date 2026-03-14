#!/usr/bin/env node
/**
 * Phase 1: Extract raw triples from arxiv paper abstracts using LLM.
 * Follows ChatIE multi-turn pattern + EDC Extract phase.
 *
 * Input: merged/abstracts.jsonl (full abstracts from arxiv API)
 * Output: enox/data/extracted-triples-{batch}.jsonl
 *
 * Design decisions (graph-informed):
 * - ChatIE: multi-turn extraction (entities first, then relations) +16.65% vs single-prompt
 * - EDC: Extract→Define→Canonicalize pipeline
 * - DocRED: full text > abstract for cross-sentence relations
 * - Chinchilla: more data × weak model > less data × strong model
 * - PURE: simple pipeline beats complex end-to-end
 *
 * Usage:
 *   node extract-relations.js --batch 0 --size 25
 *   node extract-relations.js --all
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';

const mergedDir = join(import.meta.dirname, 'merged');
const dataDir = join(import.meta.dirname, 'data');

// Load abstracts
const abstractsFile = join(mergedDir, 'abstracts.jsonl');
const abstracts = readFileSync(abstractsFile, 'utf-8')
  .split('\n')
  .filter(l => l.trim())
  .map(l => JSON.parse(l));

console.log(`Loaded ${abstracts.length} abstracts`);

// Load existing graph for context (relation types, known entities)
const nodesFile = join(mergedDir, 'nodes.jsonl');
const existingNodes = readFileSync(nodesFile, 'utf-8')
  .split('\n')
  .filter(l => l.trim())
  .map(l => JSON.parse(l));

const knownPapers = existingNodes
  .filter(n => n.node_type === 'paper')
  .map(n => ({ id: n.id, title: n.title, arxiv_id: n.arxiv_id }))
  .filter(n => n.arxiv_id);

const knownConcepts = existingNodes
  .filter(n => n.node_type === 'concept')
  .map(n => n.label);

// Enox relation schema
const RELATION_TYPES = [
  'implements',   // paper implements algorithm/method from another
  'extends',      // paper extends/improves upon method
  'outperforms',  // method beats another (with conditions)
  'fails_on',     // method fails under conditions
  'requires',     // method requires technique/assumption
  'introduces',   // paper introduces new concept/method
  'supports',     // provides evidence for a claim
  'refutes',      // contradicts findings
  'is_based_on',  // theoretical foundation
  'applies_to',   // method applicable to domain/problem
  'supersedes',   // newer method replaces older
  'surveys',      // paper reviews a field
  'enables',      // one technique enables another
  'uses',         // paper uses a method/dataset/tool
];

/**
 * Build the ChatIE-style multi-turn prompt for Phase 1 extraction.
 * Step 1: Extract entities (methods, datasets, metrics, concepts)
 * Step 2: Extract relations between entities
 */
function buildExtractionPrompt(paper) {
  return `You are an expert information extraction system for academic CS papers.
Extract structured knowledge from this paper abstract.

PAPER:
- arxiv_id: ${paper.arxiv_id}
- Title: ${paper.title}
- Authors: ${paper.authors?.join(', ') || 'N/A'}
- Published: ${paper.published || 'N/A'}

ABSTRACT:
${paper.abstract}

STEP 1: Extract all entities mentioned. For each entity, give:
- name: canonical name
- type: one of [method, dataset, metric, concept, tool, model, task, baseline]

STEP 2: Extract all relations between entities. Use ONLY these relation types:
${RELATION_TYPES.map(r => `- ${r}`).join('\n')}

For each relation, give:
- from: entity name (must match Step 1)
- rel: relation type (from list above)
- to: entity name (must match Step 1)
- confidence: 0.1-0.3 (0.1=weak inference, 0.2=moderate, 0.3=explicit in text)
- condition: when/where this holds (empty if universal)
- note: brief explanation

KNOWN CONCEPTS in our graph (link to these when possible):
${knownConcepts.slice(0, 50).join(', ')}

Output as JSON with two arrays: "entities" and "relations".
Output ONLY valid JSON, no markdown.`;
}

// Parse args
const args = process.argv.slice(2);
const batchIdx = args.indexOf('--batch');
const sizeIdx = args.indexOf('--size');
const doAll = args.includes('--all');

const batchNum = batchIdx >= 0 ? parseInt(args[batchIdx + 1]) : 0;
const batchSize = sizeIdx >= 0 ? parseInt(args[sizeIdx + 1]) : 25;

const totalBatches = Math.ceil(abstracts.length / batchSize);

if (!doAll && batchIdx < 0) {
  console.log(`Total abstracts: ${abstracts.length}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Total batches: ${totalBatches}`);
  console.log(`\nUsage: node extract-relations.js --batch N --size 25`);
  console.log(`       node extract-relations.js --all`);
  process.exit(0);
}

const batches = doAll
  ? Array.from({ length: totalBatches }, (_, i) => i)
  : [batchNum];

console.log(`Processing batches: ${batches.join(', ')}`);
console.log(`Each batch: ${batchSize} papers`);
console.log(`Prompt template follows ChatIE multi-turn + EDC Extract pattern`);

// For now, just generate the prompts for subagent consumption
for (const bi of batches) {
  const start = bi * batchSize;
  const batch = abstracts.slice(start, start + batchSize);
  const outputFile = join(dataDir, `phase1-prompts-batch${bi}.jsonl`);

  const lines = batch.map(paper => {
    return JSON.stringify({
      arxiv_id: paper.arxiv_id,
      title: paper.title,
      prompt: buildExtractionPrompt(paper),
    });
  });

  writeFileSync(outputFile, lines.join('\n') + '\n');
  console.log(`Batch ${bi}: ${batch.length} prompts -> ${outputFile}`);
}
