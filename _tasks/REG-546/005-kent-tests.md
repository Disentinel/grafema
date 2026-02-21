# Kent Beck Test Report: REG-546

## Tests Added

All tests added to `/test/unit/DataFlowTracking.test.js` in the `NewExpression Assignments` describe block.

### 1. Modified existing test: `should track new Class() assignment`

Added assertion at line 210:
```js
assert.strictEqual(helper.type, 'VARIABLE', 'NewExpression initializer should create VARIABLE node, not CONSTANT');
```
This is the core regression assertion. Before the fix, `helper` was created as `CONSTANT`.

### 2. New test: `should create VARIABLE node for module-level const x = new Map() (VariableVisitor path)`

- **Fixture:** `const myMap = new Map();` at module level (outside any function)
- **Asserts:** `myMap.type === 'VARIABLE'`
- **Why:** Exercises the `VariableVisitor.ts` code path specifically (module-level declarations go through VariableVisitor, not JSASTAnalyzer's `handleVariableDeclaration`)

### 3. New test: `should create VARIABLE node for in-function const x = new Set() (JSASTAnalyzer path)`

- **Fixture:** `const mySet = new Set();` inside a `function buildSet()` body
- **Asserts:** `mySet.type === 'VARIABLE'`
- **Why:** Exercises the `JSASTAnalyzer.ts` `handleVariableDeclaration` path (in-function declarations). This is the dual collection path documented in MEMORY.md.

### 4. New test: `should create VARIABLE node for const x = new Map<string, number>() with TypeScript generics`

- **Fixture:** `const myTypedMap = new Map<string, number>();` in an `index.ts` file
- **Asserts:** `myTypedMap.type === 'VARIABLE'`
- **Why:** Verifies that `TSTypeParameterInstantiation` does not interfere with callee detection. The callee remains `Identifier('Map')` even with type params. Uses `.ts` extension to trigger TypeScript parsing.

### 5. New test: `should preserve INSTANCE_OF edge when const x = new Foo() creates VARIABLE node`

- **Fixture:** `class Foo { constructor() {} }` + `const myFoo = new Foo();` at module level
- **Asserts:**
  - `myFoo.type === 'VARIABLE'` (not CONSTANT)
  - INSTANCE_OF edge exists from `myFoo` to CLASS `Foo`
  - ASSIGNED_FROM edge exists from `myFoo` to CONSTRUCTOR_CALL
- **Why:** After the fix moves `classInstantiations.push()` outside the `shouldBeConstant` guard, this test verifies that INSTANCE_OF edges are still created correctly. Guards against regression from the `classInstantiations` relocation.

## Test Status

### Without the fix (original code): 5 FAIL, 8 pass

All 5 NewExpression tests fail with:
```
expected: 'VARIABLE'
actual: 'CONSTANT'
```

This was verified by stashing the implementation changes, rebuilding, and running the test suite.

### With the fix applied: 13 pass, 0 fail

All tests pass after restoring the implementation changes.

## Test Fixture Patterns

- **Inline code strings** passed to `setupTest({ 'index.js': '...' })` -- no external fixture files
- **`.ts` extension** works for TypeScript fixtures (used in Test C with `'index.ts'`)
- Each test uses the shared `setupTest()` helper which creates a temp dir, writes `package.json` + fixture files, creates a test RFDB database, and runs the full analysis pipeline
- `try/finally` pattern with `backend.close()` ensures cleanup
- The test orchestrator (`createTestOrchestrator`) includes all enrichment plugins including `InstanceOfResolver`, which is required for INSTANCE_OF edge assertions

## Coverage of Dual Collection Paths

| Test | VariableVisitor (module-level) | JSASTAnalyzer (in-function) |
|------|------|------|
| existing + assertion | module-level | -- |
| new Map() test | module-level | -- |
| new Set() test | -- | in-function |
| TS generics test | module-level (.ts) | -- |
| INSTANCE_OF test | module-level | -- |

Both code paths are covered. The in-function path is explicitly exercised by the `new Set()` test (fixture wraps the declaration inside a function body).
