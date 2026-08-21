/**
 * Context Tools — the unified node inspector (get_node) + find_guards
 */

import type { ToolDefinition } from './types.js';

export const CONTEXT_TOOLS: ToolDefinition[] = [
  {
    name: 'get_node',
    description: `Inspect a single node — the unified node-detail tool for the code graph (and knowledge graph).

\`target\` is a semantic ID (from find_nodes/query_graph), a node name, or a file path.

Set \`detail\` to choose how much to return:
- "record" — the raw node record only (fast lookup, no edges).
- "neighbors" — direct incoming/outgoing edges grouped by type (no source code).
- "context" (default) — source code at the node + full graph neighborhood with code context at
  each connected node.
- "full" — for a FUNCTION/METHOD: comprehensive details incl. callers and callees (transitive
  call chains).

Smart defaults by node kind (when detail is omitted/"context"):
- a MODULE / file path → a file overview (imports, exports, classes, functions, variables).
- a CLASS / INTERFACE / typed variable → its shape (methods + properties, incl. inherited).
- otherwise → the source + neighborhood context described above.

Set \`format\`:
- "json" (default) — structured text + JSON.
- "dsl" — compact Grafema DSL notation of the node's neighborhood (archetype-grouped operators;
  great for LLM context windows). With format="dsl" you may pass \`perspective\` to filter
  archetypes: "security", "data", "errors", "api", "events", and \`context_lines\` maps to DSL depth.

Set \`graph\` to "knowledge" to inspect an entity in the project knowledge graph (its edges and
metadata) instead of the code graph (default "code").

Other params: \`edge_types\` (filter neighbors), \`context_lines\` (source context lines / DSL depth),
\`file\` (disambiguate a name).`,
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Semantic ID, node name, or file path to inspect.',
        },
        file: {
          type: 'string',
          description: 'File path to disambiguate a name (optional).',
        },
        detail: {
          type: 'string',
          description: 'record | neighbors | context (default) | full',
          enum: ['record', 'neighbors', 'context', 'full'],
        },
        format: {
          type: 'string',
          description: 'json (default) | dsl (compact Grafema notation)',
          enum: ['json', 'dsl'],
        },
        graph: {
          type: 'string',
          description: 'Which graph: "code" (default) or "knowledge".',
          enum: ['code', 'knowledge'],
        },
        edge_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter neighbors/context to these edge types (e.g. ["CALLS","ASSIGNED_FROM"]).',
        },
        perspective: {
          type: 'string',
          description: 'Archetype filter for format="dsl": security | data | errors | api | events',
          enum: ['security', 'data', 'errors', 'api', 'events'],
        },
        context_lines: {
          type: 'number',
          description: 'Source context lines around each reference (default 3); for format="dsl", the notation depth.',
        },
      },
      required: ['target'],
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
