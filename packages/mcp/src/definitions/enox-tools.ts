/**
 * Knowledge Tools — persistent project knowledge graph (long-term memory)
 *
 * The knowledge graph is a separate RFDB database ("knowledge") sharing the same
 * server socket as the code graph. These tools provide batch-native writes
 * (assert/retract), retrieval (recall), a code→knowledge bridge (crawl_entity),
 * and document storage (save_document).
 *
 * Naming note: Enox is a protocol Grafema supports, not a tool namespace — these
 * tools use neutral verb_noun names (assert, retract, recall), NOT an `enox_`
 * prefix. Generic graph reads/writes against the knowledge graph go through the
 * code-graph verbs with `graph: "knowledge"` (query_graph, find_nodes, get_node,
 * trace, get_stats).
 */

import type { ToolDefinition } from './types.js';

export const RELATION_TYPES = [
  'depends_on',
  'supersedes',
  'implements',
  'contradicts',
  'part_of',
  'extends',
  'enables',
  'isomorphic_to',
  'decided_on',
  'discussed_on',
  'changed_on',
  'created_on',
  'preceded_by',
  'triggered_by',
  'prefers',
  'distrusts',
  'values',
  'rejects',
  'believes',
  'about',
  'references',
  'blocks',
  'decomposes_into',
  'related_to',
  'similar_to',
  'requires',
  'supports',
  'outperforms',
  'fails_on',
  'introduces',
  'uses',
  'is_based_on',
  'equivalent_to',
  'foundational_for',
  'builds_on',
  'contributes_to',
  'alternative_to',
  'refutes',
  'challenges',
  'applies_to',
  'exports',
] as const;

export const ENOX_TOOLS: ToolDefinition[] = [
  {
    name: 'assert',
    description: `Write one or more facts (relation edges) into the project knowledge graph. BATCH-NATIVE.

Use this when you discover something worth remembering across sessions — a decision,
experiment result, dependency, contradiction, or any relationship between two entities.

This is the SINGLE knowledge-write tool. There is no separate "remember"/"add_assertion"/
"update_assertion" — pass an array of assertions. One fact = an array of one. Both "from"
and "to" become nodes if they don't exist yet.

To record that a newer finding replaces an older one, just use relation="supersedes"
(e.g. assert([{from:"new approach", relation:"supersedes", to:"old approach", context:"..."}])).
Re-asserting the same {from, relation, to} updates that edge's context/confidence.

Example:
  assert(assertions=[
    { from:"Grafema", relation:"uses", to:"RFDB", context:"RFDB is the storage engine", confidence:1.0, domain:"engineering" },
    { from:"V2 engine", relation:"supersedes", to:"V1 engine", context:"segment-based persistence" }
  ])`,
    inputSchema: {
      type: 'object',
      properties: {
        assertions: {
          type: 'array',
          description: 'One or more facts to write. A single fact is an array of one element.',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: 'Source entity name or ID (becomes a node if new)' },
              relation: { type: 'string', description: 'Relation type for the edge', enum: [...RELATION_TYPES] },
              to: { type: 'string', description: 'Target entity name or ID (becomes a node if new)' },
              context: { type: 'string', description: 'Context/evidence for this fact — this is what recall searches over' },
              confidence: { type: 'number', description: 'Confidence level 0-1 (default 0.9)' },
              domain: { type: 'string', description: 'Knowledge domain this fact belongs to' },
            },
            required: ['from', 'relation', 'to'],
          },
        },
      },
      required: ['assertions'],
    },
  },
  {
    name: 'retract',
    description: `Delete one or more facts (relation edges) from the knowledge graph by fact_id. BATCH-NATIVE.

Use this when assertions are wrong, outdated, or no longer relevant. Consider asserting a
"supersedes" relation instead of retracting when you want to keep the history.

fact_ids are the ids returned by \`assert\` (and visible in recall/get_node output).

Example: retract(fact_ids=["a1b2c3...", "d4e5f6..."])`,
    inputSchema: {
      type: 'object',
      properties: {
        fact_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of the assertions/edges to remove.',
        },
      },
      required: ['fact_ids'],
    },
  },
  {
    name: 'recall',
    description: `Broad "what do we know about X" retrieval over the project knowledge graph — combines
name/content search with graph traversal.

Use this at session start or before making decisions to check for prior art, known
failures, and existing context.

depth controls how far to traverse from matched nodes:
- 1: direct matches only (fast)
- 2: matches + their neighbors (good balance)
- 3: two hops out (broader context, slower)

top_k caps the number of matched seed nodes. domain filters to one knowledge domain.

Example: recall(query="federation architecture", depth=2, top_k=10)`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to recall — natural language query',
        },
        depth: {
          type: 'number',
          description: 'Traversal depth from matched nodes: 1-3 (default: 2)',
        },
        top_k: {
          type: 'number',
          description: 'Maximum number of matched seed nodes to expand (default: 10)',
        },
        domain: {
          type: 'string',
          description: 'Filter results to a specific knowledge domain',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'crawl_entity',
    description: `Run an ontological crawl on a CODE entity — bridge from the code graph into knowledge.

Queries the Grafema code graph for the entity, generates graph-derived facts (what it is,
who calls it, what it contains, what it calls), and surfaces any prior knowledge already
recorded about it. Use \`assert\` afterwards to record interpretations worth persisting.

Example: crawl_entity(entity="compactionEnricher", context="TypeScript enricher creating FEATURE nodes")`,
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name to crawl' },
        context: { type: 'string', description: 'Brief description of what this entity is' },
        depth: { type: 'number', description: 'How many matched code nodes to explore (default: 3)' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'save_document',
    description: `Store a document or artifact as a node in the knowledge graph.

Use this for longer-form content that should be persisted:
- ADRs (Architecture Decision Records)
- Postmortems and incident reports
- Specifications and design documents
- Session notes and artifacts

The document becomes a node with its content stored. Use relates_to to
link it to relevant entities in the graph.

Example: save_document(title="ADR: Federation via thick client", content="## Context\\n...", doc_type="adr", relates_to=["Grafema", "RFDB"])`,
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Document title (becomes the node name)',
        },
        content: {
          type: 'string',
          description: 'Full document content (markdown supported)',
        },
        doc_type: {
          type: 'string',
          description: 'Document type (default: "note")',
          enum: ['adr', 'postmortem', 'spec', 'note', 'artifact'],
        },
        relates_to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Node IDs or names of related entities to link to',
        },
      },
      required: ['title', 'content'],
    },
  },
];
