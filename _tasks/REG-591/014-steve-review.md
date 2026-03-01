## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK
**Complexity check:** OK — no O(n) scan over all nodes

---

### Complexity Check

The complexity concern is about scanning ALL nodes looking for patterns. Here is what actually happens:

**ExpressPlugin._findExpressVarNames:**
- Iterates over `fileResult.nodes` once to find VARIABLE nodes — O(n_nodes_in_file), not O(global_n)
- Builds an edge index from `fileResult.edges` — O(n_edges_in_file)
- BFS convergence loop over VARIABLE nodes — worst case O(n_vars^2) but bounded by file scope, not project scope

**ExpressPlugin.analyzeFile main loop:**
- Iterates over `fileResult.nodes` to find CALL nodes — O(n_nodes_in_file)
- Early exit via `expressVarNames.size === 0` — skips entirely for non-Express files

This is O(m) over a specific small set (one file at a time), not a global scan. Plugins run per-file after Stage 2 completes, so the domain is bounded. No global graph traversal.

---

### Plugin Architecture

**Forward registration — correct pattern.**

Plugins are registered in `DOMAIN_PLUGIN_REGISTRY` in `CoreV2Analyzer.ts`. New framework support (socketio, fetch, etc.) requires only:
1. A new class implementing `DomainPlugin`
2. One line in `DOMAIN_PLUGIN_REGISTRY`
3. One export in `packages/core/src/plugins/domain/index.ts`

No modifications to `walk.ts`, no modifications to the visitor pipeline. The extension point is clean and explicit.

---

### Vision Alignment

"AI should query the graph, not read code."

The plugin design supports this vision correctly. ExpressPlugin produces `http:route` and `express:mount` nodes that agents can query directly — `find_nodes(type="http:route")` instead of reading Express source files and pattern-matching manually. The graph becomes the superior interface.

The data-flow approach (`_findExpressVarNames` via ASSIGNED_FROM edges) is correct: it uses the graph that Stage 1+2 already built rather than doing independent AST pattern matching from scratch. This is the right use of available data.

**argValues in CALL metadata:** Adding `argValues` to every CALL node is a small but correct tradeoff. It slightly increases per-node memory for a meaningful gain: plugins can extract route paths without re-parsing the AST. The alternative — exposing raw AST to plugins as a mandatory interface — would be worse. The `ast` escape hatch is available but correctly discouraged.

---

### Architecture

The `DomainPlugin` interface contracts are well-specified:
- Pure function: no I/O, no mutations
- Runs after Stage 2 (file-scope resolution complete), before project-stage
- Cannot modify existing nodes — only creates new ones
- Error isolation: plugin crashes are non-fatal (caught in `runDomainPlugins`)

The `Readonly<FileResult>` parameter enforces the read-only contract at the type level, which is the right approach.

Sequential plugin execution with accumulated result (`later plugins see earlier plugin output`) is the right choice for the current scope. Parallel execution would complicate ordering guarantees and isn't needed yet.

---

### Minor Observations (non-blocking)

1. The BFS convergence loop in `_findExpressVarNames` has a minor inefficiency: it uses `nodes.find(n => n.id === nodeId)` at the end (line 196), which is O(n) per entry. This could be O(1) with `nodeById`. Not a correctness issue, and not a rejection reason — file scope keeps it bounded.

2. `DOMAIN_PLUGIN_REGISTRY` is a static object in `CoreV2Analyzer.ts`. This works for the current set but limits runtime extensibility (e.g., user-provided plugins via config). The current design matches the acceptance criteria and can be extended later without breaking the interface.

Both observations are forward-looking, not issues with the current implementation.
