/**
 * Graph Tools — raw graph traversal primitives
 * REG-521: get_node, get_neighbors, traverse_graph
 */

import type { ToolDefinition } from './types.js';

export const GRAPH_TOOLS: ToolDefinition[] = [
  {
    name: 'get_node',
    description: `Get a single node by its semantic ID with full metadata.

Use this when you have a node ID from find_nodes, query_graph, or another tool
and need the complete record.

Returns: All node properties (type, name, file, line, exported) plus
type-specific metadata (async, params, className, etc.).

Use cases:
- After find_nodes: get full details for a specific result
- After query_graph: inspect a violation node
- Quick lookup without full context (faster than get_context)

Tip: For relationships and code context, use get_context instead.
For just the direct edges, use get_neighbors.`,
    inputSchema: {
      type: 'object',
      properties: {
        semanticId: {
          type: 'string',
          description: 'Semantic ID of the node (from find_nodes, query_graph, etc.)',
        },
      },
      required: ['semanticId'],
    },
  },
  {
    name: 'get_neighbors',
    description: `Get direct neighbors of a node — all incoming and/or outgoing edges.

Returns edges grouped by type with connected node summaries.

Use this when you need:
- "What does this node connect to?" (outgoing)
- "What connects to this node?" (incoming)
- Simple graph exploration without Datalog

Direction options:
- outgoing: Edges FROM this node (calls, contains, depends on)
- incoming: Edges TO this node (callers, containers, dependents)
- both: All edges (default)

Edge type filter: Pass edgeTypes to see only specific relationships.
Omit to get all edge types.

Cheaper than get_context (no code snippets). Use when you only need
the graph structure, not source code.`,
    inputSchema: {
      type: 'object',
      properties: {
        semanticId: {
          type: 'string',
          description: 'Semantic ID of the node',
        },
        direction: {
          type: 'string',
          description: 'Edge direction: outgoing, incoming, or both (default: both)',
          enum: ['outgoing', 'incoming', 'both'],
        },
        edgeTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by edge types (e.g., ["CALLS", "CONTAINS"]). Omit for all.',
        },
      },
      required: ['semanticId'],
    },
  },
  {
    name: 'traverse_graph',
    description: `Traverse the graph using BFS from start nodes, following specific edge types.

Use this for:
- Impact analysis: "What's affected if I change this?" (outgoing CALLS, DEPENDS_ON)
- Dependency trees: "What does this module import?" (outgoing IMPORTS_FROM)
- Reverse dependencies: "Who depends on this?" (incoming DEPENDS_ON)
- Reachability: "Can data flow from X to Y?" (outgoing FLOWS_INTO, ASSIGNED_FROM)

Returns nodes with depth info (0 = start, 1 = direct neighbor, 2+ = transitive).

Direction:
- outgoing: Follow edges FROM start nodes (default)
- incoming: Follow edges TO start nodes

Examples:
- All transitive callers: traverse_graph(startNodeIds=[fnId], edgeTypes=["CALLS"], direction="incoming")
- Module dependency tree: traverse_graph(startNodeIds=[modId], edgeTypes=["IMPORTS_FROM"], maxDepth=10)

Tip: Start with maxDepth=5. Use get_schema(type="edges") to find valid edge type names.`,
    inputSchema: {
      type: 'object',
      properties: {
        startNodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Starting node IDs (semantic IDs)',
        },
        edgeTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Edge types to follow (e.g., ["CALLS", "DEPENDS_ON"]). Use get_schema to see available types.',
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum traversal depth (default: 5, max: 20)',
        },
        direction: {
          type: 'string',
          description: 'Traversal direction: outgoing or incoming (default: outgoing)',
          enum: ['outgoing', 'incoming'],
        },
      },
      required: ['startNodeIds', 'edgeTypes'],
    },
  },
];
