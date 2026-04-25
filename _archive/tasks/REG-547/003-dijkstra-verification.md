## Dijkstra Plan Verification

**Verdict:** APPROVE (with one annotation)

**Completeness tables:** 3 tables built

---

## Evidence Base

Three traversals in `JSASTAnalyzer.ts` touch `NewExpression` nodes. I traced all three:

**Traversal A — `traverse_calls` (line 1700-1702):**
Instantiates `CallExpressionVisitor` and calls `traverse(ast, visitor.getHandlers())`.
The handler object returned by `getHandlers()` registers:
```
NewExpression: (path: NodePath) => this.handleNewExpression(path, s)
```
`handleNewExpression` (lines 472-567) guards with `if (functionParent) return` — fires ONLY for module-level `new X()`. Creates `CALL(isNew)` nodes. Creates **no** CONSTRUCTOR_CALL nodes.

**Traversal B — `traverse_new` (lines 1730-1819):**
A standalone `traverse(ast, { NewExpression: ... })` registered directly in JSASTAnalyzer.
Guards with `if (functionParent) return` — fires ONLY for module-level `new X()`.
Creates **CONSTRUCTOR_CALL** nodes (lines 1756-1771). This is the correct path for module-level.
The dedup key is `constructor:new:${start}:${end}` stored in a local `processedConstructorCalls` set.

**Traversal C — `analyzeFunctionBody()` via `NewExpressionHandler`:**
Invoked for every function body. `NewExpressionHandler.getHandlers()` returns a `NewExpression` visitor.
Lines 34-103: creates **CONSTRUCTOR_CALL** nodes. Dedup key: `constructor:new:${start}:${end}` in `ctx.processedCallSites`.
Lines 105-171: creates **CALL(isNew)** nodes (the wrong path). These are the lines to be removed.

---

## Table 1 — Coverage Completeness by Location

| Location | Before fix: CONSTRUCTOR_CALL | Before fix: CALL(isNew) | After fix: CONSTRUCTOR_CALL | After fix: CALL(isNew) |
|----------|------------------------------|--------------------------|------------------------------|------------------------|
| In function body | Traversal C (lines 34-103) | Traversal C (lines 105-171) | Traversal C (lines 34-103) — UNCHANGED | REMOVED |
| Module-level | Traversal B (JSASTAnalyzer traverse_new) | Traversal A (CallExpressionVisitor.handleNewExpression) | Traversal B — UNCHANGED | REMOVED |

**Conclusion:** After the fix, CONSTRUCTOR_CALL creation is fully covered by independent paths that are not touched by the plan. The CALL(isNew) removals are clean cuts with no side effects on the CONSTRUCTOR_CALL path.

---

## Table 2 — Scenario Completeness

| Scenario | CONSTRUCTOR_CALL created by (before) | After fix? |
|----------|--------------------------------------|------------|
| `new Foo()` in function body | Traversal C, NewExpressionHandler lines 34-103 | Same. Unchanged. |
| `new Foo()` at module level | Traversal B, JSASTAnalyzer lines 1756-1771 | Same. Unchanged. The `if (functionParent) return` guard on line 1744 ensures Traversal B fires for module-level only and is independent of Traversal A. |
| `new ns.Foo()` in function body | Traversal C, lines 28-32 set `className = property.name`, then lines 34-103 | Same. Unchanged. |
| `new ns.Foo()` at module level | Traversal B, lines 1752-1753 set `className = property.name`, then lines 1756-1771 | Same. Unchanged. |
| `new Foo<T>()` TypeScript generic | Babel strips type params before AST traversal; callee is plain `Identifier` at visitor time. Handled by same Identifier branch as `new Foo()`. | Same. Unchanged. |
| `new Foo(arg1, arg2)` with args | Traversal C, lines 57-67 call `ArgumentExtractor` using `constructorCallId` from the CONSTRUCTOR_CALL block. | Same. Unchanged. The argument extraction uses `constructorCallId`, not the (deleted) CALL(isNew) id. |
| `new Promise(executor)` | Traversal C, lines 71-101 register `promiseExecutorContexts` using `constructorCallId`. | Same. Unchanged. The Promise executor context registration is inside the CONSTRUCTOR_CALL block (lines 34-103), not in the deleted block. |
| `throw new Error()` | Traversal C (if in function), Traversal B (if at module level). `analyzeCatchConnections` locates the CONSTRUCTOR_CALL by line+column in the `constructorCalls` array (JSASTAnalyzer line 3580-3584). | Same. Unchanged. The lookup targets the CONSTRUCTOR_CALL node, which survives the fix. |

**Conclusion:** All 8 scenarios are covered by code paths that are not touched by the plan. No gaps.

---

## Table 3 — Dedup Key Collision Risk

The two CONSTRUCTOR_CALL creation paths use the same dedup key pattern but operate in separate traversals with separate sets:

| Traversal | Dedup set | Key format |
|-----------|-----------|------------|
| Traversal C (NewExpressionHandler) | `ctx.processedCallSites` (per function-body invocation) | `constructor:new:${start}:${end}` |
| Traversal B (JSASTAnalyzer traverse_new) | local `processedConstructorCalls` (per module) | `constructor:new:${start}:${end}` |

These sets do NOT share state. Since Traversal B guards with `if (functionParent) return`, it only visits module-level nodes. Since Traversal C is only called from `analyzeFunctionBody()`, it only visits function-body nodes. The two sets never process the same AST node. No collision risk.

---

## Gaps Found

None. All CONSTRUCTOR_CALL creation paths are preserved unchanged. All CALL(isNew) emission paths are deleted cleanly.

---

## Precondition Issues

**One annotation (low severity, not a blocker):**

Don's plan note on line 167 states: "Looking at JSASTAnalyzer lines 1740-1770: this is inside `analyzeFunctionBody()` which handles function-scoped expressions." This is incorrect — the `traverse_new` block (lines 1730-1819) is in the **module-level analysis section** of `JSASTAnalyzer`, not inside `analyzeFunctionBody()`. The `if (functionParent) return` guard on line 1744 confirms it explicitly skips in-function nodes. Don's conclusion is still correct (module-level is covered), the description of which function contains the code is wrong. This does not affect the plan correctness.

**No unverified assumptions remain.** The module-level coverage risk flagged by Don (the "Critical risk") is resolved: `JSASTAnalyzer`'s `traverse_new` block (Traversal B) is a fully independent traversal that creates CONSTRUCTOR_CALL for module-level new expressions. Removing `CallExpressionVisitor.handleNewExpression()` removes only the CALL(isNew) side-product for module-level expressions; the CONSTRUCTOR_CALL side is handled by Traversal B which is not touched by the plan.

---

## Summary

The plan is correct and complete. The two deletion targets (NewExpressionHandler lines 105-171 and CallExpressionVisitor.handleNewExpression) are dead weight. Every CONSTRUCTOR_CALL scenario is covered by orthogonal code paths. The isNew field removal is safe — no logic consumer reads it. Snapshot regeneration is the only mechanical step.
