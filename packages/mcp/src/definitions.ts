/**
 * MCP Tool Definitions
 */

import { DEFAULT_LIMIT, MAX_LIMIT } from './utils.js';

interface SchemaProperty {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, SchemaProperty>;
    required?: string[];
  };
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'query_graph',
    description: `Execute a Datalog query on the code graph.

Available predicates:
- node(Id, Type) - match nodes by type
- edge(Src, Dst, Type) - match edges
- attr(Id, Name, Value) - match node attributes (name, file, line, etc.)

NODE TYPES:
- MODULE, FUNCTION, METHOD, CLASS, VARIABLE, PARAMETER
- CALL, METHOD_CALL, CALL_SITE
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
    description: `Find nodes in the graph by type, name, or file.`,
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Node type (e.g., FUNCTION, CLASS, MODULE)',
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
    description: `Trace data flow from/to a variable or expression.`,
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
    description: `Check a code invariant using a Datalog rule.
Returns violations if the invariant is broken.`,
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
    name: 'discover_services',
    description: `Discover services in the project without full analysis.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'analyze_project',
    description: `Run full analysis on the project or a specific service.`,
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Optional: analyze only this service',
        },
        force: {
          type: 'boolean',
          description: 'Force re-analysis even if already analyzed',
        },
        index_only: {
          type: 'boolean',
          description: 'Only index modules, skip full analysis',
        },
      },
    },
  },
  {
    name: 'get_analysis_status',
    description: `Get the current analysis status and progress.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_stats',
    description: `Get graph statistics: node and edge counts by type.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_schema',
    description: `Get the graph schema: available node and edge types.`,
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'nodes, edges, or all (default: all)',
          enum: ['nodes', 'edges', 'all'],
        },
      },
    },
  },
  // Guarantee tools
  {
    name: 'create_guarantee',
    description: `Create a new code guarantee.

Two types supported:
1. Datalog-based: Uses rule field with Datalog query (violation/1)
2. Contract-based: Uses type + schema for JSON validation

Examples:
- Datalog: name="no-eval" rule="violation(X) :- node(X, \"CALL\"), attr(X, \"name\", \"eval\")."
- Contract: name="orders" type="guarantee:queue" priority="critical" schema={...}`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Unique name for the guarantee',
        },
        // Datalog-based fields
        rule: {
          type: 'string',
          description: 'Datalog rule defining violation/1 (for Datalog-based guarantees)',
        },
        severity: {
          type: 'string',
          description: 'Severity for Datalog guarantees: error, warning, or info',
          enum: ['error', 'warning', 'info'],
        },
        // Contract-based fields
        type: {
          type: 'string',
          description: 'Guarantee type for contract-based: guarantee:queue, guarantee:api, guarantee:permission',
          enum: ['guarantee:queue', 'guarantee:api', 'guarantee:permission'],
        },
        priority: {
          type: 'string',
          description: 'Priority level: critical, important, observed, tracked',
          enum: ['critical', 'important', 'observed', 'tracked'],
        },
        status: {
          type: 'string',
          description: 'Lifecycle status: discovered, reviewed, active, changing, deprecated',
          enum: ['discovered', 'reviewed', 'active', 'changing', 'deprecated'],
        },
        owner: {
          type: 'string',
          description: 'Owner of the guarantee (team or person)',
        },
        schema: {
          type: 'object',
          description: 'JSON Schema for contract-based validation',
        },
        condition: {
          type: 'string',
          description: 'Condition expression for the guarantee',
        },
        description: {
          type: 'string',
          description: 'Human-readable description',
        },
        governs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Node IDs that this guarantee governs',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_guarantees',
    description: `List all defined guarantees.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'check_guarantees',
    description: `Check all guarantees or specific ones.`,
    inputSchema: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of guarantee names to check (omit to check all)',
        },
      },
    },
  },
  {
    name: 'delete_guarantee',
    description: `Delete a guarantee by name.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of guarantee to delete',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_coverage',
    description: `Get analysis coverage for a path.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to check coverage for',
        },
        depth: {
          type: 'number',
          description: 'Directory depth to report (default: 2)',
        },
      },
    },
  },
  {
    name: 'get_documentation',
    description: `Get documentation about Grafema usage.`,
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Topic: queries, types, guarantees, or overview',
        },
      },
    },
  },
  {
    name: 'report_issue',
    description: `Report a bug or issue with Grafema to GitHub.

Use this tool when you encounter:
- Unexpected errors or crashes
- Incorrect analysis results
- Missing features that should exist
- Documentation issues

The tool will create a GitHub issue automatically if GITHUB_TOKEN is configured.
If not configured, it will return a pre-formatted issue template that the user
can manually submit at https://github.com/Disentinel/grafema/issues/new

IMPORTANT: Always ask the user for permission before reporting an issue.
Include relevant context: error messages, file paths, query used, etc.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Brief issue title (e.g., "Query returns empty results for FUNCTION nodes")',
        },
        description: {
          type: 'string',
          description: 'Detailed description of the issue',
        },
        context: {
          type: 'string',
          description: 'Relevant context: error messages, queries, file paths, etc.',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Labels: bug, enhancement, documentation, question',
        },
      },
      required: ['title', 'description'],
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
