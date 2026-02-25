# REG-571: Don Melton — Exploration Report

**Date:** 2026-02-23
**Task:** GraphBuilder: EXPRESSION nodes for ternary/binary/OR/property-access have no outgoing data flow edges

---

## Summary

The bug is real. EXPRESSION nodes for ternary/binary/logical OR/member-access/object literal are created and linked INBOUND (variable → ASSIGNED_FROM → EXPRESSION) but have ZERO outgoing ASSIGNED_FROM or DERIVES_FROM edges in the reported cases. The DataFlowValidator's `findPathToLeaf` traverses outgoing ASSIGNED_FROM/DERIVES_FROM edges, reaches an EXPRESSION node, finds no outgoing edges, and emits ERR_NO_LEAF_NODE.

The situation is more nuanced than the issue description suggests. Some expression types DO get DERIVES_FROM edges (when the source operands are simple `Identifier` nodes — variable names). The gap is when operands are NOT simple Identifiers: literals, nested expressions, call expressions, or missing metadata.

Additionally, OBJECT_LITERAL and ARRAY_LITERAL are not in the `leafTypes` set, causing the same ERR_NO_LEAF_NODE path.

---

## Architecture Overview

Data flow for `const x = <expr>`:

```
VARIABLE:x  --ASSIGNED_FROM-->  EXPRESSION:<type>  --DERIVES_FROM-->  VARIABLE:operand
                                                     --DERIVES_FROM-->  PARAMETER:operand
```

The "leaf" resolution in DataFlowValidator follows ASSIGNED_FROM/DERIVES_FROM chains until reaching a node of type: `LITERAL`, `CALL`, `FUNCTION`, `CLASS`, `CONSTRUCTOR_CALL`, `net:stdio`, etc.

---

## File Paths and Locations

### Node Definitions

| File | Purpose |
|------|---------|
| `/Users/vadimr/grafema-worker-1/packages/core/src/core/nodes/ExpressionNode.ts` | EXPRESSION node type, `create()`, `createFromMetadata()`, `generateId()` |
| `/Users/vadimr/grafema-worker-1/packages/core/src/core/nodes/BranchNode.ts` | BRANCH node type including `branchType='ternary'` |

### Analysis Pipeline

| File | Purpose |
|------|---------|
| `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | `trackVariableAssignment()` — produces `VariableAssignmentInfo` entries per expression type (lines 612–1076) |
| `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts` | Module-level variable declarations, delegates to `trackVariableAssignment` |
| `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/handlers/BranchHandler.ts` | Creates BRANCH nodes including `branchType='ternary'`; generates consequent/alternate expression IDs (lines 213–289) |

### Graph Building

| File | Purpose |
|------|---------|
| `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Orchestrator — buffers nodes/edges, calls domain builders |
| `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/builders/AssignmentBuilder.ts` | **Core of the bug** — creates EXPRESSION nodes and ASSIGNED_FROM/DERIVES_FROM edges for variable assignments |
| `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/builders/ControlFlowBuilder.ts` | Creates EXPRESSION nodes for branch discriminants and loop conditions; also creates DERIVES_FROM edges via `bufferBranchDiscriminantDerivesFromEdges` and `bufferLoopTestDerivesFromEdges` |
| `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/builders/ReturnBuilder.ts` | Creates EXPRESSION nodes and DERIVES_FROM edges for return statements — **THE WORKING MODEL** |
| `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts` | Creates OBJECT_LITERAL and ARRAY_LITERAL nodes (no outgoing edges from these nodes) |

### Validation

| File | Purpose |
|------|---------|
| `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/validation/DataFlowValidator.ts` | `ERR_NO_LEAF_NODE` check; `findPathToLeaf()` traversal (lines 186–225) |

### Types

| File | Purpose |
|------|---------|
| `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/types.ts` | `VariableAssignmentInfo` (lines 896–940), `BranchInfo` (lines 85–116), `ASTCollections` (lines 1183–1269) |

### Existing Tests

| File | Purpose |
|------|---------|
| `/Users/vadimr/grafema-worker-1/test/unit/Expression.test.js` | Full integration tests for EXPRESSION nodes — ASSIGNED_FROM and DERIVES_FROM edge creation |

---

## How EXPRESSION Nodes Are Currently Created

### Path 1: Variable Assignment (AssignmentBuilder)

Source: `JSASTAnalyzer.trackVariableAssignment()` populates `VariableAssignmentInfo` with `sourceType: 'EXPRESSION'`.

`AssignmentBuilder.bufferAssignmentEdges()` (lines 190–405) handles this:

```
// Line 190: EXPRESSION branch
else if (sourceType === 'EXPRESSION' && sourceId) {
  // 1. Creates EXPRESSION node via NodeFactory.createExpressionFromMetadata()
  this.ctx.bufferNode(expressionNode);

  // 2. Creates ASSIGNED_FROM edge: VARIABLE -> EXPRESSION
  this.ctx.bufferEdge({ type: 'ASSIGNED_FROM', src: variableId, dst: sourceId });

  // 3. Creates DERIVES_FROM edges (conditional on operand source names):
  //    - MemberExpression: objectSourceName -> object variable
  //    - BinaryExpression/LogicalExpression: leftSourceName, rightSourceName -> variables
  //    - ConditionalExpression: consequentSourceName, alternateSourceName -> variables
  //    - TemplateLiteral: expressionSourceNames[] -> variables
  //    - UnaryExpression: unaryArgSourceName -> variable
}
```

### Per Expression Type — Current Behavior

#### MemberExpression (e.g., `const m = options.timeout`)
- **Created:** EXPRESSION node with `expressionType='MemberExpression'`, `object`, `property` fields
- **ASSIGNED_FROM:** `VARIABLE:m -> ASSIGNED_FROM -> EXPRESSION:options.timeout` — EXISTS
- **DERIVES_FROM:** `EXPRESSION -> DERIVES_FROM -> VARIABLE:options` — EXISTS if `objectSourceName` is set AND the source is a simple Identifier AND the variable is found in variableDeclarations
- **Gap:** `objectSourceName` is only `null` for non-Identifier objects (`<complex>`). So this case mostly works. BUT the lookup uses a naive `find(v => v.name === name)` without scope awareness in AssignmentBuilder (uses file-level file split on `#` for legacy IDs), which can miss variables in some scopes.

#### BinaryExpression (e.g., `const n = arr.length - 1`)
- **Created:** EXPRESSION node with `expressionType='BinaryExpression'`, `operator` field
- **ASSIGNED_FROM:** EXISTS
- **DERIVES_FROM for left operand:** Only if `initExpression.left.type === 'Identifier'` — meaning `leftSourceName` is set (JSASTAnalyzer line 842)
- **Gap:** When left or right operand is NOT a simple Identifier (e.g., `arr.length` is a MemberExpression), `leftSourceName` is `null`. No DERIVES_FROM edge is created. The EXPRESSION node has only ASSIGNED_FROM inbound, zero outbound. The DataFlowValidator then traverses VARIABLE → ASSIGNED_FROM → EXPRESSION:<BinaryExpression> → (no outgoing edges) → ERR_NO_LEAF_NODE.

#### LogicalExpression/OR (e.g., `const x = A || B`)
- **Same structure as BinaryExpression.** DERIVES_FROM edges only created when operands are Identifiers.
- **Gap:** When left or right is NOT an Identifier (e.g., `config.timeout || 5000`), no DERIVES_FROM is created.

#### ConditionalExpression/Ternary (e.g., `const name = cond ? a : b`)
- **Created:** EXPRESSION node with `expressionType='ConditionalExpression'`
- **ASSIGNED_FROM:** EXISTS
- **DERIVES_FROM:** Only if `consequentSourceName` or `alternateSourceName` is set — i.e., only when `initExpression.consequent.type === 'Identifier'` (JSASTAnalyzer line 861)
- **Important:** `trackVariableAssignment` ALSO recursively calls itself for consequent AND alternate (lines 868-869):
  ```js
  this.trackVariableAssignment(initExpression.consequent, variableId, ...);
  this.trackVariableAssignment(initExpression.alternate, variableId, ...);
  ```
  This creates ADDITIONAL `VariableAssignmentInfo` entries where `variableId` is the SAME variable but `sourceId/sourceType` points to whatever the consequent/alternate expressions are. This creates ADDITIONAL ASSIGNED_FROM edges from `variableId` directly to the consequent/alternate values.
- **BRANCH node issue:** `BranchHandler.createConditionalExpressionVisitor()` (line 244-259) generates `consequentExpressionId` = `ExpressionNode.generateId(condNode.consequent.type, ...)`. This uses the AST node TYPE as the EXPRESSION type (e.g., 'Identifier', 'NumericLiteral', 'CallExpression'). For `cond ? a : b` where `a` is an Identifier, this generates `EXPRESSION:Identifier:line:col`. But **no actual EXPRESSION node with that ID is ever created in the graph.** The ControlFlowBuilder creates HAS_CONSEQUENT/HAS_ALTERNATE edges pointing to these IDs (ControlFlowBuilder.ts lines 356-369), but only the EXPRESSION node for the CONDITION (discriminant) is created via `bufferDiscriminantExpressions`. The consequent/alternate EXPRESSION nodes are **dangling references** — the destination nodes don't exist.

#### Object Literal (e.g., `const PLUGINS = { ... }`)
- **Created:** OBJECT_LITERAL node (not an EXPRESSION node) via `CoreBuilder.bufferObjectLiteralNodes()`
- **ASSIGNED_FROM:** `VARIABLE -> ASSIGNED_FROM -> OBJECT_LITERAL` — EXISTS (created via AssignmentBuilder line 100-105 since `sourceType='OBJECT_LITERAL'` != 'EXPRESSION')
- **Gap:** `OBJECT_LITERAL` is NOT in `leafTypes`. DataFlowValidator follows VARIABLE → ASSIGNED_FROM → OBJECT_LITERAL → (no outgoing ASSIGNED_FROM/DERIVES_FROM) → ERR_NO_LEAF_NODE.

#### Array Literal
- Same situation as Object Literal. `ARRAY_LITERAL` is not a leaf type.

---

## The BRANCH Node Pattern for Ternary — The Disconnection

**BranchHandler.createConditionalExpressionVisitor()** (line ~213):

```typescript
const consequentExpressionId = ExpressionNode.generateId(
  condNode.consequent.type,  // <- uses AST node type, e.g., 'Identifier', 'NumericLiteral'
  ctx.module.file,
  consequentLine,
  consequentColumn
);
```

This produces IDs like: `/path/file.ts:EXPRESSION:Identifier:42:10`

Then in ControlFlowBuilder `bufferBranchEdges()` (line 355-370):
```typescript
if (branch.branchType === 'ternary') {
  this.ctx.bufferEdge({ type: 'HAS_CONSEQUENT', src: branch.id, dst: branch.consequentExpressionId });
  this.ctx.bufferEdge({ type: 'HAS_ALTERNATE', src: branch.id, dst: branch.alternateExpressionId });
}
```

And `bufferDiscriminantExpressions()` (line 451-473) ONLY creates EXPRESSION nodes for the **discriminant** (the condition), NOT for consequent or alternate.

**Result:** BRANCH:ternary → HAS_CONSEQUENT → EXPRESSION:Identifier:42:10 — but that EXPRESSION node **does not exist in the graph**. The edge references a nonexistent node.

The only way the ternary EXPRESSION node (the ConditionalExpression itself) gets DERIVES_FROM edges is through the AssignmentBuilder's `consequentSourceName`/`alternateSourceName` fields, which only work when the branches are simple Identifiers.

---

## What Working Expression Types Look Like (The Model)

### Simple MemberExpression — When It Works

For `const m = obj.method`:
1. JSASTAnalyzer (line 798-828): sets `objectSourceName: 'obj'`
2. AssignmentBuilder (line 248-258): finds `VARIABLE:obj` → creates `EXPRESSION:obj.method → DERIVES_FROM → VARIABLE:obj`
3. DataFlowValidator: VARIABLE:m → ASSIGNED_FROM → EXPRESSION:obj.method → DERIVES_FROM → VARIABLE:obj → (VARIABLE:obj also has its own assignment) → eventually reaches LITERAL or OBJECT_LITERAL

### ReturnBuilder — The Gold Standard

`ReturnBuilder.bufferReturnEdges()` handles EXPRESSION returns identically to AssignmentBuilder but is complete. It:
1. Creates EXPRESSION node via `NodeFactory.createExpressionFromMetadata()`
2. Creates RETURNS edge (source node → function)
3. Creates DERIVES_FROM edges for each operand type

The logic mirrors AssignmentBuilder exactly. Both have the same limitation: DERIVES_FROM edges only for Identifier operands.

### Key Insight: The Limitation Is Symmetric

Both AssignmentBuilder and ReturnBuilder only create DERIVES_FROM edges when operands are simple Identifiers. This is intentional for cases like `a + b` → DERIVES_FROM → `VARIABLE:a` and `VARIABLE:b`. The gap occurs when:
1. Operand is a literal (no DERIVES_FROM needed, but EXPRESSION has no outgoing edge)
2. Operand is a MemberExpression (e.g., `arr.length - 1`)
3. Operand is a CallExpression
4. Operand is another nested expression

---

## Why ERR_NO_LEAF_NODE Is Emitted: The Exact Path

For `const n = arr.length - 1`:
1. `trackVariableAssignment` creates: `{ sourceType: 'EXPRESSION', expressionType: 'BinaryExpression', leftSourceName: null (because 'arr.length' is MemberExpression), rightSourceName: null (because 1 is NumericLiteral) }`
2. AssignmentBuilder creates EXPRESSION:BinaryExpression node + ASSIGNED_FROM edge from VARIABLE:n
3. No DERIVES_FROM edges created (both source names are null)
4. DataFlowValidator: VARIABLE:n → ASSIGNED_FROM → EXPRESSION:BinaryExpression → getOutgoingEdges(['ASSIGNED_FROM', 'DERIVES_FROM']) → [] → returns `found: false` → ERR_NO_LEAF_NODE

For `const PLUGINS = { key: func }`:
1. AssignmentBuilder creates ASSIGNED_FROM edge: VARIABLE:PLUGINS → OBJECT_LITERAL
2. DataFlowValidator: VARIABLE:PLUGINS → ASSIGNED_FROM → OBJECT_LITERAL → not in leafTypes → getOutgoingEdges → [] → ERR_NO_LEAF_NODE

---

## Patterns and Helpers for Creating Edges

`EdgeFactory.create()` at `/Users/vadimr/grafema-worker-1/packages/core/src/core/EdgeFactory.ts` — but builders use `this.ctx.bufferEdge()` directly with inline objects.

`NodeFactory.createExpressionFromMetadata()` at `/Users/vadimr/grafema-worker-1/packages/core/src/core/NodeFactory.ts` line 110 — delegates to `CoreFactory.createExpressionFromMetadata`.

`ExpressionNode.generateId()` at `/Users/vadimr/grafema-worker-1/packages/core/src/core/nodes/ExpressionNode.ts` line 157 — used to generate IDs without creating nodes.

`BuilderContext` at `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/builders/types.ts`:
- `ctx.bufferNode(node)` — adds node to graph
- `ctx.bufferEdge({ type, src, dst })` — adds edge to graph

---

## Key Types/Interfaces

### VariableAssignmentInfo (ast/types.ts lines 896-940)

Critical fields for EXPRESSION handling:
```typescript
expressionType?: string;          // 'MemberExpression', 'BinaryExpression', etc.
object?: string;                   // MemberExpression: object name
property?: string;                 // MemberExpression: property name
objectSourceName?: string | null;  // Identifier name if object is simple Identifier
leftSourceName?: string | null;    // Identifier name if left operand is Identifier
rightSourceName?: string | null;   // Identifier name if right operand is Identifier
consequentSourceName?: string | null;  // Identifier name if consequent is Identifier
alternateSourceName?: string | null;   // Identifier name if alternate is Identifier
expressionSourceNames?: string[];  // TemplateLiteral expression names
unaryArgSourceName?: string | null;    // UnaryExpression argument if Identifier
```

The pattern: `*SourceName` is set to the variable name when the operand is a simple Identifier, `null` otherwise. This is the only signal AssignmentBuilder uses for DERIVES_FROM edge creation.

### BranchInfo (ast/types.ts lines 85-116)

Key ternary fields:
```typescript
branchType: 'ternary';
consequentExpressionId?: string;   // ID generated from condNode.consequent.type — may be dangling
alternateExpressionId?: string;    // ID generated from condNode.alternate.type — may be dangling
discriminantExpressionId?: string; // The condition EXPRESSION — this one IS created
```

---

## Root Cause Summary

There are **three distinct root causes** producing ERR_NO_LEAF_NODE from EXPRESSION nodes:

### Root Cause 1: Non-Identifier operands → no DERIVES_FROM (affects all compound expressions)
When operands of BinaryExpression, LogicalExpression, ConditionalExpression, MemberExpression are non-Identifier nodes (literals, nested expressions, calls), `*SourceName` fields are null. AssignmentBuilder skips DERIVES_FROM edge creation. The EXPRESSION node has zero outgoing data flow edges. The validator cannot find a leaf.

**Fix direction:** For the "no outgoing edge" case: Add `OBJECT_LITERAL`, `ARRAY_LITERAL`, `EXPRESSION` to `leafTypes` in DataFlowValidator (quick fix), OR create ASSIGNED_FROM/DERIVES_FROM edges from EXPRESSION nodes to their operand sub-nodes (deeper fix that enables full tracing).

### Root Cause 2: OBJECT_LITERAL and ARRAY_LITERAL not in leafTypes
`const PLUGINS = { ... }` creates VARIABLE → ASSIGNED_FROM → OBJECT_LITERAL. But DataFlowValidator doesn't treat OBJECT_LITERAL as a leaf. The validator tries to follow outgoing edges from OBJECT_LITERAL, finds none, emits ERR_NO_LEAF_NODE.

**Fix direction:** Add `OBJECT_LITERAL` and `ARRAY_LITERAL` to `leafTypes` set in DataFlowValidator.

### Root Cause 3: Ternary BRANCH HAS_CONSEQUENT/HAS_ALTERNATE edges are dangling
BranchHandler generates `consequentExpressionId` using `condNode.consequent.type` (e.g., 'Identifier', 'NumericLiteral'). No EXPRESSION node with those IDs is ever created. The BRANCH node has HAS_CONSEQUENT/HAS_ALTERNATE edges pointing to nonexistent nodes.

**Fix direction:** In BranchHandler, use the ACTUAL expression types for known composite cases, and ensure the corresponding EXPRESSION nodes are created in ControlFlowBuilder's `bufferBranchEdges()` (similar to how discriminant EXPRESSION nodes are created via `bufferDiscriminantExpressions()`).

---

## Where to Make Fixes

### Fix 1 (simplest, highest impact): DataFlowValidator leafTypes

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/validation/DataFlowValidator.ts`
**Lines:** 67-78
Add: `'OBJECT_LITERAL'`, `'ARRAY_LITERAL'`, and `'EXPRESSION'` to the `leafTypes` set.

This would stop the false positives from OBJECT_LITERAL, ARRAY_LITERAL, and EXPRESSION nodes that have DERIVES_FROM edges elsewhere. However, it would mask cases where EXPRESSION nodes genuinely have no outgoing edges (masking the bug rather than fixing it).

### Fix 2 (correct, targeted): Add DERIVES_FROM from EXPRESSION to non-Identifier sub-nodes

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/builders/AssignmentBuilder.ts`
**Lines:** 247-404

When operand is a literal (e.g., right side of `arr.length - 1`), the EXPRESSION is a dead end. Options:
- Option A: Treat literals as inline leaves — create a LITERAL node inline and link EXPRESSION → ASSIGNS_FROM → LITERAL
- Option B: For each expression type, create sub-EXPRESSION nodes recursively and link them

### Fix 3: Fix ternary BRANCH consequent/alternate EXPRESSION node creation

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/builders/ControlFlowBuilder.ts`
**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/ast/handlers/BranchHandler.ts`

Currently `bufferDiscriminantExpressions()` only creates the discriminant EXPRESSION node. Need parallel handling for `consequentExpressionId` and `alternateExpressionId`.

---

## Acceptance Criteria Mapping

| Criterion | Current State | Root Cause |
|-----------|--------------|------------|
| Ternary EXPRESSION → condition, consequent, alternate | DERIVES_FROM only for Identifier operands | Root Cause 1 + 3 |
| Binary EXPRESSION → left, right operands | DERIVES_FROM only for Identifier operands | Root Cause 1 |
| Logical OR EXPRESSION → left, right | DERIVES_FROM only for Identifier operands | Root Cause 1 |
| Member access EXPRESSION → object | DERIVES_FROM exists when object is Identifier | Root Cause 1 (partial) |
| Object literal EXPRESSION → property values | Not applicable (OBJECT_LITERAL, not EXPRESSION) | Root Cause 2 |
| BRANCH HAS_CONSEQUENT/HAS_ALTERNATE → real node IDs | Currently dangling for non-ternary | Root Cause 3 |
| Zero ERR_NO_LEAF_NODE on Grafema codebase | 2931 warnings | All three causes |
