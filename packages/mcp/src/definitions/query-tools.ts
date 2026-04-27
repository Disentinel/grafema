/**
 * Query Tools — graph querying and tracing
 */

import type { ToolDefinition } from './types.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../utils.js';

export const QUERY_TOOLS: ToolDefinition[] = [
  {
    name: 'query_graph',
    description: `Execute a Datalog or Cypher query on the code graph.

Set language to "cypher" for Cypher queries (e.g., MATCH (n:FUNCTION) RETURN n.name).
Default is Datalog.

Available Datalog predicates:
- type(Id, Type) / node(Id, Type) - match nodes by type
- edge(Src, Dst, Type) - match edges
- attr(Id, Name, Value) - match node attributes (name, file, line, etc.)
- gt(Val, N), lt(Val, N), gte(Val, N), lte(Val, N) - numeric comparisons
- \\+ - negation (not)

NODE TYPES:
- MODULE, FUNCTION, METHOD, CLASS, VARIABLE, PARAMETER
- CALL, PROPERTY_ACCESS, METHOD_CALL, CALL_SITE
- METRIC (performance metrics: value/unit/source in metadata, OBSERVES → MODULE)
- ISSUE (analysis problems: category/severity/message in metadata, CONTAINS ← MODULE)
- http:route, http:request, db:query, socketio:emit, socketio:on

EDGE TYPES:
- CONTAINS, CALLS, DEPENDS_ON, ASSIGNED_FROM, INSTANCE_OF, PASSES_ARGUMENT
- OBSERVES (METRIC → MODULE, links performance metric to observed file)

EXAMPLES:
  violation(X) :- node(X, "MODULE").
  violation(X) :- node(X, "FUNCTION"), attr(X, "file", "src/api.js").
  violation(X) :- node(X, "CALL"), \\+ edge(X, _, "CALLS").
  violation(F, Ms) :- node(M, "METRIC"), attr(M, "name", "parse_ms"), attr(M, "value", Ms), gte(Ms, 500), edge(M, Mod, "OBSERVES"), attr(Mod, "file", F).`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Datalog query (must define violation/1 predicate) or Cypher query (when language is "cypher").',
        },
        language: {
          type: 'string',
          description: 'Query language: "datalog" (default) or "cypher"',
          enum: ['datalog', 'cypher'],
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
          description: 'Show step-by-step query execution to debug empty results',
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
    name: 'find_nodes',
    description: `Find nodes in the graph by type, name, or file pattern.

Use this when you need to:
- Find all functions in a specific file: type="FUNCTION", file="src/api.js"
- Find a class by name: type="CLASS", name="UserService"
- List all HTTP routes: type="http:route"
- Get all modules in a directory: type="MODULE", file="services/"

Returns semantic IDs that you can pass to get_context, get_node, get_neighbors, or find_guards.

Supports partial matches on name and file. When a name filter returns no exact matches, automatically falls back to fuzzy name matching using token similarity (CamelCase/snake_case aware). Use limit/offset for pagination.`,
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
          description: 'File path pattern',
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
    name: 'trace_alias',
    description: `Trace an alias chain to find the original source.
For code like: const alias = obj.method; alias();
This traces "alias" back to "obj.method".`,
    inputSchema: {
      type: 'object',
      properties: {
        variableName: {
          type: 'string',
          description: 'Variable name to trace',
        },
        file: {
          type: 'string',
          description: 'File path where the variable is defined',
        },
      },
      required: ['variableName', 'file'],
    },
  },
  {
    name: 'trace_dataflow',
    description: `Trace data flow paths from or to a variable/expression.

Use this when you need to:
- Forward trace: "Where does this value flow to?" (assignments, function calls, returns)
- Backward trace: "Where does this value come from?" (sources, assignments)
- Both: Full data lineage from sources to sinks

Direction options:
- forward: Follow ASSIGNED_FROM, PASSES_ARGUMENT, FLOWS_INTO edges downstream
- backward: Follow edges upstream to find data sources
- both: Trace in both directions for complete context

Use cases:
- Track tainted data: "Does user input reach database query?" (forward from input)
- Find data sources: "What feeds this API response?" (backward from response)
- Impact analysis: "If I change this variable, what breaks?" (forward trace)

Returns: List of nodes in the data flow chain with edge types and depth.
Tip: Start with max_depth=5, increase if needed.`,
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Variable or node ID to trace from',
        },
        file: {
          type: 'string',
          description: 'File path',
        },
        direction: {
          type: 'string',
          description: 'forward, backward, or both (default: forward)',
          enum: ['forward', 'backward', 'both'],
        },
        max_depth: {
          type: 'number',
          description: 'Maximum trace depth (default: 10)',
        },
        limit: {
          type: 'number',
          description: `Max results (default: ${DEFAULT_LIMIT})`,
        },
        detail: {
          type: 'string',
          description: 'Level of detail: summary (counts only), normal (auto-compressed, default), full (every node)',
          enum: ['summary', 'normal', 'full'],
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'trace_calls',
    description: `Trace call chains from or to a function/method, following CALLS and CALLS_REMOTE edges transitively.

Use this when you need to:
- "What does this function eventually call?" (forward) — full call tree including cross-language hops
- "Who calls this function?" (backward) — all callers up the stack
- "Show the full call chain from handler to database" (forward with depth)

Unlike trace_dataflow (which follows data assignments), this follows function CALLS edges:
- CALLS: same-language function/method invocation
- CALLS_REMOTE: cross-process/language boundary (IPC, HTTP, socket)

Returns: Indented call tree showing each hop with file:line location.`,
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Function/method name or semantic ID to trace from',
        },
        file: {
          type: 'string',
          description: 'File path to disambiguate (optional)',
        },
        direction: {
          type: 'string',
          description: 'forward (callees), backward (callers), or both (default: forward)',
          enum: ['forward', 'backward', 'both'],
        },
        max_depth: {
          type: 'number',
          description: 'Maximum chain depth (default: 10)',
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'trace_effects',
    description: `Trace transitive side effects of a function through its call graph.

For any function, traverses CALLS edges (DFS) and collects effects from leaf nodes
using the effects-db (Node.js builtins, npm packages).

Use this when you need to:
- "What side effects does this function have?" → direct + transitive effects
- "Does this handler do IO?" → trace shows IO:FILE:READ from fs.readFileSync at depth 3
- "Where does the fetch() call come from?" → leaf_sources shows the origin at depth N
- "What crosses module boundaries?" → boundary_crossings shows file-to-file effect flow

Effect types: PURE, MUTATION, IO (with subtypes like IO:FILE:READ, IO:HTTP:REQUEST),
THROW, ASYNC, NONDETERMINISTIC, UNKNOWN.

UNKNOWN means: unresolved call, external package not in effects-db, or depth limit reached.

Returns: direct effects, transitive effects, boundary crossings, leaf sources.`,
    inputSchema: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Function/method name or semantic ID',
        },
        file: {
          type: 'string',
          description: 'File path to disambiguate (optional)',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum call graph traversal depth (default: 10)',
        },
      },
      required: ['node'],
    },
  },
  {
    name: 'get_shape',
    description: `Get the shape (methods + properties) of a CLASS, INTERFACE, or typed variable.

Shows all members including inherited ones via EXTENDS chain. For variables,
follows INSTANCE_OF to find the type, then returns its shape.

Use this to understand:
- "What methods does GraphBackend have?" → get_shape(target="GraphBackend")
- "What can I call on this variable?" → get_shape(target="db", file="handlers.ts")
- "What does this interface require?" → get_shape(target="NodeRecord")

Returns: members (methods + properties), extends chain, implements list.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'CLASS, INTERFACE, or variable name (or semantic ID)',
        },
        file: {
          type: 'string',
          description: 'File path to disambiguate (optional)',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'explain',
    description: `Explain a code element using graph data — returns structured context + prompt for the LLM to summarize.

Unlike other tools that return raw data, this tool returns graph query results
PLUS a natural-language prompt asking the calling LLM to explain the results
to the user. The LLM uses its own reasoning to produce a human-readable summary.

No extra API calls needed — the calling model (Claude, GPT, etc.) does the summarization.

Use cases:
- "Explain where this value comes from" → dataflow trace + summarization prompt
- "What does this function do?" → structure + calls + prompt to describe
- "How is this variable used?" → forward trace + prompt to explain usage patterns

The question parameter guides what graph data to fetch and how to frame the summary.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Variable, function, or node name to explain',
        },
        file: {
          type: 'string',
          description: 'File path to narrow scope',
        },
        question: {
          type: 'string',
          description: 'What to explain: "where does this value come from?", "what does this function do?", "how is this used?" (default: general explanation)',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'check_invariant',
    description: `Check a one-off code invariant using a Datalog rule. Returns violations if broken.

Use this for ad-hoc checks without saving a permanent guarantee.
For persistent rules, use create_guarantee + check_guarantees instead.

Use cases:
- Quick check: "Are there any eval() calls?" — rule: violation(X) :- node(X, "CALL"), attr(X, "name", "eval").
- Audit: "Functions over 100 lines?" — check for excessive complexity
- Pre-commit: "Any new SQL injection risks?" — one-time check before pushing

Returns: List of nodes violating the rule, with file and line info.`,
    inputSchema: {
      type: 'object',
      properties: {
        rule: {
          type: 'string',
          description: 'Datalog rule defining violation/1',
        },
        description: {
          type: 'string',
          description: 'Human-readable description',
        },
        limit: {
          type: 'number',
          description: `Max violations (default: ${DEFAULT_LIMIT})`,
        },
        offset: {
          type: 'number',
          description: 'Skip first N violations (default: 0)',
        },
      },
      required: ['rule'],
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
