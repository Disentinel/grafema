# REG-533: Dijkstra Plan Verification

**Verifier:** Edsger Dijkstra
**Date:** 2026-02-20
**Verdict:** REJECT (with CRITICAL gaps found)

---

## Executive Summary

Don's plan is architecturally sound but **INCOMPLETE**. The plan covers the primary expression types but has CRITICAL GAPS in:

1. **Expression type coverage** — several expression types that CAN appear in control flow are not handled
2. **Precondition verification** — assumes `extractDiscriminantExpression` can handle all types WITHOUT PROOF
3. **Edge case enumeration** — missing cases like SequenceExpression, empty operands, and this-expressions

**DECISION:** Plan must be ENHANCED before implementation to ensure COMPLETE coverage.

---

## 1. Input Universe Completeness Analysis

### 1.1 EXPRESSION Creation Sites in ControlFlowBuilder

I enumerated ALL locations where EXPRESSION nodes are created:

| Location | What Creates It | Current Metadata Available | Plan Adds DERIVES_FROM? |
|----------|----------------|---------------------------|------------------------|
| Line 156-164 | Loop test condition (for/while/do-while) | `testExpressionId`, `testExpressionType`, `testLine`, `testColumn` | ✅ YES (`bufferLoopTestDerivesFromEdges`) |
| Line 174-190 | Loop update expression (for loop) | `updateExpressionId`, `updateExpressionType`, `updateLine`, `updateColumn` | ✅ YES (`bufferLoopUpdateDerivesFromEdges`) |
| Line 262-270 | Branch discriminant (switch/if/ternary) | `discriminantExpressionId`, `discriminantExpressionType`, `discriminantLine`, `discriminantColumn` | ✅ YES (`bufferBranchDiscriminantDerivesFromEdges`) |

**FINDING:** All 3 creation sites are covered by Don's plan. ✅

---

### 1.2 Expression Types Handled by AssignmentBuilder

I examined AssignmentBuilder (lines 189-373) to understand the PROVEN pattern for DERIVES_FROM:

| Expression Type | AssignmentBuilder Handles? | Pattern Used | Operands Extracted |
|----------------|---------------------------|--------------|-------------------|
| MemberExpression | ✅ YES | Lines 246-256 | `objectSourceName` |
| BinaryExpression | ✅ YES | Lines 303-328 | `leftSourceName`, `rightSourceName` |
| LogicalExpression | ✅ YES | Lines 303-328 | `leftSourceName`, `rightSourceName` |
| ConditionalExpression | ✅ YES | Lines 330-355 | `consequentSourceName`, `alternateSourceName` |
| TemplateLiteral | ✅ YES | Lines 357-373 | `expressionSourceNames[]` |
| UpdateExpression | ❌ NO | — | — |
| UnaryExpression | ❌ NO | — | — |
| Identifier | ❌ NO (implicit) | — | — |
| SequenceExpression | ❌ NO | — | — |

**CRITICAL FINDING:** AssignmentBuilder does NOT handle UpdateExpression, UnaryExpression, or SequenceExpression because these don't appear in ASSIGNMENT contexts. BUT they DO appear in CONTROL FLOW contexts!

---

## 2. Expression Type Completeness Table

For EACH expression type Don listed, I verified where it can appear:

| Expression Type | Can appear in loop test? | Can appear in loop update? | Can appear in switch/if discriminant? | Operands to extract | Don's Plan Handles? |
|-----------------|-------------------------|---------------------------|-------------------------------------|-------------------|-------------------|
| BinaryExpression | ✅ YES (`while (i < 10)`) | ❌ NO | ✅ YES (`if (x > y)`) | left, right | ✅ YES |
| LogicalExpression | ✅ YES (`while (a && b)`) | ❌ NO | ✅ YES (`if (x \|\| y)`) | left, right | ✅ YES |
| MemberExpression | ✅ YES (`while (arr.length)`) | ❌ NO | ✅ YES (`switch(obj.type)`) | object | ✅ YES |
| ConditionalExpression | ✅ YES (`while (x ? a : b)`) | ❌ RARE | ✅ YES (`switch(x ? 1 : 2)`) | consequent, alternate | ✅ YES |
| Identifier | ✅ YES (`while (flag)`) | ❌ NO | ✅ YES (`switch(x)`) | self | ✅ YES |
| UpdateExpression | ❌ NO | ✅ **YES** (`for (;; i++)`) | ❌ NO | argument | ⚠️ **MENTIONED BUT NOT DETAILED** |
| UnaryExpression | ✅ YES (`while (!flag)`) | ❌ NO | ✅ YES (`if (-x)`) | argument | ❌ **NOT IN PLAN** |
| TemplateLiteral | ❌ RARE | ❌ NO | ⚠️ POSSIBLE (`switch(\`\${x}\`)`) | expressionSourceNames | ❌ **NOT IN PLAN** |
| ThisExpression | ✅ YES (`while (this.running)`) | ❌ NO | ✅ YES (`switch(this.state)`) | — | ❌ **NOT IN PLAN** |
| SequenceExpression | ❌ NO | ✅ **YES** (`for (;; i++, j--)`) | ❌ NO | expressions[] | ❌ **NOT IN PLAN** |
| CallExpression | ✅ YES | ❌ NO | ✅ YES | — | ✅ YES (links to CALL_SITE) |

**CRITICAL GAPS:**
1. **UnaryExpression** (`!flag`, `-x`) — common in conditions, NOT handled
2. **SequenceExpression** (`i++, j--`) — can appear in for-update, NOT handled
3. **ThisExpression** (`this.running`) — valid in conditions, NOT handled
4. **TemplateLiteral** — rare but possible, NOT handled
5. **UpdateExpression** — MENTIONED in plan but implementation details INCOMPLETE

---

## 3. EXPRESSION Creation Sites Table (Expanded)

Verifying ALL methods that create EXPRESSION nodes:

| Method | Creates EXPRESSION for | Metadata Available | DERIVES_FROM Planned? |
|--------|----------------------|-------------------|---------------------|
| `bufferLoopEdges` (lines 156-164) | Loop test (for/while/do-while) | `testExpressionId`, `testExpressionType`, `testLine`, `testColumn` | ✅ YES |
| `bufferLoopEdges` (lines 174-190) | Loop update (for) | `updateExpressionId`, `updateExpressionType`, `updateLine`, `updateColumn` | ✅ YES |
| `bufferLoopConditionExpressions` (lines 247-273) | Loop condition (non-CallExpression) | `conditionExpressionId`, `conditionExpressionType`, `conditionLine`, `conditionColumn` | ❓ UNCLEAR (overlaps with test?) |
| `bufferDiscriminantExpressions` (lines 447-469) | Branch discriminant (switch/if) | `discriminantExpressionId`, `discriminantExpressionType`, `discriminantLine`, `discriminantColumn` | ✅ YES |

**CONFUSION FOUND:**
- `bufferLoopConditionExpressions` creates EXPRESSION nodes for loop conditions
- `bufferLoopEdges` ALSO creates EXPRESSION nodes for test expressions (lines 156-164)
- Are these the SAME expressions or DIFFERENT? The plan assumes they're the same but doesn't verify!

**VERIFICATION REQUIRED:** Read code to confirm `conditionExpressionId` === `testExpressionId` for loops.

From LoopHandler.ts lines 138-164:
```typescript
// Line 147-163: Extract conditionExpressionId
const condResult = analyzer.extractDiscriminantExpression(testNode, ctx.module);
conditionExpressionId = condResult.id;

// Line 98-104: Extract testExpressionId
testExpressionType = forNode.test.type;
testExpressionId = ExpressionNode.generateId(forNode.test.type, ...);
```

**FINDING:** `testExpressionId` and `conditionExpressionId` are DIFFERENT IDs for the SAME test expression! This is a BUG in LoopHandler, not ControlFlowBuilder.

**PRECONDITION FAILURE:** The plan assumes clean metadata, but LoopHandler creates DUPLICATE IDs for the same expression. This must be fixed FIRST.

---

## 4. Edge Cases by Construction

| Scenario | Example | Current Behavior | Plan Handles? | Gap? |
|----------|---------|-----------------|--------------|------|
| Empty operands | `for (;;)` | No test expression, skip EXPRESSION creation | ✅ YES (line 212-213 in ControlFlowBuilder) | ✅ SAFE |
| Literal operands | `while (true)`, `if (10 > x)` | Creates EXPRESSION but no variable to link | ✅ Plan handles (findSource returns null, no edge) | ✅ SAFE |
| Nested expressions | `while (a.b.c > 0)` | MemberExpression with nested object | ✅ Plan extracts base object only | ✅ SAFE |
| Call in condition | `while (getNext() !== null)` | Links to CALL_SITE, not EXPRESSION | ✅ Already handled (line 221-230) | ✅ SAFE |
| This-expression | `while (this.running)` | Creates EXPRESSION node, no DERIVES_FROM | ❌ NOT IN PLAN | ⚠️ **GAP** |
| Computed member | `switch(actions[key])` | MemberExpression with computed=true | ⚠️ Plan mentions but doesn't detail | ⚠️ **UNCLEAR** |
| Assignment in condition | `while (node = node.next)` | AssignmentExpression in test | ❌ NOT IN PLAN | ⚠️ **GAP** |
| Multiple expressions in for-update | `for (;; i++, j--)` | SequenceExpression | ❌ NOT IN PLAN | ❌ **CRITICAL GAP** |
| Unary in condition | `if (!flag)` | UnaryExpression | ❌ NOT IN PLAN | ❌ **CRITICAL GAP** |

**CRITICAL GAPS FOUND:**
1. **UnaryExpression** — very common (`!flag`, `!this.done`)
2. **SequenceExpression** — valid in for-update (`i++, j--`)
3. **AssignmentExpression** — can appear in conditions (`while (node = node.next)`)
4. **ThisExpression** — no variable to link to, but should be documented as skip case

---

## 5. Preconditions Analysis

### Precondition 1: `extractDiscriminantExpression` handles all expression types

**CURRENT IMPLEMENTATION (lines 2334-2376 in JSASTAnalyzer.ts):**
```typescript
private extractDiscriminantExpression(discriminant: t.Expression, module: VisitorModule) {
  if (t.isIdentifier(discriminant)) { ... }
  else if (t.isMemberExpression(discriminant)) { ... }
  else if (t.isCallExpression(discriminant)) { ... }
  // Default: create generic EXPRESSION
  return {
    id: ExpressionNode.generateId(discriminant.type, ...),
    expressionType: discriminant.type,
    ...
  };
}
```

**FINDING:** `extractDiscriminantExpression` has a CATCH-ALL fallback that returns `discriminant.type`. This means it CAN handle any expression type, but only returns ID/type/line/column — NO operand metadata.

**PRECONDITION STATUS:** ✅ Can handle all types structurally, but ❌ does NOT extract operands for most types.

**CONSEQUENCE:** Don's plan MUST enhance this method to extract operands for ALL expression types, not just the ones explicitly mentioned.

### Precondition 2: Variable/parameter lookup is scope-correct

**CURRENT PATTERN (AssignmentBuilder lines 147-173):**
```typescript
const currentVar = variableDeclarations.find(v => v.id === variableId);
const varFile = currentVar?.file ?? null;
const sourceVariable = variableDeclarations.find(v =>
  v.name === sourceName && v.file === varFile
);
```

**FINDING:** Lookup is file-scoped only, NOT lexically scoped. This works for assignments because AssignmentBuilder has access to the target variable's file. But for control flow expressions:

**QUESTION:** How does ControlFlowBuilder determine which file to search in for operand variables?

**ANSWER (from Don's plan, lines 213-236):**
```typescript
const file = loop.file;  // Use loop's file
const findSource = (name: string): string | null => {
  const variable = variableDeclarations.find(v =>
    v.name === name && v.file === file
  );
  ...
}
```

**PRECONDITION STATUS:** ✅ SAFE — uses expression's file for lookup, same pattern as AssignmentBuilder.

### Precondition 3: All operand variables are in variableDeclarations or parameters

**EDGE CASE:** What if an operand is:
- A global (not declared in this file)
- A module import (not a local variable)
- A property access (`this.x` where `this` is not a variable)
- A literal (`10`, `"string"`)

**CURRENT BEHAVIOR:** `findSource` returns `null`, no edge is created.

**PRECONDITION STATUS:** ✅ SAFE — graceful degradation (no edge if not found).

---

## 6. Implementation Completeness Gaps

### Gap 1: UpdateExpression operand extraction

Don's plan mentions UpdateExpression (line 330-332) but doesn't show the implementation:

**REQUIRED:**
```typescript
// In extractDiscriminantExpression for UpdateExpression
if (t.isUpdateExpression(discriminant)) {
  const argumentName = t.isIdentifier(discriminant.argument)
    ? discriminant.argument.name
    : undefined;
  return {
    id: ExpressionNode.generateId('UpdateExpression', ...),
    expressionType: 'UpdateExpression',
    updateArgumentName: argumentName,  // NEW FIELD
    operator: discriminant.operator,
    ...
  };
}
```

**STATUS:** ❌ NOT SPECIFIED in plan

### Gap 2: UnaryExpression operand extraction

UnaryExpression (`!flag`, `-x`, `~bitmask`) is COMMON in conditions but NOT in plan.

**REQUIRED:**
```typescript
// In extractDiscriminantExpression for UnaryExpression
if (t.isUnaryExpression(discriminant)) {
  const argumentName = t.isIdentifier(discriminant.argument)
    ? discriminant.argument.name
    : undefined;
  return {
    id: ExpressionNode.generateId('UnaryExpression', ...),
    expressionType: 'UnaryExpression',
    unaryArgumentName: argumentName,  // NEW FIELD
    operator: discriminant.operator,
    ...
  };
}
```

**STATUS:** ❌ MISSING from plan

### Gap 3: SequenceExpression in for-update

`for (let i = 0, j = 10; i < j; i++, j--)` — the update is a SequenceExpression containing two UpdateExpressions.

**CURRENT BEHAVIOR (LoopHandler lines 107-112):**
```typescript
if (forNode.update) {
  updateExpressionType = forNode.update.type;  // "SequenceExpression"
  updateExpressionId = ExpressionNode.generateId(forNode.update.type, ...);
}
```

**PROBLEM:** Plan creates EXPRESSION node for SequenceExpression but doesn't extract sub-expressions.

**REQUIRED:** Either:
1. Create MULTIPLE EXPRESSION nodes (one per sub-expression in sequence)
2. OR create DERIVES_FROM edges from SequenceExpression to each sub-expression's operands

**STATUS:** ❌ MISSING from plan

### Gap 4: ThisExpression

`while (this.running)` creates a MemberExpression with `this` as object, but `this` is not a variable.

**QUESTION:** Should we:
1. Skip DERIVES_FROM for ThisExpression (no variable to link to)
2. Create DERIVES_FROM to the containing FUNCTION node
3. Ignore (documented as out-of-scope)

**STATUS:** ❌ NOT ADDRESSED in plan

### Gap 5: AssignmentExpression in condition

`while ((node = node.next) !== null)` — condition contains an AssignmentExpression.

**CURRENT BEHAVIOR:** `extractDiscriminantExpression` will return `BinaryExpression` for the `!==` check, but the left operand is itself an AssignmentExpression.

**QUESTION:** Should we handle nested AssignmentExpression operands?

**STATUS:** ❌ NOT ADDRESSED in plan

---

## 7. Architectural Verification

### Does the plan reuse proven patterns?

✅ **YES** — The `bufferLoopTestDerivesFromEdges` pattern (lines 213-287 in plan) is IDENTICAL to AssignmentBuilder's pattern (lines 242-373).

### Does the plan maintain architectural consistency?

✅ **YES** — Control flow EXPRESSION nodes will have the same DERIVES_FROM coverage as assignment EXPRESSION nodes.

### Does the plan scale correctly?

⚠️ **PARTIALLY** — Adding new expression types requires:
1. Enhancing `extractDiscriminantExpression` (manual)
2. Adding fields to LoopInfo/BranchInfo (manual)
3. Adding DERIVES_FROM logic in ControlFlowBuilder (manual)

**IMPROVEMENT SUGGESTION:** Consider a visitor pattern for operand extraction to reduce duplication.

---

## 8. Missing Test Cases

Don's plan mentions test strategy (lines 418-433) but MISSING:

1. **UnaryExpression test:** `if (!flag) { ... }`
2. **SequenceExpression test:** `for (let i = 0; i < 10; i++, j--) { ... }`
3. **ThisExpression test:** `while (this.running) { ... }`
4. **Nested MemberExpression test:** `while (obj.nested.prop) { ... }`
5. **Computed MemberExpression test:** `switch(actions[key]) { ... }`
6. **AssignmentExpression in condition test:** `while ((node = node.next)) { ... }`

---

## 9. Final Verdict: REJECT

### CRITICAL GAPS

1. **UnaryExpression** — NOT handled, COMMON in conditions
2. **SequenceExpression** — NOT handled, valid in for-update
3. **UpdateExpression** — mentioned but implementation INCOMPLETE
4. **ThisExpression** — NOT addressed (may be acceptable as skip case, but needs documentation)
5. **AssignmentExpression in condition** — NOT addressed

### REQUIRED ENHANCEMENTS

Before implementation, the plan MUST:

1. **Add UnaryExpression handling:**
   - Enhance `extractDiscriminantExpression` to extract `unaryArgumentName`
   - Add `unaryArgumentName` to BranchInfo/LoopInfo
   - Add DERIVES_FROM logic in ControlFlowBuilder

2. **Add SequenceExpression handling:**
   - Decide: create multiple EXPRESSION nodes OR extract all sub-expression operands
   - Document the decision in the plan

3. **Complete UpdateExpression specification:**
   - Show exact code for operand extraction in `extractDiscriminantExpression`
   - Show DERIVES_FROM edge creation logic

4. **Document ThisExpression behavior:**
   - Explicitly state: "ThisExpression creates EXPRESSION node but no DERIVES_FROM (no variable to link)"

5. **Add AssignmentExpression edge case:**
   - Document expected behavior (likely: extract assigned variable as operand)

6. **Add missing test cases:**
   - One test per gap identified above

### PRECONDITION ISSUE

LoopHandler creates DUPLICATE IDs for test expressions:
- `testExpressionId` (lines 98-104)
- `conditionExpressionId` (lines 147-163)

This must be FIXED before implementing Don's plan to avoid creating duplicate EXPRESSION nodes.

---

## 10. Recommended Next Steps

1. **Don:** Revise plan to address all CRITICAL GAPS
2. **Don:** Fix LoopHandler duplicate ID issue
3. **Dijkstra:** Re-verify revised plan
4. **Uncle Bob:** Review for code quality (after Dijkstra approval)
5. **Kent:** Implement with tests (after Uncle Bob approval)

---

**SIGNATURE:** Edsger W. Dijkstra
**PRINCIPLE APPLIED:** "Testing shows the presence, not the absence of bugs." — I have enumerated the input universe and found gaps. The plan is INCOMPLETE.
