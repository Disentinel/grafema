/**
 * MCP Tool Definitions
 */

import { DEFAULT_LIMIT, MAX_LIMIT } from './utils.js';

interface SchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
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
          description: 'Topic: queries, types, guarantees, onboarding, or overview',
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
    name: 'read_project_structure',
    description: `Get the directory structure of the project.
Returns a tree of files and directories, useful for understanding
project layout during onboarding.

Excludes: node_modules, .git, dist, build, .grafema, coverage, .next, .nuxt

Use this tool when studying a new project to identify services,
packages, and entry points.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Subdirectory to scan (relative to project root). Default: project root.',
        },
        depth: {
          type: 'number',
          description: 'Maximum directory depth (default: 3, max: 5)',
        },
        include_files: {
          type: 'boolean',
          description: 'Include files in output, not just directories (default: true)',
        },
      },
    },
  },
  {
    name: 'write_config',
    description: `Write or update the Grafema configuration file (.grafema/config.yaml).
Validates all inputs before writing. Creates .grafema/ directory if needed.

Use this tool after studying the project to save the discovered configuration.
Only include fields you want to override — defaults are used for omitted fields.`,
    inputSchema: {
      type: 'object',
      properties: {
        services: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Service name (e.g., "backend")' },
              path: { type: 'string', description: 'Path relative to project root (e.g., "apps/backend")' },
              entryPoint: { type: 'string', description: 'Entry point file relative to service path (e.g., "src/index.ts")' },
            },
            required: ['name', 'path'],
          },
          description: 'Service definitions (leave empty to use auto-discovery)',
        },
        plugins: {
          type: 'object',
          properties: {
            indexing: { type: 'array', items: { type: 'string' }, description: 'Indexing plugins' },
            analysis: { type: 'array', items: { type: 'string' }, description: 'Analysis plugins' },
            enrichment: { type: 'array', items: { type: 'string' }, description: 'Enrichment plugins' },
            validation: { type: 'array', items: { type: 'string' }, description: 'Validation plugins' },
          },
          description: 'Plugin configuration (omit to use defaults)',
        },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns for files to include (e.g., ["src/**/*.ts"])',
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns for files to exclude (e.g., ["**/*.test.ts"])',
        },
        workspace: {
          type: 'object',
          properties: {
            roots: {
              type: 'array',
              items: { type: 'string' },
              description: 'Root directories for multi-root workspace',
            },
          },
          description: 'Multi-root workspace config (only for workspaces)',
        },
      },
    },
  },
];
