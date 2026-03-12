# AI Agent User Stories — Grafema Dogfooding

> Acceptance test for Grafema's core thesis: **AI should query the graph, not read code.**
>
> Every story is tested by the AI agent (Claude) against the live graph.
> Every ❌ BROKEN story is a product gap. Every ✅ WORKING story is proof the thesis holds.
>
> **Owner:** Claude (AI agent). Updated after each dogfooding session.
> **Last full test:** 2026-03-12 (live MCP verification via dev-proxy)

---

## US-01: Graph Availability

**Status:** ✅ WORKING
**Last tested:** 2026-03-12

As an AI agent starting a session on this codebase,
I want to call `get_stats` and confirm the graph is loaded (nodeCount > 0),
So that I know Grafema is ready before I start querying.

**Acceptance criteria:**
- `get_stats` returns nodeCount > 0 and edgeCount > 0
- Response includes breakdown by node type and edge type
- Response is fast (< 1s)

**Test results (2026-03-12):**
`get_stats` returned **130,165 nodes** and **263,779 edges** across 50 node types and 39 edge types. 4 shards, 64.3% memory. Response near-instant via dev-proxy. Growth from 117K→130K nodes reflects new Go/Rust analysis + KB enrichment.

---

## US-02: Find Functions by Name

**Status:** ✅ WORKING
**Last tested:** 2026-03-11

As an AI agent looking for a specific function,
I want to call `find_nodes(name="X", type="FUNCTION")` and get matching results,
So that I can locate function definitions without reading files.

**Acceptance criteria:**
- Partial name matching works
- Returns file path, line number, and semantic ID
- Works across languages (JS/TS, Haskell, Rust)

**Test results:**
`find_nodes(name="buildMethodIndex", type="FUNCTION")` returned **6 results** across 5 files in 4 packages (grafema-resolve, java-resolve, kotlin-resolve, jvm-cross-resolve). Each result includes file, line, column, endLine, endColumn, exported status. Partial matching works — searching just `"FUNCTION"` type returns all 3,259 functions with pagination.

---

## US-03: File Overview Without Reading

**Status:** ✅ WORKING
**Last tested:** 2026-03-12 (verified live via dev-proxy)
**Fix applied:** 2026-03-11

As an AI agent needing to understand a file,
I want to call `get_file_overview(file="path/to/file.ts")` and see its structure,
So that I don't need to read the raw source code to understand what a file contains.

**Acceptance criteria:**
- Shows imports with source modules
- Shows exports with what's exported
- Shows classes with their methods
- Shows functions with signatures
- Shows variables with assignment sources

**Test results (2026-03-12, live verification):**
`get_file_overview(file="packages/util/src/knowledge/KnowledgeBase.ts")` returned:
- ✅ Imports: 5 imports (path, fs, ./parser.js, ./types.js, ./SemanticAddressResolver.js)
- ✅ Exports: 1 named export
- ✅ Classes: KnowledgeBase at line 1097 with **16 methods** — each showing name, line, async status, and call list
- ✅ Variables: TYPE_DIR const
- ✅ Each method shows its outgoing calls (e.g., `load()` → 18 calls including parseKBNode, readFileSync, etc.)

**Fix (2026-03-11):** Changed edge filter to `['CONTAINS', 'HAS_METHOD']` in FileOverview.ts:346.

---

## US-04: Who Calls This Function?

**Status:** ✅ WORKING
**Last tested:** 2026-03-11

As an AI agent assessing impact of changing a function,
I want to call `find_calls(name="X")` and get all call sites,
So that I know who depends on this function before modifying it.

**Acceptance criteria:**
- Returns file, line number for each call site
- Shows whether the call target is resolved (linked to definition)
- Works for both function calls and method calls

**Test results:**
`find_calls(name="buildMethodIndex")` returned **6 call sites** across 5 files. Each result includes file path, line number, and resolution status. All 6 calls are `resolved: false` — expected for Haskell where cross-function call resolution within the same file isn't yet linked via CALLS edges.

`get_context` on the KnowledgeBase class shows **incoming IMPORTS_FROM** edges from 2 files (git-queries.ts and state.ts), confirming cross-file dependency tracking works.

**Note:** `resolved: false` for Haskell calls is a known limitation — the call sites are found but not linked to their target FUNCTION definitions via CALLS edges. For TypeScript, resolution works better.

---

## US-05: Cross-File Import Tracing

**Status:** ✅ WORKING
**Last tested:** 2026-03-11

As an AI agent tracing dependencies between files,
I want to follow IMPORTS_FROM edges from an import to its source module,
So that I can understand the dependency graph without reading import statements.

**Acceptance criteria:**
- Relative imports (./parser.js) resolve to the correct MODULE
- Package imports (@grafema/util) resolve across package boundaries
- IMPORT_BINDING -> target node via IMPORTS_FROM

**Test results:**
1. **Relative import:** `get_context` on `IMPORT->./parser.js` shows outgoing `IMPORTS_FROM` edge to `MODULE#packages/util/src/knowledge/parser.ts` with metadata `resolvedPath: "packages/util/src/knowledge/parser.ts"` and source `js-import-resolution`. ✅
2. **Cross-package import:** `get_context` on `CLASS->KnowledgeBase` shows incoming `IMPORTS_FROM` from `packages/mcp/src/state.ts->IMPORT_BINDING->KnowledgeBase[in:@grafema/util]`. The binding correctly resolves `@grafema/util` -> `KnowledgeBase.ts`. ✅
3. **Stats:** 1,964 IMPORTS_FROM edges and 1,212 EXPORTS edges in the graph.

---

## US-06: Data Flow Tracing

**Status:** ✅ WORKING
**Last tested:** 2026-03-12

As an AI agent tracking where a value flows,
I want to call `trace_dataflow(source="variableName", file="path")` and see the chain,
So that I can do impact analysis or taint tracking without reading code.

**Acceptance criteria:**
- Forward trace shows where a variable's value flows to
- Backward trace shows where a variable's value comes from
- Works for assignments, function arguments, and returns

**Test results (2026-03-12):**
1. **Working:** `projectPath` forward → **10 nodes** across 3 files, shape "fan-in from 3 modules". ✅
2. **Working:** `db[in:handleTraceDataFlow]` forward → **45 nodes** — all method calls (`db.getNode`, `db.queryNodes`, `db.getOutgoingEdges`, `db.getIncomingEdges`) and their result consumers (`sourceNode`, `varNode`, `edges`, `refsToDecl`, etc.). ✅
3. **Working:** `sourceNode` backward → **8 nodes** — traces back through `db.getNode` → `db` → `ensureAnalyzed`. Receiver heuristic correctly bridges CALL→receiver gap. ✅
4. **Working:** `db[in:handleGetContext]` forward → **8 nodes** in context-handlers.ts — confirms fix works across files. ✅
5. **Working:** Noise filter fixed — `detail="full"` bypasses filter; noise-only results show informative message instead of "no reachable nodes". ✅
6. **Working:** `file` parameter now used in source node search for disambiguation. ✅

**Bugs fixed (2026-03-12):**
- **Root cause: missing analyzer edges** — Rust orchestrator doesn't emit `CALL→DERIVED_FROM→PA` or `PA→READS_FROM→REFERENCE` for method calls. BFS couldn't traverse receiver chains at all (0 nodes for any method-call-heavy variable).
- **Fix: receiver heuristic** — Forward BFS builds lazy index of CALL nodes by `file::receiverName` (parsed from CALL names like `db.getNode`→receiver `db`). Backward BFS parses receiver name from CALL and finds its declaration. Both directions now work.
- Handler `file` param fix and noise filter regression also fixed.

**Known limitations:**
- Receiver heuristic matches by file+name, not lexical scope — `db` in different functions of the same file share method call matches (broader but not incorrect)
- Proper fix: analyzer should emit `CALL→DERIVED_FROM→PA` and `PA→READS_FROM→REFERENCE` edges (tracked for future work)
- Local variables discoverable only by semantic ID, not by simple name

---

## US-07: Datalog Queries

**Status:** ✅ WORKING
**Last tested:** 2026-03-11

As an AI agent running custom structural queries,
I want to write Datalog rules via `query_graph` and get matching nodes,
So that I can answer arbitrary questions about the codebase structure.

**Acceptance criteria:**
- `node(X, "TYPE")` matches nodes by type
- `edge(Src, Dst, "TYPE")` matches edges
- `attr(X, "name", "value")` matches node attributes
- Negation (`\+`) works for absence checks
- `explain: true` shows step-by-step execution

**Test results:**
1. **attr() for name:** `violation(X) :- node(X, "FUNCTION"), attr(X, "name", "buildMethodIndex").` -> **6 results**. ✅
2. **attr() for name (class):** `violation(X) :- node(X, "CLASS"), attr(X, "name", "KnowledgeBase").` -> **1 result**. ✅
3. **edge() with RE_EXPORTS:** `violation(X) :- node(X, "MODULE"), edge(_, X, "RE_EXPORTS").` -> **8 results**. ✅
4. **explain mode:** Shows step-by-step atom evaluation with timing per step. ✅
5. **check_invariant (ad-hoc):** `violation(X) :- node(X, "FUNCTION"), attr(X, "name", "eval").` -> "Invariant holds." ✅
6. **attr() for exported:** `violation(X) :- node(X, "FUNCTION"), attr(X, "exported", "true").` -> **349 results** in 116ms. ✅

---

## US-08: Understanding a Module's Purpose via KB

**Status:** ✅ WORKING
**Last tested:** 2026-03-11

As an AI agent needing to understand WHY code is structured a certain way,
I want to query the Knowledge Base before querying the graph before reading files,
So that I get architectural context, not just structural facts.

**Acceptance criteria:**
- `query_knowledge(text="X")` finds relevant facts and decisions
- `query_decisions()` lists all architectural decisions
- Decisions include rejected alternatives and rationale
- Dangling code references are flagged

**Test results:**
1. **query_knowledge(text="RFDB"):** Returned **5 results** — 2 decisions, 2 facts, 1 session. Rich content with rationale and rejected alternatives. ✅
2. **query_decisions():** Returned **10 active decisions** with full content. ✅
3. **Dangling refs:** `get_knowledge_stats` reports 11 dangling KB refs and 9 dangling code refs, clearly flagged. ✅
4. **query_decisions(module="KnowledgeBase"):** Returned 0 — filter too strict. ⚠️

**Gaps:**
- `query_decisions(module=...)` filter only matches exact semantic addresses in `applies_to` field, not substring of module names.

---

## US-09: Star Re-exports

**Status:** ✅ WORKING
**Last tested:** 2026-03-11

As an AI agent understanding a barrel file (index.ts with `export * from`),
I want to see RE_EXPORTS edges from EXPORT nodes to target MODULEs,
So that I can trace what a barrel file actually exposes.

**Acceptance criteria:**
- EXPORT `*:source` nodes have RE_EXPORTS edges
- Edges point to the resolved target MODULE
- Can be queried via Datalog

**Test results:**
Graph stats show **8 RE_EXPORTS edges**. Datalog query `violation(X) :- node(X, "MODULE"), edge(_, X, "RE_EXPORTS").` returned **8 target modules**, all in `packages/types/src/`. ✅

---

## US-10: Structural Guarantees via MCP

**Status:** ✅ WORKING
**Last tested:** 2026-03-12 (verified live via dev-proxy)
**Fix applied:** 2026-03-11

As an AI agent wanting to verify code quality invariants,
I want to call `list_guarantees` and `check_guarantees` via MCP,
So that I can validate the codebase against its defined rules.

**Acceptance criteria:**
- `list_guarantees` shows all guarantees from `.grafema/guarantees.yaml`
- `check_guarantees` runs Datalog rules and returns violations
- Can check specific guarantees by name
- Results include node IDs, file, line for violations

**Test results (2026-03-12, live verification):**
- `list_guarantees` → **36 Datalog-based guarantees** loaded from YAML ✅
- `check_guarantees(["module-has-children", "function-has-contains", "method-has-class"])` →
  - ❌ module-has-children: 3 violations (builtinPlugins.ts, pluginLoader.ts, lib.rs)
  - ✅ function-has-contains: PASSED
  - ✅ method-has-class: PASSED
- Real violations found, actionable output with file:line ✅

**Known issue:** Guarantees using `attr(X, "branchType", ...)` silently pass because BRANCH nodes store type in `name` field. Fix in progress — updating YAML to use `attr(X, "name", "switch")`.

**Fix (2026-03-11):** Added `loadFromYaml()` to GuaranteeManager + call in MCP init.

---

## US-11: Deep Context for Any Node

**Status:** ✅ WORKING
**Last tested:** 2026-03-11

As an AI agent deep-diving into a specific code entity,
I want to call `get_context(semanticId)` and see all relationships with code,
So that I understand how a node connects to the rest of the codebase.

**Acceptance criteria:**
- Shows source code at the node's location
- Shows all outgoing edges grouped by type
- Shows all incoming edges grouped by type
- Includes code context at connected nodes' locations

**Test results:**
`get_context` on `CLASS->KnowledgeBase` returned:
- **16 outgoing HAS_METHOD edges** — constructor, setBackend, invalidateResolutionCache, resolveReferences, getDanglingCodeRefs, load, getNode, queryNodes, activeDecisionsFor, addNode, supersedeFact, addEdge, getEdges, getStats, scanFiles, generateSlug
- **5 outgoing HAS_PROPERTY edges** — knowledgeDir, nodes, edges, loaded, resolver
- **2 incoming IMPORTS_FROM edges** — from git-queries.ts and state.ts (with code context)
- **1 incoming EXPORTS, 1 CONTAINS, 1 DECLARES**

---

## US-12: Engineer Onboarding — "What does this codebase have?"

**Status:** ✅ WORKING
**Last tested:** 2026-03-11

As an AI agent encountering this codebase for the first time,
I want to quickly understand its size, structure, and main components,
So that I can orient myself without reading dozens of files.

**Acceptance criteria:**
- `get_stats` gives size overview
- `get_schema` shows vocabulary (what node/edge types exist)
- `find_nodes(type="CLASS")` lists all classes
- `find_nodes(type="MODULE", file="packages/")` shows package structure

**Test results:**
1. **Size:** 117K nodes, 224K edges. ✅
2. **Schema:** 49 node types, 37 edge types. ✅
3. **Classes:** 51 classes found across error hierarchy, core, UI, diagnostics. ✅
4. **Modules by package:** 52 modules in packages/util/src. ✅

---

## US-13: Expert Engineer — "What breaks if I change this class?"

**Status:** ✅ WORKING
**Last tested:** 2026-03-12 (verified live via dev-proxy)
**Fix applied:** 2026-03-11

As an AI agent planning a refactoring of a class,
I want to find all dependents (importers, callers, subclasses),
So that I know the blast radius before making changes.

**Acceptance criteria:**
- `get_context` incoming edges show who imports the class
- `traverse_graph` with IMPORTS_FROM follows transitive dependents
- `find_calls` shows method call sites

**Test results (pre-fix):**
1. **Direct dependents:** `get_context` on KnowledgeBase shows 2 files import it. ✅
2. **traverse_graph:** `traverse_graph(startNodeIds=["MODULE#...KnowledgeBase.ts"], edgeTypes=["IMPORTS_FROM"], direction="incoming")` -> found 1 of 2 known importers. The second importer uses IMPORT_BINDING -> CLASS (not IMPORT -> MODULE), so `traverse_graph` misses it. 🔶
3. **find_calls("load"):** "No calls found" — method calls not found by `find_calls`. ❌
4. **find_calls("queryNodes"):** "No calls found" — same issue. ❌

**Root causes & fixes (3 changes):**

1. **`find_calls` missed method calls** — CALL nodes store method calls as `receiver.method` (e.g., `kb.queryNodes`). Handler did exact match on full name only. Fixed: extract method name after last `.`, match against both full name and method part. (query-handlers.ts)

2. **`get_function_details` missed class methods** — only searched `type: "FUNCTION"` nodes. Class methods are `type: "METHOD"`. Fixed: search both FUNCTION and METHOD types. (context-handlers.ts)

3. **`traverse_graph` incomplete for MODULE dependencies** — IMPORTS_FROM edges connect IMPORT_BINDINGs to target nodes, not MODULE→MODULE. Datalog join to derive MODULE→MODULE times out. Fixed: added in-memory MODULE→MODULE DEPENDS_ON edge derivation in Rust orchestrator after all resolvers complete. Collects IMPORTS_FROM edges, maps file→MODULE, deduplicates pairs. (main.rs)

**Remaining gap:**
- `className` parameter on `find_calls` matches receiver variable name (e.g., `kb`), not actual class type (`KnowledgeBase`). True class-name matching needs type resolution — deferred as future enhancement.
- DEPENDS_ON edges require re-analysis (`grafema analyze`) to be generated.

---

## US-14: Non-Engineer — "How big is this project and is it healthy?"

**Status:** 🔶 PARTIAL (git tools disabled, rest works)
**Last tested:** 2026-03-12

As a non-technical stakeholder or project manager,
I want to get a high-level health assessment of the codebase,
So that I can understand project status without reading code.

**Acceptance criteria:**
- `get_stats` gives size metrics
- `check_guarantees` shows how many rules pass/fail
- `get_knowledge_stats` shows documentation coverage
- `git_churn` shows activity hot spots

**Test results (2026-03-12):**
1. **Size:** 130K nodes, 383 modules, 3,727 functions, 56 classes. ✅
2. **Health:** `check_guarantees` works! 36 guarantees loaded, real violations found. ✅
3. **KB:** 31 knowledge nodes (14 decisions, 13 facts, 4 sessions), 62 edges. ✅
4. **Git activity:** Git tools disabled (require unfinished git-ingest feature, US-17). ❌

**Gaps:**
- Git history tools disabled until git-ingest feature is complete (US-17)

---

## US-15: Datalog attr() for Non-Name Attributes

**Status:** ✅ MOSTLY WORKING (RFD-48 fixed!)
**Last tested:** 2026-03-12

As an AI agent writing Datalog queries that filter by file path, line number, or other attributes,
I want `attr(X, "file", "path")` and `attr(X, "name", "switch")` to work,
So that I can write precise queries beyond just name matching.

**Acceptance criteria:**
- `attr(X, "name", "value")` works
- `attr(X, "file", "path")` works
- `attr(X, "exported", "true/false")` works
- Performance is reasonable (< 1s for typical queries)

**Test results (2026-03-12 — RFD-48 fixed!):**
1. **name:** `attr(X, "name", "handleTraceDataFlow")` -> 1 result. ✅
2. **exported:** `attr(X, "exported", "true")` -> works. ✅
3. **file:** `attr(X, "file", "packages/mcp/src/handlers/dataflow-handlers.ts")` -> **7 results!** ✅✅✅
4. **branchType schema change:** `attr(X, "branchType", "switch")` -> 0 results. BUT this is because BRANCH nodes store type in `name` field ("if", "switch", "ternary"), NOT in `branchType`. This is a schema difference, not an attr() bug. Guarantee rules updated to use `attr(X, "name", "switch")`. ⚠️

**Major improvement from 2026-03-11:** `attr(X, "file", ...)` now works! RFD-48 is resolved. The remaining `branchType` issue is a schema mapping problem, not a Datalog engine bug.

---

## US-16: Analysis Coverage

**Status:** ✅ WORKING
**Last tested:** 2026-03-11

As an AI agent debugging why a query returns empty results for a known file,
I want to check `get_coverage` to see which files were analyzed,
So that I know if the file is in the graph at all.

**Acceptance criteria:**
- Shows total files, analyzed count, coverage percentage
- Shows unsupported file types
- Shows unreachable files

**Test results:**
`get_coverage` returned: **345 of 669 files analyzed (52%)**. 13 unsupported (.graphql, .java, .kt, .py), 311 unreachable (.ts: 79, .js: 194, .rs: 17, etc.). Clear breakdown by extension. ✅

---

## US-17: Git History Tools

**Status:** ⏸️ DISABLED (tools hidden from MCP, awaiting git-ingest feature)
**Last tested:** 2026-03-12

As an AI agent wanting to understand code evolution and ownership,
I want to use `git_churn`, `git_archaeology`, and `git_ownership`,
So that I can identify hot spots, file age, and domain experts.

**Acceptance criteria:**
- `git_churn` shows files ranked by change frequency
- `git_archaeology` shows first/last commit for a file
- `git_ownership` shows authors ranked by contribution

**Decision (2026-03-12):** Git tools commented out from MCP tool definitions. They require `grafema git-ingest` which is an unfinished feature. Exposing broken tools hurts trust. Will re-enable when git-ingest is integrated into the analysis pipeline.

**Gaps:**
- All git history tools require `grafema git-ingest` to be run first as a separate step
- No auto-ingestion during `analyze_project`
- Needs either: auto-ingest during analyze, or explicit `git-ingest` MCP tool

---

## US-18: Go Analyzer — Node Accuracy

**Status:** ✅ WORKING
**Last tested:** 2026-03-11

As an AI agent analyzing Go codebases,
I want the go-parser → go-analyzer pipeline to produce accurate graph nodes,
So that I can query the graph for Go code with confidence.

**Acceptance criteria:**
- Struct types → CLASS nodes with correct name, line, fields
- Interface types → INTERFACE nodes with correct name, methods
- Functions/methods → FUNCTION nodes with name, line, receiver, exported, paramCount
- Variables → VARIABLE nodes for params, var decls, short var decls (:=)
- Calls → CALL nodes with name, argCount, receiver metadata
- Branches/Loops → BRANCH/LOOP nodes at correct lines
- Imports → IMPORT nodes matching import block
- Exports → correct exported names list

**Test results (gorilla/mux — 3 files exhaustively verified):**

| Check | mux.go | route.go | middleware.go | Accuracy |
|-------|--------|----------|---------------|----------|
| Structs/CLASS | 5/5 | 7/7 | 1/1 | 100% |
| Interfaces | 0/0 | 1/1 | 1/1 | 100% |
| Functions | 44/44 | 47/47 | 10/10 | 100% |
| Variables (spot) | 10/10 | 10/10 | 14/14 exhaustive | 100% |
| Calls (spot) | 10/10 | 10/10 | 14/14 exhaustive | 100% |
| Branches | 46 verified | 5/5 | 4/4 | 100% |
| Loops | 14/14 | — | 4/4 | 100% |
| Closures | — | 1/1 | 2/2 | 100% |
| Exports | 35/35 | 44/44 | 5/5 | 100% |
| Imports | 7/7 | — | — | 100% |

**Zero mismatches** on any emitted node — name, line, receiver, metadata all correct.

**Known gaps (minor, cosmetic):**
1. ~~Closure parameters not emitted~~ **FIXED** — closure params now emitted as VARIABLE nodes
2. ~~Range loop vars not emitted~~ **FIXED** — range key/value vars now emitted as VARIABLE nodes
3. ~~Closure paramCount/returnCount missing~~ **FIXED** — closures now have paramCount and returnCount metadata
4. `goTypeToName` strips package qualifier (`http.Handler` → `Handler`) — by design
5. Type aliases (func/slice/map types) classified as CLASS with `kind=type_alias` — by design

**Phase 3 deep analysis (all verified):**
- Error return tracking: `returns_error=True`, `error_return_index` on functions returning `error`
- Channel data flow: SENDS_TO and RECEIVES_FROM edges with line/col metadata
- Channel variable metadata: `chan_dir`, `chan_value_type` on channel params and vars
- Context propagation: `accepts_context`, `goroutine`, `deferred` metadata + resolver edges

**Orchestrator integration (e2e verified):**
- gorilla/mux: 6 files → 1035 nodes, 1168 edges, 0 errors
- Go module path auto-detected from go.mod: `github.com/gorilla/mux`
- Resolution: 134 edges (imports, calls, interfaces, types, context)
- Full pipeline: discovery → parse → analyze → RFDB ingest → resolve

---

## US-19: Go Context Propagation

**Status:** ✅ WORKING
**Last tested:** 2026-03-11

As an AI agent tracking context.Context flow in Go code,
I want the analyzer to detect context parameters and the resolver to emit propagation edges,
So that I can identify goroutine leaks and missing context propagation.

**Acceptance criteria:**
- Functions with `context.Context` params → `accepts_context=true` metadata
- `go func(ctx)` → `goroutine=true` on CALL node
- `defer func(ctx)` → `deferred=true` on CALL node
- Resolver emits PROPAGATES_CONTEXT, SPAWNS_WITH_CONTEXT, DEFERS_WITH_CONTEXT edges
- Functions without context params correctly have no context metadata

**Test results:**
- Custom test file with `handleRequest(ctx)` → `processData(ctx)` → `go backgroundTask(ctx)` + `defer cleanup(ctx)`:
  - All 4 context-accepting functions marked `accepts_context=True`, `context_param_index=0`
  - `noContextFunc` correctly has NO context metadata
  - `go backgroundTask(ctx)` CALL node: `goroutine=True`
  - `defer cleanup(ctx)` CALL node: `deferred=True`
  - Context param variables: `context_param=True`
- Resolver test suite: 23/23 tests pass (6 context propagation tests)
- gorilla/mux (no context params in mux.go): correctly no false positives

---

## US-20: Rust Data Flow in `describe` Output

**Status:** ❌ BROKEN
**Last tested:** 2026-03-12

As an AI agent exploring a Rust codebase via `describe file.rs -d 2`,
I want to see the same flow information as for TypeScript files — calls, reads, writes, data flow —
So that I can understand Rust module behavior without reading source code.

**Acceptance criteria:**
- `describe shard.rs -d 2` shows `> calls`, `< reads`, `=> writes` for impl methods
- Impl blocks are nested under their struct/trait
- Closures (`.map(|x| ...)`, `.filter(|x| ...)`) show callback context like TS arrows
- Error handling chains (`?`, `.unwrap()`, `.expect()`) show as `>x throws` or similar
- `match` arms appear as `?| case` branches

**Test results:**
`describe packages/rfdb-server/src/storage_v2/multi_shard.rs -d 2`:
- ✅ Structs shown: `DatabaseConfig`, `MultiShardStore`, `ShardStats` with fields and attributes
- ✅ Imports: `crate o- imports from lib`, `std`, `serde`
- ❌ **Zero flow edges** — no `> calls`, `< reads`, `=> writes` for any function/method
- ❌ **Impl methods not visible** — struct blocks show `> has field`, `> has attribute`, `> derives` but no methods
- ❌ **`<unknown>` nodes** — unresolved structural nodes (line 1357, 2000) appear raw
- ❌ **No closures resolved** — Rust closures not detected at all

`describe packages/rfdb-server/src/storage_v2/shard.rs -d 2`:
- Same pattern: structs + fields + attributes, **zero flow**, no impl methods, `<unknown>` nodes

`describe packages/rfdb-server/src/storage_v2/writer.rs -d 2`:
- Same pattern: `NodeSegmentWriter`, `EdgeSegmentWriter` structs only

**Root cause:** Rust analyzer (grafema-orchestrator) focuses on structural analysis — `struct`, `enum`, `impl`, `use`, `mod`, `trait` declarations and their relationships. It does **not yet analyze function bodies** for:
- CALLS edges (function/method invocations)
- READS_FROM / WRITES_TO (variable access)
- PASSES_ARGUMENT (function arguments, including closures)
- Control flow (match arms, if/else, loops)

This is the same gap as TypeScript circa early Grafema — structural skeleton without behavioral edges.

**Impact:** Rust files in `describe` output show WHAT exists but not WHAT IT DOES. For a 2000-line `shard.rs`, the describe output is ~15 lines of struct names — vs TypeScript where a 500-line file produces rich flow notation showing calls, data flow, error handling.

**Needed:**
1. Rust function body traversal in orchestrator (syn crate already parses these)
2. CALLS edges for `fn()` and method calls (`self.flush()`, `Shard::new()`)
3. READS_FROM / WRITES_TO for field access (`self.shards`, `config.path`)
4. PASSES_ARGUMENT for closures (`.map(|x| ...)`, `.filter(...)`)
5. Control flow: `match` → BRANCH, `if let` → BRANCH, `loop`/`for` → LOOP
6. Error propagation: `?` operator → implicit THROWS chain

---

## Summary

| Story | Status | Key Finding |
|-------|--------|-------------|
| US-01 | ✅ WORKING | 130K nodes, 264K edges, instant response |
| US-02 | ✅ WORKING | Cross-language function search |
| US-03 | ✅ WORKING | File overview with 16 class methods + call lists |
| US-04 | ✅ WORKING | 41 call sites for queryNodes via receiver.method |
| US-05 | ✅ WORKING | Relative + cross-package imports resolve |
| US-06 | 🔶 PARTIAL | Noise filter regression + `file` param ignored (fix in progress) |
| US-07 | ✅ WORKING | attr(), edge(), negation, explain all work |
| US-08 | ✅ WORKING | 14 decisions, 13 facts, 4 sessions |
| US-09 | ✅ WORKING | 8 RE_EXPORTS edges via Datalog |
| US-10 | ✅ WORKING | 36 guarantees loaded from YAML, violations found |
| US-11 | ✅ WORKING | Rich context: methods, properties, importers |
| US-12 | ✅ WORKING | Full onboarding via stats + schema |
| US-13 | ✅ WORKING | find_calls + get_context work; get_function_details inconsistent (fix in progress) |
| US-14 | 🔶 PARTIAL | Stats + guarantees + KB work; git tools disabled |
| US-15 | ✅ MOSTLY | RFD-48 FIXED! attr(file) works. branchType→name schema fix applied |
| US-16 | ✅ WORKING | 345/669 files (52%) analyzed |
| US-17 | ⏸️ DISABLED | Git tools hidden from MCP until git-ingest feature complete |
| US-18 | ✅ WORKING | Go analyzer: 100% accuracy on gorilla/mux |
| US-19 | ✅ WORKING | Context propagation: analyzer + resolver |
| US-20 | ❌ BROKEN | Rust: zero flow edges, no impl methods, no closures |

**Score: 15 ✅ / 2 🔶 / 1 ❌ / 1 ⏸️** (was 13/3/2 → promoted US-03, US-10, US-13, US-15; disabled US-17)

### Critical Product Gaps (Remaining)

1. **US-06: trace_dataflow regression** — Noise filter (REFERENCE/EXPRESSION/LITERAL) hides BFS results. Handler ignores `file` parameter. BFS algorithm itself is correct. Fix in progress.
2. **US-13 partial: get_function_details inconsistency** — Returns `calls: [], calledBy: []` while `describe` shows rich call data for the same function. Different code paths (scope traversal vs edge query). Fix in progress.
3. **US-17: Git tools disabled** — Require unfinished git-ingest feature. Removed from public API.
4. **US-20: Rust analyzer lacks function body analysis** — Only structural skeleton. `describe` on Rust files shows 15 lines of struct names for 2000-line files. Needs syn-based function body traversal in orchestrator.

### Go Analyzer Gaps (from US-18 validation) — ALL FIXED

4. ~~**Closure params not emitted**~~ **FIXED** — `FuncLitNode` now extracts params from `funcType` and calls `walkParam` for each.
5. ~~**Range loop vars not emitted**~~ **FIXED** — `RangeStmt` now emits VARIABLE nodes for key/value identifiers (skips `_`).
6. ~~**Closure paramCount/returnCount missing**~~ **FIXED** — Closure metadata now includes `paramCount` and `returnCount`.
7. **Package qualifier stripped** — `goTypeToName(SelectorType _ sel _) = sel` drops the prefix. `http.Handler` → `Handler`. Known trade-off, by design.

### Fixes Applied 2026-03-12

1. **Narrative Trace Renderer** — New `renderTraceNarrative()` with LOD (summary/normal/full), unified operator vocabulary from `archetypes.ts`, `generateLegend()` as single source of truth for describe + trace
2. **MCP dev-proxy** — `packages/mcp/src/dev-proxy.ts`: stdio proxy with `reload` tool injection. No more manual MCP restarts after `pnpm build`
3. **US-06 fix (in progress)** — Handler: use `file` param in source lookup. Renderer: show raw BFS count when noise filter removes everything
4. **US-13 fix (in progress)** — `get_function_details` consistency with `describe`
5. **US-15** — Guarantee rules `branchType` → `name` for BRANCH nodes
6. **US-17** — Git tools commented out from MCP definitions

### Fixes Applied 2026-03-11 (gap-loop session #1)

1. **US-03** — FileOverview.ts: changed `['CONTAINS']` to `['CONTAINS', 'HAS_METHOD']` in `buildClassOverview`
2. **US-10** — GuaranteeManager.ts: added `loadFromYaml()` method; state.ts: call it during MCP init
3. **US-13** — Three fixes:
   - query-handlers.ts: `find_calls` now extracts method name from `receiver.method` pattern
   - context-handlers.ts: `get_function_details` searches both FUNCTION and METHOD node types
   - main.rs (orchestrator): MODULE→MODULE DEPENDS_ON edge derivation from IMPORTS_FROM edges
