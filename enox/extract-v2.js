#!/usr/bin/env node
/**
 * Phase 1 v2: Extract relations using few-shot examples + relation descriptions.
 *
 * Key improvements over v1 (informed by AutoRE paper analysis):
 * - D-F paradigm (simple prompt, not multi-step pipeline) — Decomposition Paradox
 * - Relation descriptions with examples (+44% F1 from AutoRE)
 * - 3 few-shot examples in every prompt
 * - High precision instructions (fewer hallucinated relations)
 *
 * Usage:
 *   node extract-v2.js --batch 0 --size 25
 *   node extract-v2.js --all --size 50
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const mergedDir = join(import.meta.dirname, 'merged');
const dataDir = join(import.meta.dirname, 'data');

// Load abstracts
const abstracts = readFileSync(join(mergedDir, 'abstracts.jsonl'), 'utf-8')
  .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

// Load existing nodes for context
const nodes = readFileSync(join(mergedDir, 'nodes.jsonl'), 'utf-8')
  .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

const knownConcepts = nodes
  .filter(n => n.node_type === 'concept')
  .map(n => n.label)
  .slice(0, 40);

// Relation definitions with examples (AutoRE: +44% F1 from clear descriptions)
const RELATION_DEFS = `RELATION TYPES (use ONLY these, with exact spelling):

- introduces: Paper/method creates something new. Example: (BERT, introduces, Masked Language Modeling)
- extends: Subject builds upon object, adding improvements. Example: (QLoRA, extends, LoRA) — adds 4-bit quantization
- outperforms: Subject beats object. MUST include metrics/dataset in "condition". Example: (AutoRE, outperforms, TAG) condition: "Re-DocRED test: 53.84% vs 49.38% F1"
- fails_on: Subject performs poorly on object. Include failure conditions. Example: (ChatGPT, fails_on, DocRE) condition: "without fine-tuning, F1 < 8%"
- requires: Subject needs object to function. Strong dependency. Example: (AutoRE, requires, QLoRA)
- is_based_on: Subject is architecturally/theoretically founded on object. Example: (BERT, is_based_on, Transformer)
- supersedes: Subject replaces object. Example: (Re-DocRED, supersedes, DocRED) — fixes annotation errors
- uses: Subject employs object as component/tool. Example: (AutoRE, uses, QLoRA)
- applies_to: Subject is applicable to object domain/task. Example: (AutoRE, applies_to, Document-Level RE)
- enables: Subject makes object possible. Example: (QLoRA, enables, memory-efficient 65B fine-tuning)
- supports: Subject provides evidence for object. Example: (Chinchilla, supports, Scaling Laws)
- surveys: Subject reviews object field comprehensively.
- formalizes: Subject provides formal definition of object.
- refutes: Subject contradicts object. Use sparingly, only for explicit contradictions.`;

// Few-shot examples (3 diverse examples)
const FEW_SHOT = `EXAMPLES of correct extraction:

Example 1 (arxiv:2403.14888 — AutoRE):
Input abstract: "This paper introduces AutoRE, an end-to-end DocRE model using RHF paradigm. Using QLoRA, AutoRE surpasses TAG by 10.03% on Re-DocRED."
Output:
{"entities":[{"name":"AutoRE","type":"method"},{"name":"RHF","type":"paradigm"},{"name":"QLoRA","type":"method"},{"name":"TAG","type":"method"},{"name":"Re-DocRED","type":"dataset"},{"name":"Document-Level RE","type":"task"}],"relations":[{"from":"AutoRE","rel":"introduces","to":"RHF","confidence":0.3,"condition":"","note":"core contribution"},{"from":"AutoRE","rel":"outperforms","to":"TAG","confidence":0.3,"condition":"Re-DocRED: +10.03% F1","note":"explicit comparison"},{"from":"AutoRE","rel":"uses","to":"QLoRA","confidence":0.3,"condition":"","note":"fine-tuning method"}]}

Example 2 (arxiv:1706.03762 — Attention Is All You Need):
Input abstract: "We propose the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely."
Output:
{"entities":[{"name":"Transformer","type":"model"},{"name":"Self-Attention","type":"method"},{"name":"Recurrent Neural Networks","type":"model"},{"name":"Sequence Transduction","type":"task"}],"relations":[{"from":"Transformer","rel":"introduces","to":"Self-Attention","confidence":0.25,"condition":"as sole mechanism","note":"replaces RNN/CNN"},{"from":"Transformer","rel":"supersedes","to":"Recurrent Neural Networks","confidence":0.2,"condition":"for sequence tasks","note":""}]}

Example 3 (arxiv:2305.03452 — QLoRA):
Input abstract: "QLoRA reduces memory enough to finetune a 65B model on a single 48GB GPU. It backpropagates through frozen 4-bit quantized models into LoRA adapters."
Output:
{"entities":[{"name":"QLoRA","type":"method"},{"name":"LoRA","type":"method"},{"name":"4-bit Quantization","type":"technique"},{"name":"PEFT","type":"concept"}],"relations":[{"from":"QLoRA","rel":"extends","to":"LoRA","confidence":0.3,"condition":"adds 4-bit quantization","note":""},{"from":"QLoRA","rel":"enables","to":"PEFT","confidence":0.25,"condition":"65B on single 48GB GPU","note":"memory reduction"}]}`;

function buildPrompt(paper) {
  return `You are an expert knowledge graph builder extracting entities and relations from CS paper abstracts.

${RELATION_DEFS}

${FEW_SHOT}

RULES:
- Extract only what is EXPLICITLY stated or strongly implied. Do NOT infer relations not supported by text.
- Confidence: 0.3 = explicit in text, 0.2 = moderate inference, 0.1 = weak inference
- Entity types: method, model, dataset, metric, concept, technique, task, tool, baseline, paradigm
- Prefer linking to KNOWN CONCEPTS when possible: ${knownConcepts.join(', ')}
- Output ONLY valid JSON, no markdown, no explanation

NOW EXTRACT from this paper:

arxiv_id: ${paper.arxiv_id}
Title: ${paper.title}
Authors: ${paper.authors?.join(', ') || 'N/A'}
Published: ${paper.published || 'N/A'}

Abstract:
${paper.abstract}

Output JSON with "entities" and "relations" arrays:`;
}

// Parse args
const args = process.argv.slice(2);
const sizeIdx = args.indexOf('--size');
const batchIdx = args.indexOf('--batch');
const doAll = args.includes('--all');

const batchSize = sizeIdx >= 0 ? parseInt(args[sizeIdx + 1]) : 25;
const batchNum = batchIdx >= 0 ? parseInt(args[batchIdx + 1]) : 0;
const totalBatches = Math.ceil(abstracts.length / batchSize);

const papersToProcess = doAll
  ? abstracts.slice(0, parseInt(args[args.indexOf('--size') + 1]) || abstracts.length)
  : abstracts.slice(batchNum * batchSize, (batchNum + 1) * batchSize);

console.log(`=== Extract v2 (few-shot + relation descriptions) ===`);
console.log(`Papers to process: ${papersToProcess.length}`);
console.log(`Prompt includes: 3 few-shot examples, 14 relation definitions`);

// Generate prompt files for subagent consumption
const promptsPerBatch = 10; // smaller batches for subagents
const numBatches = Math.ceil(papersToProcess.length / promptsPerBatch);

for (let i = 0; i < numBatches; i++) {
  const batch = papersToProcess.slice(i * promptsPerBatch, (i + 1) * promptsPerBatch);
  const outputFile = join(dataDir, `v2-prompts-batch${i}.jsonl`);

  const lines = batch.map(paper => JSON.stringify({
    arxiv_id: paper.arxiv_id,
    title: paper.title,
    prompt: buildPrompt(paper),
  }));

  writeFileSync(outputFile, lines.join('\n') + '\n');
  console.log(`Batch ${i}: ${batch.length} prompts -> ${outputFile}`);
}

console.log(`\nTotal: ${numBatches} batch files generated`);
console.log(`Launch subagents to process each batch file.`);
