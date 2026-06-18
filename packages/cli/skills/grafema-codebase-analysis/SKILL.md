---
name: grafema-codebase-analysis
description: >
  Analyze codebases using a graph database instead of reading source files.
  Use when understanding code architecture, finding functions or call patterns,
  tracing data flow, checking dependencies, or answering "where is X used?"
  questions. Grafema builds a queryable code graph from static analysis —
  prefer querying the graph over reading files manually.
license: Apache-2.0
compatibility: Requires Grafema MCP server configured (grafema or @grafema/mcp package)
metadata:
  author: Grafema
  version: "0.3.0"
---

# Grafema: Graph-Based Codebase Analysis

## Core Principle

**Query the graph, not read code.**

Grafema builds a graph database from your codebase via static analysis.
Instead of reading dozens of files to understand how code connects,
query the graph to get structured, complete answers instantly.

```
BAD:  Read 20 files hoping to find all callers of a function
GOOD: find_calls({ name: "processPayment" }) -> get all callers in one query

BAD:  Grep for variable name across files, miss aliased references
GOOD: trace({ source: "userInput", along: "data", direction: "forward" }) -> complete data flow

BAD:  Read file by file to understand module dependencies
GOOD: get_node({ target: "src/api.ts" }) -> structured imports, exports, classes, functions
```

### When to Use Grafema

- Finding where functions/methods are called
- Understanding module dependencies and imports
- Tracing data flow (forward or backward)
- Getting function details (signature, callers, callees)
- Checking code invariants with Datalog rules
- Exploring file structure and entity relationships

### When NOT to Use Grafema

- Reading a single specific file (use your editor/Read tool — faster)
- Editing code (Grafema is read-only analysis)
- Runtime behavior questions (Grafema is static analysis)
- Files not yet analyzed (run `analyze_project` first)

## Essential Tools (Tier 1)

These 4 tools handle ~80% of queries. Start here.

### find_nodes — Find entities by type, name, or file

```json
find_nodes({ type: "FUNCTION", name: "validateUser" })
find_nodes({ type: "CLASS", file: "src/auth.ts" })
find_nodes({ type: "http:request" })
find_nodes({ type: "MODULE" })
```

**Use when:** "Find all X", "What functions are in file Y", "List all routes"

**Node types:** MODULE, FUNCTION, METHOD, CLASS, VARIABLE, PARAMETER,
CALL, PROPERTY_ACCESS, METHOD_CALL, CALL_SITE,
http:route, http:request, db:query, socketio:emit, socketio:on

### find_calls — Find function/method call sites

```json
find_calls({ name: "processPayment" })
find_calls({ name: "query", className: "Database" })
```

**Use when:** "Where is X called?", "Who calls this function?", "Find all usages"

Returns call sites with file locations and whether the target is resolved.

### get_node — The unified node inspector

```json
get_node({ target: "src/api.ts:handleRequest#fn" })                         // detail="context" (default): source + neighborhood
get_node({ target: "handleRequest", detail: "full" })                       // function details: callers + callees, transitive
get_node({ target: "src/db.ts:Database#class", detail: "neighbors", edge_types: ["CALLS"] })
get_node({ target: "src/api.ts" })                                          // a file path ⇒ file overview
```

**Use when:** "Tell me everything about this entity", "What does this function do /
call / get called by?", "Show me its relationships", "What's in this file?"

One tool replaces the old get_context / get_function_details / get_file_overview /
get_shape / describe. Pick scope with `detail`: `record` (raw node), `neighbors`
(edges only), `context` (default — source + neighborhood), `full` (FUNCTION/METHOD
callers + callees + transitive chains). A file path / MODULE target defaults to a
file overview; a CLASS / typed VARIABLE defaults to its shape. `format: "dsl"`
renders compact Grafema notation. Use after `find_nodes` to deep-dive into a result.

### trace — Trace relationships transitively

```json
trace({ source: "userInput", along: "data", direction: "forward" })
trace({ source: "dbResult", along: "data", direction: "backward" })
trace({ source: "handleRequest", along: "calls", direction: "backward" })
trace({ source: "processOrder", along: "effects" })
```

**Use when:** "Where does this value end up?", "Where does this data come from?",
"Who calls this / what does it call?", "What side effects does this trigger?",
"Is user input reaching the database unsanitized?"

One tool replaces trace_dataflow / trace_calls / trace_effects / trace_alias /
traverse_graph. Pick what to follow with `along`: `data`, `calls`, `effects`,
`alias` (requires `file`), or `edges` (generic BFS over `edge_types`).
Directions: `forward` (default), `backward`, `both` (data/calls/edges).

## Decision Tree

```
START: What do you need?
|
|-- "Find entities (functions, classes, routes)"
|   -> find_nodes({ type, name, file })
|
|-- "Find who calls function X"
|   -> find_calls({ name: "X" })
|   -> For full details: get_node({ target: "X", detail: "full" })
|
|-- "Understand a specific entity deeply"
|   -> First: find_nodes to get its semantic ID
|   -> Then: get_node({ target: "..." })
|
|-- "Trace data flow"
|   -> trace({ source, along: "data", direction })
|
|-- "Understand a file's structure"
|   -> get_node({ target: "path/to/file.ts" })   (file path ⇒ file overview)
|
|-- "Trace an alias/re-export chain"
|   -> trace({ source: "alias", along: "alias", file: "path.ts" })
|
|-- "Check a code rule/invariant"
|   -> query_graph({ query: "violation(X) :- ..." })   (datalog; the rule IS the check)
|
|-- "Custom complex query"
|   -> query_graph({ query: "violation(X) :- ..." })
|   -> See references/query-patterns.md for Datalog syntax
|
|-- "Explore unknown codebase"
|   -> get_stats() for high-level overview + available node/edge types (include: ["schema"])
|   -> find_nodes({ type: "MODULE" }) for module list
|   -> get_node for specific files
```

## Common Workflows

### 1. Impact Analysis: "What breaks if I change function X?"

```
get_node({ target: "X", detail: "full" })
-> Check calledBy array for all callers (direct + transitive)
-> For critical callers: get_node({ target: "..." }) for full picture
```

### 2. Security Audit: "Does user input reach the database?"

```
find_nodes({ type: "http:request" })
-> For each route, trace({ source: requestParam, along: "data", direction: "forward" })
-> Check if flow reaches db:query nodes
-> Use find_guards to check for sanitization
```

### 3. Onboarding: "How is this codebase structured?"

```
get_stats()                              -> Node/edge counts by type
find_nodes({ type: "MODULE" })           -> All modules
get_node({ target: "src/index.ts" })     -> Entry point structure (file overview)
find_nodes({ type: "http:request" })     -> All API endpoints
```

### 4. Dependency Analysis: "What does module X depend on?"

```
get_node({ target: "src/service.ts" })
-> Check imports section for dependencies
-> For each import: get_node for deeper relationships
```

### 5. Find Dead Code: "What functions have no callers?"

```
query_graph({
  query: 'violation(X) :- node(X, "FUNCTION"), \\+ edge(_, X, "CALLS").'
})
```

## Anti-Patterns

**Don't read files to find call sites.** Use `find_calls` — it finds ALL callers across
the entire codebase, including indirect references you'd miss by grepping.

**Don't use `query_graph` for simple lookups.** `find_nodes`, `find_calls`, and
`get_node` are optimized for common queries. Reserve Datalog for
complex patterns (joins, transitive closure, invariant checks).

**Don't skip analysis status.** If you just ran `analyze_project`, check
`get_analysis_status` before querying — partial results are misleading.

**Don't request excessive depth.** `get_node` with no filters returns everything.
Use the `edge_types` filter to focus on specific relationships (e.g., `["CALLS","ASSIGNED_FROM"]`).

**Don't use Grafema for single-file questions.** If you only need to read one file,
use your editor. Grafema shines for cross-file relationships.

## Advanced Tools (Tier 2)

### query_graph — Custom Datalog queries

For complex patterns not covered by high-level tools.
See [references/query-patterns.md](references/query-patterns.md) for syntax and examples.

```json
query_graph({
  query: "violation(X) :- node(X, \"CALL\"), attr(X, \"name\", \"eval\").",
  explain: true
})
```

Available predicates: `node(Id, Type)`, `edge(Src, Dst, Type)`, `attr(Id, Name, Value)`.
Must define `violation/1` predicate for results. Use `explain: true` to debug empty results.

### get_node (file overview / shape) — File and type structure

A file-path / MODULE target gives a structured overview of imports, exports, classes,
functions, variables; a CLASS / typed VARIABLE target gives its shape (methods +
properties). Recommended first step when exploring a specific file or type.

### trace (along: "alias") — Resolve alias chains

For code like `const alias = obj.method; alias()` — traces "alias" back to
"obj.method". Requires `file`.

### get_stats (include: ["schema"]) — Available types

Returns all node and edge types in the graph (plus counts). Use when you need exact
type names before writing a query.

### query_graph (datalog violation/1) — Code rule checking

Run a Datalog `violation/1` rule — the rule IS the check; there is no separate
check_invariant tool. For persistent rules, use `create_guarantee`.

## Specialized Tools (Tier 3)

| Tool | Purpose |
|------|---------|
| get_stats | Graph statistics (node/edge counts by type) |
| get_coverage | Analysis coverage for a path |
| find_guards | Conditional guards protecting a node |
| create_guarantee | Create persistent code invariant |
| list_guarantees | List all guarantees |
| check_guarantees | Check guarantee violations |
| delete_guarantee | Remove a guarantee |
| discover_services | Discover services without full analysis |
| analyze_project | Run/re-run analysis |
| get_analysis_status | Check analysis progress |
| read_project_structure | Directory tree |
| write_config | Update .grafema/config.yaml |
| get_docs | Grafema usage docs |
| report_issue | Report bugs |
| explain_datalog | Why / why-not / what-if for derived (Datalog) facts |
| find_shared_behaviors | Cross-modality duplicate behavior clusters |
| assert / retract / recall | Knowledge-graph write / delete / retrieval |
| crawl_entity / save_document | Code→knowledge bridge / document storage |
| query_registry | Query the effects/contract registry |

## Troubleshooting

**Query returns nothing?**
1. Check analysis ran: `get_analysis_status`
2. Check type names: `get_stats({ include: ["schema"] })` for available types
3. Use `explain: true` in `query_graph` to debug
4. Check file paths match (relative to project root)

**Need help with Datalog syntax?**
- See [references/query-patterns.md](references/query-patterns.md)
- Use `get_docs({ topic: "queries" })` for inline help

**Graph seems incomplete?**
- Run `get_coverage({ path: "src/" })` to check coverage
- Re-analyze with `analyze_project({ force: true })`
- Check `.grafema/config.yaml` for include/exclude patterns

## References

- [Node and Edge Types](references/node-edge-types.md) — Complete graph schema
- [Query Patterns](references/query-patterns.md) — Datalog cookbook with examples
