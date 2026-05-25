/**
 * Enox Tools — persistent knowledge graph (long-term memory)
 *
 * Enox is a federated knowledge graph shared across sessions and projects.
 * These tools provide CRUD operations on nodes and edges, semantic search,
 * graph traversal, and document storage.
 */

import type { ToolDefinition } from './types.js';

const RELATION_TYPES = [
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
    name: 'remember',
    description: `Quick knowledge write — store a fact about a subject.

Use this when you:
- Discover something worth remembering across sessions
- Want to record an experiment result, decision, or observation
- Need a quick "jot it down" without specifying exact graph structure

The subject becomes a node (or reuses an existing one), and the fact is stored
as an assertion from that node.

Example: remember(subject="RFDB compaction", fact="flush_data_only was a no-op in V2 engine", domain="engineering")`,
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'The entity this fact is about (becomes a node)',
        },
        fact: {
          type: 'string',
          description: 'The fact or observation to record',
        },
        domain: {
          type: 'string',
          description: 'Knowledge domain (default: "memory")',
        },
        confidence: {
          type: 'number',
          description: 'Confidence level 0-1 (default: 0.9)',
        },
        relation: {
          type: 'string',
          description: 'Relation type for the assertion edge',
          enum: [...RELATION_TYPES],
        },
      },
      required: ['subject', 'fact'],
    },
  },
  {
    name: 'recall',
    description: `Broad "what do we know about X" — combines embedding search with graph traversal.

Use this at session start or before making decisions to check for prior art,
known failures, and existing context.

Depth controls how far to traverse from matched nodes:
- 1: direct matches only (fast)
- 2: matches + their neighbors (default, good balance)
- 3: two hops out (broader context, slower)

Example: recall(query="federation architecture", depth=2)`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to recall — natural language query',
        },
        depth: {
          type: 'number',
          description: 'Traversal depth from matched nodes: 1-3 (default: 1)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'semantic_search',
    description: `Embedding-based similarity search across the knowledge graph.

Use this for precise similarity matching — finds nodes whose content
is semantically close to the query, even if exact keywords differ.

More targeted than recall: returns ranked results without graph traversal.

Example: semantic_search(query="Docker container auth token", top_k=5, domain="devops")`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query',
        },
        top_k: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
        domain: {
          type: 'string',
          description: 'Filter results to a specific domain',
        },
        include_edges: {
          type: 'boolean',
          description: 'Include edges connected to matched nodes (default: false)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'enox_explore',
    description: `Get all edges around an entity in the knowledge graph — see everything connected to it.

Use this to understand the full context of an entity: what it relates to,
what depends on it, what contradicts it, etc.

Returns all incoming and outgoing edges with connected node summaries.

Example: explore(entity="RFDB V2 engine")`,
    inputSchema: {
      type: 'object',
      properties: {
        entity: {
          type: 'string',
          description: 'Name or ID of the entity to explore',
        },
      },
      required: ['entity'],
    },
  },
  {
    name: 'add_assertion',
    description: `Create a precise edge between two nodes in the knowledge graph.

Use this when you need exact control over the graph structure:
- Specific relation type between two entities
- Confidence level on an assertion
- Domain scoping

Both "from" and "to" become nodes if they don't exist yet.

Example: add_assertion(from="Grafema", relation="uses", to="RFDB", context="RFDB is the storage engine for code graphs", confidence=1.0)`,
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Source entity name or ID',
        },
        relation: {
          type: 'string',
          description: 'Relation type for the edge',
          enum: [...RELATION_TYPES],
        },
        to: {
          type: 'string',
          description: 'Target entity name or ID',
        },
        context: {
          type: 'string',
          description: 'Additional context or evidence for this assertion',
        },
        confidence: {
          type: 'number',
          description: 'Confidence level 0-1',
        },
        domain: {
          type: 'string',
          description: 'Knowledge domain this assertion belongs to',
        },
      },
      required: ['from', 'relation', 'to'],
    },
  },
  {
    name: 'update_assertion',
    description: `Update an existing edge in the knowledge graph.

Use this to change the context or confidence of a previously recorded assertion
without deleting and re-creating it.

Example: update_assertion(fact_id="edge-abc123", confidence=0.5, context="Partially confirmed after testing")`,
    inputSchema: {
      type: 'object',
      properties: {
        fact_id: {
          type: 'string',
          description: 'ID of the assertion/edge to update',
        },
        context: {
          type: 'string',
          description: 'Updated context or evidence',
        },
        confidence: {
          type: 'number',
          description: 'Updated confidence level 0-1',
        },
      },
      required: ['fact_id'],
    },
  },
  {
    name: 'delete_assertion',
    description: `Remove an edge from the knowledge graph.

Use this when an assertion is wrong, outdated, or no longer relevant.
Consider using update_assertion to lower confidence instead of deleting,
or add_assertion with "supersedes" relation to record the replacement.

Example: delete_assertion(fact_id="edge-abc123")`,
    inputSchema: {
      type: 'object',
      properties: {
        fact_id: {
          type: 'string',
          description: 'ID of the assertion/edge to remove',
        },
      },
      required: ['fact_id'],
    },
  },
  {
    name: 'enox_query',
    description: `Filter nodes in the knowledge graph by type, domain, or name.

Use this for exact filtering when you know what you're looking for.
Unlike semantic_search, this does exact/substring matching on fields.

Example: query_graph(type="decision", domain="engineering", limit=20)`,
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Filter by node type',
        },
        domain: {
          type: 'string',
          description: 'Filter by knowledge domain',
        },
        name: {
          type: 'string',
          description: 'Filter by node name (substring match)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 50)',
        },
      },
    },
  },
  {
    name: 'enox_traverse',
    description: `Graph traversal from a knowledge entity following specific edge types and direction.

Use this for structured exploration:
- "What does X depend on?" → traverse(start="X", direction="outgoing", edge_types=["depends_on"])
- "What supersedes X?" → traverse(start="X", direction="incoming", edge_types=["supersedes"])
- Full neighborhood: traverse(start="X", direction="both", max_depth=2)

Returns nodes with depth info (0 = start, 1 = direct, 2+ = transitive).

Example: traverse(start="RFDB", direction="outgoing", edge_types=["depends_on", "uses"], max_depth=3)`,
    inputSchema: {
      type: 'object',
      properties: {
        start: {
          type: 'string',
          description: 'Starting entity name or ID',
        },
        direction: {
          type: 'string',
          description: 'Traversal direction (default: "both")',
          enum: ['outgoing', 'incoming', 'both'],
        },
        edge_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by edge/relation types. Omit for all.',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum traversal depth (default: 2)',
        },
      },
      required: ['start'],
    },
  },
  {
    name: 'enox_stats',
    description: `Get statistics about the Enox knowledge graph.

Use this to:
- Check if the knowledge graph has content
- See node and edge counts by type
- Assess graph density and coverage

Returns: total nodes, total edges, counts by type, domain distribution.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'recent_activity',
    description: `Get recently created or updated nodes and edges.

Use this at session start to see what other sessions have recorded recently.
Helps avoid duplicating work and provides continuity across sessions.

Example: recent_activity(since="2026-05-20T00:00:00Z", limit=10)`,
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'ISO 8601 date — only show activity after this time',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
        },
      },
    },
  },
  {
    name: 'update_node',
    description: `Update metadata on an existing node in the knowledge graph.

Use this to rename, re-domain, or add descriptions to existing nodes
without affecting their edges.

Example: update_node(node_id="node-abc123", description="V2 storage engine with segment-based persistence")`,
    inputSchema: {
      type: 'object',
      properties: {
        node_id: {
          type: 'string',
          description: 'ID of the node to update',
        },
        name: {
          type: 'string',
          description: 'Updated node name',
        },
        domain: {
          type: 'string',
          description: 'Updated knowledge domain',
        },
        description: {
          type: 'string',
          description: 'Updated node description',
        },
      },
      required: ['node_id'],
    },
  },
  {
    name: 'crawl_entity',
    description: `Run ontological crawl on a code entity — generate hypotheses and verify against code graph.
Uses the Grafema code graph for verification. Records findings in knowledge database.
Example: crawl_entity(entity="compactionEnricher", context="TypeScript enricher creating FEATURE nodes")`,
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name to crawl' },
        context: { type: 'string', description: 'Brief description of what this entity is' },
        depth: { type: 'number', description: 'How many perspectives to explore (default: 3)' },
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
