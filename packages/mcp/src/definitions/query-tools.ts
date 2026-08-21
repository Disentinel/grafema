/**
 * Query Tools — graph querying and tracing (code graph + knowledge graph)
 */

import type { ToolDefinition } from './types.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../utils.js';

export const QUERY_TOOLS: ToolDefinition[] = [
  {
    name: 'query_graph',
    description: `Execute a Datalog, Cypher, or GraphQL query on a graph.

This is the general query tool. Set \`language\`:
- "datalog" (default) — pattern matching with a violation/1 rule. Also use this to run a
  one-off invariant/violation check (the rule IS the query; no separate check_invariant tool).
- "cypher" — MATCH (n:FUNCTION) RETURN n.name
- "graphql" — typed nested queries; pass the GraphQL document as \`query\`. Use GraphQL when
  you need node + edges + neighbors in one shot.

Set \`graph\`:
- "code" (default) — the code graph (functions, calls, dataflow, modules…)
- "knowledge" — the project knowledge graph (asserted facts, decisions, documents). With
  graph="knowledge", filter by node type/domain/name (see find_nodes for the field-filter form).

Available Datalog predicates:
- type(Id, Type) / node(Id, Type) - match nodes by type
- edge(Src, Dst, Type) - match edges
- attr(Id, Name, Value) - match node attributes (name, file, line, etc.)
- gt(Val, N), lt(Val, N), gte(Val, N), lte(Val, N) - numeric comparisons
- \\+ - negation (not)

NODE TYPES (code graph):
- MODULE, FUNCTION, METHOD, CLASS, VARIABLE, PARAMETER
- CALL, PROPERTY_ACCESS, METHOD_CALL, CALL_SITE
- METRIC, ISSUE, http:route, http:request, db:query, socketio:emit, socketio:on

EDGE TYPES:
- CONTAINS, CALLS, DEPENDS_ON, ASSIGNED_FROM, INSTANCE_OF, PASSES_ARGUMENT, OBSERVES

EXAMPLES:
  violation(X) :- node(X, "FUNCTION"), attr(X, "file", "src/api.js").
  violation(X) :- node(X, "CALL"), attr(X, "name", "eval").          // one-off invariant
  violation(X) :- node(X, "CALL"), \\+ edge(X, _, "CALLS").`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Datalog query (must define violation/1), Cypher query, or GraphQL document (per language).',
        },
        language: {
          type: 'string',
          description: 'Query language: "datalog" (default), "cypher", or "graphql"',
          enum: ['datalog', 'cypher', 'graphql'],
        },
        graph: {
          type: 'string',
          description: 'Which graph to query: "code" (default) or "knowledge".',
          enum: ['code', 'knowledge'],
        },
        limit: {
          type: 'number',
          description: `Max results to return (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
        },
        offset: {
          type: 'number',
          description: 'Skip first N results for pagination (default: 0)',
        },
        explain: {
          type: 'boolean',
          description: 'Show step-by-step query execution to debug empty results (datalog only)',
        },
        count: {
          type: 'boolean',
          description: 'When true, returns only the count of matching results instead of the full result list',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_nodes',
    description: `Find nodes in a graph by type, name, or file pattern.

Use this when you need to:
- Find all functions in a specific file: type="FUNCTION", file="src/api.js"
- Find a class by name: type="CLASS", name="UserService"
- List all HTTP routes: type="http:route"
- Get all modules in a directory: type="MODULE", file="services/"
- Filter knowledge nodes: graph="knowledge", type="decision", file="<domain>" (domain is stored in the file field)

Set \`graph\` to "knowledge" to filter the project knowledge graph instead of the code graph
(default "code").

Returns semantic IDs that you can pass to get_node, trace, or find_guards.

Supports partial matches on name and file. When a name filter returns no exact matches on the
code graph, automatically falls back to fuzzy name matching (CamelCase/snake_case aware).
Use limit/offset for pagination.`,
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Node type (e.g., FUNCTION, CLASS, MODULE, PROPERTY_ACCESS)',
        },
        name: {
          type: 'string',
          description: 'Node name pattern',
        },
        file: {
          type: 'string',
          description: 'File path pattern (code graph) or domain (knowledge graph)',
        },
        graph: {
          type: 'string',
          description: 'Which graph to search: "code" (default) or "knowledge".',
          enum: ['code', 'knowledge'],
        },
        limit: {
          type: 'number',
          description: `Max results (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
        },
        offset: {
          type: 'number',
          description: 'Skip first N results (default: 0)',
        },
      },
    },
  },
  {
    name: 'find_calls',
    description: `Find every place in the codebase that calls a specific function or method.

Use this when you need to answer:
- "Who calls getUserById?" → name="getUserById"
- "Where is redis.get used?" → name="get", className="redis"
- "Is this function dead code?" → if 0 calls found, likely unused

Returns file, line, and whether the call target is resolved (linked to its definition in the graph).`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Function or method name to find calls for',
        },
        className: {
          type: 'string',
          description: 'Optional: class name for method calls',
        },
        limit: {
          type: 'number',
          description: `Max results (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
        },
        offset: {
          type: 'number',
          description: 'Skip first N results (default: 0)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'trace',
    description: `Trace relationships transitively from a source node — the unified traversal tool.

Set \`along\` to pick what to follow:
- "data" — data flow (ASSIGNED_FROM, PASSES_ARGUMENT, FLOWS_INTO). "Where does this value flow
  to / come from?"
- "calls" — the call graph (CALLS, CALLS_REMOTE), incl. cross-language hops. "What does this call /
  who calls this?"
- "effects" — transitive side effects through the call graph (IO, MUTATION, THROW…), using the
  effects-db. direction is ignored (always forward).
- "alias" — an alias chain back to its original source (const alias = obj.method; alias()).
  requires \`file\`; direction is ignored.
- "edges" — generic BFS following the given \`edge_types\` (impact analysis, dependency trees,
  reachability). Requires edge_types.

Set \`direction\`: "forward" (default), "backward", or "both" (data/calls/edges).

Set \`graph\` to "knowledge" to traverse the project knowledge graph instead of the code graph
(generic relation BFS; pass edge_types to filter relations, default "code").

Examples:
  trace(source="userInput", along="data", direction="forward")
  trace(source="handleRequest", along="calls", direction="backward")
  trace(source="processOrder", along="effects")
  trace(source="<modId>", along="edges", edge_types=["IMPORTS_FROM"], max_depth=10)
  trace(source="RFDB", along="edges", graph="knowledge", edge_types=["depends_on","uses"])`,
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Variable, function/method name, or semantic ID to trace from',
        },
        file: {
          type: 'string',
          description: 'File path to disambiguate (required for along="alias")',
        },
        along: {
          type: 'string',
          description: 'What to follow: "data", "calls", "effects", "alias", or "edges" (default: "calls")',
          enum: ['data', 'calls', 'effects', 'alias', 'edges'],
        },
        direction: {
          type: 'string',
          description: 'forward (default), backward, or both (data/calls/edges)',
          enum: ['forward', 'backward', 'both'],
        },
        edge_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Edge/relation types to follow for along="edges" (e.g., ["CALLS","DEPENDS_ON"]).',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum traversal depth (default: 10; edges default 5, max 20)',
        },
        detail: {
          type: 'string',
          description: 'Detail level for along="data": summary, normal (default), full',
          enum: ['summary', 'normal', 'full'],
        },
        graph: {
          type: 'string',
          description: 'Which graph to traverse: "code" (default) or "knowledge" (along="edges").',
          enum: ['code', 'knowledge'],
        },
        limit: {
          type: 'number',
          description: `Max results for along="data" (default: ${DEFAULT_LIMIT})`,
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'explain_datalog',
    description: `Explain or simulate derived (Datalog) facts — the provenance/what-if tool.

Set \`mode\`:
- "fact" — explain WHY a derived fact holds: the rule that derived it + supporting body facts.
  Requires predicate + key. "Why does module A depend on B?"
  explain_datalog(mode="fact", predicate="depends", key=["<A_id>","<B_id>"])
- "gap" — explain why a fact does NOT hold (why-not): the satisfied premise prefix and the first
  premise no binding satisfies (a MISSING positive premise, or a PRESENT negated one).
  Requires predicate + key.
- "sim" — predict which NEW derived facts a hypothetical overlay of nodes/edges would create,
  WITHOUT committing anything. Requires predicate + at least one hypothetical node or edge.
  explain_datalog(mode="sim", predicate="depends", edges=[{src:"<A_id>",dst:"<B_id>",edgeType:"IMPORTS_FROM"}])

Default program is the bundled depends.dl (so the common predicate is "depends"). Pass \`source\`
for a custom Datalog program. Keys/ids are wire-string terms (node ids as decimal).`,
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: 'Which explanation: "fact" (why), "gap" (why-not), or "sim" (what-if).',
          enum: ['fact', 'gap', 'sim'],
        },
        predicate: {
          type: 'string',
          description: 'The derived predicate (e.g. "depends").',
        },
        key: {
          type: 'array',
          items: { type: 'string' },
          description: "The fact's ground key tuple as wire-string terms (required for mode fact/gap).",
        },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Decimal node id (may be a new, invented id).' },
              nodeType: { type: 'string', description: 'Node type (e.g. "MODULE").' },
              name: { type: 'string', description: 'Node name attr.' },
              file: { type: 'string', description: 'Node file attr.' },
            },
            required: ['id', 'nodeType'],
          },
          description: 'Hypothetical nodes to overlay (mode="sim").',
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              src: { type: 'string', description: 'Source node id (existing or hypothetical).' },
              dst: { type: 'string', description: 'Target node id (existing or hypothetical).' },
              edgeType: { type: 'string', description: 'Edge type (e.g. "IMPORTS_FROM").' },
            },
            required: ['src', 'dst', 'edgeType'],
          },
          description: 'Hypothetical edges to overlay (mode="sim").',
        },
        source: {
          type: 'string',
          description: 'Optional Datalog program (derive engine); empty/omitted ⇒ the bundled depends.dl.',
        },
      },
      required: ['mode', 'predicate'],
    },
  },
  {
    name: 'find_shared_behaviors',
    description: `List clusters of FEATUREs whose entry-points share an identical BEHAVIOR (same forward-slice hash).

Surfaces cross-modality duplication — e.g. "this CLI command is a thin wrapper around the
same library function as that HTTP endpoint" or "this MCP tool and that VS Code command
delegate to identical logic".

Each cluster contains:
  - hash:           sha256 of the shared transitive call set (BEHAVIOR.metadata.hash)
  - effects:        transitive effects (IO, MUTATION, …) attributed to the shared behavior
  - coreNodeCount:  size of the shared forward slice
  - features:       array of { id, type, name, file } — the FEATUREs that share this behavior

Cluster types are FEATURE node types: cli:command, mcp:tool, vscode:command (and any future
domain types created by enrichers).

Returns clusters ordered by size (largest first), then hash (deterministic tie-break).
Empty result means every FEATURE has a unique implementation.`,
    inputSchema: {
      type: 'object',
      properties: {
        minClusterSize: {
          type: 'number',
          description: 'Minimum FEATUREs per cluster (default: 2). Values below 2 are clamped to 2.',
        },
        limit: {
          type: 'number',
          description: 'Maximum clusters to return (default: 100).',
        },
      },
    },
  },
];
