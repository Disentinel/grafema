## Uncle Bob — Code Quality Review

**Verdict:** APPROVE

**File sizes:** OK — all files within limits
**Method quality:** OK — additions are small, readable, and consistent
**Patterns & naming:** OK — conventions followed throughout

---

### File Sizes

| File | Lines | Limit | Status |
|------|-------|-------|--------|
| `JSASTAnalyzer.ts` | 4634 | n/a (monolith, pre-existing) | OK — no new size problem |
| `CallExpressionVisitor.ts` | 684 | 700 | OK |
| `NewExpressionHandler.ts` | 205 | 500 | OK |
| `ArgumentExtractor.ts` | 313 | 500 | OK |
| `CallFlowBuilder.ts` | 283 | 500 | OK |

No file crossed the 500 or 700 line limits due to REG-556 changes.

---

### Method Quality

**`bufferArgumentEdges` (CallFlowBuilder.ts, ~166 lines)**

Already exceeded 50 lines on `main` (~149 lines). The two new blocks added by REG-556 total 17 lines. Since the method was already over the limit before this change, REJECT rule does not apply here. The additions themselves are clean: each new `else if` branch follows the identical positional-lookup pattern used for `CALL` arguments directly above it. The MemberExpression fallback (lines 149–155) is correctly gated with `!targetNodeId && objectName !== 'this'`, preventing it from overriding the existing `this.method` resolution path.

**`handleNewExpression` (CallExpressionVisitor.ts, ~119 lines)**

Was ~101 lines on `main`. Again already over 50. The two added blocks are structurally identical to the existing patterns in `handleDirectCall` and `handleSimpleMethodCall`: guard on `arguments.length > 0`, then call `ArgumentExtractor.extract`. No duplication concern — this is intentional replication across the two callee-type branches of a single method (Identifier vs MemberExpression).

**`NewExpressionHandler.ts` additions**

Two identical 14-line blocks added after `ctx.callSites.push()` and `ctx.methodCalls.push()`. The pattern mirrors the CONSTRUCTOR_CALL extraction block already present at lines 57–66 of the same file. There is surface-level structural repetition across the three extraction calls in this file, but extracting a helper would require passing `newCallId`/`newMethodCallId` through additional indirection — the current inline approach is more readable. Not a violation.

**`ArgumentExtractor.ts` addition (6 lines)**

The `NewExpression` branch is placed between `CallExpression` and `MemberExpression`, which is the correct semantic ordering: a `new Foo()` inside an argument list is more like a nested call than a member expression. The branch sets `targetType: 'CONSTRUCTOR_CALL'` with `nestedCallLine`/`nestedCallColumn` — exactly symmetric with the `CallExpression` branch above it.

**`JSASTAnalyzer.ts` additions**

Fix 1: The `extractMethodCallArguments` call after `callSites.push()` in the function-body Identifier branch directly mirrors the pattern used for the MemberExpression branch a hundred lines below. This closes a genuine asymmetry.

Fix 5a': The `isNewExpression` branch in `extractMethodCallArguments` sets `CONSTRUCTOR_CALL` target type — same semantics as in `ArgumentExtractor.ts`. Consistent.

---

### Patterns & Naming

**Comment markers:** All new inline comments use `// REG-556:` prefix. This matches the established convention in all four modified files (existing markers: `// REG-400:`, `// REG-402:`, `// REG-532:`, etc.). No deviations.

**`ConstructorCallInfo` import in CallFlowBuilder:** Correctly added to the import list and used as the type for the new `constructorCalls` parameter in `bufferArgumentEdges`. The type was already defined in `types.js` and imported by other builders. Usage is correct.

**New `bufferArgumentEdges` branches:**

The two new branches follow identical style to the surrounding `CALL` and `FUNCTION` branches: positional lookup via `.find()`, guard on `targetNodeId`, then assignment. The `nestedCallLine !== undefined && nestedCallColumn !== undefined` guard in the `CONSTRUCTOR_CALL` branch is slightly more defensive than the `CALL` branch (which uses truthy check `nestedCallLine && nestedCallColumn`). This is a minor inconsistency but not a defect — `undefined` check is strictly more correct for columns that could be `0`.

---

### Test File

`CallNodePassesArgument.test.js` (332 lines, untracked):

Intent is communicated clearly. The file header explains what REG-556 fixed, which gaps are addressed, and what edges are being verified. Test descriptions match the test bodies accurately. Each test follows the standard project pattern: write files to tmpdir, run full orchestrator, query graph, assert. The acceptance-criteria test (Test 1: `foo(a, b.c, new X())`) maps directly to the task description. The regression tests (Tests 5, 6) guard against breaking existing PASSES_ARGUMENT behavior.

One observation: the `beforeEach` creates a new DB but `db.cleanup()` is also called in an `after` hook. The `cleanupAllTestDatabases` registered in the top-level `after` provides a safety net. Consistent with the pattern in `ConstructorCallTracking.test.js`.

The `findCallNodes` helper filters by both `CALL` and `CONSTRUCTOR_CALL` — correct, since constructor calls produce both node types and Tests 3 and 4 specifically target `CONSTRUCTOR_CALL` nodes via direct filter, not `findCallNodes`. No confusion.

---

### Summary

All five fixes are small, targeted, and internally consistent. Each follows an existing pattern in the same file or method. No new abstractions were introduced where none were needed. No forbidden markers. No duplication that demands extraction. Tests communicate intent accurately and cover all stated gaps.

**APPROVE.**
