# REG-562: Don's Implementation Plan — Fix class field arrow function node duplication

**Date:** 2026-02-22
**Author:** Don Melton (Tech Lead)

---

## 1. What I explored

### FunctionVisitor.ArrowFunctionExpression (lines 292–389)

The REG-559 guard added at line 295–296:

```typescript
const functionParent = path.getFunctionParent();
if (functionParent) return;
```

This guard skips arrows **nested inside other functions**. It does NOT skip class field arrows because in Babel's AST, `ClassProperty` is NOT a function boundary. `path.getFunctionParent()` for an arrow in `class A { field = x => x }` walks up through `ClassProperty → ClassBody → ClassDeclaration` and finds no function parent, so it returns `null`. The guard passes, and FunctionVisitor proceeds to create a FUNCTION node.

FunctionVisitor names this node using `generateAnonymousName()` as the default, and only assigns a real name if `parent.type === 'VariableDeclarator'`. For `class A { field = x => x }`, the parent is `ClassProperty`, not `VariableDeclarator`, so `functionName` stays as `anonymous[N]` (where N is the sibling index counter). This means FunctionVisitor creates: `FUNCTION[anonymous[0]]` at global scope.

ID produced by FunctionVisitor (no namedParent since scopeTracker is at global scope during `traverse_functions`):
```
index.js->FUNCTION->anonymous[0]
```

### ClassVisitor.ClassProperty (lines 249–334)

ClassVisitor processes the same `ArrowFunctionExpression` (and `FunctionExpression`) class field values at lines 277–334. At this point, the class scope has been entered via `scopeTracker.enterScope(className, 'CLASS')` at line 230. So `scopeTracker.getNamedParent()` returns `className` (e.g., `"A"`).

ClassVisitor produces:
```typescript
const functionId = computeSemanticIdV2('FUNCTION', propName, module.file, scopeTracker.getNamedParent());
// => "index.js->FUNCTION->field[in:A]"
```

This is the semantically correct ID — it uses the property name and links it to the class.

### Traversal order (JSASTAnalyzer.ts)

- Line 1863: `traverse(ast, functionVisitor.getHandlers())` — FunctionVisitor traverses first
- Line 1969: `traverse(ast, classVisitor.getHandlers())` — ClassVisitor traverses second (via nested `classPath.traverse()` at line 248)

So FunctionVisitor runs first and creates the wrong/anonymous node; ClassVisitor runs second and creates the correct named node. Result: 2 FUNCTION nodes for one source arrow.

### FunctionExpression class fields

ClassVisitor handles both `ArrowFunctionExpression` and `FunctionExpression` class field values (line 278–280). FunctionVisitor only has a top-level `ArrowFunctionExpression` handler — `FunctionExpression` in class fields is handled by the `traverse_callbacks` pass in JSASTAnalyzer.ts (lines 1980–1984), which uses `getFunctionParent()` guard as well and would exhibit the same blindness to ClassProperty boundaries. However, the task scope is specifically about arrow functions; addressing `FunctionExpression` class fields is out of scope unless discovered broken.

---

## 2. Root cause (precise)

**Two independent traversals both create a FUNCTION node for the same class field arrow, because `ClassProperty` is invisible to `path.getFunctionParent()`.**

The FunctionVisitor guard at line 295–296 uses `getFunctionParent()` to skip arrows already claimed by an enclosing function scope. This works for nested arrows inside functions. It does NOT work for class field arrows because Babel's `getFunctionParent()` does not treat `ClassProperty` as a function boundary — class field initializers sit "outside" the class body from a function-scope perspective.

---

## 3. The single correct fix

**ClassVisitor is the authoritative path for class field arrows. FunctionVisitor must skip them.**

Rationale:
1. ClassVisitor assigns the semantically correct name (the property name, e.g., `field`) and correctly links the FUNCTION to its class context (`[in:ClassName]`).
2. FunctionVisitor treats the arrow as anonymous (no `VariableDeclarator` parent) — the name `anonymous[0]` is wrong.
3. ClassVisitor already does all the right work: creates PARAMETERs, creates a body SCOPE, calls `analyzeFunctionBody`, manages scope enter/exit.
4. Deferring to FunctionVisitor would require FunctionVisitor to detect the class context, pick the right name, and duplicate logic already in ClassVisitor. More change, more risk.

**Do NOT defer to FunctionVisitor. Fix FunctionVisitor to skip class field arrows.**

---

## 4. Exact code change

### File: `packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts`

**Location:** `ArrowFunctionExpression` handler, immediately after the existing `getFunctionParent()` guard.

**Current code (lines 292–313):**

```typescript
// Arrow functions (module-level, assigned to variables or as callbacks)
ArrowFunctionExpression: (path: NodePath) => {
  // Skip arrow functions nested inside other functions — those are handled
  // by NestedFunctionHandler during analyzeFunctionBody traversal.
  const functionParent = path.getFunctionParent();
  if (functionParent) return;

  const node = path.node as ArrowFunctionExpression;
  const line = getLine(node);
  const column = getColumn(node);
  const isAsync = node.async || false;

  // Determine arrow function name (use scope-level counter for stable semanticId)
  let functionName = generateAnonymousName();

  // If arrow function is assigned to variable: const add = () => {}
  const parent = path.parent;
  if (parent.type === 'VariableDeclarator') {
```

**Change:** Add one guard after the `getFunctionParent` check:

```typescript
// Arrow functions (module-level, assigned to variables or as callbacks)
ArrowFunctionExpression: (path: NodePath) => {
  // Skip arrow functions nested inside other functions — those are handled
  // by NestedFunctionHandler during analyzeFunctionBody traversal.
  const functionParent = path.getFunctionParent();
  if (functionParent) return;

  // Skip arrow functions used as class field initializers — those are handled
  // by ClassVisitor.ClassProperty, which assigns the correct property name and
  // class scope context. ClassProperty is not a function boundary in Babel, so
  // getFunctionParent() above does not catch this case. (REG-562)
  const parent = path.parent;
  if (parent.type === 'ClassProperty') return;

  const node = path.node as ArrowFunctionExpression;
  const line = getLine(node);
  const column = getColumn(node);
  const isAsync = node.async || false;

  // Determine arrow function name (use scope-level counter for stable semanticId)
  let functionName = generateAnonymousName();

  // If arrow function is assigned to variable: const add = () => {}
  if (parent.type === 'VariableDeclarator') {
```

Note: The `parent` variable is hoisted before the original `parent.type === 'VariableDeclarator'` check below — refactor accordingly. The `const parent = path.parent` declaration on line 307 becomes the single declaration used by both the new guard and the existing variable-declarator name extraction below.

**Exact diff summary:**
- After line 296 (`if (functionParent) return;`), insert 5 lines:
  ```typescript
  // Skip arrow functions used as class field initializers — those are handled
  // by ClassVisitor.ClassProperty, which assigns the correct property name and
  // class scope context. ClassProperty is not a function boundary in Babel, so
  // getFunctionParent() above does not catch this case. (REG-562)
  const parent = path.parent;
  if (parent.type === 'ClassProperty') return;
  ```
- Remove the later `const parent = path.parent;` on line 307 (it's now declared above).

The final structure in the handler becomes:

```typescript
ArrowFunctionExpression: (path: NodePath) => {
  // Skip arrow functions nested inside other functions
  const functionParent = path.getFunctionParent();
  if (functionParent) return;

  // Skip arrow functions used as class field initializers (REG-562)
  const parent = path.parent;
  if (parent.type === 'ClassProperty') return;

  const node = path.node as ArrowFunctionExpression;
  // ... rest unchanged ...

  let functionName = generateAnonymousName();

  // If arrow function is assigned to variable: const add = () => {}
  if (parent.type === 'VariableDeclarator') {          // parent already declared above
    const declarator = parent as VariableDeclarator;
    if (declarator.id.type === 'Identifier') {
      functionName = declarator.id.name;
    }
  }
  // ... rest unchanged ...
```

---

## 5. Does this break FunctionExpression class fields?

FunctionVisitor does NOT have a `FunctionExpression` handler. FunctionExpression class fields are handled by:
1. ClassVisitor.ClassProperty (line 278–280 handles both types)
2. The inline `traverse_callbacks` pass in JSASTAnalyzer (lines 1980–1984), which already has `if (functionParent) return` and only fires for `CallExpression` parents (`funcPath.parent.type === 'CallExpression'`)

FunctionExpression class fields are NOT handled by FunctionVisitor at all — no risk there.

**The fix is purely in FunctionVisitor's `ArrowFunctionExpression` handler.**

---

## 6. Does ClassVisitor handle all cases correctly after the fix?

ClassVisitor.ClassProperty (lines 249–334) processes class field arrows fully:
- Creates FUNCTION node with the property name and class context (line 286)
- Adds to `currentClass.methods` (line 289) for CONTAINS edges
- Creates PARAMETER nodes (line 311)
- Creates body SCOPE node (lines 315–327)
- Calls `analyzeFunctionBody` (line 330) for nested call sites, variables, etc.
- Enters/exits scope (lines 307, 333)

ClassVisitor handles both `ClassDeclaration` (line 175) and `ClassExpression` (line ~669) — both have the same `ClassProperty` handler. Both cases are already correct.

The same logic appears twice: at lines ~249–334 (ClassDeclaration handler) and at lines ~728–780 (ClassExpression handler). Both need no changes — they're already correct.

---

## 7. Regression tests required

### Test file: `test/unit/ClassFieldArrowDedup.test.js` (NEW)

The existing test in `ArrowFunctionArgDedup.test.js` (lines 200–235) is a regression *anchor* that currently documents the bug (expects 2 FUNCTION nodes). After the fix, that test must be **updated** to expect exactly 1 FUNCTION node.

New test file should cover:

1. **Basic case** — `class A { field = x => x }` → exactly 1 FUNCTION node named `field` with ID ending `->FUNCTION->field[in:A]`

2. **Async arrow** — `class A { fetch = async (url) => fetch(url) }` → exactly 1 FUNCTION node named `fetch`, `async: true`

3. **Multiple class field arrows in one class** — `class A { a = () => 1; b = () => 2 }` → exactly 2 FUNCTION nodes (`a` and `b`), no duplicates

4. **Class field arrow alongside class method** — `class A { method() {} field = () => {} }` → exactly 2 FUNCTION nodes total (one for `method`, one for `field`), no duplicates

5. **Module-level arrow still works** — `const fn = x => x` alongside a class → module-level arrow still gets 1 FUNCTION node (regression guard for the fix not over-excluding)

6. **Nested arrow inside class method is NOT affected** — `class A { method() { const inner = x => x } }` → inner arrow handled by NestedFunctionHandler (not FunctionVisitor), still 1 FUNCTION node

7. **Class expression field arrow** — `const A = class { field = x => x }` → exactly 1 FUNCTION node (ClassExpression path also works)

### Update existing test

In `test/unit/ArrowFunctionArgDedup.test.js`, lines 200–235:
- Change the `assert.strictEqual(allFunctions.length, 2, ...)` to `assert.strictEqual(allFunctions.length, 1, ...)`
- Update the comment to reflect the fix, not the bug
- Assert the single FUNCTION node has name `field` and semantic ID `index.js->FUNCTION->field[in:A]`

---

## 8. Implementation checklist for Rob

1. Open `packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts`
2. In `getHandlers()`, in the `ArrowFunctionExpression` handler (line 292):
   - After line 296 (`if (functionParent) return;`), add the `ClassProperty` guard
   - Hoist the `const parent = path.parent` declaration to before the new guard
   - Remove the duplicate `const parent = path.parent` at the original location (~line 307)
3. Write new test file `test/unit/ClassFieldArrowDedup.test.js` with the 7 cases above
4. Update `test/unit/ArrowFunctionArgDedup.test.js` lines 200–235 to expect 1, not 2
5. `pnpm build && node --test --test-concurrency=1 'test/unit/ClassFieldArrowDedup.test.js'`
6. `node --test --test-concurrency=1 'test/unit/ArrowFunctionArgDedup.test.js'`
7. `node --test --test-concurrency=1 'test/unit/ClassMethodSemanticId.test.js'` — ensure existing property tests still pass
8. Run full suite: `node --test --test-concurrency=1 'test/unit/*.test.js'`

---

## 9. Why not the alternative approach?

**Alternative considered:** Add a `ClassProperty` guard in FunctionVisitor by detecting the parent is a ClassProperty — but instead, have FunctionVisitor pick up the property name from `ClassProperty.key` and generate the correct ID.

Rejected because:
- ClassVisitor already does this correctly and completely (parameters, scope, body analysis)
- Duplicating that logic in FunctionVisitor would be fragile and untestable independently
- The fix in ClassVisitor would then become dead code
- KISS: one guard line in FunctionVisitor, zero changes elsewhere

**Alternative considered:** Guard in ClassVisitor — skip the FUNCTION node creation and defer to FunctionVisitor.

Rejected because:
- FunctionVisitor would name it `anonymous[0]`, not the property name
- FunctionVisitor has no class scope context — ID would be wrong
- Would require significant surgery to FunctionVisitor to pick up the class context

**Conclusion:** The guard in FunctionVisitor is the minimal, correct, safe fix. One guard, one test file, one test update.
