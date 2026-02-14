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
  version: "0.2.5"
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
GOOD: trace_dataflow({ source: "userInput", direction: "forward" }) -> complete data flow

BAD:  Read file by file to understand module dependencies
GOOD: get_file_overview({ file: "src/api.ts" }) -> structured imports, exports, classes, functions
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

These 5 tools handle ~80% of queries. Start here.

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

### get_function_details — Complete function info

```json
get_function_details({ name: "handleRequest" })
get_function_details({ name: "validate", file: "src/auth.ts" })
get_function_details({ name: "processOrder", transitive: true })
```

**Use when:** "What does function X do?", "What does it call?", "Who calls it?"

Returns: signature, parameters, what it calls, who calls it.
Use `transitive: true` to follow call chains (A calls B calls C, max depth 5).

### get_context — Deep context for any node

```json
get_context({ semanticId: "src/api.ts:handleRequest#fn" })
get_context({ semanticId: "src/db.ts:Database#class", edgeType: "CALLS" })
```

**Use when:** "Tell me everything about this entity", "Show me its relationships"

Returns: node info, source code, ALL incoming/outgoing edges with code context.
Use after `find_nodes` to deep-dive into a specific result.

### trace_dataflow — Trace data flow

```json
trace_dataflow({ source: "userInput", file: "src/handler.ts", direction: "forward" })
trace_dataflow({ source: "dbResult", file: "src/query.ts", direction: "backward" })
trace_dataflow({ source: "config", direction: "both", max_depth: 5 })
```

**Use when:** "Where does this value end up?", "Where does this data come from?",
"Is user input reaching the database unsanitized?"

Directions: `forward` (where does it go?), `backward` (where did it come from?), `both`.

## Decision Tree

```
START: What do you need?
|
|-- "Find entities (functions, classes, routes)"
|   -> find_nodes({ type, name, file })
|
|-- "Find who calls function X"
|   -> find_calls({ name: "X" })
|   -> For full details: get_function_details({ name: "X" })
|
|-- "Understand a specific entity deeply"
|   -> First: find_nodes to get its semantic ID
|   -> Then: get_context({ semanticId: "..." })
|
|-- "Trace data flow"
|   -> trace_dataflow({ source, file, direction })
|
|-- "Understand a file's structure"
|   -> get_file_overview({ file: "path/to/file.ts" })
|
|-- "Trace an alias/re-export chain"
|   -> trace_alias({ variableName: "alias", file: "path.ts" })
|
|-- "Check a code rule/invariant"
|   -> check_invariant({ rule: "violation(X) :- ..." })
|
|-- "Custom complex query"
|   -> query_graph({ query: "violation(X) :- ..." })
|   -> See references/query-patterns.md for Datalog syntax
|
|-- "Explore unknown codebase"
|   -> get_stats() for high-level overview
|   -> get_schema() for available node/edge types
|   -> find_nodes({ type: "MODULE" }) for module list
|   -> get_file_overview for specific files
```

## Common Workflows

### 1. Impact Analysis: "What breaks if I change function X?"

```
get_function_details({ name: "X", transitive: true })
-> Check calledBy array for all callers (direct + transitive)
-> For critical callers: get_context({ semanticId }) for full picture
```

### 2. Security Audit: "Does user input reach the database?"

```
find_nodes({ type: "http:request" })
-> For each route, trace_dataflow({ source: requestParam, direction: "forward" })
-> Check if flow reaches db:query nodes
-> Use find_guards to check for sanitization
```

### 3. Onboarding: "How is this codebase structured?"

```
get_stats()                              -> Node/edge counts by type
find_nodes({ type: "MODULE" })           -> All modules
get_file_overview({ file: "src/index.ts" })  -> Entry point structure
find_nodes({ type: "http:request" })     -> All API endpoints
```

### 4. Dependency Analysis: "What does module X depend on?"

```
get_file_overview({ file: "src/service.ts" })
-> Check imports section for dependencies
-> For each import: get_context for deeper relationships
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
`get_function_details` are optimized for common queries. Reserve Datalog for
complex patterns (joins, transitive closure, invariant checks).

**Don't skip analysis status.** If you just ran `analyze_project`, check
`get_analysis_status` before querying — partial results are misleading.

**Don't request excessive depth.** `get_context` with no filters returns everything.
Use `edgeType` filter to focus on specific relationships (e.g., `"CALLS,ASSIGNED_FROM"`).

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

### get_file_overview — File-level structure

Structured overview of imports, exports, classes, functions, variables with relationships.
Recommended first step when exploring a specific file before using `get_context`.

### trace_alias — Resolve alias chains

For code like `const alias = obj.method; alias()` — traces "alias" back to "obj.method".

### get_schema — Available types

Returns all node and edge types in the graph. Use when you need exact type names.

### check_invariant — Code rule checking

Check if a Datalog rule has violations. For persistent rules, use `create_guarantee`.

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
| get_documentation | Grafema usage docs |
| report_issue | Report bugs |

## Troubleshooting

**Query returns nothing?**
1. Check analysis ran: `get_analysis_status`
2. Check type names: `get_schema` for available types
3. Use `explain: true` in `query_graph` to debug
4. Check file paths match (relative to project root)

**Need help with Datalog syntax?**
- See [references/query-patterns.md](references/query-patterns.md)
- Use `get_documentation({ topic: "queries" })` for inline help

**Graph seems incomplete?**
- Run `get_coverage({ path: "src/" })` to check coverage
- Re-analyze with `analyze_project({ force: true })`
- Check `.grafema/config.yaml` for include/exclude patterns

## References

- [Node and Edge Types](references/node-edge-types.md) — Complete graph schema
- [Query Patterns](references/query-patterns.md) — Datalog cookbook with examples
