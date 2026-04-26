## Dijkstra Plan Verification

**Verdict:** REJECT

**Reason for rejection:** The snapshot impact analysis is materially wrong. The plan claims "only 2 snapshot nodes change" but the actual count is at least 9. This means the implementor will update 2 snapshot entries and then face failing snapshot tests. The plan must be corrected before implementation.

---

## Completeness Table 1: `shouldBeConstant` Truth Table

All 16 combinations of the four boolean inputs. "After fix" column shows the new behavior when `|| isNewExpression` is removed.

| isConst | isLoopVariable | isLiteral | isNewExpression | shouldBeConstant (before) | shouldBeConstant (after fix) | Node Type (after) | Correct? |
|---------|---------------|-----------|-----------------|--------------------------|------------------------------|-------------------|----------|
| false   | false         | false     | false           | false                     | false                        | VARIABLE          | YES      |
| false   | false         | false     | true            | false                     | false                        | VARIABLE          | YES      |
| false   | false         | true      | false           | false                     | false                        | VARIABLE          | YES      |
| false   | false         | true      | true            | false                     | false                        | VARIABLE          | YES      |
| false   | true          | false     | false           | false                     | false                        | VARIABLE          | YES      |
| false   | true          | false     | true            | false                     | false                        | VARIABLE          | YES      |
| false   | true          | true      | false           | false                     | false                        | VARIABLE          | YES      |
| false   | true          | true      | true            | false                     | false                        | VARIABLE          | YES      |
| true    | false         | false     | false           | false                     | false                        | VARIABLE          | YES      |
| true    | false         | false     | true            | **true**                  | **false**                    | **VARIABLE**      | YES — this is the bug fix |
| true    | false         | true      | false           | true                      | true                         | CONSTANT          | YES      |
| true    | false         | true      | true            | true                      | true                         | CONSTANT          | YES (isLiteral wins; a literal can't also be NewExpression in practice) |
| true    | true          | false     | false           | true                      | true                         | CONSTANT          | YES      |
| true    | true          | false     | true            | true                      | true                         | CONSTANT          | YES — loop var const stays CONSTANT; not affected by fix |
| true    | true          | true      | false           | true                      | true                         | CONSTANT          | YES      |
| true    | true          | true      | true            | true                      | true                         | CONSTANT          | YES      |

**Conclusion:** The truth table is correct. The fix is narrowly scoped: only `isConst=true, isLoopVariable=false, isLiteral=false, isNewExpression=true` changes behavior. All other cases are unaffected.

---

## Completeness Table 2: `classInstantiations.push()` firing after move outside if/else

| Input                                  | isNewExpression | callee.type       | push fires? (after fix) | Correct? |
|----------------------------------------|-----------------|-------------------|------------------------|----------|
| `const x = new Foo()`                  | true            | Identifier        | YES                    | YES      |
| `let x = new Foo()`                    | true            | Identifier        | YES                    | YES — was a bug before; let path never pushed |
| `const x = new Foo.Bar()`             | true            | MemberExpression  | NO (callee check fails)| YES — intentional, stated in plan |
| `const x = new Foo<T>()`             | true            | Identifier        | YES (TSTypeParameterInstantiation is in `typeParameters`, callee still Identifier) | YES |
| `const x = 'literal'`                 | false           | N/A               | NO (isNewExpression guard) | YES — no regression |
| `const x = foo.bar()`                 | false           | N/A               | NO (isNewExpression guard) | YES — no regression |

**However, there is a gap in the plan regarding the existing `let x = new Foo()` case.** Before the fix, for `let x = new Foo()`, `shouldBeConstant=false` so the VARIABLE node is created correctly — but `classInstantiations.push()` is NEVER called (it's inside the `shouldBeConstant` guard). After the fix, the push moves outside, so `let x = new Foo()` will now ALSO push to `classInstantiations`. This is a behavior change for the `let` case: INSTANCE_OF edges will now be created that did not exist before. The plan correctly identifies this as a desired side-effect (section "In-function NewExpression (regression for dual-path)" test case mentions `let`), but does NOT explicitly flag it as a behavior change that may affect existing snapshots or tests.

**Verdict on Table 2:** PASS with one caveat — the `let NewExpression` INSTANCE_OF edge creation is a new behavior not fully called out as a potential snapshot impact.

---

## Completeness Table 3: Dual path coverage

Both paths confirmed by reading the actual source files:

| Path | File | Line | Bug present? | Fix needed? |
|------|------|------|--------------|-------------|
| Module-level | `packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts` | 253 | YES: `isConst && (isLoopVariable \|\| isLiteral \|\| isNewExpression)` | YES |
| In-function | `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | 2084 | YES: identical line | YES |

The two code paths are structurally identical at the relevant lines. The fix is symmetric and correctly identified in both files.

**Verdict on Table 3:** PASS — both paths identified and must be fixed.

---

## Completeness Table 4: Snapshot impact — CRITICAL FAILURE

The plan states: "only 2 snapshot nodes change (CONSTANT→VARIABLE)". This is **INCORRECT**.

### Evidence from reading actual fixture files and snapshots

**Snapshot `03-complex-async.snapshot.json`:**

Module-level `const ... = new ...` declarations (go through `VariableVisitor.ts`):

| Variable | File | Declaration | Current type in snapshot |
|----------|------|-------------|--------------------------|
| `app`    | app.js line 10 | `const app = new express()` | CONSTANT (will change) |
| `config` | app.js line 45 | `const config = new AppConfig()` | CONSTANT (will change) |
| `userSchema` | models/User.js line 6 | `const userSchema = new mongoose.Schema({...})` | CONSTANT (will change) |

In-function `const ... = new ...` declarations (go through `JSASTAnalyzer.ts` `handleVariableDeclaration`):

| Variable | File | Declaration | Current type in snapshot |
|----------|------|-------------|--------------------------|
| `processor` | app.js line 131 | `const processor = new DataProcessor()` | CONSTANT (will change) |
| `processor` | dataProcessor.js line 302 | `const processor = new DataProcessor()` | CONSTANT (will change) |
| `processor` | dataProcessor.js line 311 | `const processor = new DataProcessor()` | CONSTANT (will change) |
| `processor` | dataProcessor.js line 319 | `const processor = new DataProcessor()` | CONSTANT (will change) |
| `newUser` | routes/api.js line 25 | `const newUser = new User({...})` | CONSTANT (will change) |

**Snapshot `07-http-requests.snapshot.json`:**

| Variable | File | Declaration | Current type in snapshot |
|----------|------|-------------|--------------------------|
| `headers` | client.js line 64 | `const headers = new Headers(options.headers)` | CONSTANT (will change) |

**Total CONSTANT→VARIABLE changes: at minimum 9** (3 module-level in snapshot 03, 5 in-function in snapshot 03, 1 in snapshot 07).

The plan says "2 snapshot nodes change". It correctly identifies `app` in snapshot 03 and `headers` in snapshot 07, but misses:
- `config` in snapshot 03 (module-level NewExpression, same file as `app`)
- `userSchema` in snapshot 03 (module-level, `new mongoose.Schema(...)` — note: `mongoose.Schema` is a MemberExpression callee, but `isNewExpression` only checks `declarator.init.type === 'NewExpression'`, not the callee type, so it still triggers `shouldBeConstant=true` and will change)
- All 5 in-function `processor`/`newUser` CONSTANT nodes

**This is the plan's critical error.** The implementor following this plan will update 2 entries, run the snapshot tests, and get failures on the remaining 7 nodes.

### Additional concern: other snapshots and test fixtures not mentioned

The plan does not check `02-api-service`, `04-control-flow`, `06-socketio`, `nodejs-builtins` snapshots. Spot check confirms they have no NewExpression CONSTANT nodes affected. But the plan does not document this verification — it is an implicit assumption.

---

## Completeness Table 5: `trackVariableAssignment` ASSIGNED_FROM edge for NewExpression

**Claim:** `trackVariableAssignment` already correctly creates the ASSIGNED_FROM edge for NewExpression.

**Verified at `JSASTAnalyzer.ts` lines 725-751:**

```ts
// 5. NewExpression -> CONSTRUCTOR_CALL
if (initExpression.type === 'NewExpression') {
  const callee = initExpression.callee;
  let className: string;
  if (callee.type === 'Identifier') {
    className = callee.name;
  } else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    className = callee.property.name;
  } else {
    return;
  }
  variableAssignments.push({
    variableId,
    sourceType: 'CONSTRUCTOR_CALL',
    ...
  });
}
```

This code is called from the `else { trackVariableAssignment(...) }` branch at line 463 in VariableVisitor.ts and from line 2198+ in JSASTAnalyzer.ts. It is called AFTER the `shouldBeConstant` if/else block, for all non-destructuring, non-loop variables with an initializer.

For `const x = new Foo()`, `trackVariableAssignment` IS called because the init expression is not a loop variable and not a destructuring pattern. The ASSIGNED_FROM edge will be created regardless of CONSTANT vs VARIABLE node type.

**Verdict on Table 5:** PASS — `trackVariableAssignment` correctly handles NewExpression for ASSIGNED_FROM edges. The plan's claim is correct.

**Important nuance:** In `VariableVisitor.ts`, the `trackVariableAssignment` callback is also called for `isNewExpression=true` cases because `isNewExpression` does not block the `else { trackVariableAssignment(...) }` path. There is no double-counting issue.

---

## Gaps Found

### GAP 1 (CRITICAL): Snapshot count is wrong

**Gap:** Plan states "2 snapshot nodes change" but at least 9 CONSTANT nodes will change across both snapshots:
- `app` (snapshot 03, module-level) — mentioned in plan ✓
- `config` (snapshot 03, module-level) — **MISSING from plan**
- `userSchema` (snapshot 03, module-level) — **MISSING from plan**
- `processor` x4 (snapshot 03, in-function, app.js + dataProcessor.js) — **MISSING from plan**
- `newUser` (snapshot 03, in-function, routes/api.js) — **MISSING from plan**
- `headers` (snapshot 07, in-function) — mentioned in plan ✓

The plan must be corrected to list ALL affected snapshot entries before implementation begins.

### GAP 2 (MINOR): `let x = new Foo()` INSTANCE_OF edge is new behavior

**Gap:** The plan correctly moves `classInstantiations.push()` outside the if/else, which means `let x = new Foo()` declarations will now ALSO generate INSTANCE_OF edges — behavior that did not exist before. The plan acknowledges this is correct but does not explicitly verify that no existing test or snapshot contains a `let NewExpression` variable that would be affected by this new INSTANCE_OF edge.

Search required: does any fixture have `let x = new Foo()` at module level or in-function? If so, the snapshot will now contain a new INSTANCE_OF edge that must be updated.

### GAP 3 (MINOR): `new mongoose.Schema({})` — callee is MemberExpression

**Gap:** The plan says after the fix, `classInstantiations.push()` fires for `Identifier` callees only. But `userSchema = new mongoose.Schema({})` has a `MemberExpression` callee. The plan is CORRECT that push does NOT fire for this case (intentional by design). However:
- `userSchema` will still change from CONSTANT to VARIABLE (because `isNewExpression` still fires for `shouldBeConstant`)
- `userSchema` will NOT get an INSTANCE_OF edge (callee is MemberExpression)
- This is the existing behavior for all MemberExpression NewExpressions — the ASSIGNED_FROM edge is still correctly created via `trackVariableAssignment` (which DOES handle MemberExpression callees at line 732)

This gap is not a bug, but the plan's claim that `userSchema` won't change is wrong — it **will** change from CONSTANT to VARIABLE.

---

## Precondition Issues

### PRECONDITION 1: Plan does not verify that `const user = new this(userData)` is safe

In `models/User.js` line 150: `const user = new this(userData)`. Here `callee.type` is `ThisExpression`. The `isNewExpression` check in VariableVisitor.ts is `declarator.init.type === 'NewExpression'` — this is true. So `user` will also change from CONSTANT to VARIABLE. But `classInstantiations.push()` won't fire (callee is not Identifier). Need to verify if `user` appears as a CONSTANT in any snapshot.

Check: `models/User.js` is analyzed as part of fixture `03-complex-async`. The `const user = new this(userData)` is inside a static method body (in-function path). Looking at snapshot entries for "user" with file "models/User.js" — it appears as `type: "CONSTANT"` at snapshot line 7823-7825. **This is an additional node the plan missed.**

### PRECONDITION 2: Plan's snapshot line numbers (7585-7591) may be approximate

The plan cites "Node entry at line 7585-7591" in snapshot 03 for the `app` node. This is correct as verified. But the plan should not be taken as the source of truth for snapshot line numbers during implementation — the actual snapshot must be searched.

---

## Correction Required

The plan must be updated before Rob implements it:

1. **Section "Snapshot Updates Required"**: Replace with complete list of all CONSTANT nodes that will change:
   - `03-complex-async`: `app`, `config`, `userSchema`, `user` (models/User.js), `processor` (app.js), `processor` x3 (dataProcessor.js), `newUser` (routes/api.js)
   - `07-http-requests`: `headers`

2. **Section "Tests to Add"**: Add a test specifically for `let x = new Foo()` producing INSTANCE_OF edge (currently omitted — test 3 in plan only checks VARIABLE type, not the new INSTANCE_OF edge behavior).

3. **Section "Edge Cases"**: Add note about `new this(...)` callee type (`ThisExpression`): `isNewExpression` is still true, node will become VARIABLE, but `classInstantiations.push()` will not fire (callee is not Identifier) — this is correct behavior.

---

## Summary

The plan's logic for the core fix is sound:
- Remove `|| isNewExpression` from `shouldBeConstant` — correct
- Move `classInstantiations.push()` outside if/else — correct
- Fix both VariableVisitor.ts and JSASTAnalyzer.ts — correct
- No changes to `trackVariableAssignment` — correct

The plan's snapshot impact analysis is **materially wrong** and must be corrected. An implementor following the plan verbatim will produce a PR with failing snapshot tests. This is why I reject: the plan is incomplete in a way that will cause observable test failures.
