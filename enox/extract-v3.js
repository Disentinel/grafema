#!/usr/bin/env node
/**
 * Phase 1 v3: Decision-support extraction.
 *
 * Key change from v2: relation types are decision-support archetypes,
 * not catalogue metadata. Every edge must answer a decision question.
 *
 * Usage:
 *   node extract-v3.js --all --size 50
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const mergedDir = join(import.meta.dirname, 'merged');
const dataDir = join(import.meta.dirname, 'data');

const abstracts = readFileSync(join(mergedDir, 'abstracts.jsonl'), 'utf-8')
  .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

const nodes = readFileSync(join(mergedDir, 'nodes.jsonl'), 'utf-8')
  .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

const knownConcepts = nodes
  .filter(n => n.node_type === 'concept')
  .map(n => n.label)
  .slice(0, 40);

const PROMPT_TEMPLATE = (paper) => `You are a decision-support knowledge graph builder. You extract ONLY relations that help someone MAKE BETTER DECISIONS about which techniques to use.

GOAL: Every edge must answer one of these questions:
- What works better? (outperforms)
- What DOESN'T work? (fails_on)
- Is this proven or disproven? (supports / refutes)
- Is this obsolete? (supersedes)
- Is this the same thing under a different name? (equivalent_to)
- What is this built on? (extends)
- What is required for this to work? (requires)

RELATION TYPES (use ONLY these):

CORE DECISION-SUPPORT (prioritize these):
- outperforms: A beats B. MUST have "condition" with metric/dataset/context. Example: (QLoRA, outperforms, full fine-tuning) condition: "≤48GB GPU, preserves 16-bit quality"
- fails_on: A doesn't work in situation B. MUST have "condition". Example: (Transformer, fails_on, long sequences) condition: "O(n²) memory, >4096 tokens"
- refutes: A disproves/invalidates B. Example: (Re-evaluation, refutes, FB15k benchmark results) note: "data leakage inflated scores"
- supports: A provides evidence for B. Example: (Chinchilla, supports, compute-optimal scaling) note: "70B+4x data > 280B+1x data"
- supersedes: A replaces B, B is now obsolete. Example: (Re-DocRED, supersedes, DocRED) note: "fixes false negatives"
- equivalent_to: A and B are the same concept in different domains/notations. Example: (message passing, equivalent_to, abstract interpretation on graphs)

LINEAGE (use when relevant):
- extends: A builds on B, adding something. Example: (QLoRA, extends, LoRA) note: "adds 4-bit quantization"
- requires: A needs B to function. Without B, A fails. Example: (D-R-H-F paradigm, requires, QLoRA fine-tuning) note: "without it F1=1.81"

DO NOT USE generic catalogue relations like "applies_to", "uses", "introduces", "surveys".
These are metadata, not decision support. If a paper "introduces X" — extract X as an entity, but don't create an "introduces" edge.

FEW-SHOT EXAMPLES:

Example 1 (AutoRE paper):
Abstract: "AutoRE uses QLoRA with RHF paradigm, surpassing TAG by 10% on Re-DocRED. Relation descriptions improve F1 from 6.44 to 14.04."
{"entities":[{"name":"AutoRE","type":"method"},{"name":"RHF paradigm","type":"paradigm"},{"name":"QLoRA","type":"method"},{"name":"TAG","type":"baseline"},{"name":"Re-DocRED","type":"dataset"},{"name":"Relation Description Rewriting","type":"technique"}],"relations":[{"from":"AutoRE","rel":"outperforms","to":"TAG","confidence":0.3,"condition":"Re-DocRED test: 53.84% vs 49.38% F1","note":""},{"from":"AutoRE","rel":"extends","to":"RHF paradigm","confidence":0.25,"condition":"","note":"implements RHF with 3 QLoRA modules"},{"from":"AutoRE","rel":"requires","to":"Relation Description Rewriting","confidence":0.25,"condition":"","note":"without it F1 drops from 14.04 to 6.44"},{"from":"AutoRE","rel":"requires","to":"QLoRA","confidence":0.3,"condition":"","note":"without fine-tuning D-R-H-F gives F1=1.81"}]}

Example 2 (Chinchilla paper):
Abstract: "We find current LLMs are undertrained. Chinchilla uses same compute as Gopher (280B) but 4x more data with 70B params."
{"entities":[{"name":"Chinchilla","type":"model"},{"name":"Gopher","type":"model"},{"name":"Compute-Optimal Scaling","type":"concept"}],"relations":[{"from":"Chinchilla","rel":"outperforms","to":"Gopher","confidence":0.3,"condition":"same compute budget, 4x data, 4x fewer params","note":""},{"from":"Chinchilla","rel":"supports","to":"Compute-Optimal Scaling","confidence":0.3,"condition":"","note":"more data + smaller model > less data + bigger model"},{"from":"Chinchilla","rel":"supersedes","to":"Gopher","confidence":0.2,"condition":"","note":"same compute, better results"}]}

Example 3 (GNN limitations paper):
Abstract: "We show GNNs are at most as powerful as the WL test. No existing GNN can distinguish certain graph structures."
{"entities":[{"name":"Graph Neural Networks","type":"concept"},{"name":"Weisfeiler-Leman Test","type":"concept"},{"name":"Graph Isomorphism","type":"task"}],"relations":[{"from":"Graph Neural Networks","rel":"fails_on","to":"Graph Isomorphism","confidence":0.3,"condition":"cannot distinguish non-isomorphic graphs that WL test cannot","note":"fundamental expressiveness limit"},{"from":"Graph Neural Networks","rel":"equivalent_to","to":"Weisfeiler-Leman Test","confidence":0.25,"condition":"in terms of distinguishing power","note":"GNNs ≤ 1-WL"}]}

RULES:
- Extract ONLY decision-support relations. Skip obvious/generic ones.
- EVERY "outperforms" and "fails_on" MUST have a "condition" field.
- Confidence: 0.3 = explicit in text, 0.2 = moderate inference, 0.1 = weak
- Entity types: method, model, dataset, metric, concept, technique, task, tool, baseline, paradigm
- Link to known concepts when possible: ${knownConcepts.join(', ')}
- It's OK to extract fewer relations if they are all high-quality decision-support.
- Output ONLY valid JSON, no markdown.

PAPER:
arxiv_id: ${paper.arxiv_id}
Title: ${paper.title}
Authors: ${paper.authors?.join(', ') || 'N/A'}
Published: ${paper.published || 'N/A'}

Abstract:
${paper.abstract}

Output JSON with "entities" and "relations" arrays:`;

// Parse args
const args = process.argv.slice(2);
const sizeIdx = args.indexOf('--size');
const batchIdx = args.indexOf('--batch');
const doAll = args.includes('--all');

const batchSize = sizeIdx >= 0 ? parseInt(args[sizeIdx + 1]) : 25;
const batchNum = batchIdx >= 0 ? parseInt(args[batchIdx + 1]) : 0;

const papersToProcess = doAll
  ? abstracts.slice(0, parseInt(args[args.indexOf('--size') + 1]) || abstracts.length)
  : abstracts.slice(batchNum * batchSize, (batchNum + 1) * batchSize);

console.log(`=== Extract v3 (decision-support archetypes) ===`);
console.log(`Papers: ${papersToProcess.length}`);
console.log(`Core relations: outperforms, fails_on, refutes, supports, supersedes, equivalent_to, extends, requires`);
console.log(`Excluded: applies_to, uses, introduces, surveys (catalogue metadata)`);

const promptsPerBatch = 10;
const numBatches = Math.ceil(papersToProcess.length / promptsPerBatch);

for (let i = 0; i < numBatches; i++) {
  const batch = papersToProcess.slice(i * promptsPerBatch, (i + 1) * promptsPerBatch);
  const outputFile = join(dataDir, `v3-prompts-batch${i}.jsonl`);

  const lines = batch.map(paper => JSON.stringify({
    arxiv_id: paper.arxiv_id,
    title: paper.title,
    prompt: PROMPT_TEMPLATE(paper),
  }));

  writeFileSync(outputFile, lines.join('\n') + '\n');
  console.log(`Batch ${i}: ${batch.length} prompts -> ${outputFile}`);
}

console.log(`\nTotal: ${numBatches} batch files`);
