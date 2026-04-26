# REG-550: PARAMETER nodes store column=0 — Don's Analysis & Plan

## 1. Root Cause

The bug is in **`createParameterNodes.ts`** — it creates `ParameterInfo` objects with a `line` field but **never sets a `column` field**. The `ParameterInfo` interface itself has no `column` field:

```typescript
// types.ts
export interface ParameterInfo {
  id: string;
  semanticId?: string;
  type: 'PARAMETER';
  name: string;
  file: string;
  line: number;
  // <-- NO column field!
  index?: number;
  hasDefault?: boolean;
  isRest?: boolean;
  // ...
}
```

When `GraphBuilder` buffers the param (line ~282 of `GraphBuilder.ts`):

```typescript
const { functionId: _functionId, ...paramData } = param;
this._bufferNode(paramData as GraphNode);  // no column in paramData
```

The RFDB backend stores the node without `column`. When the MCP displays it as `PARAMETER options L85:0`, the `:0` column comes from the backend returning 0 for missing numeric fields.

## 2. Exact File(s) and Line(s) Where the Bug Lives

### Primary bug location: Sequential path
**File:** `/Users/vadimr/grafema-worker-2/packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts`

Every case in the `params.forEach` block creates a `ParameterInfo` with `line` but no `column`:

- **Line 60-70** — `Identifier` param: uses `param.loc?.start.line` but NOT `param.loc?.start.column`
- **Line 79-90** — `AssignmentPattern` default param: uses `assignmentParam.left.loc?.start.line` but NOT column
- **Line 145-156** — `RestElement`: uses `restParam.argument.loc?.start.line` but NOT column
- **Line 112-123** — Destructured `AssignmentPattern` (pattern-level default): uses `paramInfo.loc.start.line` but NOT `paramInfo.loc.start.column`
- **Line 178-188** — `ObjectPattern`/`ArrayPattern` destructuring: uses `paramInfo.loc.start.line` but NOT column

The `ParameterInfo` interface also needs a `column` field added.

### Secondary bug location: Parallel path
**File:** `/Users/vadimr/grafema-worker-2/packages/core/src/core/ASTWorker.ts`

Lines 409-421: The `ParameterNode` interface (line 97-105) has no `column` field, and `collections.parameters.push({...})` only sets `line: getLine(param)` without a column:

```typescript
interface ParameterNode {
  id: string;
  type: 'PARAMETER';
  name: string;
  index: number;
  functionId: string;
  file: string;
  line: number;
  // <-- NO column field!
}
```

This only handles simple `Identifier` params. Note: ASTWorker.ts is a simplified parallel path that is known to lag behind JSASTAnalyzer (see MEMORY). Fix scope: add `column` for the Identifier case.

## 3. What the Fix Should Be

### Step 1: Add `column` to `ParameterInfo` interface

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

Add `column?: number;` to `ParameterInfo`:

```typescript
export interface ParameterInfo {
  id: string;
  semanticId?: string;
  type: 'PARAMETER';
  name: string;
  file: string;
  line: number;
  column?: number;  // ADD THIS
  // ...rest unchanged
}
```

### Step 2: Fix `createParameterNodes.ts`

For each case, read `column` from the **identifier node** (not the function/arrow node):

#### Case 1: Simple `Identifier` param (e.g., `function foo(p)`)
```typescript
// BEFORE:
line: param.loc?.start.line || line,

// AFTER:
line: param.loc?.start.line || line,
column: param.loc?.start.column ?? 0,
```
The `param` itself IS the Identifier node. `param.loc.start.column` is the correct position.

#### Case 2: `AssignmentPattern` default (e.g., `function foo(options = {})`)
```typescript
// BEFORE:
line: assignmentParam.left.loc?.start.line || line,

// AFTER:
line: assignmentParam.left.loc?.start.line || line,
column: assignmentParam.left.loc?.start.column ?? 0,
```
`assignmentParam.left` is the Identifier node (`options`). Its column is the position of the parameter name.

#### Case 3: `RestElement` (e.g., `function foo(...args)`)
```typescript
// BEFORE:
line: restParam.argument.loc?.start.line || line,

// AFTER:
line: restParam.argument.loc?.start.line || line,
column: restParam.argument.loc?.start.column ?? 0,
```
`restParam.argument` is the Identifier node (`args`). Note: the column here is the column of `args`, not `...`. This is consistent with how lines already work.

#### Case 4: Destructured `ObjectPattern`/`ArrayPattern` (e.g., `function foo({ x, y })`)
These cases use `extractNamesFromPattern` which already returns `paramInfo.loc.start.column`. Just use it:
```typescript
line: paramInfo.loc.start.line,
column: paramInfo.loc.start.column,  // ADD
```
`extractNamesFromPattern` already returns `loc: { start: { line, column } }` from `pattern.loc.start` (line 90 of `extractNamesFromPattern.ts`).

#### Case 5: `AssignmentPattern` wrapping `ObjectPattern`/`ArrayPattern` (e.g., `function foo({ x } = {})`)
Same as Case 4 — `extractNamesFromPattern` is called on `assignmentParam.left` which returns loc with column.

### Step 3: Fix `ASTWorker.ts` parallel path

Add `column` to `ParameterNode` interface and pass `getColumn(param)` when creating it:

```typescript
interface ParameterNode {
  id: string;
  type: 'PARAMETER';
  name: string;
  index: number;
  functionId: string;
  file: string;
  line: number;
  column: number;  // ADD
}

// In params.forEach:
collections.parameters.push({
  id: paramId,
  type: 'PARAMETER',
  name: param.name,
  index,
  functionId,
  file: filePath,
  line: getLine(param),
  column: getColumn(param),  // ADD
});
```

Note: ASTWorker imports `getColumn` already (check the import at top of file — it imports `getLine, getColumn` from `'../utils/location.js'` — verify before assuming).

## 4. Edge Cases

### a. Simple `Identifier` param — `function foo(p)`
- AST: `Identifier { name: 'p', loc: { start: { line: L, column: C } } }`
- Fix: `column = param.loc?.start.column ?? 0`
- `p` column points to the start of the identifier name. Correct.

### b. Default value param — `function foo(options = {})`
- AST: `AssignmentPattern { left: Identifier { name: 'options', ... } }`
- Fix: `column = assignmentParam.left.loc?.start.column ?? 0`
- Column points to `options`, NOT `=` or `{}`. Correct — the identifier is what matters.

### c. Rest param — `function foo(...args)`
- AST: `RestElement { argument: Identifier { name: 'args', ... } }`
- Fix: `column = restParam.argument.loc?.start.column ?? 0`
- This gives the column of `args`, not `...`. The `...` prefix is at `column - 3`.
- Decision: use the identifier column (consistent with Babel's standard). If needed, the `...` position is `argument.loc.start.column - 3`, but that's out of scope for this bug.

### d. Destructured object param — `function foo({ x, y })`
- Each property extracted by `extractNamesFromPattern` has `loc.start.column` = column of that property's identifier.
- `x` in `{ x, y }` has its own column. `y` has a different column. Both are correctly stored.

### e. Destructured with pattern-level default — `function foo({ x, y } = {})`
- `extractNamesFromPattern` is called on `assignmentParam.left` (the ObjectPattern).
- Each extracted identifier has its correct column from the AST. No change needed in extraction logic.

### f. Arrow function with single param — `p => p.value`
- In arrow functions, Babel parses `p` as an `Identifier` param directly (no parentheses needed).
- The `FunctionVisitor` calls `createParameterNodes(node.params, ...)` where `node.params[0]` is the Identifier `p`.
- Fix in Case 1 handles this correctly.

### g. Nested destructuring — `function foo({ data: { user } })`
- `extractNamesFromPattern` recursively extracts `user` with `user`'s actual column.
- Column of `user` in `{ data: { user } }` is the column of the `user` identifier. Correct.

## 5. Which Test File to Add the New Test To

Add tests to:
**`/Users/vadimr/grafema-worker-2/test/unit/plugins/analysis/ast/destructured-parameters.test.ts`**

This is the existing integration test file for PARAMETER nodes. Add a new describe group at the end:

```typescript
describe('PARAMETER node column positions (REG-550)', () => {
  it('should store correct column for simple identifier param', async () => {
    // function foo(p) — p starts at column 13
    // function foo(options = {}) — options starts at column 13
  });

  it('should store correct column for default value param', async () => {
    // options is at column 13 in: function foo(options = {})
  });

  it('should store correct column for rest param', async () => {
    // args is at column 16 in: function foo(...args)
  });

  it('should store correct column for arrow function param', async () => {
    // p is at column 7 in: const f = p => p
  });

  it('should store correct column for destructured params', async () => {
    // x at column 14 in: function foo({ x, y })
    // y at column 17 in: function foo({ x, y })
  });
});
```

Alternatively, consider adding unit tests to a new file:
**`/Users/vadimr/grafema-worker-2/test/unit/plugins/analysis/ast/utils/createParameterNodes.test.ts`**

For pure unit testing of `createParameterNodes` with a mock AST.

## 6. Snapshot Implications

**Yes, snapshots will change.** Every PARAMETER node in every snapshot will gain a new `column` field.

Snapshots affected (all 6 snapshots contain PARAMETER nodes):
- `test/snapshots/02-api-service.snapshot.json`
- `test/snapshots/03-complex-async.snapshot.json`
- `test/snapshots/04-control-flow.snapshot.json`
- `test/snapshots/06-socketio.snapshot.json`
- `test/snapshots/07-http-requests.snapshot.json`
- `test/snapshots/nodejs-builtins.snapshot.json`

**Per MEMORY note:** Never manually predict which snapshot nodes change — always run `UPDATE_SNAPSHOTS=true` to regenerate. The count is non-trivial: every PARAMETER node across all fixtures will get a `column` field added.

After implementing the fix:
```bash
pnpm build
UPDATE_SNAPSHOTS=true node --test --test-concurrency=1 'test/unit/*.test.js'
```
or whichever snapshot update command is used in this repo.

## 7. Summary of Changes

| File | Change |
|------|--------|
| `packages/core/src/plugins/analysis/ast/types.ts` | Add `column?: number` to `ParameterInfo` interface |
| `packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts` | Add `column` to all 5 param cases, reading from identifier node |
| `packages/core/src/core/ASTWorker.ts` | Add `column` to `ParameterNode` interface and `push()` call |
| `test/unit/plugins/analysis/ast/destructured-parameters.test.ts` | Add new describe block for column position tests |
| `test/snapshots/*.snapshot.json` (all 6) | Regenerate with `UPDATE_SNAPSHOTS=true` |

## 8. What NOT to Change

- `GraphBuilder.ts` — it correctly passes through all `ParameterInfo` fields to the graph
- `extractNamesFromPattern.ts` — already returns `loc.start.column` correctly
- `ParameterNode.ts` (factory) — the `ParameterNode.create()` already takes `column` as a parameter, but `createParameterNodes.ts` does NOT use `ParameterNode.create()` — it builds plain objects directly. This is consistent with how other nodes work in this codebase.
