## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK
**Complexity check:** OK

---

### Vision Alignment

The goal is "AI queries graph, not reads code." This feature moves us directly toward it.

Before REG-492, an agent wanting to answer "which calls in this file use the `express` IMPORT?" had to correlate two graph queries manually: get all CALLs, get all IMPORTs, then join on `file + name`. That join is brittle — it requires the agent to understand the data model. With `CALL → HANDLED_BY → IMPORT`, the graph carries the relationship directly. One edge traversal answers the question.

The `express.Router()` gap (namespace/method calls with `object` field) is real — those calls are completely unresolved here. The test explicitly documents it (test: "should skip namespace import method calls"). For an early access tool, this is acceptable as long as it is visible. It is visible. The test names the gap, and the "Re-exported Externals" suite documents another known limitation explicitly. That is honest engineering.

One note: the HANDLED_BY edge currently only fires for external function calls. Internal function calls (resolved by FunctionCallResolver to other FUNCTION nodes) do not get HANDLED_BY → IMPORT edges. This means the graph relationship from CALL to the import statement is only navigable for external packages. This inconsistency is not a blocker for this task's stated scope, but it should be filed as a follow-on.

### Architecture

The right call was made: extend ExternalCallResolver, not create a new enricher. The logic is tightly coupled — you can only create the HANDLED_BY → IMPORT edge at the same moment you've found the matching import for the external call. A separate enricher would duplicate the import lookup entirely. Extending the existing enricher is correct.

The refactor into three private methods (buildImportIndex, collectUnresolvedCalls, resolveCall) is clean. Each method has a single responsibility. The execute() method reads as a pipeline. This is the right shape for a plugin.

The type-only import guard (`imp.importBinding !== 'type'`) is correct and necessary — `import type { Foo }` creates no runtime binding and should not produce a HANDLED_BY edge. The test covering this is present.

### Complexity Check

- **Iteration space:** Two full graph scans (IMPORT nodes for index, CALL nodes for resolution), both O(n). The resolution loop then does O(1) index lookups per call. There is one additional O(m) scan for existing EXTERNAL_MODULE nodes to seed the dedup set. Total is O(n + m) which is appropriate for an enrichment plugin. No quadratic hidden cost.

- **Existing abstractions used correctly:** Uses `graph.queryNodes`, `graph.getOutgoingEdges`, `graph.addEdge`, `graph.addNode` — all standard graph API. Uses `NodeFactory.createExternalModule` rather than constructing nodes inline. Correct.

- **Reuses existing iteration:** The HANDLED_BY logic is inside the existing `resolveCall` method, sharing the already-fetched import node. Zero redundant lookups. Good.

- **Idempotency:** The second-run case is handled. Already-resolved calls are skipped (they have CALLS edges). EXTERNAL_MODULE dedup uses both in-memory Set and a graph.getNode check. HANDLED_BY idempotency is inherited — if the CALL was already resolved, the whole call is skipped, so no duplicate HANDLED_BY can be created.

### One Issue Worth Watching

The `collectUnresolvedCalls` method loads all unresolved CALL nodes into memory before processing. On a large codebase with 100k+ unresolved calls, this is a memory cliff. The existing EXTERNAL_MODULE pre-load has the same pattern. For the current target (legacy codebases), this could bite us. Not a reject — this was the existing pattern in the file and changing it is out of scope here — but it should be filed.
