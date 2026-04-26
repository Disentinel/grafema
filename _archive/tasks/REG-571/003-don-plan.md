# REG-571: ERR_NO_LEAF_NODE on EXPRESSION nodes — Don's Plan

## Summary

Three distinct root causes have been identified. Each requires a targeted fix. No existing subsystems
need to be replaced — this is extension work only.

---

## Root Cause 1: EXPRESSION nodes with non-Identifier operands have no DERIVES_FROM edges

### The Problem

In `JSASTAnalyzer.trackVariableAssignment`, when the operands of a BinaryExpression,
LogicalExpression, ConditionalExpression, MemberExpression, or UnaryExpression are not plain
Identifier nodes (e.g., they are literals, nested member expressions, call results), the `*SourceName`
fields on the `VariableAssignmentInfo` are set to `null`:

```typescript
// BinaryExpression (line 842-843)
leftSourceName: initExpression.left.type === 'Identifier' ? initExpression.left.name : null,
rightSourceName: initExpression.right.type === 'Identifier' ? initExpression.right.name : null,
```

In `AssignmentBuilder.bufferAssignmentEdges`, DERIVES_FROM edges are only created when those names
are non-null. When all `*SourceName` fields are null, the EXPRESSION node is created but has zero
outgoing edges. `DataFlowValidator.findPathToLeaf` then tries to traverse outgoing ASSIGNED_FROM /
DERIVES_FROM from the EXPRESSION node, finds none, and reports ERR_NO_LEAF_NODE.

**Concrete examples that fail today:**
- `const x = obj.timeout || 10` — right operand `10` is a literal, so `rightSourceName` is null
- `const x = a + 1` — right operand `1` is a literal, so `rightSourceName` is null
- `const x = cond ? getDefault() : b` — consequent is a CallExpression, so `consequentSourceName` is null

### The Correct Fix: EXPRESSION nodes with all-literal operands are terminal values

The key insight: when ALL resolvable operands of an expression are literals (non-Identifier values),
the EXPRESSION itself represents a terminal computed value. It needs no DERIVES_FROM edges — it IS
the leaf. The fix is to add 'EXPRESSION' to `leafTypes` in `DataFlowValidator` ONLY when the
EXPRESSION has zero outgoing DERIVES_FROM edges (i.e., the validator only marks it a leaf if it
cannot traverse further).

**Wait — that is wrong.** The validator already has no special case for EXPRESSION. Adding EXPRESSION
to `leafTypes` unconditionally would mask cases where an EXPRESSION genuinely should have edges.

The CORRECT approach, consistent with project principles, is:

**Option A (recommended): Make EXPRESSION a conditional leaf via the existing traversal logic.**

Modify `DataFlowValidator.findPathToLeaf` to treat an EXPRESSION node as a leaf when it has no
outgoing DERIVES_FROM edges. This is the minimal, correct change. The rationale: an EXPRESSION with
no DERIVES_FROM represents a computation entirely from literal values. It is a terminal data value —
the expression `5 + 3` is as terminal as the literal `8`.

Change in `DataFlowValidator.findPathToLeaf` after the `leafTypes.has(startNode.type)` check:

```typescript
// EXPRESSION with no outgoing edges = computed from literals = terminal value
if (startNode.type === 'EXPRESSION') {
  const outgoingDerivesFrom = await graph.getOutgoingEdges(startNode.id, ['DERIVES_FROM']);
  if (outgoingDerivesFrom.length === 0) {
    return { found: true, chain };
  }
}
```

This does NOT add EXPRESSION to leafTypes globally. It only treats it as a leaf when it provably
has no data flow dependencies to trace. If an EXPRESSION does have DERIVES_FROM edges, traversal
continues normally.

**Why not Option B (add DERIVES_FROM edges to LITERAL nodes)?**
We could create LITERAL sub-nodes for literal operands and add DERIVES_FROM from EXPRESSION to
LITERAL. But LITERAL nodes are already in `leafTypes` and this would require changes in
`trackVariableAssignment` (create LITERAL nodes for inline operands) and `AssignmentBuilder`
(add DERIVES_FROM to those LITERAL nodes). That's more invasive for the same result. Option A
is simpler and architecturally sound: the validator logic itself determines terminality.

**What about the mixed case (some Identifier, some literal operands)?**
Example: `const x = a + 1`. Here `leftSourceName = 'a'`, `rightSourceName = null`.
AssignmentBuilder WILL create a DERIVES_FROM edge from the EXPRESSION to variable `a`. The
validator traverses: `x -> EXPRESSION -> a -> LITERAL`. This already works. Root Cause 1's
fix (Option A) only affects the case where NO DERIVES_FROM edges exist (all-literal operands).

### Files to Change for Root Cause 1

**`packages/core/src/plugins/validation/DataFlowValidator.ts`**
- In `findPathToLeaf`, after `leafTypes.has(startNode.type)` check, add EXPRESSION-with-no-edges
  terminality check (see code above)
- No change to `leafTypes` set itself

---

## Root Cause 2: OBJECT_LITERAL and ARRAY_LITERAL missing from leafTypes

### The Problem

`trackVariableAssignment` creates OBJECT_LITERAL and ARRAY_LITERAL nodes (cases 0.5 and 0.6) and
pushes assignments with `sourceType: 'OBJECT_LITERAL'` and `sourceType: 'ARRAY_LITERAL'`. These
resolve to actual OBJECT_LITERAL and ARRAY_LITERAL nodes in the graph.

In `AssignmentBuilder.bufferAssignmentEdges`, the branch `if (sourceId && sourceType !== 'EXPRESSION')`
creates an ASSIGNED_FROM edge from the variable to the OBJECT_LITERAL / ARRAY_LITERAL node. The
edge IS created correctly.

But `DataFlowValidator.leafTypes` does not include `'OBJECT_LITERAL'` or `'ARRAY_LITERAL'`. So the
validator follows the ASSIGNED_FROM edge to the OBJECT_LITERAL/ARRAY_LITERAL node, then tries to
find outgoing ASSIGNED_FROM/DERIVES_FROM edges from it, finds none, and reports ERR_NO_LEAF_NODE.

### The Correct Fix

OBJECT_LITERAL and ARRAY_LITERAL ARE terminal data values — they are sources, not intermediaries.
Adding them to `leafTypes` is exactly correct. This is not masking a bug; it is describing the
accurate semantics of these nodes.

### Files to Change for Root Cause 2

**`packages/core/src/plugins/validation/DataFlowValidator.ts`**
- Add `'OBJECT_LITERAL'` and `'ARRAY_LITERAL'` to the `leafTypes` set

```typescript
const leafTypes = new Set([
  'LITERAL',
  'OBJECT_LITERAL',   // <-- add
  'ARRAY_LITERAL',    // <-- add
  'net:stdio',
  // ... rest unchanged
]);
```

---

## Root Cause 3: Ternary BRANCH HAS_CONSEQUENT/HAS_ALTERNATE edges point to non-existent EXPRESSION nodes

### The Problem

In `BranchHandler.createConditionalExpressionVisitor`, the consequent and alternate expression IDs
are generated using `ExpressionNode.generateId(condNode.consequent.type, ...)` and
`ExpressionNode.generateId(condNode.alternate.type, ...)`.

For example, if the ternary is `cond ? a : b`, then:
- consequentExpressionId = `{file}:EXPRESSION:Identifier:{line}:{col}`
- alternateExpressionId = `{file}:EXPRESSION:Identifier:{line}:{col}`

These IDs are stored in `BranchInfo` and `ControlFlowBuilder.bufferBranchEdges` creates:
- `BRANCH -> HAS_CONSEQUENT -> {file}:EXPRESSION:Identifier:...`
- `BRANCH -> HAS_ALTERNATE -> {file}:EXPRESSION:Identifier:...`

But no EXPRESSION nodes with those IDs are ever created. `trackVariableAssignment` for a ternary
(case 9) creates ONE EXPRESSION node for the whole ConditionalExpression, then calls itself
recursively on `.consequent` and `.alternate`. If `.consequent` is an Identifier, the recursive
call hits case 4 (Identifier) and creates an ASSIGNED_FROM edge from the variable to the Identifier
source — it does NOT create an EXPRESSION node. So the HAS_CONSEQUENT and HAS_ALTERNATE edges dangle.

This is a control flow graph correctness issue. The BRANCH for a ternary should either:
(a) point to the variable/literal that consequent/alternate resolve to, or
(b) not have HAS_CONSEQUENT/HAS_ALTERNATE edges when the targets are simple values (Identifiers,
    literals), not complex expressions.

### The Correct Fix

The ternary control flow representation needs to be corrected. There are two sub-cases:

**Sub-case A: Consequent/alternate is an Identifier.**
The BRANCH should point to the corresponding VARIABLE node (which already exists). In
`ControlFlowBuilder.bufferBranchEdges` for ternary branches, instead of using the pre-generated
`consequentExpressionId`, look up the actual node ID: find the VARIABLE declaration by name.
This requires passing `variableDeclarations` and `parameters` into the method.

**Sub-case B: Consequent/alternate is a non-Identifier non-Expression (literal, call, etc.).**
When the consequent/alternate is a literal, no EXPRESSION node is created. The HAS_CONSEQUENT /
HAS_ALTERNATE edges should simply not be buffered if no target node exists.

**Sub-case C: Consequent/alternate is a complex expression.**
If the consequent/alternate is itself a BinaryExpression, MemberExpression, etc., then
`trackVariableAssignment` recursion WILL create an EXPRESSION node for it (it follows to case 7/8
etc.) and the ASSIGNED_FROM will point from the variable to it. BUT the EXPRESSION node's ID won't
match `ExpressionNode.generateId(condNode.consequent.type, ...)` unless it's the same file/line/col,
which it might be (since the column of the consequent is used).

Actually on closer inspection: `ExpressionNode.generateId` uses the AST node type for the ID.
If `condNode.consequent.type === 'BinaryExpression'`, the generated ID is
`{file}:EXPRESSION:BinaryExpression:{line}:{col}`. The recursive `trackVariableAssignment` call
for the consequent (which is a BinaryExpression) hits case 8 and generates `ExpressionNode.generateId('BinaryExpression', file, line, col)`. These ARE the same ID — they match. So for complex expression
consequents, the IDs DO match and the HAS_CONSEQUENT edge is valid.

The real problem is only when consequent/alternate is:
1. An Identifier — the recursive call creates no EXPRESSION node, just an ASSIGNED_FROM from
   the parent variable directly to the source variable
2. A Literal — the recursive call creates a LITERAL node, not an EXPRESSION node, so the ID
   `{file}:EXPRESSION:NumericLiteral:...` is generated but no node with that ID exists
3. CallExpression — similar: creates a CALL_SITE reference, not an EXPRESSION node

### Correct Approach for Root Cause 3

**In `ControlFlowBuilder.bufferBranchEdges` for ternary branches**, when buffering
HAS_CONSEQUENT and HAS_ALTERNATE edges, validate that the target ID format is actually for an
EXPRESSION node that will exist. The simplest check: only buffer the edge if the consequent/alternate
node type is one that `trackVariableAssignment` would handle as an EXPRESSION (i.e., MemberExpression,
BinaryExpression, LogicalExpression, ConditionalExpression, UnaryExpression, TemplateLiteral, etc.).

For Identifier, literal, and call expression consequents/alternates, do NOT create
HAS_CONSEQUENT / HAS_ALTERNATE edges from BRANCH (the data flow is already captured by the
ASSIGNED_FROM edges from the variable itself, created by the recursive `trackVariableAssignment` call).

This requires passing expression type information from `BranchHandler` to `ControlFlowBuilder` so
the builder knows what the consequent/alternate node types are. `BranchInfo` already stores
`consequentExpressionId` — we need to also store `consequentNodeType` and `alternateNodeType`
(the raw AST node types, not 'EXPRESSION').

**Alternative (simpler):** In `BranchHandler`, only set `consequentExpressionId` /
`alternateExpressionId` in the BranchInfo when the consequent/alternate would result in an actual
EXPRESSION node being created. For Identifier, Literal, CallExpression, etc. — set these fields
to `undefined`. The `ControlFlowBuilder` already guards with `if (branch.consequentExpressionId)`.

### Files to Change for Root Cause 3

**`packages/core/src/plugins/analysis/ast/handlers/BranchHandler.ts`**
- In `createConditionalExpressionVisitor`, when setting `consequentExpressionId` and
  `alternateExpressionId`, only set them if the AST node type would result in an EXPRESSION node:

```typescript
// Types that DO create EXPRESSION nodes in trackVariableAssignment
const EXPRESSION_PRODUCING_TYPES = new Set([
  'MemberExpression', 'OptionalMemberExpression',
  'BinaryExpression', 'LogicalExpression', 'ConditionalExpression',
  'UnaryExpression', 'TemplateLiteral', 'TaggedTemplateExpression',
  'OptionalCallExpression'
  // Note: ObjectExpression -> OBJECT_LITERAL (not EXPRESSION node with EXPRESSION ID)
  // Note: ArrayExpression -> ARRAY_LITERAL (not EXPRESSION node with EXPRESSION ID)
  // Note: Identifier -> no EXPRESSION node
  // Note: Literal types -> LITERAL node, not EXPRESSION
  // Note: CallExpression -> CALL_SITE, not EXPRESSION
  // Note: NewExpression -> CONSTRUCTOR_CALL, not EXPRESSION
]);

const consequentProducesExpression = EXPRESSION_PRODUCING_TYPES.has(condNode.consequent.type);
const alternateProducesExpression = EXPRESSION_PRODUCING_TYPES.has(condNode.alternate.type);

const consequentExpressionId = consequentProducesExpression
  ? ExpressionNode.generateId(condNode.consequent.type === 'OptionalMemberExpression'
      ? 'MemberExpression' : condNode.consequent.type,
      ctx.module.file, consequentLine, consequentColumn)
  : undefined;

const alternateExpressionId = alternateProducesExpression
  ? ExpressionNode.generateId(condNode.alternate.type === 'OptionalMemberExpression'
      ? 'MemberExpression' : condNode.alternate.type,
      ctx.module.file, alternateLine, alternateColumn)
  : undefined;
```

Note: `OptionalMemberExpression` maps to `'MemberExpression'` because `trackVariableAssignment`
case 16 uses `ExpressionNode.generateId('MemberExpression', ...)` for OptionalMemberExpression.

---

## Order of Changes

The three root causes are independent of each other and can be fixed in any order. Recommended
sequence based on risk/impact:

1. **Root Cause 2 first** (OBJECT_LITERAL / ARRAY_LITERAL in leafTypes)
   - Simplest change: 2 lines added to `DataFlowValidator.ts`
   - Zero risk of regression; purely additive
   - Add test first, verify it fails, apply fix, verify it passes

2. **Root Cause 1 second** (EXPRESSION terminality in DataFlowValidator)
   - One small addition to `findPathToLeaf` in `DataFlowValidator.ts`
   - Risk: could make validator too permissive (but the condition is tight: only EXPRESSION
     with zero DERIVES_FROM edges, which genuinely means all-literal operands)
   - Add test first with all-literal operands (e.g., `const x = 1 + 2`)

3. **Root Cause 3 last** (Ternary BRANCH dangling edges)
   - Most complex change; touches `BranchHandler.ts`
   - Risk: any change to branch ID generation could affect existing ternary tests
   - Must verify existing ternary tests still pass after the change

---

## Test Plan

All tests go in `test/unit/Expression.test.js` unless noted.

### Tests for Root Cause 1 (all-literal operands)

**New test: BinaryExpression with literal operands should not cause ERR_NO_LEAF_NODE**
```javascript
it('should treat BinaryExpression with literal operands as terminal (no ERR_NO_LEAF_NODE)', async () => {
  // const x = 1 + 2 — both operands are literals, no DERIVES_FROM edges expected
  // DataFlowValidator should not report ERR_NO_LEAF_NODE for 'x'
  const code = `const x = 1 + 2;`;
  // Run analyzeProject, check validation errors do not include ERR_NO_LEAF_NODE for 'x'
});
```

**New test: LogicalExpression with right-side literal operand**
```javascript
it('should handle LogicalExpression with one literal operand (obj.timeout || 10)', async () => {
  // const x = obj.timeout || 10
  // Left operand is MemberExpression (gets DERIVES_FROM -> obj), right is literal (no DERIVES_FROM)
  // EXPRESSION should have 1 DERIVES_FROM (to obj), validator should succeed
  const code = `
    const obj = { timeout: 5000 };
    const x = obj.timeout || 10;
  `;
});
```

**New test: BinaryExpression with all-literal operands should terminate cleanly**
```javascript
it('should not report ERR_NO_LEAF_NODE for const x = 1 + 2', async () => {
  // Verifies DataFlowValidator treats zero-DERIVES_FROM EXPRESSION as terminal
});
```

### Tests for Root Cause 2 (OBJECT_LITERAL / ARRAY_LITERAL as leaves)

**New test: variable assigned from object literal should not cause ERR_NO_LEAF_NODE**
```javascript
it('should treat OBJECT_LITERAL assignment as terminal value', async () => {
  // const config = { host: 'localhost', port: 3000 };
  // config -> ASSIGNED_FROM -> OBJECT_LITERAL
  // DataFlowValidator should follow and stop at OBJECT_LITERAL
  const code = `const config = { host: 'localhost', port: 3000 };`;
});
```

**New test: variable assigned from array literal**
```javascript
it('should treat ARRAY_LITERAL assignment as terminal value', async () => {
  // const items = [1, 2, 3];
  // items -> ASSIGNED_FROM -> ARRAY_LITERAL
  const code = `const items = [1, 2, 3];`;
});
```

These tests should check that validation produces zero ERR_NO_LEAF_NODE errors. The test setup
pattern already exists in `Expression.test.js`; add a validation check using the orchestrator's
validation phase.

### Tests for Root Cause 3 (Ternary BRANCH edges)

Add to existing `ConditionalExpression` describe block or create a new `Ternary BRANCH edges` describe:

**New test: ternary with Identifier branches should not have dangling HAS_CONSEQUENT edges**
```javascript
it('should not create dangling HAS_CONSEQUENT edge for Identifier consequent', async () => {
  // const x = cond ? a : b
  // BRANCH -> HAS_CONSEQUENT should NOT point to a non-existent EXPRESSION node
  // Either no HAS_CONSEQUENT edge, or the edge points to an actual existing node
  const code = `
    const cond = true;
    const a = 1;
    const b = 2;
    const x = cond ? a : b;
  `;
  // Find BRANCH node with branchType 'ternary'
  // Get HAS_CONSEQUENT outgoing edges
  // For each edge, verify the target node actually exists in the graph
});
```

**New test: ternary with literal branches should not have dangling edges**
```javascript
it('should not create dangling HAS_CONSEQUENT edge for literal consequent', async () => {
  // const x = cond ? 'yes' : 'no'
  const code = `
    const cond = true;
    const x = cond ? 'yes' : 'no';
  `;
});
```

**Regression test: ternary with expression branches should still have HAS_CONSEQUENT**
```javascript
it('should create valid HAS_CONSEQUENT edge for BinaryExpression consequent', async () => {
  // const x = cond ? a + b : c
  // Consequent is BinaryExpression — EXPRESSION node WILL be created
  // BRANCH -> HAS_CONSEQUENT -> EXPRESSION should be valid
  const code = `
    const cond = true;
    const a = 1;
    const b = 2;
    const c = 3;
    const x = cond ? a + b : c;
  `;
  // Verify HAS_CONSEQUENT edge exists and points to an actual node
});
```

---

## Risk Assessment

### Root Cause 2 Fix (leafTypes addition)
**Risk: LOW**
- Purely additive: only affects nodes that currently have no outgoing edges in the validator
- No existing tests test OBJECT_LITERAL or ARRAY_LITERAL as traversal endpoints
- Could theoretically hide a case where an OBJECT_LITERAL should have outgoing edges — but
  OBJECT_LITERAL nodes are sources by design (they don't point to anything they derive from;
  properties are tracked separately via HAS_PROPERTY)

### Root Cause 1 Fix (EXPRESSION terminality check)
**Risk: LOW-MEDIUM**
- Modifies validator traversal logic
- The guard condition (zero outgoing DERIVES_FROM edges) is tight and precise
- Risk: if an EXPRESSION node should have DERIVES_FROM edges but they were not created (a different
  bug), this fix would silently swallow that bug instead of surfacing ERR_NO_LEAF_NODE
- Mitigation: the condition is structural (zero edges), not type-based. Any EXPRESSION that
  genuinely derives from something will have at least one edge and will NOT be affected.
- Existing tests: all existing Expression.test.js tests pass DERIVES_FROM edge existence assertions,
  so regressions would be caught

### Root Cause 3 Fix (Ternary BRANCH edges)
**Risk: MEDIUM**
- Modifies `BranchHandler.ts` — a core traversal file
- The `EXPRESSION_PRODUCING_TYPES` set must be kept in sync with `trackVariableAssignment` branches
  in `JSASTAnalyzer.ts`. If a new expression type is added to `trackVariableAssignment` without
  updating this set, dangling edges could reappear.
- Mitigation: document the set with a reference to `trackVariableAssignment` case numbers; add a
  comment explaining the invariant.
- Existing ternary tests (`ConditionalExpression` describe block) will catch regressions in the
  EXPRESSION node creation path.
- The set of EXPRESSION_PRODUCING_TYPES needs careful verification against the current
  `trackVariableAssignment` implementation to ensure nothing is missed or incorrectly included.

### Cross-cutting Risk
- Root Cause 1 and 3 interact: after RC3 is fixed, some EXPRESSION nodes that previously had
  dangling HAS_CONSEQUENT edges pointing to non-existent EXPRESSION nodes will instead have no
  HAS_CONSEQUENT edges at all. The validator (RC1 fix) may then encounter the ConditionalExpression
  EXPRESSION node and find zero DERIVES_FROM edges (because consequent/alternate were literals), which
  will now correctly terminate as a leaf. This is the correct behavior and the two fixes compose well.

---

## Summary of Changes

| File | Change | Root Cause |
|------|--------|------------|
| `packages/core/src/plugins/validation/DataFlowValidator.ts` | Add `'OBJECT_LITERAL'`, `'ARRAY_LITERAL'` to `leafTypes` | RC2 |
| `packages/core/src/plugins/validation/DataFlowValidator.ts` | In `findPathToLeaf`, treat EXPRESSION with 0 DERIVES_FROM as terminal | RC1 |
| `packages/core/src/plugins/analysis/ast/handlers/BranchHandler.ts` | Only set `consequentExpressionId`/`alternateExpressionId` when consequent/alternate produces an actual EXPRESSION node | RC3 |
| `test/unit/Expression.test.js` | Add tests for all-literal operands, OBJECT/ARRAY_LITERAL assignments, ternary dangling edges | All |

No new files. No new node types. No new subsystems. Extends existing infrastructure only.
