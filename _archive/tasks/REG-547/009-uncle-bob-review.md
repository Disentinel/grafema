## Uncle Bob — Code Quality Review

**Verdict:** APPROVE

**File sizes:** OK
**Method quality:** OK
**Patterns & naming:** OK (one minor test duplication noted)

---

### File Sizes

All files are well within limits:

| File | Lines | Status |
|------|-------|--------|
| `NewExpressionHandler.ts` | 107 | OK |
| `CallExpressionVisitor.ts` | 469 | OK |
| `call-expression-types.ts` | 177 | OK |
| `types.ts` | 1281 | OK (pre-existing large aggregate types file) |

No split required. No critical thresholds approached.

### Leftover References

```
grep -n "isNew|handleNewExpression" NewExpressionHandler.ts  → 0 matches
grep -n "isNew|handleNewExpression" CallExpressionVisitor.ts → 0 matches
```

Clean. No dangling references, no dead imports, no commented-out code.

### NewExpressionHandler.ts — Post-Deletion Quality

The remaining handler is clean and linear. One responsibility: detect `NewExpression`, extract `className`, create `CONSTRUCTOR_CALL`, extract arguments, register Promise executor context if applicable. The logic reads top-to-bottom with no surprises. The `if (className)` guard is tight. The early return via `processedCallSites` dedup is clear.

No leftover `isNew` assignments. No leftover `computeSemanticId` import. The file header comment still accurately describes the handler's purpose.

### CallExpressionVisitor.ts — Post-Deletion Quality

The `getHandlers()` method now registers only `CallExpression`. The trailing comma after the `CallExpression` handler body (line 201) is a minor style artifact but harmless and consistent with JS/TS trailing-comma convention. No dangling reference to `handleNewExpression` anywhere. The JSDoc in the file header was updated to remove "Constructor calls" from the handled list.

The `extractFirstLiteralArg` function signature was correctly simplified from `CallExpression | NewExpression` to `CallExpression` only — matching the new reality. No dead import of `NewExpression` type remains.

The private handler hierarchy (`handleDirectCall`, `handleMemberCall`, `handleSimpleMethodCall`, `handleNestedMethodCall`) is unaffected and reads cleanly.

### Test Quality: ConstructorCallTracking.test.js (REG-547 section)

The describe block name is explicit: `'No spurious CALL(isNew:true) duplicates (REG-547)'`. The section comment above it (lines 800-806) explains the bug and the expected post-fix behavior. This is good — a reader who finds a failing test immediately knows what the original defect was.

Test names communicate intent clearly:
- `'should NOT produce a CALL node with isNew:true for new Foo()'` — the primary regression test
- `'should produce exactly N CONSTRUCTOR_CALL nodes and 0 CALL(isNew:true) for N new expressions'` — the counting invariant
- `'should produce CONSTRUCTOR_CALL with className for namespaced new ns.Foo()'` — the MemberExpression callee case
- `'should not produce CALL(isNew:true) duplicates inside functions'` — the in-function path
- `'should not produce CALL(isNew:true) duplicates for thrown constructors'` — the throw context
- `'should not produce CALL(isNew:true) duplicates for constructor in return'` — the return context
- `'should not produce CALL(isNew:true) duplicates for constructor passed as argument'` — the argument context

One minor duplication: tests 1 and 2 both use `const x = new Foo();` as the source program. Test 2 adds attribute assertions (`file`, `line`) not present in test 1, so it is not a pure duplicate — but the overlap is real. This is a low-severity issue; both tests could have been a single test, or test 1 could have used a different program to distinguish the two scenarios. Not worth a reject.

### CallExpressionVisitorSemanticIds.test.js — Updated Tests

The two updated tests in the `'constructor calls (new)'` describe block now explicitly assert `CONSTRUCTOR_CALL` existence and zero `CALL(isNew:true)` nodes. The assertion messages are clear. The intent is unambiguous.

### Summary

This is a pure deletion. Pure deletions are the best kind of fix — no new complexity introduced, no new patterns to learn, no new edge cases to manage. The code that remained was already clean. The tests lock the correct post-fix behavior with specific, well-named cases. The change is complete and correct.
