# REG-571 Plan Verification — Dijkstra Report

**Verified by:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-23
**Plan file:** `_tasks/REG-571/003-don-plan.md`
**Files read:**
- `packages/core/src/plugins/validation/DataFlowValidator.ts`
- `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` (lines 612–1076, `trackVariableAssignment`)
- `packages/core/src/plugins/analysis/ast/builders/AssignmentBuilder.ts`
- `packages/core/src/plugins/analysis/ast/builders/ControlFlowBuilder.ts`
- `packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts` (lines 315–358)
- `packages/core/src/plugins/analysis/ast/handlers/BranchHandler.ts`
- `packages/core/src/plugins/analysis/ast/ExpressionEvaluator.ts` (lines 22–70)
- `packages/core/src/plugins/analysis/ast/nodes/ExpressionNode.ts`

---

## Verification: Root Cause 1 Fix (EXPRESSION terminality in `findPathToLeaf`)

### What the plan proposes

After the `leafTypes.has(startNode.type)` check, add:
```typescript
if (startNode.type === 'EXPRESSION') {
  const outgoingDerivesFrom = await graph.getOutgoingEdges(startNode.id, ['DERIVES_FROM']);
  if (outgoingDerivesFrom.length === 0) {
    return { found: true, chain };
  }
}
```

### Verification of the precondition claim

The plan claims: EXPRESSION nodes with all-null `*SourceName` fields have zero DERIVES_FROM edges.

**Confirmed.** In `AssignmentBuilder.bufferAssignmentEdges` (lines 190–404), DERIVES_FROM edges for EXPRESSION nodes are only created when the corresponding source name field is non-null. If all source name fields are null, zero DERIVES_FROM edges are buffered. The node is still created and the ASSIGNED_FROM edge from variable to EXPRESSION is still created. The validator reaches the EXPRESSION, finds 0 DERIVES_FROM edges, and currently reports ERR_NO_LEAF_NODE.

### Edge types traversed by `findPathToLeaf`

`findPathToLeaf` at line 212 calls:
```typescript
graph.getOutgoingEdges(startNode.id, ['ASSIGNED_FROM', 'DERIVES_FROM'])
```

It also checks for incoming USES edges (lines 204–210). It does NOT traverse HAS_CONSEQUENT, HAS_ALTERNATE, or any other edge type. The plan's proposed fix correctly queries only `['DERIVES_FROM']` when checking for the EXPRESSION termination condition.

### Proposed insertion point is correct

The plan proposes inserting after `leafTypes.has(startNode.type)` and before the USES check. The actual code order is:
1. Cycle check
2. `leafTypes.has(startNode.type)` — return found
3. USES check — return found if used by call
4. Outgoing ASSIGNED_FROM/DERIVES_FROM — follow or fail

Inserting at position 2.5 (between steps 2 and 3) is correct. An EXPRESSION used by a CALL (USES incoming) would already be terminated at step 3 before reaching step 2.5 — this is benign. EXPRESSION nodes do not typically have USES edges (USES edges originate from CALL nodes pointing to VARIABLE/PARAMETER nodes), so the interaction is harmless.

### Important subtlety: ASSIGNED_FROM outgoing from EXPRESSION

EXPRESSION nodes have ASSIGNED_FROM edges incoming (from the variable) and DERIVES_FROM edges outgoing (to source variables). They do NOT have outgoing ASSIGNED_FROM edges. Therefore `getOutgoingEdges(id, ['DERIVES_FROM'])` is equivalent to `getOutgoingEdges(id, ['ASSIGNED_FROM', 'DERIVES_FROM'])` for EXPRESSION nodes. The plan's use of only `['DERIVES_FROM']` is precise and correct.

### Note: `findPathToLeaf` follows only `outgoing[0]`

At line 213, `const assignment = outgoing[0]` — the validator follows only the first outgoing edge. For EXPRESSION nodes with multiple DERIVES_FROM edges (e.g., a ternary with two Identifier branches), the validator only follows one path. This is pre-existing behavior, unchanged by the plan. RC1 fix only affects EXPRESSION nodes with ZERO DERIVES_FROM edges. **No issue with the plan here.**

### Completeness table: EXPRESSION subtypes

| Expression subtype | Creates EXPRESSION node? | Has DERIVES_FROM when operands are identifiers? | Has DERIVES_FROM when all operands are non-identifiers? | RC1 fix handles all-non-identifier case? |
|---|---|---|---|---|
| MemberExpression (case 7) | YES | YES (`objectSourceName` non-null) | NO (object is `<complex>`, `objectSourceName` null) | YES |
| BinaryExpression (case 8) | YES | YES (`leftSourceName`/`rightSourceName` non-null) | NO | YES |
| ConditionalExpression (case 9) | YES | YES (`consequentSourceName`/`alternateSourceName`) | NO | YES |
| LogicalExpression (case 10) | YES | YES (left/right source names) | NO | YES |
| TemplateLiteral with expressions (case 11) | YES | YES (expressionSourceNames) | NO (all expressions are non-identifiers) | YES |
| UnaryExpression (case 12) | YES | YES (`unaryArgSourceName` non-null) | NO (argument is non-identifier) | YES |
| TaggedTemplateExpression fallback (case 13, non-ident/non-member tag) | YES | N/A (no source name fields) | N/A (no source name fields) | YES — has 0 DERIVES_FROM, treated as terminal |
| OptionalCallExpression (case 15) | YES | N/A (no source names) | N/A | YES — always 0 DERIVES_FROM, treated as terminal |
| OptionalMemberExpression (case 16) | YES (as MemberExpression ID) | YES (`objectSourceName`) | NO | YES |

**Conclusion for RC1: The fix is correct and complete.** An EXPRESSION with zero DERIVES_FROM edges is provably computed entirely from literals, constants, or non-traceable expressions. The condition is tight and precise. **APPROVED.**

---

## Verification: Root Cause 2 Fix (OBJECT_LITERAL and ARRAY_LITERAL in `leafTypes`)

### Claim: These node types are terminal (no outgoing data flow edges)

**Confirmed.** `CoreBuilder.bufferObjectLiteralNodes` (line 326–339) and `bufferArrayLiteralNodes` (line 345–357) create nodes with only structural fields (id, type, name, file, line, column, parentCallId, argIndex). Neither method buffers any ASSIGNED_FROM or DERIVES_FROM edges from these nodes. These nodes are sources, not intermediaries.

**Searching for any other place that creates outgoing ASSIGNED_FROM/DERIVES_FROM from OBJECT_LITERAL or ARRAY_LITERAL:** None found in AssignmentBuilder or ControlFlowBuilder. These nodes only receive edges (ASSIGNED_FROM from the variable, HAS_PROPERTY from properties). They never have outgoing data flow edges.

### Claim: OBJECT_LITERAL and ARRAY_LITERAL are assigned via ASSIGNED_FROM

**Confirmed.** In `AssignmentBuilder.bufferAssignmentEdges`, the block at line 100–106:
```typescript
if (sourceId && sourceType !== 'EXPRESSION') {
  this.ctx.bufferEdge({ type: 'ASSIGNED_FROM', src: variableId, dst: sourceId });
}
```
Since `sourceType` is `'OBJECT_LITERAL'` or `'ARRAY_LITERAL'` (not `'EXPRESSION'`), and `sourceId` is set to the generated node ID, the ASSIGNED_FROM edge IS created.

### Current `leafTypes`

```typescript
const leafTypes = new Set([
  'LITERAL',
  'net:stdio', 'db:query', 'net:request', 'fs:operation', 'event:listener',
  'CLASS', 'FUNCTION', 'CALL', 'CONSTRUCTOR_CALL'
]);
```

`'OBJECT_LITERAL'` and `'ARRAY_LITERAL'` are absent. The fix (adding them) is correct.

### Risk assessment

The plan correctly identifies LOW risk. Adding these types only affects nodes that already have no outgoing ASSIGNED_FROM/DERIVES_FROM edges (verified above). The fix cannot mask a genuine missing-edge bug because no code creates outgoing data flow edges from these node types.

**Conclusion for RC2: Correct and complete. APPROVED.**

---

## Verification: Root Cause 3 Fix (EXPRESSION_PRODUCING_TYPES in BranchHandler)

### Overview

The plan proposes to guard `consequentExpressionId` / `alternateExpressionId` creation in `BranchHandler.createConditionalExpressionVisitor` behind a set:

```typescript
const EXPRESSION_PRODUCING_TYPES = new Set([
  'MemberExpression', 'OptionalMemberExpression',
  'BinaryExpression', 'LogicalExpression', 'ConditionalExpression',
  'UnaryExpression', 'TemplateLiteral', 'TaggedTemplateExpression',
  'OptionalCallExpression'
]);
```

### Complete mapping table: all AST node types that can appear as ternary consequent/alternate

| AST node type | `trackVariableAssignment` case | Node type created | ID format | In `EXPRESSION_PRODUCING_TYPES`? | IDs match? | Dangling? |
|---|---|---|---|---|---|---|
| Identifier | case 4 | No new node; VARIABLE looked up | — | NO | — | Fixed (no edge created) |
| StringLiteral / NumericLiteral / BooleanLiteral | case 1 | LITERAL node | `LITERAL#line:start#file` | NO | — | Fixed |
| NullLiteral | FALLBACK (extractLiteralValue returns null!) | No node created | — | NO | — | Fixed (no edge created) |
| TemplateLiteral (0 expressions) | case 1 (extractLiteralValue catches it) | LITERAL node | `LITERAL#line:start#file` | **YES — WRONG** | NO | **NOT FIXED** |
| TemplateLiteral (1+ expressions) | case 11 | EXPRESSION node | `file:EXPRESSION:TemplateLiteral:line:col` | YES | YES | Fixed |
| ObjectExpression | case 0.5 | OBJECT_LITERAL node | `ObjectLiteralNode.create(...)` | NO | — | Fixed |
| ArrayExpression | case 0.6 | ARRAY_LITERAL node | `ArrayLiteralNode.create(...)` | NO | — | Fixed |
| CallExpression (Identifier callee) | case 2 | CALL_SITE looked up | Coordinate-based | NO | — | Fixed |
| CallExpression (MemberExpression callee) | case 3 | METHOD_CALL looked up | Coordinate-based | NO | — | Fixed |
| NewExpression | case 5 | CONSTRUCTOR_CALL node | `NodeFactory.generateConstructorCallId(...)` | NO | — | Fixed |
| ArrowFunctionExpression / FunctionExpression | case 6 | FUNCTION looked up | Semantic ID (name-based) | NO | — | Fixed |
| MemberExpression | case 7 | EXPRESSION node | `file:EXPRESSION:MemberExpression:line:col` | YES | YES | Fixed |
| BinaryExpression | case 8 | EXPRESSION node | `file:EXPRESSION:BinaryExpression:line:col` | YES | YES | Fixed |
| ConditionalExpression | case 9 | EXPRESSION node | `file:EXPRESSION:ConditionalExpression:line:col` | YES | YES | Fixed |
| LogicalExpression | case 10 | EXPRESSION node | `file:EXPRESSION:LogicalExpression:line:col` | YES | YES | Fixed |
| UnaryExpression | case 12 | EXPRESSION node | `file:EXPRESSION:UnaryExpression:line:col` | YES | YES | Fixed |
| TaggedTemplateExpression (Identifier tag) | case 13 | CALL_SITE looked up | Coordinate-based | **YES — WRONG** | NO | **NOT FIXED** |
| TaggedTemplateExpression (MemberExpression tag) | case 13 | METHOD_CALL looked up | Coordinate-based | **YES — WRONG** | NO | **NOT FIXED** |
| TaggedTemplateExpression (other tag) | case 13 fallback | EXPRESSION node | `file:EXPRESSION:TaggedTemplateExpression:line:col` | YES | YES | Fixed |
| ClassExpression | case 14 | CLASS looked up | Name-based semantic ID | NO | — | Fixed |
| OptionalCallExpression | case 15 | EXPRESSION node | `file:EXPRESSION:OptionalCallExpression:line:col` | YES | YES | Fixed |
| OptionalMemberExpression | case 16 | EXPRESSION node | `file:EXPRESSION:MemberExpression:line:col` (uses 'MemberExpression' not 'OptionalMemberExpression') | YES (mapped to MemberExpression in plan) | YES | Fixed |
| SequenceExpression | case 17 | Delegates to last expression | — | NO (correct) | — | Correct |
| YieldExpression | case 18 | Delegates to argument | — | NO (correct) | — | Correct |
| AssignmentExpression | case 19 | Delegates to right side | — | NO (correct) | — | Correct |
| AwaitExpression | case 0 | Delegates to argument | — | NO (correct) | — | Correct |
| TSAsExpression etc. | case 0.1 | Delegates to .expression | — | NO (correct) | — | Correct |

### Identified Gaps in EXPRESSION_PRODUCING_TYPES

**GAP 1: `TaggedTemplateExpression` is included unconditionally.**

`trackVariableAssignment` case 13 has three sub-branches:
- tag is `Identifier` → creates CALL_SITE, no EXPRESSION node → ID `file:EXPRESSION:TaggedTemplateExpression:...` does NOT exist → **dangling edge**
- tag is `MemberExpression` → creates METHOD_CALL, no EXPRESSION node → **dangling edge**
- tag is anything else (fallback) → creates EXPRESSION node → ID matches → correct

The plan includes `TaggedTemplateExpression` in `EXPRESSION_PRODUCING_TYPES` unconditionally. When the ternary's consequent/alternate is a tagged template with an Identifier or MemberExpression tag (the most common case: `html\`...\``, `css\`...\``, etc.), the fix will still create a dangling HAS_CONSEQUENT/HAS_ALTERNATE edge.

**GAP 2: `TemplateLiteral` is included unconditionally.**

`trackVariableAssignment` case 1 (via `ExpressionEvaluator.extractLiteralValue`) handles TemplateLiteral with zero expressions as a literal, returning the cooked string. This is checked BEFORE case 11. When the ternary's consequent/alternate is a zero-expression template literal (`` `hello` ``), the BranchHandler would generate `ExpressionNode.generateId('TemplateLiteral', ...)` and set `consequentExpressionId`, but `trackVariableAssignment` creates a LITERAL node (not an EXPRESSION node). The HAS_CONSEQUENT edge dangles.

The plan states `TemplateLiteral` should only generate a consequentExpressionId when the template has expressions. This is not checked by the plan's proposed `EXPRESSION_PRODUCING_TYPES` set alone; the type check on `condNode.consequent.type === 'TemplateLiteral'` cannot distinguish 0-expression from N-expression templates.

### Verdict on RC3

The plan's EXPRESSION_PRODUCING_TYPES set has two confirmed gaps:
1. `TaggedTemplateExpression` should only be included when tag is neither Identifier nor MemberExpression (i.e., the rare fallback path). In practice, tagged templates nearly always use Identifier tags.
2. `TemplateLiteral` should only be included when `expressions.length > 0`.

For gap 1, fixing it requires inspecting `condNode.consequent.tag` (not just `.type`) at the point where the consequentExpressionId is generated. The fix requires checking `condNode.consequent.type === 'TaggedTemplateExpression' && condNode.consequent.tag.type !== 'Identifier' && condNode.consequent.tag.type !== 'MemberExpression'`.

For gap 2, fixing it requires checking `condNode.consequent.type === 'TemplateLiteral' && condNode.consequent.expressions.length > 0`.

These are not trivial type checks on `EXPRESSION_PRODUCING_TYPES`; they require inspecting AST node properties beyond `.type`.

### Causal relationship to ERR_NO_LEAF_NODE

An additional observation: RC3 (dangling HAS_CONSEQUENT/HAS_ALTERNATE edges) does NOT directly cause `ERR_NO_LEAF_NODE` in the current `DataFlowValidator`. The validator traverses only ASSIGNED_FROM and DERIVES_FROM edges and never traverses HAS_CONSEQUENT or HAS_ALTERNATE. The RC3 issue is a graph integrity problem (dangling edges point to non-existent nodes), but it does not trigger the ERR_NO_LEAF_NODE error path in the current validator implementation. This means RC3 is a legitimate correctness fix for graph quality, but it is not a "root cause" of the ERR_NO_LEAF_NODE symptom described in REG-571. The plan conflates the two concerns without establishing the ERR_NO_LEAF_NODE causation chain for RC3.

---

## Cross-Cutting Interaction Verification

### RC1 + RC3 interaction (from plan)

The plan asserts: "after RC3 is fixed, some EXPRESSION nodes that previously had dangling HAS_CONSEQUENT edges pointing to non-existent EXPRESSION nodes will instead have no HAS_CONSEQUENT edges at all. The validator (RC1 fix) may then encounter the ConditionalExpression EXPRESSION node and find zero DERIVES_FROM edges (because consequent/alternate were literals), which will now correctly terminate as a leaf."

**This is correct behavior**, but it is not caused by the RC3 fix. Even without RC3, the ConditionalExpression EXPRESSION node (case 9) would have zero DERIVES_FROM edges when both branches are literals (`cond ? 1 : 2` → `consequentSourceName: null`, `alternateSourceName: null`). The RC1 fix handles this independently of RC3. The plan is correct that the two fixes compose well, but RC1 does the actual work of fixing ERR_NO_LEAF_NODE in this scenario, not RC3.

### RC1 silent swallowing risk

The plan acknowledges the risk: "if an EXPRESSION node should have DERIVES_FROM edges but they were not created (a different bug), this fix would silently swallow that bug instead of surfacing ERR_NO_LEAF_NODE."

This risk is real but acceptable given the tight condition (zero edges) and the nature of EXPRESSION nodes. Any EXPRESSION with genuinely-traceable operands (Identifier operands) WILL have DERIVES_FROM edges. The silent swallowing only occurs for EXPRESSION nodes where all operands are non-identifiers — which is exactly the case where the EXPRESSION IS terminal. The plan's risk assessment is accurate.

---

## Summary of Findings

| Root Cause | Plan Claim | Verification Result |
|---|---|---|
| RC2: OBJECT_LITERAL / ARRAY_LITERAL in leafTypes | Correct fix, LOW risk | **CONFIRMED CORRECT** |
| RC1: EXPRESSION terminality in findPathToLeaf | Correct fix, LOW-MEDIUM risk | **CONFIRMED CORRECT** |
| RC3: EXPRESSION_PRODUCING_TYPES set | Set is nearly correct but has two gaps | **GAPS FOUND** |

### RC3 specific gaps

| Gap | Type | Impact |
|---|---|---|
| `TaggedTemplateExpression` included unconditionally | Wrong — only valid for non-Identifier, non-MemberExpression tags | Common case (e.g., `html\`...\``, `css\`...\``) still produces dangling edges after fix |
| `TemplateLiteral` included unconditionally | Wrong — only valid when `expressions.length > 0` | Zero-expression template literals in ternary branches still produce dangling edges after fix |

### Required corrections for RC3

The plan's approach of a simple type set is insufficient. The generation of `consequentExpressionId` in BranchHandler must account for AST node content, not just type:

```typescript
// For TaggedTemplateExpression: only an EXPRESSION node exists for the fallback tag case
const consequentProducesExpression =
  (condNode.consequent.type === 'TaggedTemplateExpression'
    ? condNode.consequent.tag.type !== 'Identifier' && condNode.consequent.tag.type !== 'MemberExpression'
    : false) ||
  (condNode.consequent.type === 'TemplateLiteral'
    ? condNode.consequent.expressions.length > 0
    : false) ||
  new Set([
    'MemberExpression', 'OptionalMemberExpression',
    'BinaryExpression', 'LogicalExpression', 'ConditionalExpression',
    'UnaryExpression', 'OptionalCallExpression'
  ]).has(condNode.consequent.type);
```

(Same logic for alternate.)

---

## Verdict

**RC2 fix: APPROVE.**
**RC1 fix: APPROVE.**
**RC3 fix: REJECT — two gaps in EXPRESSION_PRODUCING_TYPES. The simple type-set approach is insufficient; content-based checks are required for TaggedTemplateExpression (inspect tag type) and TemplateLiteral (inspect expressions.length).**

The implementer (Rob) must revise the RC3 fix before proceeding with the `BranchHandler` changes. RC1 and RC2 can proceed as planned.
