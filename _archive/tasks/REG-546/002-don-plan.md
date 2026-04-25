# REG-546 Implementation Plan — Don Melton

## Problem Restatement

`const x = new Foo()` creates a **CONSTANT** node. `const items = foo.map(...)` creates a **VARIABLE** node.

Enrichers (`ValueDomainAnalyzer`, `AliasTracker`) and the VS Code trace engine only query `nodeType: 'VARIABLE'`. They silently miss everything initialized with `new`. The acceptance criteria is explicit: `const x = new Foo()` must create a VARIABLE node.

The root cause is this line in **two separate code paths**:

```js
const shouldBeConstant = isConst && (isLoopVariable || isLiteral || isNewExpression);
//                                                                   ^^^^^^^^^^^^^^^
//                                                         This is the bug — remove it
```

---

## Root Cause: The Dual Collection Paths

Per the MEMORY.md architectural note: AST node types are collected via **TWO independent paths**. Both must be changed.

### Path 1 — Module-level (VariableVisitor)

File: `packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`

Line 249-253:
```ts
const isNewExpression = declarator.init && declarator.init.type === 'NewExpression';
// ...
const shouldBeConstant = isConst && (isLoopVariable || isLiteral || isNewExpression);
```

### Path 2 — In-function (JSASTAnalyzer.handleVariableDeclaration)

File: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

Line 2080-2084:
```ts
const isNewExpression = declarator.init && declarator.init.type === 'NewExpression';
// ...
const shouldBeConstant = isConst && (isLoopVariable || isLiteral || isNewExpression);
```

---

## Exact Changes Required

### Change 1: VariableVisitor.ts — remove `|| isNewExpression` from shouldBeConstant

**File:** `packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`

**Before (line 253):**
```ts
const shouldBeConstant = isConst && (isLoopVariable || isLiteral || isNewExpression);
```

**After:**
```ts
const shouldBeConstant = isConst && (isLoopVariable || isLiteral);
```

**Side effect: move `classInstantiations.push()` outside the `shouldBeConstant` guard.**

Currently (lines 282-294):
```ts
if (shouldBeConstant) {
  // CONSTANT node creation...
  if (isNewExpression) {
    classInstantiations.push({ variableId: varId, ... });  // INSTANCE_OF edges
  }
} else {
  // VARIABLE node creation...
  // classInstantiations NOT pushed here — bug for `let x = new Foo()`
}
```

After the fix, `const x = new Foo()` falls through to the `else` branch (VARIABLE). The `classInstantiations.push()` must be placed AFTER the if/else block so it fires for any NewExpression, regardless of const/let and regardless of shouldBeConstant:

```ts
if (shouldBeConstant) {
  // CONSTANT node creation (literals, loop vars)...
} else {
  // VARIABLE node creation...
}

// After the if/else: track NewExpression for INSTANCE_OF edges
if (isNewExpression) {
  const newExpr = declarator.init as NewExpression;
  if (newExpr.callee.type === 'Identifier') {
    const className = (newExpr.callee as Identifier).name;
    (classInstantiations as ClassInstantiationInfo[]).push({
      variableId: varId,
      variableName: varInfo.name,
      className: className,
      line: varInfo.loc.start.line,
      parentScopeId: module.id
    });
  }
}
```

### Change 2: JSASTAnalyzer.ts (handleVariableDeclaration) — same fix

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Before (line 2084):**
```ts
const shouldBeConstant = isConst && (isLoopVariable || isLiteral || isNewExpression);
```

**After:**
```ts
const shouldBeConstant = isConst && (isLoopVariable || isLiteral);
```

**Same side effect: move `classInstantiations.push()` outside the `shouldBeConstant` guard.**

Currently (lines 2119-2129):
```ts
if (shouldBeConstant) {
  // ...
  const init = declarator.init;
  if (isNewExpression && t.isNewExpression(init) && t.isIdentifier(init.callee)) {
    const className = init.callee.name;
    classInstantiations.push({ variableId: varId, ... });
  }
} else {
  // VARIABLE creation — no classInstantiations push
}
```

After the fix, move the classInstantiations block to after the if/else:

```ts
if (shouldBeConstant) {
  // CONSTANT node (literals, loop vars)...
} else {
  // VARIABLE node...
}

// After if/else: track NewExpression for INSTANCE_OF edges
const init = declarator.init;
if (isNewExpression && t.isNewExpression(init) && t.isIdentifier(init.callee)) {
  const className = init.callee.name;
  classInstantiations.push({
    variableId: varId,
    variableName: varInfo.name,
    className: className,
    line: varInfo.loc.start.line,
    parentScopeId
  });
}
```

### No Changes Needed in trackVariableAssignment

`trackVariableAssignment` in `JSASTAnalyzer.ts` (lines 610-891) already handles NewExpression correctly — it creates the ASSIGNED_FROM edge to the CONSTRUCTOR_CALL node. This code path is NOT the bug. The bug is in `handleVariableDeclaration` and `VariableVisitor` (the node type decision), not in the edge creation.

Similarly, `NewExpressionHandler.ts` (in-function CONSTRUCTOR_CALL creation) and `AssignmentBuilder.ts` (ASSIGNED_FROM edge building) are correct and do not need changes.

---

## Snapshot Updates Required

**~10 snapshot nodes** (not 2 as initially estimated — Dijkstra correction) will flip from CONSTANT to VARIABLE across two snapshot files. Do NOT manually edit snapshot entries. After implementation, run the snapshot update command to regenerate them all at once.

Affected nodes (Dijkstra-verified enumeration):

### `test/snapshots/03-complex-async.snapshot.json`

Module-level (VariableVisitor path):
- `app` — `const app = new express()` (app.js line 10)
- `config` — `const config = new AppConfig()` (app.js line 45)
- `userSchema` — `const userSchema = new mongoose.Schema(...)` (models/User.js line 6)

In-function (JSASTAnalyzer path):
- `processor` — `const processor = new DataProcessor()` (app.js line 131)
- `processor` x3 — (dataProcessor.js lines 302, 311, 319)
- `newUser` — `const newUser = new User({...})` (routes/api.js line 25)
- `user` — `const user = new this(userData)` (models/User.js line 150, callee is ThisExpression — VARIABLE but no INSTANCE_OF edge)

### `test/snapshots/07-http-requests.snapshot.json`

In-function (JSASTAnalyzer path):
- `headers` — `const headers = new Headers(options.headers)` (client.js line 64)

**How to update snapshots:** Run `node --test --test-concurrency=1 'test/unit/snapshot*.test.js' -- --update-snapshots` (or equivalent update flag for this project). Check the project's existing snapshot test mechanism first.

**CONSTANT nodes that remain CONSTANT (unaffected):**
- Literals (`const PORT = 3000`, `const batch = []`) — still CONSTANT because of `isLiteral`
- Loop variables (`for (const key in obj)`) — still CONSTANT because of `isLoopVariable`

---

## Tests to Add / Modify

### Modify existing test: `test/unit/DataFlowTracking.test.js` line 194

The existing `'should track new Class() assignment'` test does NOT assert `helper.type === 'VARIABLE'`. After the fix, add this assertion:

```js
assert.strictEqual(helper.type, 'VARIABLE', 'NewExpression initializer should create VARIABLE node, not CONSTANT');
```

### Add new tests to `test/unit/DataFlowTracking.test.js`

Add these cases to the `NewExpression Assignments` describe block:

**1. In-function NewExpression (regression for dual-path)**
```js
it('should track in-function new Class() as VARIABLE', async () => {
  // const consumerIndex = new Map(); inside a function body
  // Tests the handleVariableDeclaration path in JSASTAnalyzer
});
```

**2. TypeScript generics (regression for TS type parameter stripping)**
```js
it('should track const x = new Map<string, Set<string>>() as VARIABLE', async () => {
  // Verify TSTypeParameterInstantiation wrapping doesn't break callee detection
  // The callee is still Identifier 'Map' even with type params
});
```

**3. let x = new Foo() (not const)**
```js
it('should track let x = new Foo() as VARIABLE', async () => {
  // Verify let NewExpression also creates VARIABLE (was already VARIABLE before, regression guard)
});
```

**4. INSTANCE_OF edge preserved for const NewExpression**
```js
it('should still create INSTANCE_OF edge for const x = new Foo()', async () => {
  // After moving classInstantiations.push() outside the shouldBeConstant guard,
  // verify INSTANCE_OF edge is still created (x -[INSTANCE_OF]-> Foo)
});
```

---

## Edge Cases

### TypeScript Type Parameters (`new Map<string, Set<string>>()`)

When Babel parses TypeScript, `new Map<string, Set<string>>()` produces:
```
NewExpression {
  callee: Identifier { name: 'Map' }
  typeParameters: TSTypeParameterInstantiation { ... }
  arguments: []
}
```

The `callee` is still an `Identifier` — the generic type params are in `typeParameters`, not wrapping the callee. So `callee.type === 'Identifier'` still matches, and `callee.name === 'Map'`. No special handling needed.

This was verified empirically via test script `/tmp/test-ts-generics.mjs`.

### Chained Member Expression Callee (`new Foo.Bar()`)

In `trackVariableAssignment` (lines 725-752), the callee case for `MemberExpression` is already handled:
```js
else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
  className = callee.property.name;
}
```

In `VariableVisitor.ts` and `handleVariableDeclaration`, the `classInstantiations.push()` only fires for `Identifier` callees. This is intentional — for `new Foo.Bar()` we can't easily resolve the CLASS node. No change needed.

### Enricher and VS Code Gaps (Out of Scope for REG-546)

These components only query `nodeType: 'VARIABLE'` and silently miss `CONSTANT` nodes:
- `ValueDomainAnalyzer.ts` lines 245, 691
- `AliasTracker.ts` line 233
- `packages/vscode/src/traceEngine.ts` lines 219, 235

After REG-546, these enrichers will work correctly for formerly-CONSTANT NewExpression nodes (which are now VARIABLE). However, they still miss CONSTANT nodes created from literals. That is a separate issue — do NOT scope creep into fixing that here.

---

## Implementation Order

1. Build green baseline: `pnpm build && node --test --test-concurrency=1 'test/unit/*.test.js'`
2. Modify existing test in `DataFlowTracking.test.js` to assert `type === 'VARIABLE'` for NewExpression (test will now FAIL — that's correct TDD)
3. Add new tests (they will also fail)
4. Change `VariableVisitor.ts` — remove `|| isNewExpression`, move `classInstantiations.push()`
5. Change `JSASTAnalyzer.ts` (handleVariableDeclaration) — same
6. `pnpm build`
7. Run unit tests — new tests should now pass
8. Update snapshots `03-complex-async` and `07-http-requests`
9. Run full test suite — all pass

---

## What Dijkstra Will Look For

- Dual path coverage (both VariableVisitor AND handleVariableDeclaration)
- classInstantiations moved correctly (not lost, not duplicated)
- No scope creep into enrichers
- Snapshot diffs minimal and correct (only CONSTANT→VARIABLE for NewExpression nodes)
- Test names precise about which path they exercise
