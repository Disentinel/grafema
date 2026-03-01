/**
 * Context Tools — node details, context, file overview, guards
 */

import type { ToolDefinition } from './types.js';

export const CONTEXT_TOOLS: ToolDefinition[] = [
  {
    name: 'get_function_details',
    description: `Get comprehensive details about a function, including what it calls and who calls it.

Graph structure:
  FUNCTION -[HAS_SCOPE]-> SCOPE -[CONTAINS]-> CALL/METHOD_CALL
  CALL -[CALLS]-> FUNCTION (target)

Returns:
- Function metadata (name, file, line, async)
- calls: What functions/methods this function calls
- calledBy: What functions call this one

For calls array:
- resolved=true means target function was found
- resolved=false means unknown target (external/dynamic)
- type='CALL' for function calls like foo()
- type='METHOD_CALL' for method calls like obj.method()
- depth field shows transitive level (0=direct, 1+=indirect)

Use transitive=true to follow call chains (A calls B calls C).
Max transitive depth is 5 to prevent explosion.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Function name to look up',
        },
        file: {
          type: 'string',
          description: 'Optional: file path to disambiguate (partial match)',
        },
        transitive: {
          type: 'boolean',
          description: 'Follow call chains recursively (default: false)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_context',
    description: `Get deep context for a graph node: source code + full graph neighborhood.

Shows ALL incoming and outgoing edges grouped by type, with source code
at each connected node's location. Works for ANY node type.

Use this after find_nodes or query_graph to deep-dive into a specific node.

Output includes:
- Node info (type, name, semantic ID, location)
- Source code at the node's location
- All outgoing edges (what this node connects to)
- All incoming edges (what connects to this node)
- Code context at each connected node's location

Primary edges (CALLS, ASSIGNED_FROM, DEPENDS_ON, etc.) include code context.
Structural edges (CONTAINS, HAS_SCOPE, etc.) are shown in compact form.`,
    inputSchema: {
      type: 'object',
      properties: {
        semanticId: {
          type: 'string',
          description: 'Exact semantic ID of the node (from find_nodes or query_graph)',
        },
        contextLines: {
          type: 'number',
          description: 'Lines of code context around each reference (default: 3)',
        },
        edgeType: {
          type: 'string',
          description: 'Filter by edge type (comma-separated, e.g., "CALLS,ASSIGNED_FROM")',
        },
      },
      required: ['semanticId'],
    },
  },
  {
    name: 'get_file_overview',
    description: `Understand what a file does without reading it — shows structure and relationships from the graph.

USE THIS FIRST when you need to understand a file. It replaces reading the file with
a structured summary: imports, exports, classes, functions, variables, and how they
connect to the rest of the codebase.

Returns:
- Imports: what modules are pulled in and which names
- Exports: what the file exposes to others
- Classes: with methods and their call targets
- Functions: with what they call
- Variables: with their assignment sources

After this, use get_context with specific node IDs to deep-dive into relationships.`,
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'File path (relative to project root or absolute)',
        },
        include_edges: {
          type: 'boolean',
          description:
            'Include relationship edges like CALLS, EXTENDS (default: true). Set false for faster results.',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'find_guards',
    description: `Find conditional guards protecting a node.

Returns all SCOPE nodes that guard the given node, walking from inner to outer scope.
Useful for answering "what conditions must be true for this code to execute?"

Each guard includes:
- scopeId: The SCOPE node ID
- scopeType: Type of conditional (if_statement, else_statement, etc.)
- condition: Raw condition text (e.g., "user !== null")
- constraints: Parsed constraints (if available)
- file/line: Location in source

Example use cases:
- "What conditions guard this API call?"
- "Is this code protected by a null check?"
- "What's the full guard chain for this function call?"`,
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'ID of the node to find guards for (e.g., CALL, VARIABLE)',
        },
      },
      required: ['nodeId'],
    },
  },
];
