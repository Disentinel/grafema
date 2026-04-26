## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

---

### Vision Alignment

"AI should query the graph, not read code."

Before this fix, 47.4% of nodes inside switch/case blocks were unreachable — not disconnected from the codebase, disconnected from the graph. An AI agent querying the graph would get a structurally incomplete picture of any file with switch statements. That is a direct product gap.

This fix closes that gap. After it, every node inside every case clause is reachable through a continuous CONTAINS chain: FUNCTION_BODY → ... → BRANCH → CASE → SCOPE(case_body) → node. The graph now accurately represents the code. That is exactly what the vision demands.

### Architecture

The implementation follows established patterns without inventing new ones:

- `SCOPE` node creation in `SwitchCase.enter` mirrors LoopHandler's body SCOPE creation in loop `enter`
- `scopeIdStack.push/pop` discipline matches LoopHandler and TryCatchHandler exactly
- `scopeTracker.enterCountedScope/exitScope` called in the same order as LoopHandler: push stack first, enter tracker second — ensuring children see the correct semantic context
- `switchCaseScopeMap` on `FunctionBodyContext` follows `ifElseScopeMap` and `tryScopeMap` — same data structure, same purpose, consistent naming

One significant improvement over the original plan: the SCOPE node is created in `SwitchCase.enter` (Dijkstra's Approach B), not pre-allocated in `handleSwitchStatement`. This eliminates the semantic ID context mismatch that Dijkstra identified as the most significant correctness gap. The map carries only the caseId needed as parentScopeId. Correct.

The `ctx.parentScopeId` → `ctx.getCurrentScopeId()` fix is necessary and correct. The pre-existing bug — passing a stale function-body scope ID for nested switches — has existed since SwitchStatement tracking was introduced. It is fixed here as a byproduct of this change. Fixing root causes is the right policy.

Empty case fall-throughs are correctly excluded: `if (caseNode.consequent.length === 0) return` in both enter and exit. No empty SCOPE nodes, no wasted IDs. The map-based exit guard (`switchCaseScopeMap.has(caseNode)`) provides correct pop-only-if-pushed behavior and is safe because the map is only deleted in exit, so if enter ran to completion the map will have the entry when exit fires.

The scope type strings `switch-case` and `default-case` are distinct, which is the right choice — a `default:` clause is semantically different from a named case and should be distinguishable in queries.

### One observation

The exit guard uses `ctx.switchCaseScopeMap.has(caseNode)` to decide whether to pop. Dijkstra flagged this as introducing a logical dependency between the pop decision and map state. In practice this is safe — enter and exit are called in matched pairs by Babel, and the map is not modified between them except by the exit handler itself. However, LoopHandler's exit is unconditional (no map lookup). This is a minor style inconsistency, not a defect. The behavior is correct.
