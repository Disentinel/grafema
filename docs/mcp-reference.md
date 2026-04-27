# Grafema feature catalogue

_45 features exported._

## Contents

- [`mcp:tool` `add_knowledge`](#mcptool-addknowledge)
- [`mcp:tool` `analyze_project`](#mcptool-analyzeproject)
- [`mcp:tool` `CallToolRequestSchema`](#mcptool-calltoolrequestschema)
- [`mcp:tool` `check_guarantees`](#mcptool-checkguarantees)
- [`mcp:tool` `check_invariant`](#mcptool-checkinvariant)
- [`mcp:tool` `create_guarantee`](#mcptool-createguarantee)
- [`mcp:tool` `delete_guarantee`](#mcptool-deleteguarantee)
- [`mcp:tool` `describe`](#mcptool-describe)
- [`mcp:tool` `discover_services`](#mcptool-discoverservices)
- [`mcp:tool` `explain`](#mcptool-explain)
- [`mcp:tool` `find_calls`](#mcptool-findcalls)
- [`mcp:tool` `find_guards`](#mcptool-findguards)
- [`mcp:tool` `find_nodes`](#mcptool-findnodes)
- [`mcp:tool` `find_shared_behaviors`](#mcptool-findsharedbehaviors)
- [`mcp:tool` `get_analysis_status`](#mcptool-getanalysisstatus)
- [`mcp:tool` `get_context`](#mcptool-getcontext)
- [`mcp:tool` `get_coverage`](#mcptool-getcoverage)
- [`mcp:tool` `get_documentation`](#mcptool-getdocumentation)
- [`mcp:tool` `get_file_overview`](#mcptool-getfileoverview)
- [`mcp:tool` `get_function_details`](#mcptool-getfunctiondetails)
- [`mcp:tool` `get_knowledge_stats`](#mcptool-getknowledgestats)
- [`mcp:tool` `get_neighbors`](#mcptool-getneighbors)
- [`mcp:tool` `get_node`](#mcptool-getnode)
- [`mcp:tool` `get_schema`](#mcptool-getschema)
- [`mcp:tool` `get_shape`](#mcptool-getshape)
- [`mcp:tool` `get_stats`](#mcptool-getstats)
- [`mcp:tool` `GetPromptRequestSchema`](#mcptool-getpromptrequestschema)
- [`mcp:tool` `list_guarantees`](#mcptool-listguarantees)
- [`mcp:tool` `ListPromptsRequestSchema`](#mcptool-listpromptsrequestschema)
- [`mcp:tool` `ListToolsRequestSchema`](#mcptool-listtoolsrequestschema)
- [`mcp:tool` `query_decisions`](#mcptool-querydecisions)
- [`mcp:tool` `query_graph`](#mcptool-querygraph)
- [`mcp:tool` `query_graphql`](#mcptool-querygraphql)
- [`mcp:tool` `query_knowledge`](#mcptool-queryknowledge)
- [`mcp:tool` `query_registry`](#mcptool-queryregistry)
- [`mcp:tool` `read_project_structure`](#mcptool-readprojectstructure)
- [`mcp:tool` `report_issue`](#mcptool-reportissue)
- [`mcp:tool` `supersede_fact`](#mcptool-supersedefact)
- [`mcp:tool` `TEST`](#mcptool-test)
- [`mcp:tool` `trace_alias`](#mcptool-tracealias)
- [`mcp:tool` `trace_calls`](#mcptool-tracecalls)
- [`mcp:tool` `trace_dataflow`](#mcptool-tracedataflow)
- [`mcp:tool` `trace_effects`](#mcptool-traceeffects)
- [`mcp:tool` `traverse_graph`](#mcptool-traversegraph)
- [`mcp:tool` `write_config`](#mcptool-writeconfig)

## `mcp:tool` `add_knowledge`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/knowledge-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Add a new knowledge node (decision, fact, session, etc.) to the knowledge base.

Use this when you:
- Make an architectural decision during a session → type: DECISION
- Discover a fact about the codebase → type: FACT
- Want to record a design session → type: SESSION
- Need to track a commit, ticket, incident, or author → type: COMMIT/TICKET/INCIDENT/AUTHOR

The node is persisted as a markdown file in the knowledge/ directory and tracked by git.
ID format: kb:<type>:<slug> — generated from type + slug. Slug collision = error (likely a duplicate; use supersede_fact instead).

Example: add_knowledge(type="DECISION", content="Use file-based storage for KB", slug="kb-file-based-storage", status="active", projections=["epistemic"])

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `string` | no |  | Node type |
| `content` | `string` | no |  | Markdown body content for the knowledge node |
| `slug` | `string` | yes |  | URL-safe slug for the ID (auto-generated from content if omitted). Format: lowercase, hyphens, digits. |
| `subtype` | `string` | yes |  | Subtype within the node type. FACT: domain, error, preference. DECISION: adr, runbook. Extensible — not restricted to these values. |
| `scope` | `string` | yes |  | Scope of applicability for this knowledge node |
| `relates_to` | `array` | yes |  | Semantic IDs of related nodes. Creates edges in edges.yaml. |
| `projections` | `array` | yes |  | Projections this node belongs to (e.g., "epistemic", "temporal", "organizational") |
| `status` | `string` | yes |  | Decision status (only for DECISION type) |
| `confidence` | `string` | yes |  | Confidence level (only for FACT type) |
| `effective_from` | `string` | yes |  | Date when decision took effect (YYYY-MM-DD, only for DECISION) |
| `applies_to` | `array` | yes |  | Semantic addresses of code this applies to (only for DECISION) |
| `task_id` | `string` | yes |  | Associated Linear task ID (only for SESSION) |

- Allowed for `type`: [DECISION, FACT, SESSION, COMMIT, FILE_CHANGE, AUTHOR, TICKET, INCIDENT]
- Allowed for `scope`: [global, project, module]
- Allowed for `status`: [active, superseded, deprecated, proposed]
- Allowed for `confidence`: [high, medium, low]

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `analyze_project`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/analysis-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Build the code graph by analyzing project source code.

REQUIRED before using query tools. Without analysis, the graph is empty.

Options:
- service: Analyze only one service (faster for multi-service projects)
- force: Re-analyze even if graph exists (use after code changes)
- index_only: Fast mode — create MODULE nodes only, skip detailed analysis

Phases: Discovery → Indexing → Analysis → Enrichment → Validation
Returns: Analysis summary with node/edge counts and timing.

Tip: Use get_stats after analysis to verify graph was built successfully.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `service` | `string` | yes |  | Optional: analyze only this service |
| `force` | `boolean` | yes |  | Force re-analysis even if already analyzed |
| `index_only` | `boolean` | yes |  | Only index modules, skip full analysis |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `CallToolRequestSchema`

**File**: `packages/mcp/src/server.ts`
**Modality**: `mcp:tool`

_No speced contract recovered for this feature._

### Behavior

- Effects: ASYNC, IO, IO:HTTP:REQUEST, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `check_guarantees`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/guarantee-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Validate code against defined guarantees and return violations.

Use this to:
- Find violations: Run all rules, get list of breaking code
- Verify specific rule: check_guarantees(names=["no-eval"]) — test one guarantee
- Pre-commit validation: Catch issues before code review
- After code changes: Verify you didn't break existing rules

Returns: Violations array with node IDs, file, line, rule name.
Empty array = all guarantees pass.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `names` | `array` | yes |  | List of guarantee names to check (omit to check all) |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `check_invariant`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Check a one-off code invariant using a Datalog rule. Returns violations if broken.

Use this for ad-hoc checks without saving a permanent guarantee.
For persistent rules, use create_guarantee + check_guarantees instead.

Use cases:
- Quick check: "Are there any eval() calls?" — rule: violation(X) :- node(X, "CALL"), attr(X, "name", "eval").
- Audit: "Functions over 100 lines?" — check for excessive complexity
- Pre-commit: "Any new SQL injection risks?" — one-time check before pushing

Returns: List of nodes violating the rule, with file and line info.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `rule` | `string` | no |  | Datalog rule defining violation/1 |
| `description` | `string` | yes |  | Human-readable description |
| `limit` | `number` | yes |  | Max violations (default: <expr>) |
| `offset` | `number` | yes |  | Skip first N violations (default: 0) |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `create_guarantee`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/guarantee-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Create a new code guarantee.

Two types supported:
1. Datalog-based: Uses rule field with Datalog query (violation/1)
2. Contract-based: Uses type + schema for JSON validation

Examples:
- Datalog: name="no-eval" rule="violation(X) :- node(X, \"CALL\"), attr(X, \"name\", \"eval\")."
- Contract: name="orders" type="guarantee:queue" priority="critical" schema={...}

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | no |  | Unique name for the guarantee |
| `rule` | `string` | yes |  | Datalog rule defining violation/1 (for Datalog-based guarantees) |
| `severity` | `string` | yes |  | Severity for Datalog guarantees: error, warning, or info |
| `type` | `string` | yes |  | Guarantee type for contract-based: guarantee:queue, guarantee:api, guarantee:permission |
| `priority` | `string` | yes |  | Priority level: critical, important, observed, tracked |
| `status` | `string` | yes |  | Lifecycle status: discovered, reviewed, active, changing, deprecated |
| `owner` | `string` | yes |  | Owner of the guarantee (team or person) |
| `schema` | `object` | yes |  | JSON Schema for contract-based validation |
| `condition` | `string` | yes |  | Condition expression for the guarantee |
| `description` | `string` | yes |  | Human-readable description |
| `governs` | `array` | yes |  | Node IDs that this guarantee governs |

- Allowed for `severity`: [error, warning, info]
- Allowed for `type`: [guarantee:queue, guarantee:api, guarantee:permission]
- Allowed for `priority`: [critical, important, observed, tracked]
- Allowed for `status`: [discovered, reviewed, active, changing, deprecated]

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `delete_guarantee`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/guarantee-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Delete a guarantee by name.

Use this when:
- A guarantee is no longer relevant to the codebase
- Replacing a guarantee with a new version (delete old, create new)
- Cleaning up experimental guarantees after testing

This permanently removes the guarantee. Use list_guarantees first to verify the name.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | no |  | Name of guarantee to delete |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `describe`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/notation-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Render a node's neighborhood as compact Grafema DSL notation.

Reduces verbose edge listings to archetype-grouped visual operators:
  o-  dependency/import
  >   outward flow (calls, delegates, passes)
  <   inward flow (reads, extends, receives)
  =>  persistent write (db, file, redis)
  >x  exception (throws, rejects)
  ~>> event/message (emits, publishes)
  ?|  conditional guard (if, case)
  |=  governance (governs, monitors)

Containment edges ({ }) define nesting structure.

Example output:
  login {
    o- imports bcrypt
    > calls UserDB.findByEmail, createToken
    < reads config.auth
    => writes session
    >x throws AuthError
    ~>> emits 'auth:login'
  }

Use depth to control detail:
  0 = names only (children listed, no edges)
  1 = edges (default — shows all relationship lines)
  2 = nested + folded (compressed view — repetitive siblings collapsed)
  3 = nested (exact — every node expanded, no folding)

10-30 lines vs 500+ lines of raw edge data. Ideal for LLM context windows.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `target` | `string` | no |  | Semantic ID, file path, or node name to describe |
| `depth` | `number` | yes |  | Level of detail: 0=names, 1=edges (default), 2=nested+folded (compressed), 3=nested (exact, no folding) |
| `perspective` | `string` | yes |  | Archetype filter preset: "security" (write,exception), "data" (flow_out,flow_in,write), "errors" (exception), "api" (flow_out,publishes,depends), "events" (publishes) |

- Allowed for `perspective`: [security, data, errors, api, events]

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `discover_services`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/analysis-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Discover services in the project without running full analysis.

Use this during onboarding to understand project structure BEFORE running analyze_project.

Returns:
- Service names and paths (e.g., "backend" at "apps/backend")
- Entry points (e.g., "src/index.ts")
- No graph data yet — this is fast discovery only

Workflow:
1. discover_services — see what's in the project
2. analyze_project — build graph for specific service or all
3. Query tools — explore the graph

Tip: If project has no .grafema/config.yaml, this scans for common patterns
(package.json, index.ts, etc.). Use write_config to save the configuration.

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `explain`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Explain a code element using graph data — returns structured context + prompt for the LLM to summarize.

Unlike other tools that return raw data, this tool returns graph query results
PLUS a natural-language prompt asking the calling LLM to explain the results
to the user. The LLM uses its own reasoning to produce a human-readable summary.

No extra API calls needed — the calling model (Claude, GPT, etc.) does the summarization.

Use cases:
- "Explain where this value comes from" → dataflow trace + summarization prompt
- "What does this function do?" → structure + calls + prompt to describe
- "How is this variable used?" → forward trace + prompt to explain usage patterns

The question parameter guides what graph data to fetch and how to frame the summary.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `target` | `string` | no |  | Variable, function, or node name to explain |
| `file` | `string` | yes |  | File path to narrow scope |
| `question` | `string` | yes |  | What to explain: "where does this value come from?", "what does this function do?", "how is this used?" (default: general explanation) |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `find_calls`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### When to use

"Who calls this?" — the structural question grep can't answer
because of aliases, re-exports, dynamic dispatch. Returns every
resolved call site of a function or method with file:line. The
callable side mirror of `trace_dataflow` (data side).

### Contract — mcp-inputSchema

Find every place in the codebase that calls a specific function or method.

Use this when you need to answer:
- "Who calls getUserById?" → name="getUserById"
- "Where is redis.get used?" → name="get", className="redis"
- "Is this function dead code?" → if 0 calls found, likely unused

Returns file, line, and whether the call target is resolved (linked to its definition in the graph).

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | no |  | Function or method name to find calls for |
| `className` | `string` | yes |  | Optional: class name for method calls |
| `limit` | `number` | yes |  | Max results (default: <expr>, max: <expr>) |
| `offset` | `number` | yes |  | Skip first N results (default: 0) |

### Examples

**Find all callers of a function**

```json
{ "name": "createTerminal" }
```

**Method on a specific class**

```json
{ "name": "get", "className": "redis" }
```

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- For methods, pass `className` to disambiguate when the same method name exists on multiple classes (`get`, `parse`, …).

### See also

- `mcp:tool:trace_alias`
- `mcp:tool:find_nodes`
- `cli:command:who`

## `mcp:tool` `find_guards`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/context-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Find conditional guards protecting a node.

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
- "What's the full guard chain for this function call?"

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `nodeId` | `string` | no |  | ID of the node to find guards for (e.g., CALL, VARIABLE) |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `find_nodes`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### When to use

Primary entry point for navigating the code graph. Find functions,
classes, modules, or any node by type and/or name pattern.
Replaces grep for structural questions: instead of "where is the
string `UserService`", ask "where is the CLASS named `UserService`."
Returns semantic IDs you can hand to other tools (`get_context`,
`find_calls`, `describe`).

### Contract — mcp-inputSchema

Find nodes in the graph by type, name, or file pattern.

Use this when you need to:
- Find all functions in a specific file: type="FUNCTION", file="src/api.js"
- Find a class by name: type="CLASS", name="UserService"
- List all HTTP routes: type="http:route"
- Get all modules in a directory: type="MODULE", file="services/"

Returns semantic IDs that you can pass to get_context, get_node, get_neighbors, or find_guards.

Supports partial matches on name and file. When a name filter returns no exact matches, automatically falls back to fuzzy name matching using token similarity (CamelCase/snake_case aware). Use limit/offset for pagination.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `string` | yes |  | Node type (e.g., FUNCTION, CLASS, MODULE, PROPERTY_ACCESS) |
| `name` | `string` | yes |  | Node name pattern |
| `file` | `string` | yes |  | File path pattern |
| `limit` | `number` | yes |  | Max results (default: <expr>, max: <expr>) |
| `offset` | `number` | yes |  | Skip first N results (default: 0) |

### Examples

**Find a class by name**

```json
{ "name": "DragAndDrop", "type": "CLASS" }
```

**All HTTP routes in a directory**

```json
{ "type": "http:route", "file": "src/api/" }
```

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- Name match is partial by default. Pass `fuzzyNameFallback: false` if you need exact substring instead of CamelCase-aware fuzzy.
- For broad type categories (e.g. all FUNCTIONs in a project) use `limit` + `offset` for pagination — defaults cap at 10.

### See also

- `mcp:tool:get_context`
- `mcp:tool:find_calls`
- `mcp:tool:get_file_overview`

## `mcp:tool` `find_shared_behaviors`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

List clusters of FEATUREs whose entry-points share an identical BEHAVIOR (same forward-slice hash).

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
Empty result means every FEATURE has a unique implementation.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `minClusterSize` | `number` | yes |  | Minimum FEATUREs per cluster (default: 2). Values below 2 are clamped to 2. |
| `limit` | `number` | yes |  | Maximum clusters to return (default: 100). |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `get_analysis_status`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/analysis-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Get the current analysis status and progress.

Use this to:
- Poll progress during long-running analysis (started by analyze_project)
- Check if analysis is still running before making queries
- See which phase is active (discovery, indexing, analysis, enrichment, validation)

Returns: { running: boolean, phase: string, progress: number, error: string | null }

Call this periodically after analyze_project to monitor progress.

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `get_context`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/context-tools.ts`
**Modality**: `mcp:tool`

### When to use

Single-call answer for "tell me everything you know about this
node." Returns: source code snippet, immediate graph neighborhood
(callers, callees, contains, contained-by), effects, throws.
Cheaper than chaining multiple queries when you have a node id.
Best paired with `find_nodes` (locate) → `get_context` (zoom in).

### Contract — mcp-inputSchema

Get deep context for a graph node: source code + full graph neighborhood.

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
Structural edges (CONTAINS, HAS_SCOPE, etc.) are shown in compact form.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `semanticId` | `string` | no |  | Exact semantic ID of the node (from find_nodes or query_graph) |
| `contextLines` | `number` | yes |  | Lines of code context around each reference (default: 3) |
| `edgeType` | `string` | yes |  | Filter by edge type (comma-separated, e.g., "CALLS,ASSIGNED_FROM") |

### Examples

**Get full context for a node**

```json
{ "nodeId": "FUNCTION:authenticate@src/auth.ts" }
```

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- Returns up to ~30 neighbors by default. For exhaustive traversal of a hub node (e.g. a popular utility), use `find_calls` + `traverse_graph` for paginated control.

### See also

- `mcp:tool:describe`
- `mcp:tool:find_nodes`
- `mcp:tool:get_function_details`

## `mcp:tool` `get_coverage`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/project-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Check which files were analyzed and which were skipped.

Use this to:
- Find gaps: "Why doesn't query find this file?" — check if it was analyzed
- Verify include/exclude patterns work correctly
- Debug empty query results: file not in graph → not analyzed
- Identify unsupported file types or parse errors

Returns: analyzed/skipped file counts, coverage percentage, skip reasons.

Use AFTER analyze_project when queries return unexpected empty results.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | yes |  | Path to check coverage for |
| `depth` | `number` | yes |  | Directory depth to report (default: 2) |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `get_documentation`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/project-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Get documentation about Grafema usage and query syntax.

Topics available:
- queries: Datalog query syntax, predicates (including numeric comparisons), and examples
- types: Available node and edge types (including METRIC and ISSUE diagnostic nodes)
- guarantees: How to create and manage code guarantees
- notation: DSL notation reference (archetypes, operators, LOD, perspectives)
- metrics: Performance metrics (METRIC nodes) and analysis issues (ISSUE nodes)
- effects: Side-effect taxonomy and manifest system
- onboarding: Step-by-step guide for new projects
- overview: High-level Grafema architecture

Use this when you need to learn Datalog syntax, DSL notation, or understand available features.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `topic` | `string` | yes |  | Topic: queries, types, guarantees, notation, metrics, effects, onboarding, or overview |

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `get_file_overview`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/context-tools.ts`
**Modality**: `mcp:tool`

### When to use

"What's in this file?" Returns every entity the file contains:
classes, functions, exports, imports, top-level constants, plus
line numbers. Use as the file-level entry point — read this first
before diving into specific function definitions.

### Contract — mcp-inputSchema

Understand what a file does without reading it — shows structure and relationships from the graph.

USE THIS FIRST when you need to understand a file. It replaces reading the file with
a structured summary: imports, exports, classes, functions, variables, and how they
connect to the rest of the codebase.

Returns:
- Imports: what modules are pulled in and which names
- Exports: what the file exposes to others
- Classes: with methods and their call targets
- Functions: with what they call
- Variables: with their assignment sources

After this, use get_context with specific node IDs to deep-dive into relationships.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `file` | `string` | no |  | File path (relative to project root or absolute) |
| `include_edges` | `boolean` | yes |  | Include relationship edges like CALLS, EXTENDS (default: true). Set false for faster results. |

### Examples

**Overview of a source file**

```json
{ "file": "packages/cli/src/cli.ts" }
```

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- For very large files (>200 entities) the response paginates via `limit` + `offset`. Default returns top 50.

### See also

- `mcp:tool:find_nodes`
- `mcp:tool:describe`
- `cli:command:tldr`
- `cli:command:file`

## `mcp:tool` `get_function_details`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/context-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Get comprehensive details about a function, including what it calls and who calls it.

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
Max transitive depth is 5 to prevent explosion.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | no |  | Function name to look up |
| `file` | `string` | yes |  | Optional: file path to disambiguate (partial match) |
| `transitive` | `boolean` | yes |  | Follow call chains recursively (default: false) |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `get_knowledge_stats`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/knowledge-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Get statistics about the knowledge base.

Use this to:
- Check if knowledge base is loaded and has content
- See counts by node type (DECISION, FACT, SESSION, etc.)
- See counts by lifecycle (declared, derived, synced)
- Identify dangling references in edges
- See dangling code references (KB nodes pointing at code that no longer exists in the graph)

Returns: total nodes, by-type counts, by-lifecycle counts, edge counts, dangling KB refs, dangling code refs.
Code reference resolution requires the code graph to be analyzed — without it, danglingCodeRefs will be empty.

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `get_neighbors`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/graph-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Get direct neighbors of a node — all incoming and/or outgoing edges.

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
the graph structure, not source code.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `semanticId` | `string` | no |  | Semantic ID of the node |
| `direction` | `string` | yes |  | Edge direction: outgoing, incoming, or both (default: both) |
| `edgeTypes` | `array` | yes |  | Filter by edge types (e.g., ["CALLS", "CONTAINS"]). Omit for all. |

- Allowed for `direction`: [outgoing, incoming, both]

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `get_node`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/graph-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Get a single node by its semantic ID with full metadata.

Use this when you have a node ID from find_nodes, query_graph, or another tool
and need the complete record.

Returns: All node properties (type, name, file, line, exported) plus
type-specific metadata (async, params, className, etc.).

Use cases:
- After find_nodes: get full details for a specific result
- After query_graph: inspect a violation node
- Quick lookup without full context (faster than get_context)

Tip: For relationships and code context, use get_context instead.
For just the direct edges, use get_neighbors.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `semanticId` | `string` | no |  | Semantic ID of the node (from find_nodes, query_graph, etc.) |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `get_schema`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/analysis-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Get the graph schema: available node and edge types with counts.

Use this to:
- Discover what types exist: "What node types does this graph have?"
- Validate edge types before traverse_graph or get_neighbors
- Understand graph structure before writing Datalog queries
- Find correct type names (e.g., "http:route" not "HTTP_ROUTE")

Options:
- type: "nodes" (node types only), "edges" (edge types only), "all" (default)

Tip: Run this first when exploring a new graph to learn the available vocabulary.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `string` | yes |  | nodes, edges, or all (default: all) |

- Allowed for `type`: [nodes, edges, all]

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `get_shape`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Get the shape (methods + properties) of a CLASS, INTERFACE, or typed variable.

Shows all members including inherited ones via EXTENDS chain. For variables,
follows INSTANCE_OF to find the type, then returns its shape.

Use this to understand:
- "What methods does GraphBackend have?" → get_shape(target="GraphBackend")
- "What can I call on this variable?" → get_shape(target="db", file="handlers.ts")
- "What does this interface require?" → get_shape(target="NodeRecord")

Returns: members (methods + properties), extends chain, implements list.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `target` | `string` | no |  | CLASS, INTERFACE, or variable name (or semantic ID) |
| `file` | `string` | yes |  | File path to disambiguate (optional) |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `get_stats`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/analysis-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Get graph statistics: node and edge counts by type.

Use this to:
- Verify analysis completed: nodeCount > 0 means the graph is loaded
- Understand graph size before running expensive queries
- See what node/edge types exist in this particular codebase
- Debug empty results: check if expected node types are present

Returns:
- nodeCount, edgeCount: Total counts
- nodesByType: {FUNCTION: 1234, CLASS: 56, ...}
- edgesByType: {CALLS: 5678, CONTAINS: 3456, ...}

Use BEFORE querying an unfamiliar graph to understand what data is available.

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `GetPromptRequestSchema`

**File**: `packages/mcp/src/server.ts`
**Modality**: `mcp:tool`

_No speced contract recovered for this feature._

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `list_guarantees`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/guarantee-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

List all defined code guarantees (rules and contracts).

Use this to:
- See existing invariants: "What rules does this codebase enforce?"
- Understand code contracts before modifying code
- Find Datalog-based rules (e.g., "no-eval", "no-sql-injection")
- List contract-based guarantees (queue schemas, API contracts)

Returns for each guarantee: name, type, description, rule/schema, priority, status.
Use BEFORE check_guarantees to see what will be validated.

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `ListPromptsRequestSchema`

**File**: `packages/mcp/src/server.ts`
**Modality**: `mcp:tool`

_No speced contract recovered for this feature._

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `ListToolsRequestSchema`

**File**: `packages/mcp/src/server.ts`
**Modality**: `mcp:tool`

_No speced contract recovered for this feature._

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `query_decisions`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/knowledge-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Query architectural decisions, optionally filtered by module or status.

Use this to:
- Find decisions affecting a module: query_decisions(module="packages/cli:CLI:MODULE")
- Find all active decisions: query_decisions(status="active")
- Find all decisions: query_decisions()

Returns decisions with status, applies_to, and full content.
Decisions are the core artifact type — they record WHY code is the way it is.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `module` | `string` | yes |  | Semantic address to match against applies_to (string includes matching) |
| `status` | `string` | yes |  | Filter by decision status |

- Allowed for `status`: [active, superseded, deprecated, proposed]

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `query_graph`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Execute a Datalog or Cypher query on the code graph.

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
  violation(F, Ms) :- node(M, "METRIC"), attr(M, "name", "parse_ms"), attr(M, "value", Ms), gte(Ms, 500), edge(M, Mod, "OBSERVES"), attr(Mod, "file", F).

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | `string` | no |  | Datalog query (must define violation/1 predicate) or Cypher query (when language is "cypher"). |
| `language` | `string` | yes |  | Query language: "datalog" (default) or "cypher" |
| `limit` | `number` | yes |  | Max results to return (default: <expr>, max: <expr>) |
| `offset` | `number` | yes |  | Skip first N results for pagination (default: 0) |
| `explain` | `boolean` | yes |  | Show step-by-step query execution to debug empty results |
| `count` | `boolean` | yes |  | When true, returns only the count of matching results instead of the full result list |

- Allowed for `language`: [datalog, cypher]

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `query_graphql`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/graphql-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Execute a GraphQL query on the code graph.

GraphQL provides typed, nested queries with pagination — complementary to Datalog.
Use GraphQL when you need nested data in one query (node + edges + neighbors).
Use Datalog (query_graph) for pattern matching and logical rules.

SCHEMA HIGHLIGHTS:
- node(id: ID!): Node — get a single node
- nodes(filter: {type, name, file, exported}, first, after): NodeConnection — paginated search
- bfs/dfs(startIds, maxDepth, edgeTypes): [ID!]! — graph traversal
- reachability(from, to, edgeTypes, maxDepth): Boolean — path existence
- datalog(query, limit, offset): DatalogResult — Datalog passthrough
- findCalls(target, className): [CallInfo!]! — call graph
- traceDataFlow(source, file, direction, maxDepth): [[String!]!]! — data flow
- stats: GraphStats — node/edge counts

Node fields: id, name, type, file, line, column, exported, metadata,
  outgoingEdges(types), incomingEdges(types), children, parent

EXAMPLE:
  query {
    nodes(filter: {type: "FUNCTION", file: "src/api"}, first: 5) {
      edges {
        node {
          name, file, line
          outgoingEdges(types: ["CALLS"]) {
            edges { node { dst { name, file } } }
          }
        }
      }
      totalCount
    }
  }

Use get_documentation(topic="graphql-schema") for the full schema.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | `string` | no |  | GraphQL query string |
| `variables` | `object` | yes |  | Optional variables for the query (JSON object) |
| `operationName` | `string` | yes |  | Optional operation name (when query contains multiple operations) |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `query_knowledge`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/knowledge-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Query knowledge nodes with filters.

Use this to:
- Find all decisions: query_knowledge(type="DECISION")
- Search by keyword: query_knowledge(text="RFDB")
- Find nodes in a projection: query_knowledge(projection="epistemic")
- Find related nodes: query_knowledge(relates_to="kb:session:2026-03-06-design")
- Combine filters: query_knowledge(type="FACT", text="auth")
- Find facts about code that no longer exists: query_knowledge(include_dangling_only=true)

Returns matching nodes with their full content, metadata, and code reference resolution status.
Code references (relates_to, applies_to) are resolved against the current code graph — each ref shows [OK] or [DANGLING] status.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `string` | yes |  | Filter by node type |
| `projection` | `string` | yes |  | Filter by projection (e.g., "epistemic", "temporal") |
| `relates_to` | `string` | yes |  | Filter by relates_to containing this semantic ID |
| `text` | `string` | yes |  | Case-insensitive text search in body content |
| `include_dangling_only` | `boolean` | yes |  | When true, return only nodes with code references that no longer resolve (dangling). Requires code graph to be analyzed. |

- Allowed for `type`: [DECISION, FACT, SESSION, COMMIT, FILE_CHANGE, AUTHOR, TICKET, INCIDENT]

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `query_registry`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/registry-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Query the local manifest registry for package export information and side effects.

The registry contains pre-analyzed manifests for npm dependencies. Each manifest describes
a package's API surface: exported symbols, their kinds, and side effects.

Use this when you need to:
- Know what a package exports: query_registry(package="graphql") → 216 exports
- Check effects of a specific function: query_registry(package="yaml", symbol="parse") → PURE
- Understand a dependency's API without reading its source code
- Verify if a package is in the registry: query_registry(package="express") → not found

Returns: package metadata (purl, source_type, confidence), and either:
- A specific export (when symbol is given)
- All exports summary (when only package is given)
- Full registry index (when neither is given)

source_type values:
- "compiled_js" — standard npm package, fully analyzed
- "source" — TypeScript source, fully analyzed
- "minified" — bundled output (esbuild/webpack), exports not statically resolvable
- "dts_only" — type declarations only, not in registry

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `package` | `string` | yes |  | Package name (e.g., "graphql", "@anthropic-ai/sdk"). Omit to list all packages. |
| `symbol` | `string` | yes |  | Exported symbol name (e.g., "parse", "GraphQLSchema"). Requires package. |

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `read_project_structure`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/project-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Get the directory structure of the project.
Returns a tree of files and directories, useful for understanding
project layout during onboarding.

Excludes: node_modules, .git, dist, build, .grafema, coverage, .next, .nuxt

Use this tool when studying a new project to identify services,
packages, and entry points.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | yes |  | Subdirectory to scan (relative to project root). Default: project root. |
| `depth` | `number` | yes |  | Maximum directory depth (default: 3, max: 5) |
| `include_files` | `boolean` | yes |  | Include files in output, not just directories (default: true) |

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `report_issue`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/project-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Report a bug or issue with Grafema to GitHub.

Use this tool when you encounter:
- Unexpected errors or crashes
- Incorrect analysis results
- Missing features that should exist
- Documentation issues

The tool will create a GitHub issue automatically if GITHUB_TOKEN is configured.
If not configured, it will return a pre-formatted issue template that the user
can manually submit at https://github.com/Disentinel/grafema/issues/new

IMPORTANT: Always ask the user for permission before reporting an issue.
Include relevant context: error messages, file paths, query used, etc.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `title` | `string` | no |  | Brief issue title (e.g., "Query returns empty results for FUNCTION nodes") |
| `description` | `string` | no |  | Detailed description of the issue |
| `context` | `string` | yes |  | Relevant context: error messages, queries, file paths, etc. |
| `labels` | `array` | yes |  | Labels: bug, enhancement, documentation, question |

### Behavior

- Effects: ASYNC, IO, IO:HTTP:REQUEST, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `supersede_fact`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/knowledge-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Supersede an existing fact with a new version.

Use this when:
- A fact becomes outdated (e.g., library was upgraded, architecture changed)
- You discover new information that replaces an existing fact
- Correcting a previously recorded fact

This creates a NEW fact and marks the OLD fact with superseded_by pointing to the new one.
The old fact remains in the knowledge base for history.

Example: supersede_fact(old_id="kb:fact:auth-uses-bcrypt", new_content="Auth now uses argon2 after migration in REG-500")

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `old_id` | `string` | no |  | Semantic ID of the fact to supersede (e.g., "kb:fact:auth-uses-bcrypt") |
| `new_content` | `string` | no |  | Markdown content for the new fact |
| `new_slug` | `string` | yes |  | Optional slug for the new fact (auto-generated if omitted) |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `TEST`

**File**: `a.ts`
**Modality**: `mcp:tool`

_No speced contract recovered for this feature._

## `mcp:tool` `trace_alias`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Trace an alias chain to find the original source.
For code like: const alias = obj.method; alias();
This traces "alias" back to "obj.method".

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `variableName` | `string` | no |  | Variable name to trace |
| `file` | `string` | no |  | File path where the variable is defined |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `trace_calls`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Trace call chains from or to a function/method, following CALLS and CALLS_REMOTE edges transitively.

Use this when you need to:
- "What does this function eventually call?" (forward) — full call tree including cross-language hops
- "Who calls this function?" (backward) — all callers up the stack
- "Show the full call chain from handler to database" (forward with depth)

Unlike trace_dataflow (which follows data assignments), this follows function CALLS edges:
- CALLS: same-language function/method invocation
- CALLS_REMOTE: cross-process/language boundary (IPC, HTTP, socket)

Returns: Indented call tree showing each hop with file:line location.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `source` | `string` | no |  | Function/method name or semantic ID to trace from |
| `file` | `string` | yes |  | File path to disambiguate (optional) |
| `direction` | `string` | yes |  | forward (callees), backward (callers), or both (default: forward) |
| `max_depth` | `number` | yes |  | Maximum chain depth (default: 10) |

- Allowed for `direction`: [forward, backward, both]

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `trace_dataflow`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### When to use

Cross-function data trace. Forward: "where does this value flow
next?" Backward: "where does this value come from?" Both: full
lineage. Use for taint analysis, "is this user input ever logged",
"is the password ever hashed before storage", "which response
fields propagate to the cache".

### Contract — mcp-inputSchema

Trace data flow paths from or to a variable/expression.

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
Tip: Start with max_depth=5, increase if needed.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `source` | `string` | no |  | Variable or node ID to trace from |
| `file` | `string` | yes |  | File path |
| `direction` | `string` | yes |  | forward, backward, or both (default: forward) |
| `max_depth` | `number` | yes |  | Maximum trace depth (default: 10) |
| `limit` | `number` | yes |  | Max results (default: <expr>) |
| `detail` | `string` | yes |  | Level of detail: summary (counts only), normal (auto-compressed, default), full (every node) |

- Allowed for `direction`: [forward, backward, both]
- Allowed for `detail`: [summary, normal, full]

### Examples

**Forward trace from user input**

```json
{ "source": "userInput", "file": "src/api.ts", "direction": "forward" }
```

**Backward trace to find sources**

```json
{ "source": "response", "file": "src/api.ts", "direction": "backward", "max_depth": 7 }
```

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- Start with `max_depth: 5` and increase if the trace truncates. Going to 20 on a large project may take seconds.
- Cross-process flows (HTTP, queue messages) are surfaced via `CALLS_REMOTE` bridges only when the analyzer recognized the library — use the bridge-detection list to verify coverage.

### See also

- `mcp:tool:trace_alias`
- `mcp:tool:find_calls`
- `cli:command:wtf`

## `mcp:tool` `trace_effects`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Trace transitive side effects of a function through its call graph.

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

Returns: direct effects, transitive effects, boundary crossings, leaf sources.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `node` | `string` | no |  | Function/method name or semantic ID |
| `file` | `string` | yes |  | File path to disambiguate (optional) |
| `max_depth` | `number` | yes |  | Maximum call graph traversal depth (default: 10) |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `traverse_graph`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/graph-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Traverse the graph using BFS from start nodes, following specific edge types.

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

Tip: Start with maxDepth=5. Use get_schema(type="edges") to find valid edge type names.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `startNodeIds` | `array` | no |  | Starting node IDs (semantic IDs) |
| `edgeTypes` | `array` | no |  | Edge types to follow (e.g., ["CALLS", "DEPENDS_ON"]). Use get_schema to see available types. |
| `maxDepth` | `number` | yes |  | Maximum traversal depth (default: 5, max: 20) |
| `direction` | `string` | yes |  | Traversal direction: outgoing or incoming (default: outgoing) |

- Allowed for `direction`: [outgoing, incoming]

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `write_config`

**File**: `/Users/vadimr/grafema-worker-1/packages/mcp/src/definitions/project-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Write or update the Grafema configuration file (.grafema/config.yaml).
Validates all inputs before writing. Creates .grafema/ directory if needed.

Use this tool after studying the project to save the discovered configuration.
Only include fields you want to override — defaults are used for omitted fields.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `services` | `array` | yes |  | Service definitions (leave empty to use auto-discovery) |
| `plugins` | `object` | yes |  | Plugin configuration (omit to use defaults) |
| `include` | `array` | yes |  | Glob patterns for files to include (e.g., ["src/**/*.ts"]) |
| `exclude` | `array` | yes |  | Glob patterns for files to exclude (e.g., ["**/*.test.ts"]) |
| `workspace` | `object` | yes |  | Multi-root workspace config (only for workspaces) |

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10
