#!/usr/bin/env node
/**
 * Generate cross-cluster edges based on shared concepts and known relationships.
 * Run AFTER merge.js to enrich the graph with inter-domain connections.
 *
 * These are the edges that make the Enox graph valuable — connections invisible
 * in individual clusters but visible when you look across domains.
 */

import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';

const mergedDir = join(import.meta.dirname, 'merged');

const graphLines = readFileSync(join(mergedDir, 'graph.jsonl'), 'utf-8')
  .split('\n').filter(l => l.trim());

const nodes = new Map();
const edges = [];

for (const line of graphLines) {
  const obj = JSON.parse(line);
  if (obj._type === 'node') nodes.set(obj.id, obj);
  else if (obj._type === 'edge') edges.push(obj);
}

const crossEdges = [];

function addCross(from, rel, to, confidence, note) {
  if (nodes.has(from) && nodes.has(to)) {
    crossEdges.push({
      _type: 'edge',
      from, rel, to,
      confidence,
      source: 'cross-link-analysis',
      extracted: '2026-03-14',
      status: 'extracted',
      note,
      _cross_cluster: true
    });
  }
}

// Known cross-domain relationships that wouldn't appear in single-cluster analysis
const knownCrossLinks = [
  // Datalog <-> Program Analysis
  ['enox:concept/datalog', 'enables', 'enox:concept/points_to_analysis', 0.3,
   'Datalog is the standard formalism for declarative points-to analysis'],

  // Abstract Interpretation <-> GNN
  ['enox:concept/abstract_interpretation', 'isomorphic_to', 'enox:concept/message_passing', 0.15,
   'Both are fixpoint computations on lattices/graphs — GNN aggregation is abstract interpretation over node features'],

  // Knowledge Graphs <-> Semantic Web
  ['enox:concept/knowledge_graph', 'extends', 'enox:concept/rdf', 0.25,
   'Knowledge Graphs evolved from RDF/Linked Data, adding property graphs and embeddings'],

  // Transformers <-> Knowledge Graphs
  ['enox:concept/transformer', 'enables', 'enox:concept/relation_extraction', 0.25,
   'Transformer-based models revolutionized relation extraction accuracy'],

  // RAG <-> Knowledge Graphs
  ['enox:concept/rag', 'requires', 'enox:concept/knowledge_graph', 0.2,
   'Knowledge-grounded RAG uses KGs as structured retrieval source'],

  // IPFS <-> Content Addressing
  ['enox:concept/ipfs', 'implements', 'enox:concept/content_addressable_storage', 0.3,
   'IPFS implements content-addressable storage via Merkle DAGs'],

  // PageRank <-> Trust
  ['enox:concept/pagerank', 'isomorphic_to', 'enox:concept/eigentrust', 0.2,
   'EigenTrust adapts PageRank eigenvector computation to P2P trust networks'],

  // Federated Learning <-> Differential Privacy
  ['enox:concept/federated_learning', 'requires', 'enox:concept/differential_privacy', 0.25,
   'Production federated learning requires differential privacy for meaningful guarantees'],

  // Code Property Graphs <-> Knowledge Graphs
  ['enox:concept/code_property_graph', 'isomorphic_to', 'enox:concept/knowledge_graph', 0.2,
   'Code Property Graphs apply KG principles to source code — nodes are code entities, edges are typed relationships'],
];

for (const [from, rel, to, conf, note] of knownCrossLinks) {
  addCross(from, rel, to, conf, note);
}

// Also find papers that cite concepts from other clusters
// (detect by looking at node titles/abstracts mentioning terms from other clusters)
const clusterTerms = {
  'knowledge_graph': ['knowledge graph', 'KG embedding', 'triple'],
  'gnn': ['graph neural', 'GNN', 'message passing', 'graph convolution'],
  'semantic_web': ['RDF', 'OWL', 'linked data', 'SPARQL', 'ontology'],
  'information_extraction': ['relation extraction', 'NER', 'information extraction'],
  'program_analysis': ['static analysis', 'abstract interpretation', 'data flow', 'call graph'],
  'datalog': ['Datalog', 'logic programming', 'declarative'],
  'llm': ['language model', 'transformer', 'BERT', 'GPT', 'LLM'],
  'federated': ['federated', 'distributed', 'P2P', 'CRDT', 'consensus'],
  'trust': ['trust', 'reputation', 'verification', 'epistemic'],
};

console.log(`Generated ${crossEdges.length} cross-cluster edges`);

// Append to graph
const crossJsonl = crossEdges.map(e => JSON.stringify(e)).join('\n');
if (crossEdges.length > 0) {
  appendFileSync(join(mergedDir, 'graph.jsonl'), '\n' + crossJsonl + '\n');
  writeFileSync(join(mergedDir, 'cross-edges.jsonl'), crossJsonl + '\n');
}

console.log('Cross-cluster edges written to merged/cross-edges.jsonl');
