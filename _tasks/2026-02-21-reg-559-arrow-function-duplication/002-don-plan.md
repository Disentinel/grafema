# REG-559: Fix Anonymous Arrow Function Node Duplication — Don Melton Plan

**Date:** 2026-02-21
**Author:** Don Melton (Tech Lead)
**Status:** Ready for implementation

---

## Phase 1: Exploration Findings

### The Bug in One Sentence

`FunctionVisitor.ArrowFunctionExpression` fires for ALL arrow functions in the entire AST (including those nested inside class methods), while `NestedFunctionHandler.ArrowFunctionExpression` also fires for the same arrow functions when `analyzeFunctionBody` processes the containing class method. Both create a FUNCTION node. Because they use different ID generation functions (`computeSemanticIdV2` vs `computeSemanticId`), they generate **different IDs** for the same AST node — producing two distinct FUNCTION nodes.

---

### Two Code Paths That Create FUNCTION Nodes

#### Path 1: `FunctionVisitor.ArrowFunctionExpression`

**File:** `packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts` (lines 291–384)

**Called from:** `JSASTAnalyzer.ts` line 1863:
```js
traverse(ast, functionVisitor.getHandlers());
```

This traversal walks the **entire AST**. The `ArrowFunctionExpression` handler has **no `getFunctionParent()` guard** — it fires for every arrow function regardless of nesting depth.

ID generation (line 312):
```js
const functionId = idGenerator.generateV2Simple('FUNCTION', functionName, module.file);
// -> computeSemanticIdV2(type, name, file, namedParent)
// Format: file->TYPE->name[in:parent]
```

At the time this runs for `p => p.metadata?.phase === 'DISCOVERY'`, the `scopeTracker` is at **global/module scope** (not inside the class method), so `namedParent` is undefined or the class name, not the method name.

#### Path 2: `NestedFunctionHandler.ArrowFunctionExpression`

**File:** `packages/core/src/plugins/analysis/ast/handlers/NestedFunctionHandler.ts` (lines 115–198)

**Called from:** `JSASTAnalyzer.analyzeFunctionBody()` → which is called by `ClassVisitor.ClassMethod` handler after `scopeTracker.enterScope(methodName, 'FUNCTION')`.

ID generation (line 132–134):
```js
const legacyId = `FUNCTION#${funcName}:${line}:${column}:${ctx.functionCounterRef.value++}`;
const functionId = ctx.scopeTracker
  ? computeSemanticId('FUNCTION', funcName, ctx.scopeTracker.getContext())
  : legacyId;
// Format: file->scope->TYPE->name (v1)
```

At this point, `scopeTracker.getContext().scopePath` includes the class name AND method name, so the ID is different from Path 1.

### Concrete ID Difference

For `p => p.metadata?.phase === 'DISCOVERY'` inside `class PluginManager { loadPlugins() { this.plugins.some(p => ...) } }`:

**Path 1 (FunctionVisitor, v2 format):**
```
/path/to/file.js->FUNCTION->anonymous[0][in:PluginManager]
```
(namedParent = `PluginManager` because the class scope is the nearest named parent when FunctionVisitor runs the full-AST traversal)

**Path 2 (NestedFunctionHandler, v1 format):**
```
/path/to/file.js->PluginManager->loadPlugins->FUNCTION->anonymous[0]
```
(full scope path via `computeSemanticId`)

These are **different strings** → two separate FUNCTION nodes in RFDB.

### Why the Edges Look Like Duplicates

The `CallFlowBuilder.bufferArgumentEdges` (line 146) looks up the FUNCTION node by **position** (file + line + column):
```js
const funcNode = functions.find(f =>
  f.file === file && f.line === functionLine && f.column === functionColumn
);
if (funcNode) {
  targetNodeId = funcNode.id;
}
```

It finds the **first** matching FUNCTION node (from Path 2, NestedFunctionHandler) and creates both:
- `CALL --PASSES_ARGUMENT--> FUNCTION (Path 2 ID)`
- `CALL --DERIVES_FROM--> FUNCTION (Path 2 ID)`

But Path 1 (FunctionVisitor) **also** created a FUNCTION node with a different ID at the same position. That node has no edges from the call, but it exists in the "nodes in file" list, appearing as a duplicate.

### Supporting Evidence: `path.skip()` in FunctionVisitor

`FunctionVisitor.ArrowFunctionExpression` calls `path.skip()` at the end (line 383). The comment says:
```
// Stop traversal - analyzeFunctionBody already processed contents
// Without this, babel traverse continues into arrow body and finds
// nested arrow functions, causing duplicate FUNCTION nodes
```

This comment acknowledges the duplication issue for **nested** arrow bodies, but does NOT address the scenario where `FunctionVisitor` itself should not process arrow functions that are nested inside class methods.

The `FunctionDeclaration` handler also uses `path.skip()` — and it works correctly there because `FunctionDeclaration` nodes are not visited inside class method bodies by a separate `NestedFunctionHandler`. The problem is specific to `ArrowFunctionExpression` (and `FunctionExpression`) which appear at ANY depth in the AST.

---

## Phase 2: Root Cause Analysis

### Root Cause

**`FunctionVisitor` is designed for module-level functions, but its `ArrowFunctionExpression` handler lacks a scope guard.** It processes ALL arrow functions in the file, regardless of whether they are module-level or nested inside class methods/other functions.

The function-body traversal (`analyzeFunctionBody` → `NestedFunctionHandler`) is the **canonical** place to process arrow functions that appear inside function bodies. The module-level `FunctionVisitor` should only process arrow functions that are NOT already inside a function body.

### Why the Fix is Adding a `getFunctionParent()` Guard

The `FunctionDeclaration` handler in the **callbacks traverse** (line 1981 in JSASTAnalyzer.ts) already demonstrates the correct pattern:
```js
FunctionExpression: (funcPath) => {
  const functionParent = funcPath.getFunctionParent();
  if (functionParent) return;  // Skip if inside function
  ...
```

`FunctionVisitor.ArrowFunctionExpression` is missing this guard. The fix is to add it.

**Why not fix NestedFunctionHandler instead?**
`NestedFunctionHandler` is correct. It runs in the right context (inside `analyzeFunctionBody`) with the right scope tracking, and its ID generation places the arrow function in its proper parent scope. The `FunctionVisitor` is the interloper — it fires too broadly.

### ID Mismatch Impact

After adding the guard, all anonymous arrow functions nested in function bodies will ONLY be created by `NestedFunctionHandler` using the v1 `computeSemanticId` format. Module-level arrow functions will continue to be created by `FunctionVisitor` using the v2 `computeSemanticIdV2` format.

This is **by design** — the codebase is in a mixed v1/v2 ID migration state. The important thing is: **the same AST node is created exactly once**.

---

## Phase 3: Implementation Plan

### Change 1: Add `getFunctionParent()` guard to `FunctionVisitor.ArrowFunctionExpression`

**File:** `packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts`

**Location:** Line 292 — the `ArrowFunctionExpression` handler

**Change:** Add an early-return guard at the top of the handler:

```typescript
ArrowFunctionExpression: (path: NodePath) => {
  // Skip arrow functions nested inside other functions — those are handled
  // by NestedFunctionHandler during analyzeFunctionBody traversal.
  const functionParent = path.getFunctionParent();
  if (functionParent) return;

  const node = path.node as ArrowFunctionExpression;
  // ... rest of handler unchanged
```

**Rationale:** `path.getFunctionParent()` returns the nearest enclosing function (FunctionDeclaration, FunctionExpression, ArrowFunctionExpression, ClassMethod, etc.). If it exists, the arrow is nested and will be handled by `NestedFunctionHandler`. If it returns `null`, the arrow is at module level and should be handled by `FunctionVisitor`.

### Change 2: Verify `FunctionExpression` in the callbacks traverse (JSASTAnalyzer.ts)

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Location:** Line 1980–1024 (the `traverse_callbacks` block)

The existing `FunctionExpression` handler already has the guard:
```js
const functionParent = funcPath.getFunctionParent();
if (functionParent) return;
```

BUT it only fires for `FunctionExpression` with a `CallExpression` parent — i.e., for module-level callbacks like `setTimeout(function() {...})`. The corresponding `ArrowFunctionExpression` case is ABSENT from this block (only `FunctionExpression` is handled). After Change 1, `FunctionVisitor.ArrowFunctionExpression` will also skip nested arrows, which means the case `someFunction(() => {...})` at MODULE level will still be handled by `FunctionVisitor` (because `functionParent === null`). This is correct.

No change needed here.

### Change 3: Check `NestedFunctionHandler.FunctionExpression` for the same issue

**File:** `packages/core/src/plugins/analysis/ast/handlers/NestedFunctionHandler.ts`

The existing `FunctionExpression` handler (line 68) in `NestedFunctionHandler` is ONLY called from `analyzeFunctionBody` — not from a full-AST traverse. So `FunctionExpression` nodes nested inside class methods are correctly handled by:
- `traverse_callbacks` (line 1980 in JSASTAnalyzer.ts) for module-level FunctionExpression callbacks
- `NestedFunctionHandler` for function-body-level FunctionExpression nodes

Similarly `ArrowFunctionExpression` inside function bodies is handled only by `NestedFunctionHandler`. After the fix, `FunctionVisitor` will only handle module-level arrows.

No change needed to `NestedFunctionHandler`.

### Change 4 (New Test): `arr.map(x => x)` produces exactly one FUNCTION node

**File:** New test file `test/unit/ArrowFunctionArgDedup.test.js`

The test should:
1. Create a fixture with a class containing a method that passes an arrow function as a call argument:
   ```js
   class MyClass {
     run() {
       const result = this.items.map(x => x);
     }
   }
   ```
2. Run analysis
3. Query all FUNCTION nodes
4. Assert exactly one FUNCTION node exists for the arrow `x => x`

**Acceptance criterion from REG-559:**
```
arr.map(x => x) → exactly one FUNCTION node
```

Extended test case matching the original bug:
```js
class PluginManager {
  loadPlugins() {
    const found = this.plugins.some(p => p.metadata?.phase === 'DISCOVERY');
  }
}
```
Should produce exactly one FUNCTION node for `p => p.metadata?.phase === 'DISCOVERY'`.

### Additional Test: Both edges point to the same single node

The test should also verify that `PASSES_ARGUMENT` and `DERIVES_FROM` edges from the call both point to the **same** FUNCTION node:
```
CALL "this.items.map" --PASSES_ARGUMENT--> FUNCTION (anonymous[0])
CALL "this.items.map" --DERIVES_FROM--> FUNCTION (anonymous[0])
```
Both edges should have the same `dst` value.

---

## Summary

| Item | Detail |
|------|--------|
| Root cause | `FunctionVisitor.ArrowFunctionExpression` has no `getFunctionParent()` guard, causing it to create FUNCTION nodes for ALL arrow functions in the AST, including those nested inside class methods |
| Second creator | `NestedFunctionHandler.ArrowFunctionExpression` correctly creates the same node during `analyzeFunctionBody`, but with a different ID (v1 vs v2 format) |
| Result | Two FUNCTION nodes at the same source position, with different IDs |
| Fix location | `FunctionVisitor.ts` — add `if (path.getFunctionParent()) return;` at the top of `ArrowFunctionExpression` handler |
| Fix size | ~3 lines added |
| Risk | Low — the guard matches existing patterns in `CallExpressionVisitor`, `traverse_callbacks`, and the `FunctionVisitor.FunctionDeclaration` handler itself |
| Tests needed | New test: `arr.map(x => x)` → exactly 1 FUNCTION node; both edges target same node |

---

## Files Changed

1. **`packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts`** — add `getFunctionParent()` guard
2. **`test/unit/ArrowFunctionArgDedup.test.js`** (new) — regression test for REG-559

---

## Revised Plan — v2

*Addressing Dijkstra's REJECT (2026-02-21)*

---

### Gap 1 — Class Field Initializer Arrow: Investigation Results

**Question:** Does `class A { field = x => x }` produce duplicate FUNCTION nodes after the proposed fix?

**Code inspection findings:**

#### What `ClassVisitor.ClassProperty` does (lines 277–334)

When `ClassVisitor` processes a class property whose value is an `ArrowFunctionExpression` or
`FunctionExpression`, it:
1. Creates a FUNCTION node with `computeSemanticIdV2('FUNCTION', propName, module.file, scopeTracker.getNamedParent())` (line 286)
2. Calls `analyzeFunctionBody(funcPath, ...)` to process the body (line 330)
3. Does NOT call `path.skip()` or `propPath.skip()` anywhere in the `ClassProperty` handler

#### What `FunctionVisitor.ArrowFunctionExpression` does

`FunctionVisitor.getHandlers()` returns exactly two handlers: `FunctionDeclaration` and
`ArrowFunctionExpression`. There is no `ClassDeclaration`, `ClassMethod`, or `ClassProperty` handler,
and `FunctionVisitor` never calls `path.skip()` on a class node.

`traverse(ast, functionVisitor.getHandlers())` at JSASTAnalyzer.ts line 1863 is a **full-AST traversal**
that runs before `traverse_classes` (line 1969). It will enter class bodies and fire on every
`ArrowFunctionExpression` it finds, including class field initializer arrows.

Crucially, `ClassVisitor.ClassDeclaration` also does NOT call `classPath.skip()` at its end (line 666
— only `scopeTracker.exitScope()` is called). So the `ClassVisitor` traversal does nothing to prevent
`FunctionVisitor` from also visiting the same nodes.

#### The proposed fix's effect on class field arrows

The proposed fix adds: `if (path.getFunctionParent()) return;`

For `class A { field = x => x }`:
- `getFunctionParent()` on the arrow returns `null` (confirmed by Dijkstra's runtime test — `ClassProperty`
  is not a function boundary in Babel's scope model)
- Therefore the guard does NOT trigger
- `FunctionVisitor.ArrowFunctionExpression` fires and creates a FUNCTION node with v2 ID

`ClassVisitor.ClassProperty` also fires (during `traverse_classes`, line 1969) and creates a FUNCTION
node with v2 ID using the same `computeSemanticIdV2('FUNCTION', propName, module.file, scopeTracker.getNamedParent())` call.

#### Do the IDs match?

`scopeTracker.getNamedParent()` is called in two different traversal contexts:
- In `FunctionVisitor` (traverse_functions, line 1863): the scopeTracker is at **global scope** because
  `FunctionVisitor` does not call `scopeTracker.enterScope()` for class boundaries.
- In `ClassVisitor.ClassProperty` (traverse_classes, line 1969): the scopeTracker is at **class scope**
  because `ClassVisitor.ClassDeclaration` calls `scopeTracker.enterScope(className, 'CLASS')` at line
  230 before calling `classPath.traverse(...)`.

Therefore `getNamedParent()` returns different values: `undefined` (or the module-level named parent)
in `FunctionVisitor`, versus `className` in `ClassVisitor`. The two `computeSemanticIdV2` calls produce
**different IDs** for the same AST node.

**Conclusion for Gap 1:** The class field arrow duplication problem EXISTS and is structurally identical
to the ClassMethod case. It is a **pre-existing bug** (present regardless of the proposed fix). The
proposed fix does not make it worse — it was already producing two nodes before the fix. However, the
original plan's claim that "getFunctionParent() === null means module level" is incorrect for this case,
and the original plan does not address it.

#### Is this case in scope for REG-559?

REG-559's acceptance criterion is specifically: `arr.map(x => x)` inside a class method body.
Class field arrow duplication is a distinct pattern with a distinct fix location.

**Decision: Out of scope for this fix, but must be explicitly documented.**

Rationale:
- The class field arrow bug pre-exists the proposed fix — it's not a regression introduced by REG-559
- Fixing it requires a different change (either add `isClassProperty` parent check to `FunctionVisitor`,
  or add `path.skip()` to `ClassVisitor.ClassProperty` handler after `analyzeFunctionBody`)
- Mixing the two fixes in the same PR increases diff size and review complexity
- The class field case should be filed as a separate issue (REG-XXX) to track it

**Required addition to test suite:** Add a test case `class A { field = x => x }` to the new test
file, but assert the CURRENT behavior (which is expected to be 2 FUNCTION nodes, i.e., the pre-existing
bug). This serves as a regression anchor: it confirms the behavior doesn't change after REG-559 lands,
and creates a visible test that will be fixed by the follow-up issue.

---

### Gap 2 — Default Parameter Arrow: Investigation Results

**Question:** Does `function f(cb = x => x) {}` result in an orphaned (unprocessed) arrow after the fix?

**Code inspection findings:**

`analyzeFunctionBody` at JSASTAnalyzer.ts line 3286 calls:
```
funcPath.traverse(mergedVisitor);
```

Babel's `path.traverse()` traverses the **entire subtree** of the `funcPath` node. For a
`FunctionDeclaration`, the AST subtree includes:
- `node.params` — the parameters array
- Each param's children — including `AssignmentPattern.right` for default values
- `node.body` — the function body

So when `analyzeFunctionBody` is called for `function f(cb = x => x)`, the traversal starting
at the `FunctionDeclaration` path WILL reach the `ArrowFunctionExpression` node that is the
default value of the `cb` parameter.

`NestedFunctionHandler.ArrowFunctionExpression` (line 115) handles it: it fires, creates a
FUNCTION node using `computeSemanticId`, and calls `arrowPath.skip()`.

After the proposed fix:
- `FunctionVisitor` skips the arrow (guard triggers: `getFunctionParent()` returns `FunctionDeclaration`)
- `NestedFunctionHandler` handles it during `analyzeFunctionBody` traversal

**Conclusion for Gap 2:** Default parameter arrows are NOT orphaned. Babel's `path.traverse()` from
the function path covers default parameter values. `NestedFunctionHandler.ArrowFunctionExpression`
fires for them correctly.

**This case is safe.** No additional fix is required.

**Required addition to test suite:** Add a test case `function f(cb = x => x) {}` to the new test
file, asserting exactly one FUNCTION node for the arrow. This is a verification test (expected to pass
immediately) that documents the behavior is correct.

---

### Updated Implementation Plan

#### Changes (same as v1):

1. **`FunctionVisitor.ts`** — add `if (path.getFunctionParent()) return;` guard to `ArrowFunctionExpression`
2. **`test/unit/ArrowFunctionArgDedup.test.js`** (new) — expanded test suite

#### Expanded test suite (Change 4, updated):

| Test case | Expected result | Purpose |
|-----------|----------------|---------|
| `class A { run() { arr.map(x => x) } }` | exactly 1 FUNCTION node | REG-559 primary fix |
| `class PluginManager { loadPlugins() { this.plugins.some(p => p.metadata?.phase === 'DISCOVERY') } }` | exactly 1 FUNCTION node | original bug reproduction |
| `class A { field = x => x }` | 2 FUNCTION nodes (pre-existing bug) | regression anchor for class field issue |
| `function f(cb = x => x) {}` | exactly 1 FUNCTION node | default param safety verification |
| `const fn = x => x` | exactly 1 FUNCTION node | module-level arrow not broken by fix |

The class field test case asserts the **pre-existing** behavior to prevent silent regressions. The
comment in the test must clearly note it's a known pre-existing bug tracked by REG-XXX (to be filed).

#### Out-of-scope items filed as follow-up:

- **Class field arrow duplication** (`class A { field = x => x }` → 2 FUNCTION nodes): file as
  REG-XXX with label `Bug`, `v0.2`. Fix approach: add `|| path.parent.type === 'ClassProperty'`
  to the `FunctionVisitor` guard, OR add `path.skip()` to `ClassVisitor.ClassProperty` after
  `analyzeFunctionBody`. Either approach eliminates one of the two creation paths for the class
  field arrow. The ClassProperty approach is slightly cleaner since ClassVisitor is already the
  authoritative handler for class internals.

---

### Files Changed (v2)

1. **`packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts`** — add `getFunctionParent()` guard (unchanged from v1)
2. **`test/unit/ArrowFunctionArgDedup.test.js`** (new) — expanded test suite with 5 cases
3. (Follow-up) New Linear issue for class field arrow duplication
