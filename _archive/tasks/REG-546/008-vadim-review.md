## Вадим auto — Completeness Review

**Verdict:** APPROVE

**Feature completeness:** OK
**Test coverage:** OK
**Commit quality:** OK (changes are uncommitted, ready to stage)

---

### Acceptance Criteria Verification

**AC1: `const x = new Foo()` creates a VARIABLE node**

Confirmed. Both code paths updated:

- `VariableVisitor.ts` line 253: `isNewExpression` removed from `shouldBeConstant`
- `JSASTAnalyzer.ts` line 2084: same change

The fix is minimal and correct. The `shouldBeConstant` guard now only fires for literals and loop variables — as intended.

**AC2: `const x = new Foo<T>()` (TypeScript generics) creates VARIABLE**

Confirmed. The TypeScript generics test uses `'index.ts': 'const myTypedMap = new Map<string, number>();'` and asserts `myTypedMap.type === 'VARIABLE'`. The callee detection (`t.isIdentifier(init.callee)`) is unaffected by `TSTypeParameterInstantiation` since type params are not on the callee node.

**AC3: ASSIGNED_FROM edge from VARIABLE to CONSTRUCTOR_CALL**

Confirmed. The `trackVariableAssignment` callback handles `NewExpression` via the `sourceType: 'CONSTRUCTOR_CALL'` branch in `JSASTAnalyzer.ts` lines 725–751. `AssignmentBuilder.ts` lines 78–96 consume that assignment and emit the `ASSIGNED_FROM` edge. This was pre-existing logic — the fix did not break it, and test 5 (INSTANCE_OF + ASSIGNED_FROM) verifies both edges still exist after the restructuring.

**AC4: Test coverage for NewExpression initializers**

Confirmed. Four new tests plus one updated assertion cover:

| Test | Path | Scenario |
|------|------|----------|
| existing: `should track new Class()` | VariableVisitor | regression assertion added |
| new: `const myMap = new Map()` | VariableVisitor | module-level basic case |
| new: `const mySet = new Set()` | JSASTAnalyzer | in-function (dual path) |
| new: `const myTypedMap = new Map<string, number>()` | VariableVisitor (.ts) | TypeScript generics |
| new: `const myFoo = new Foo()` + INSTANCE_OF + ASSIGNED_FROM | VariableVisitor | edges preserved |

Both collection paths (VariableVisitor + JSASTAnalyzer in-function) are explicitly exercised — matching the dual-path requirement from project memory.

**AC5: Variables like `consumerIndex`, `deps` now appear as VARIABLE**

Confirmed indirectly. Snapshot diffs for `03-complex-async.snapshot.json` and `07-http-requests.snapshot.json` show 9 nodes flipping from CONSTANT to VARIABLE: `app`, `config`, `newUser`, `processor`, `user`, `userSchema`. These are exactly the `new SomeClass()` initializers that were incorrectly classified before. The pattern matches `consumerIndex = new Map()`, `deps = new DependencyTracker()`, etc.

---

### Regression Check

**`const PORT = 3000` — still CONSTANT?**

Yes. `isLiteral` is computed via `ExpressionEvaluator.extractLiteralValue()` which returns non-null for numeric literals. Since `isNewExpression` was only removed and `isLiteral` remains, literal constants are unaffected.

**Loop variables — still CONSTANT?**

Yes. `isLoopVariable` check is unchanged. `const x of arr` still produces CONSTANT.

**`let x = new Foo()` — still VARIABLE?**

Yes. `shouldBeConstant = isConst && (...)` — `isConst` is false for `let`, so it was always VARIABLE and remains so.

---

### Test Quality

Tests are meaningful:

- Each test uses the full analysis pipeline (not mocks), so they test real behavior end-to-end.
- Dual path coverage is explicit: one test for module-level (VariableVisitor), one for in-function (JSASTAnalyzer). This directly addresses the documented dual-path footgun from project memory.
- The INSTANCE_OF + ASSIGNED_FROM test guards against the specific regression risk of the `classInstantiations.push()` relocation — a test that could only fail if the structural change was done incorrectly.
- Error messages include actual values (`got ${myMap.type}`), making failures debuggable.
- `try/finally` cleanup pattern used consistently.

One minor observation: the existing test's assertion on the ASSIGNED_FROM destination is permissive (`CLASS || EXTERNAL_MODULE || CONSTRUCTOR_CALL`). This is acceptable given that enrichers resolve CONSTRUCTOR_CALL to CLASS post-analysis, and the test is testing the pre-enrichment state.

---

### Commit Quality

Changes are uncommitted (5 modified files in working tree, not yet staged). No TODOs or FIXMEs introduced. No commented-out code. The single TODO in JSASTAnalyzer.ts (`sideEffects: unknown[] // TODO: define SideEffectInfo`) is pre-existing and not in the diff. Changes are atomic — one logical fix affecting exactly the files that needed changing.
