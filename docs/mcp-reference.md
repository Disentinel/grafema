# Grafema feature catalogue

_27 features exported._

## Contents

- [`mcp:tool` `analyze_project`](#mcptool-analyzeproject)
- [`mcp:tool` `assert`](#mcptool-assert)
- [`mcp:tool` `check_guarantees`](#mcptool-checkguarantees)
- [`mcp:tool` `crawl_entity`](#mcptool-crawlentity)
- [`mcp:tool` `create_guarantee`](#mcptool-createguarantee)
- [`mcp:tool` `delete_guarantee`](#mcptool-deleteguarantee)
- [`mcp:tool` `discover_services`](#mcptool-discoverservices)
- [`mcp:tool` `explain_datalog`](#mcptool-explaindatalog)
- [`mcp:tool` `find_calls`](#mcptool-findcalls)
- [`mcp:tool` `find_guards`](#mcptool-findguards)
- [`mcp:tool` `find_nodes`](#mcptool-findnodes)
- [`mcp:tool` `find_shared_behaviors`](#mcptool-findsharedbehaviors)
- [`mcp:tool` `get_analysis_status`](#mcptool-getanalysisstatus)
- [`mcp:tool` `get_coverage`](#mcptool-getcoverage)
- [`mcp:tool` `get_docs`](#mcptool-getdocs)
- [`mcp:tool` `get_node`](#mcptool-getnode)
- [`mcp:tool` `get_stats`](#mcptool-getstats)
- [`mcp:tool` `list_guarantees`](#mcptool-listguarantees)
- [`mcp:tool` `query_graph`](#mcptool-querygraph)
- [`mcp:tool` `query_registry`](#mcptool-queryregistry)
- [`mcp:tool` `read_project_structure`](#mcptool-readprojectstructure)
- [`mcp:tool` `recall`](#mcptool-recall)
- [`mcp:tool` `report_issue`](#mcptool-reportissue)
- [`mcp:tool` `retract`](#mcptool-retract)
- [`mcp:tool` `save_document`](#mcptool-savedocument)
- [`mcp:tool` `trace`](#mcptool-trace)
- [`mcp:tool` `write_config`](#mcptool-writeconfig)

## `mcp:tool` `analyze_project`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/analysis-tools.ts`
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

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `assert`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/enox-tools.ts`
**Modality**: `mcp:tool`

### When to use

The SINGLE knowledge-write tool. BATCH-NATIVE: pass an array of
assertions; one fact is an array of one. Use when you discover something
worth remembering across sessions — a decision, experiment result,
dependency, contradiction, or any relationship between two entities.
Both `from` and `to` become nodes if they don't exist yet.
Relation-expressed facts are just `assert` with the right relation — to
record that a newer finding replaces an older one, use
relation:"supersedes" (no separate supersede/supersede_fact tool).
Re-asserting the same {from, relation, to} updates that edge's
context/confidence.
Replaces remember / add_assertion / update_assertion / supersede(_fact).
"Enox" is the assertion protocol Grafema supports, not a tool prefix —
hence `assert`, not `enox_remember`.

_No speced contract recovered for this feature._

### Examples

**Record a single fact**

```json
{ "assertions": [
  { "from": "Grafema", "relation": "uses", "to": "RFDB",
    "context": "RFDB is the storage engine", "confidence": 1.0, "domain": "engineering" }
] }
```

**Batch several facts at once**

```json
{ "assertions": [
  { "from": "V2 engine", "relation": "supersedes", "to": "V1 engine",
    "context": "segment-based persistence" },
  { "from": "compaction", "relation": "depends_on", "to": "RFDB",
    "context": "L1 compaction runs inside the storage engine" }
] }
```

### Behavior

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- Include a rich `context` string — that is what `recall` searches over.
- `confidence` defaults to 0.9; `domain` scopes the fact to a knowledge domain that `recall`/`query_graph` can filter on.
- To delete a fact entirely use `retract({fact_ids:[...]})`; prefer a "supersedes" assertion when you want to keep the history.

### See also

- `mcp:tool:retract`
- `mcp:tool:recall`
- `mcp:tool:save_document`

## `mcp:tool` `check_guarantees`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/guarantee-tools.ts`
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

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `crawl_entity`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/enox-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Run an ontological crawl on a CODE entity — bridge from the code graph into knowledge.

Queries the Grafema code graph for the entity, generates graph-derived facts (what it is,
who calls it, what it contains, what it calls), and surfaces any prior knowledge already
recorded about it. Use \`assert\` afterwards to record interpretations worth persisting.

Example: crawl_entity(entity="compactionEnricher", context="TypeScript enricher creating FEATURE nodes")

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `entity` | `string` | no |  | Entity name to crawl |
| `context` | `string` | yes |  | Brief description of what this entity is |
| `depth` | `number` | yes |  | How many matched code nodes to explore (default: 3) |

### Behavior

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `create_guarantee`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/guarantee-tools.ts`
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

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `delete_guarantee`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/guarantee-tools.ts`
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

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `discover_services`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/analysis-tools.ts`
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

## `mcp:tool` `explain_datalog`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### When to use

Explain or simulate derived (Datalog) facts — the provenance / what-if
tool. Set `mode`:
- "fact" — explain WHY a derived fact holds: the rule that derived it +
           supporting body facts. Requires predicate + key.
           "Why does module A depend on B?"
- "gap"  — explain why a fact does NOT hold (why-not): the satisfied
           premise prefix and the first premise no binding satisfies
           (a missing positive premise, or a present negated one).
           Requires predicate + key.
- "sim"  — predict which NEW derived facts a hypothetical overlay of
           nodes/edges would create, WITHOUT committing anything.
           Requires predicate + at least one hypothetical node or edge.
Default program is the bundled depends.dl (so the common predicate is
"depends"). Pass `source` for a custom Datalog program.
Replaces the old explain_fact / explain_gap / sim_datalog tools — they
are now `mode` values of one tool.

### Contract — mcp-inputSchema

Explain or simulate derived (Datalog) facts — the provenance/what-if tool.

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

Default program is the bundled depends.dl (so the common predicate is "depends"). Pass \`source\

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `mode` | `string` | no |  | Which explanation: "fact" (why), "gap" (why-not), or "sim" (what-if). |
| `predicate` | `string` | no |  | The derived predicate (e.g. "depends"). |
| `key` | `array` | yes |  | The fact's ground key tuple as wire-string terms (required for mode fact/gap). |
| `nodes` | `array` | yes |  | Hypothetical nodes to overlay (mode="sim"). |
| `edges` | `array` | yes |  | Hypothetical edges to overlay (mode="sim"). |
| `source` | `string` | yes |  | Optional Datalog program (derive engine); empty/omitted ⇒ the bundled depends.dl. |

- Allowed for `mode`: [fact, gap, sim]

### Examples

**Why does this derived fact hold? (fact)**

```json
{ "mode": "fact", "predicate": "depends", "key": ["<A_id>", "<B_id>"] }
```

**Why does it NOT hold? (gap / why-not)**

```json
{ "mode": "gap", "predicate": "depends", "key": ["<A_id>", "<B_id>"] }
```

**What-if: which facts would a new edge create? (sim)**

```json
{
  "mode": "sim",
  "predicate": "depends",
  "edges": [{ "src": "<A_id>", "dst": "<B_id>", "edgeType": "IMPORTS_FROM" }]
}
```

### Behavior

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, MESSAGE_PASSING, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- Keys/ids are wire-string terms — node ids as decimal strings.
- mode="sim" overlay ids may be new/invented ids; nothing is persisted.

### See also

- `mcp:tool:query_graph`
- `mcp:tool:trace`
- `cli:command:why`

## `mcp:tool` `find_calls`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### When to use

"Who calls this?" — the structural question grep can't answer
because of aliases, re-exports, dynamic dispatch. Returns every
resolved call site of a function or method with file:line. The
callable side mirror of `trace(along="data")` (data side); for the
transitive call graph use `trace(along="calls")`.

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

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- For methods, pass `className` to disambiguate when the same method name exists on multiple classes (`get`, `parse`, …).

### See also

- `mcp:tool:trace`
- `mcp:tool:find_nodes`
- `cli:command:who`

## `mcp:tool` `find_guards`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/context-tools.ts`
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

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `find_nodes`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### When to use

Primary entry point for navigating the code graph. Find functions,
classes, modules, or any node by type and/or name pattern.
Replaces grep for structural questions: instead of "where is the
string `UserService`", ask "where is the CLASS named `UserService`."
Returns semantic IDs you can hand to other tools (`get_node`,
`find_calls`, `trace`).

### Contract — mcp-inputSchema

Find nodes in a graph by type, name, or file pattern.

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
Use limit/offset for pagination.

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `string` | yes |  | Node type (e.g., FUNCTION, CLASS, MODULE, PROPERTY_ACCESS) |
| `name` | `string` | yes |  | Node name pattern |
| `file` | `string` | yes |  | File path pattern (code graph) or domain (knowledge graph) |
| `graph` | `string` | yes |  | Which graph to search: "code" (default) or "knowledge". |
| `limit` | `number` | yes |  | Max results (default: <expr>, max: <expr>) |
| `offset` | `number` | yes |  | Skip first N results (default: 0) |

- Allowed for `graph`: [code, knowledge]

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

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- Name match is partial by default. Pass `fuzzyNameFallback: false` if you need exact substring instead of CamelCase-aware fuzzy.
- For broad type categories (e.g. all FUNCTIONs in a project) use `limit` + `offset` for pagination — defaults cap at 10.

### See also

- `mcp:tool:get_node`
- `mcp:tool:find_calls`
- `mcp:tool:trace`

## `mcp:tool` `find_shared_behaviors`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/query-tools.ts`
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

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `get_analysis_status`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/analysis-tools.ts`
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

## `mcp:tool` `get_coverage`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/project-tools.ts`
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

### Behavior

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `get_docs`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/project-tools.ts`
**Modality**: `mcp:tool`

### When to use

Fetch Grafema's own usage documentation inline — query syntax, tool
guidance, node/edge vocabulary, and "how do I…" help — without leaving
the agent loop. Use when unsure how to phrase a Datalog/Cypher query,
which tool answers a question, or what a node/edge type means.
Renamed from get_documentation.

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

### Examples

**Get usage docs for a topic**

```json
{ "topic": "queries" }
```

### Gotchas

- For the live type vocabulary of a specific graph (not prose docs), use `get_stats(include=["schema"])` instead.

### See also

- `mcp:tool:get_stats`
- `mcp:tool:query_graph`

## `mcp:tool` `get_node`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/context-tools.ts`
**Modality**: `mcp:tool`

### When to use

The unified node inspector — single-call answer for "tell me about
this node." `target` is a semantic ID (from find_nodes/query_graph), a
node name, or a file path. Pick how much to return with `detail`:
- "record"    — raw node record only (fast lookup, no edges)
- "neighbors" — direct in/out edges grouped by type (no source code)
- "context"   — (default) source code + full neighborhood with code context
- "full"      — for a FUNCTION/METHOD: callers + callees, transitive chains
Smart defaults when detail is omitted: a file path / MODULE → a file
overview (imports, exports, classes, functions, constants); a
CLASS/INTERFACE/typed VARIABLE → its shape (methods + properties).
Best paired with `find_nodes` (locate) → `get_node` (zoom in).
Replaces the old get_context / get_file_overview / get_function_details /
get_shape / describe tools — they are now `detail` levels of one tool.

### Contract — mcp-inputSchema

Inspect a single node — the unified node-detail tool for the code graph (and knowledge graph).

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
\`file\` (disambiguate a name).

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `target` | `string` | no |  | Semantic ID, node name, or file path to inspect. |
| `file` | `string` | yes |  | File path to disambiguate a name (optional). |
| `detail` | `string` | yes |  | record \| neighbors \| context (default) \| full |
| `format` | `string` | yes |  | json (default) \| dsl (compact Grafema notation) |
| `graph` | `string` | yes |  | Which graph: "code" (default) or "knowledge". |
| `edge_types` | `array` | yes |  | Filter neighbors/context to these edge types (e.g. ["CALLS","ASSIGNED_FROM"]). |
| `perspective` | `string` | yes |  | Archetype filter for format="dsl": security \| data \| errors \| api \| events |
| `context_lines` | `number` | yes |  | Source context lines around each reference (default 3); for format="dsl", the notation depth. |

- Allowed for `detail`: [record, neighbors, context, full]
- Allowed for `format`: [json, dsl]
- Allowed for `graph`: [code, knowledge]
- Allowed for `perspective`: [security, data, errors, api, events]

### Examples

**Full context for a node (default)**

```json
{ "target": "FUNCTION:authenticate@src/auth.ts" }
```

**Just the record, no edges**

```json
{ "target": "UserService", "detail": "record" }
```

**Overview of a source file (file path ⇒ file overview)**

```json
{ "target": "packages/cli/src/cli.ts" }
```

**Comprehensive function details (callers + callees, transitive)**

```json
{ "target": "processOrder", "detail": "full" }
```

**Inspect a knowledge-graph entity**

```json
{ "target": "RFDB", "graph": "knowledge", "detail": "neighbors" }
```

### Behavior

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- "context" returns up to ~30 neighbors by default. For exhaustive traversal of a hub node (e.g. a popular utility), use `find_calls` + `trace(along="edges")` for paginated control.
- Set `graph: "knowledge"` to inspect an entity in the project knowledge graph (its edges and metadata) instead of the code graph.
- `format: "dsl"` renders compact Grafema notation; with it you may pass `perspective` (security|data|errors|api|events) and `context_lines` maps to DSL depth.

### See also

- `mcp:tool:find_nodes`
- `mcp:tool:find_calls`
- `mcp:tool:trace`

## `mcp:tool` `get_stats`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/analysis-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Get graph statistics and/or schema — counts and the available node/edge type vocabulary.

Use this to:
- Verify analysis completed: nodeCount > 0 means the graph is loaded (call BEFORE querying).
- Understand graph size before running expensive queries.
- Discover the type vocabulary before writing Datalog/Cypher (e.g. "http:route" not "HTTP_ROUTE").
- Debug empty results: check if expected node/edge types are present.

Set \`include\` (array, default both):
- "counts" — nodeCount, edgeCount, nodesByType, edgesByType, shard diagnostics.
- "schema" — the node and edge type names with counts (the query vocabulary).

Set \`graph\` to "knowledge" for the project knowledge graph instead of the code graph
(default "code").

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `graph` | `string` | yes |  | Which graph: "code" (default) or "knowledge". |
| `include` | `array` | yes |  | What to include: "counts" and/or "schema" (default: both). |

- Allowed for `graph`: [code, knowledge]

### Behavior

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `list_guarantees`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/guarantee-tools.ts`
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

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `query_graph`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Execute a Datalog, Cypher, or GraphQL query on a graph.

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
  violation(X) :- node(X, "CALL"), \\+ edge(X, _, "CALLS").

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | `string` | no |  | Datalog query (must define violation/1), Cypher query, or GraphQL document (per language). |
| `language` | `string` | yes |  | Query language: "datalog" (default), "cypher", or "graphql" |
| `graph` | `string` | yes |  | Which graph to query: "code" (default) or "knowledge". |
| `limit` | `number` | yes |  | Max results to return (default: <expr>, max: <expr>) |
| `offset` | `number` | yes |  | Skip first N results for pagination (default: 0) |
| `explain` | `boolean` | yes |  | Show step-by-step query execution to debug empty results (datalog only) |
| `count` | `boolean` | yes |  | When true, returns only the count of matching results instead of the full result list |

- Allowed for `language`: [datalog, cypher, graphql]
- Allowed for `graph`: [code, knowledge]

### Behavior

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, MESSAGE_PASSING, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `query_registry`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/registry-tools.ts`
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

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `read_project_structure`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/project-tools.ts`
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

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `recall`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/enox-tools.ts`
**Modality**: `mcp:tool`

### When to use

Broad "what do we know about X" retrieval over the project knowledge
graph — combines name/content (semantic) search with graph traversal.
Use at session start or before making decisions to check for prior art,
known failures, and existing context. `depth` controls how far to
traverse from matched seed nodes (1 = direct matches, 2 = + neighbors,
3 = two hops out). `top_k` caps matched seed nodes; `domain` filters to
one knowledge domain.
This is the single knowledge-retrieval entry point — the old
semantic_search (pure embedding similarity) is folded into recall; for
exact name/type/domain filtering use `query_graph`/`find_nodes` with
`graph: "knowledge"`.

### Contract — mcp-inputSchema

Broad "what do we know about X" retrieval over the project knowledge graph — combines
name/content search with graph traversal.

Use this at session start or before making decisions to check for prior art, known
failures, and existing context.

depth controls how far to traverse from matched nodes:
- 1: direct matches only (fast)
- 2: matches + their neighbors (good balance)
- 3: two hops out (broader context, slower)

top_k caps the number of matched seed nodes. domain filters to one knowledge domain.

Example: recall(query="federation architecture", depth=2, top_k=10)

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | `string` | no |  | What to recall — natural language query |
| `depth` | `number` | yes |  | Traversal depth from matched nodes: 1-3 (default: 2) |
| `top_k` | `number` | yes |  | Maximum number of matched seed nodes to expand (default: 10) |
| `domain` | `string` | yes |  | Filter results to a specific knowledge domain |

### Examples

**What do we know about a topic?**

```json
{ "query": "federation architecture", "depth": 2, "top_k": 10 }
```

**Scope to one knowledge domain**

```json
{ "query": "compaction tradeoffs", "domain": "engineering", "depth": 2 }
```

### Behavior

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- depth=3 is broader but slower; start at depth=2 for a good balance.
- Results include `age_days` — older findings in fast-moving domains may be stale; check before relying on them.

### See also

- `mcp:tool:assert`
- `mcp:tool:query_graph`
- `mcp:tool:get_node`

## `mcp:tool` `report_issue`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/project-tools.ts`
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

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `retract`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/enox-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Delete one or more facts (relation edges) from the knowledge graph by fact_id. BATCH-NATIVE.

Use this when assertions are wrong, outdated, or no longer relevant. Consider asserting a
"supersedes" relation instead of retracting when you want to keep the history.

fact_ids are the ids returned by \`assert\` (and visible in recall/get_node output).

Example: retract(fact_ids=["a1b2c3...", "d4e5f6..."])

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `fact_ids` | `array` | no |  | IDs of the assertions/edges to remove. |

### Behavior

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `save_document`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/enox-tools.ts`
**Modality**: `mcp:tool`

### Contract — mcp-inputSchema

Store a document or artifact as a node in the knowledge graph.

Use this for longer-form content that should be persisted:
- ADRs (Architecture Decision Records)
- Postmortems and incident reports
- Specifications and design documents
- Session notes and artifacts

The document becomes a node with its content stored. Use relates_to to
link it to relevant entities in the graph.

Example: save_document(title="ADR: Federation via thick client", content="## Context\\n...", doc_type="adr", relates_to=["Grafema", "RFDB"])

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `title` | `string` | no |  | Document title (becomes the node name) |
| `content` | `string` | no |  | Full document content (markdown supported) |
| `doc_type` | `string` | yes |  | Document type (default: "note") |
| `relates_to` | `array` | yes |  | Node IDs or names of related entities to link to |

- Allowed for `doc_type`: [adr, postmortem, spec, note, artifact]

### Behavior

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `mcp:tool` `trace`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/query-tools.ts`
**Modality**: `mcp:tool`

### When to use

The unified transitive-traversal tool. Set `along` to pick what to follow:
- "data"    — data flow (ASSIGNED_FROM, PASSES_ARGUMENT, FLOWS_INTO).
              Forward: "where does this value flow next?" Backward: "where
              does it come from?" Use for taint analysis, "is this user
              input ever logged", "is the password hashed before storage".
- "calls"   — the call graph (CALLS, CALLS_REMOTE), incl. cross-language
              hops. "What does this call / who calls this?"
- "effects" — transitive side effects (IO, MUTATION, THROW…) via effects-db.
- "alias"   — an alias chain back to its source (const fn = obj.method).
              Requires `file`.
- "edges"   — generic BFS over given `edge_types` (impact analysis,
              dependency trees, reachability). Requires edge_types.
Set `direction`: "forward" (default), "backward", or "both"
(data/calls/edges). Replaces trace_dataflow / trace_calls / trace_effects /
trace_alias / traverse_graph — they are now `along` modes of one tool.

### Contract — mcp-inputSchema

Trace relationships transitively from a source node — the unified traversal tool.

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
  trace(source="RFDB", along="edges", graph="knowledge", edge_types=["depends_on","uses"])

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `source` | `string` | no |  | Variable, function/method name, or semantic ID to trace from |
| `file` | `string` | yes |  | File path to disambiguate (required for along="alias") |
| `along` | `string` | yes |  | What to follow: "data", "calls", "effects", "alias", or "edges" (default: "calls") |
| `direction` | `string` | yes |  | forward (default), backward, or both (data/calls/edges) |
| `edge_types` | `array` | yes |  | Edge/relation types to follow for along="edges" (e.g., ["CALLS","DEPENDS_ON"]). |
| `max_depth` | `number` | yes |  | Maximum traversal depth (default: 10; edges default 5, max 20) |
| `detail` | `string` | yes |  | Detail level for along="data": summary, normal (default), full |
| `graph` | `string` | yes |  | Which graph to traverse: "code" (default) or "knowledge" (along="edges"). |
| `limit` | `number` | yes |  | Max results for along="data" (default: <expr>) |

- Allowed for `along`: [data, calls, effects, alias, edges]
- Allowed for `direction`: [forward, backward, both]
- Allowed for `detail`: [summary, normal, full]
- Allowed for `graph`: [code, knowledge]

### Examples

**Forward data trace from user input**

```json
{ "source": "userInput", "along": "data", "direction": "forward" }
```

**Backward data trace to find sources**

```json
{ "source": "response", "along": "data", "direction": "backward", "max_depth": 7 }
```

**Who calls this (call graph, backward)**

```json
{ "source": "handleRequest", "along": "calls", "direction": "backward" }
```

**Transitive side effects of a function**

```json
{ "source": "processOrder", "along": "effects" }
```

**Impact analysis over import edges**

```json
{ "source": "<modId>", "along": "edges", "edge_types": ["IMPORTS_FROM"], "max_depth": 10 }
```

### Behavior

- Effects: ASYNC, IO, IO:SOCKET:CONNECT, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- Start with `max_depth: 5` and increase if the trace truncates. Going to 20 on a large project may take seconds.
- Cross-process flows (HTTP, queue messages) are surfaced via `CALLS_REMOTE` bridges only when the analyzer recognized the library — use the bridge-detection list to verify coverage.
- For along="edges" against the knowledge graph, set `graph: "knowledge"` and pass relation names in `edge_types`.

### See also

- `mcp:tool:find_calls`
- `mcp:tool:get_node`
- `cli:command:wtf`

## `mcp:tool` `write_config`

**File**: `/tmp/grafema-tools/packages/mcp/src/definitions/project-tools.ts`
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
