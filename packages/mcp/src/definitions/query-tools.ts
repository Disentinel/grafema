/**
 * Query Tools — graph querying and tracing
 */

import type { ToolDefinition } from './types.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../utils.js';

export const QUERY_TOOLS: ToolDefinition[] = [
  {
    name: 'query_graph',
    description: `Execute a Datalog query on the code graph.

Available predicates:
- type(Id, Type) - match nodes by type (alias: node)
- edge(Src, Dst, Type) - match edges
- attr(Id, Name, Value) - match node attributes (name, file, line, etc.)

NODE TYPES:
- MODULE, FUNCTION, METHOD, CLASS, VARIABLE, PARAMETER
- CALL, PROPERTY_ACCESS, METHOD_CALL, CALL_SITE
- http:route, http:request, db:query, socketio:emit, socketio:on

EDGE TYPES:
- CONTAINS, CALLS, DEPENDS_ON, ASSIGNED_FROM, INSTANCE_OF, PASSES_ARGUMENT

EXAMPLES:
  violation(X) :- node(X, "MODULE").
  violation(X) :- node(X, "FUNCTION"), attr(X, "file", "src/api.js").
  violation(X) :- node(X, "CALL"), \\+ edge(X, _, "CALLS").`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Datalog query. Must define violation/1 predicate for results.',
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
    description: `Find all calls to a specific function or method.
Returns call sites with file locations and whether they're resolved.`,
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

Supports partial matches on name and file. Use limit/offset for pagination.`,
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
      },
      required: ['source'],
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
];
