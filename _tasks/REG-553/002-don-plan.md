# REG-553: Plan — Index logical/nullish expressions (||, &&, ??) as EXPRESSION nodes

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-22

---

## 1. Summary: How EXPRESSION nodes currently work

### The pipeline

AST → `JSASTAnalyzer` → `variableAssignments[]` → `AssignmentBuilder` → graph nodes/edges

### Step 1: JSASTAnalyzer.trackVariableAssignment (lines 871–892)

When a variable initializer is a `LogicalExpression`, the analyzer already handles it:

```typescript
// 10. LogicalExpression
if (initExpression.type === 'LogicalExpression') {
  const column = initExpression.start ?? 0;
  const expressionId = ExpressionNode.generateId('LogicalExpression', module.file, line, column);

  variableAssignments.push({
    variableId,
    sourceType: 'EXPRESSION',
    sourceId: expressionId,
    expressionType: 'LogicalExpression',
    operator: initExpression.operator,          // '||', '&&', or '??'
    leftSourceName: initExpression.left.type === 'Identifier' ? initExpression.left.name : null,
    rightSourceName: initExpression.right.type === 'Identifier' ? initExpression.right.name : null,
    file: module.file,
    line: line,
    column: column
  });

  // Recurse into both operands
  this.trackVariableAssignment(initExpression.left, ...);
  this.trackVariableAssignment(initExpression.right, ...);
  return;
}
```

**Key finding:** In Babel's AST, `??` (nullish coalescing) is a `LogicalExpression` with `operator: '??'`, NOT a separate `NullishCoalescingExpression` node type. This means `const x = a ?? b` is ALREADY caught by the `LogicalExpression` branch.

### Step 2: AssignmentBuilder.bufferAssignmentEdges (lines 190–403)

The builder ALREADY creates EXPRESSION nodes for `LogicalExpression` and creates `DERIVES_FROM` edges to left/right operands (lines 303–328).

### Step 3: ExpressionNode._computeName (lines 112–131)

This is the **actual gap**:

```typescript
case 'BinaryExpression':
case 'LogicalExpression':
  return `<${expressionType}>`;   // ← returns '<LogicalExpression>' for ALL operators
```

The acceptance criteria requires: `"a || b"` (short source representation, truncated at 64 chars).

The data IS available: `operator`, `leftSourceName`, `rightSourceName` are passed to `_computeName` via `ExpressionNodeOptions`. The method just doesn't use them for `LogicalExpression`.

### What IS already working

- `LogicalExpression` (||, &&, ??) produces EXPRESSION nodes — **done**
- Both operands get DERIVES_FROM edges (when operands are Identifiers) — **done**
- ASSIGNED_FROM edge from VARIABLE to EXPRESSION node — **done**
- Return statements with LogicalExpression produce EXPRESSION nodes — **done**

### What IS NOT working (the gaps)

1. **Node `name` field** — currently `'<LogicalExpression>'` for all operators; should be `'a || b'`, `'a && b'`, `'a ?? b'`
2. **No test for `??`** — existing tests cover `||` and `&&` but not `??`
3. **`BinaryExpression` naming** — same issue: returns `'<BinaryExpression>'` instead of `'a + b'`; this is out of scope for REG-553 but worth noting

---

## 2. Files that need changes

### Primary change (1 file)

**`/Users/regina/workspace/grafema/packages/core/src/core/nodes/ExpressionNode.ts`**

Method `_computeName` (lines 112–131): add operator-based name for `LogicalExpression`:

```typescript
case 'LogicalExpression': {
  const left = options.leftSourceName ?? '…';
  const right = options.rightSourceName ?? '…';
  const raw = `${left} ${options.operator ?? '||'} ${right}`;
  return raw.length > 64 ? raw.slice(0, 61) + '…' : raw;
}
```

This uses `leftSourceName`, `rightSourceName`, and `operator` — which are already populated in `ExpressionNodeOptions`.

### No other production files need changes

The pipeline from analyzer → builder → graph already works. Only the `name` computation is wrong.

### Test file (1 file, new tests in existing file)

**`/Users/regina/workspace/grafema/test/unit/Expression.test.js`**

Add new test cases to the existing `LogicalExpression` describe block:
- `const x = a ?? b` → EXPRESSION node with name `"a ?? b"` and operator `"??"`
- `const x = a || b` → EXPRESSION node with name `"a || b"` (verify name format, not just existence)
- `const x = a && b` → EXPRESSION node with name `"a && b"`
- Long expression names truncate at 64 chars

---

## 3. Step-by-step implementation plan

### Step 1: Write failing test first (TDD)

Add to `test/unit/Expression.test.js` inside the existing `'LogicalExpression'` describe block:

```javascript
it('should use short representation for node name: "a || b"', async () => {
  const { backend, testDir } = await setupTest({
    'index.js': `
const a = null;
const b = 'default';
const x = a || b;
`
  });
  try {
    let expressionNode = null;
    for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
      if (node.expressionType === 'LogicalExpression' && node.operator === '||') {
        expressionNode = node;
        break;
      }
    }
    assert.ok(expressionNode, 'Should create EXPRESSION node');
    assert.strictEqual(expressionNode.name, 'a || b', 'Name should be "a || b"');
  } finally {
    await cleanup(backend, testDir);
  }
});

it('should create EXPRESSION node for ?? (nullish coalescing)', async () => {
  const { backend, testDir } = await setupTest({
    'index.js': `
const a = null;
const b = 'default';
const x = a ?? b;
`
  });
  try {
    let expressionNode = null;
    for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
      if (node.expressionType === 'LogicalExpression' && node.operator === '??') {
        expressionNode = node;
        break;
      }
    }
    assert.ok(expressionNode, 'Should create EXPRESSION node for ??');
    assert.strictEqual(expressionNode.operator, '??', 'Operator should be ??');
    assert.strictEqual(expressionNode.name, 'a ?? b', 'Name should be "a ?? b"');
  } finally {
    await cleanup(backend, testDir);
  }
});
```

Also add the full acceptance-criteria test (EXPRESSION node + ASSIGNED_FROM edges):

```javascript
it('should create EXPRESSION node with ASSIGNED_FROM for const x = a || b', async () => {
  const { backend, testDir } = await setupTest({
    'index.js': `
const a = 'first';
const b = 'second';
const x = a || b;
`
  });
  try {
    // 1. Find EXPRESSION node
    let expressionNode = null;
    for await (const node of backend.queryNodes({ type: 'EXPRESSION' })) {
      if (node.expressionType === 'LogicalExpression' && node.operator === '||') {
        expressionNode = node;
        break;
      }
    }
    assert.ok(expressionNode, 'EXPRESSION node should exist');
    assert.strictEqual(expressionNode.name, 'a || b');

    // 2. Find variable x and verify ASSIGNED_FROM → EXPRESSION
    let xVar = null;
    for await (const node of backend.queryNodes({ type: 'CONSTANT' })) {
      if (node.name === 'x') { xVar = node; break; }
    }
    if (!xVar) {
      for await (const node of backend.queryNodes({ type: 'VARIABLE' })) {
        if (node.name === 'x') { xVar = node; break; }
      }
    }
    assert.ok(xVar, 'Variable x should exist');

    const edges = await backend.getOutgoingEdges(xVar.id, ['ASSIGNED_FROM']);
    const assignedToExpression = edges.some(e => e.dst === expressionNode.id);
    assert.ok(assignedToExpression, 'x should have ASSIGNED_FROM to EXPRESSION node');
  } finally {
    await cleanup(backend, testDir);
  }
});
```

### Step 2: Verify tests fail

```bash
pnpm build
node --test test/unit/Expression.test.js
```

Tests for name format will fail because `_computeName` currently returns `'<LogicalExpression>'`.

### Step 3: Fix `ExpressionNode._computeName`

In `/Users/regina/workspace/grafema/packages/core/src/core/nodes/ExpressionNode.ts`, change:

```typescript
// BEFORE:
case 'BinaryExpression':
case 'LogicalExpression':
  return `<${expressionType}>`;
```

```typescript
// AFTER:
case 'LogicalExpression': {
  const left = options.leftSourceName ?? '…';
  const right = options.rightSourceName ?? '…';
  const op = options.operator ?? '||';
  const raw = `${left} ${op} ${right}`;
  return raw.length > 64 ? raw.slice(0, 61) + '…' : raw;
}
case 'BinaryExpression':
  return `<BinaryExpression>`;  // unchanged — out of scope for REG-553
```

Note: `leftSourceName` and `rightSourceName` are already in `ExpressionNodeOptions`, so no interface changes needed.

### Step 4: Build and verify tests pass

```bash
pnpm build
node --test test/unit/Expression.test.js
```

### Step 5: Run full test suite

```bash
node --test --test-concurrency=1 'test/unit/*.test.js'
```

---

## 4. Edge cases to consider

### 4.1 Operand is not an Identifier

When left or right operand is a complex expression (e.g., `options.workerCount || 10` or `options.logger ?? createLogger()`), `leftSourceName` or `rightSourceName` will be `null`. The name should degrade gracefully:

- `null || b` → `"… || b"`
- `a || null` → `"a || …"`
- `null || null` → `"… || …"`

This is handled by the `?? '…'` fallback above.

### 4.2 Nested logical expressions

`a ?? b ?? c` parses as `(a ?? b) ?? c` (left-associative). The inner `(a ?? b)` becomes a `LogicalExpression` that is the left operand of the outer one. The outer `leftSourceName` will be `null` (it's not an Identifier). Result: `"… ?? c"`. This is acceptable per the spec (truncation is fine).

### 4.3 `??` not being parsed

Some Babel parser configurations might not support `??` without the `nullishCoalescingOperator` plugin. However, since the project already uses `@babel/parser` with TypeScript plugins (which includes modern syntax), `??` is already parsed correctly as `LogicalExpression` — confirmed by manual test.

### 4.4 Name truncation at 64 chars

For long variable names like `options.workerCount`, `leftSourceName` will be `null` (it's a MemberExpression, not an Identifier), so truncation is not needed in practice. For simple variable names, the 64-char limit is extremely conservative. The implementation correctly truncates at 61 chars + `'…'` to stay within 64 chars total.

### 4.5 Existing tests for `<LogicalExpression>` name

The existing tests in `Expression.test.js` do NOT check the `name` field for `LogicalExpression` — they check `expressionType` and `operator`. No regressions expected. **Verify this by running existing tests before adding new ones.**

### 4.6 `createFromMetadata` vs `create`

The `AssignmentBuilder` uses `createFromMetadata` which calls `_computeName` with the same logic. The fix in `_computeName` covers both code paths.

### 4.7 Return statements with LogicalExpression

`ReturnBuilder` (line 192) also creates EXPRESSION nodes for `LogicalExpression`. It passes `operator` to `createExpressionFromMetadata` but does NOT pass `leftSourceName`/`rightSourceName`. After fixing `_computeName`, these return-statement EXPRESSION nodes will show `"… || …"` (both operands `null`). This is a minor limitation: the ReturnBuilder would need a separate fix to populate `leftSourceName`/`rightSourceName`. This is out of scope for REG-553 (which focuses on variable assignments) but worth filing as a follow-up.

---

## 5. Tests to write

All tests go in `/Users/regina/workspace/grafema/test/unit/Expression.test.js`, inside the existing `describe('LogicalExpression', ...)` block.

### Test 1 — Name format for `||`
```
const x = a || b → EXPRESSION node, name === "a || b"
```

### Test 2 — Name format for `&&`
```
const x = a && b → EXPRESSION node, name === "a && b"
```

### Test 3 — Name format for `??`
```
const x = a ?? b → EXPRESSION node, operator === "??", name === "a ?? b"
```

### Test 4 — Acceptance criteria test: `const x = a || b` → EXPRESSION + ASSIGNED_FROM
```
Variable x has ASSIGNED_FROM edge to EXPRESSION node
EXPRESSION node has name "a || b"
EXPRESSION node has DERIVES_FROM edges to both 'a' and 'b' variables
```

### Test 5 — Fallback name when operand is not an Identifier
```
const x = options.timeout || 10 → EXPRESSION node, name === "… || …"
```
(Both operands are non-Identifier, so both fall back to `'…'`)

### Test 6 — Name truncation (optional, low-priority)
```
Long variable names → truncated at 64 chars with trailing '…'
```

### DO NOT write tests for:
- `BinaryExpression` name format — out of scope (REG-553 is about logical/nullish)
- `ReturnBuilder` LogicalExpression names — follow-up issue
- Nested LogicalExpression chains — behavior is acceptable as-is

---

## Summary

**Scope is much smaller than it appears.** The pipeline already works end-to-end for `||`, `&&`, and `??`. The only actual code change needed is 5 lines in `ExpressionNode._computeName` to produce human-readable names instead of `'<LogicalExpression>'`.

**The task title says "currently invisible" — this is only true for the `name` field.** The nodes exist in the graph already. Value Trace gap might be a separate issue in the Trace layer, not the indexer. Implementer should verify this by running a trace query after the fix.

**Files to change:**

| File | Change |
|------|--------|
| `packages/core/src/core/nodes/ExpressionNode.ts` | Fix `_computeName` for `LogicalExpression` |
| `test/unit/Expression.test.js` | Add 4–6 new test cases |

**Files NOT to change:** JSASTAnalyzer, AssignmentBuilder, ReturnBuilder, GraphBuilder, types, edges — all already handle LogicalExpression correctly.
