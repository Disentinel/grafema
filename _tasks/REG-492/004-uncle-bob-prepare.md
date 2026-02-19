## Uncle Bob PREPARE Review: ExternalCallResolver.ts

**File size:** 258 lines — OK
**Methods to modify:** `execute()` (lines 61–223, 162 lines), `extractPackageName()` (lines 237–257, 20 lines — not modified)

---

**File-level:**

The file is well under the 500-line threshold and has a clear single responsibility: resolving external calls. The module-level comment accurately describes what the class does. No split is warranted at the file level.

One structural concern: the `metadata` getter declares `creates.edges: ['CALLS']` and `produces: ['CALLS']`, but after this change it will also create `HANDLED_BY` edges. The metadata block will need updating to accurately declare the new edge type. This is not a structural smell requiring a split — it is a correctness update that the implementer must not forget.

---

**Method-level:** `ExternalCallResolver.ts:execute`

The `execute()` method is **162 lines** — more than three times the 50-line threshold. It performs four distinct phases sequentially, all inlined:

1. Build import index (lines 69–83)
2. Collect unresolved CALL nodes (lines 85–99)
3. Pre-check existing EXTERNAL_MODULE nodes (lines 101–108)
4. Main resolution loop with counter tracking and progress reporting (lines 110–201)
5. Logging and return (lines 202–222)

Each of these phases is a candidate for extraction. The method violates the Single Responsibility Principle at the method level: it is simultaneously an orchestrator, an index builder, a node collector, a deduplication guard, and a resolution engine.

The resolution loop (lines 121–200) is itself 80 lines with nesting depth reaching **3 levels** (for loop > if statement > nested if for module existence check at lines 175–183). The progress-reporting block at lines 125–133 adds visual clutter without semantic weight.

The counter bundle (`nodesCreated`, `edgesCreated`, `callsProcessed`, `externalResolved`, `builtinResolved`, `unresolvedByReason`) — 6 mutable variables declared together — is a Parameter Object smell in disguise: these belong on a result-accumulator struct or a simple counter object.

Adding ~15 lines for HANDLED_BY edge creation inside the already-dense resolution loop will push the method to ~177 lines and deepen the cognitive load of the main loop body.

**Recommendation: REFACTOR**

Specific actions before implementing the new feature:

1. Extract `buildImportIndex(graph)` — lines 69–83 into a private method returning `Map<string, ImportNode>`. Clean, testable, named.

2. Extract `collectUnresolvedCalls(graph)` — lines 85–99 into a private method returning `CallNode[]`. The `await graph.getOutgoingEdges` call inside a loop is the expensive part; isolating it makes the cost visible.

3. Extract `resolveCall(callNode, importIndex, createdExternalModules, counters)` — the per-call resolution logic from the main for-loop body (lines 135–199). This is the method that will receive the new HANDLED_BY logic. At ~65 lines today it is still too long, but extracting it from `execute()` is the correct first move. The HANDLED_BY addition belongs inside this extracted method, not directly in `execute()`.

4. Consider an inline counter object `{ nodesCreated: 0, edgesCreated: 0, ... }` passed by reference into `resolveCall` to eliminate the 6-variable scatter.

The refactoring affects no external behavior; all logic remains identical. After extraction, `execute()` should read as a clean 5-step orchestration of ~30 lines, and the new feature lands in `resolveCall()` where it belongs.

---

**Risk:** LOW
**Estimated scope:** 3 private method extractions, no logic changes. ~30 lines moved, ~10 lines added (method signatures + calls). The existing test suite covers `execute()` behavior end-to-end, so regressions will be caught immediately.
