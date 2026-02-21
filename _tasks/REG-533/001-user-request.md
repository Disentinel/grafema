# REG-533: EXPRESSION nodes missing DERIVES_FROM edges to operands

## Source
Linear issue REG-533 (https://linear.app/reginaflow/issue/REG-533)

## Problem
~2640 ERR_NO_LEAF_NODE warnings caused by EXPRESSION nodes having no outgoing DERIVES_FROM edges. Data flow tracing stops at the EXPRESSION node.

Pattern: `VARIABLE:x → ASSIGNED_FROM → EXPRESSION:<BinaryExpression> → (dead end)`

## Examples
- `const totalPhases = this.phases.length` — EXPRESSION has no outgoing edges
- `const name = x ? y : z` — ternary EXPRESSION has no DERIVES_FROM to branches
- `const phaseNum = idx + 1` — BinaryExpression has no DERIVES_FROM to operands

## Breakdown
- EXPRESSION → dead end: 1913 cases
- EXPRESSION → VARIABLE/CONSTANT (then breaks): 726 cases
- EXPRESSION → CALL (then breaks): 130 cases

## Expected
EXPRESSION node should have outgoing DERIVES_FROM edges to each operand:
- BinaryExpression: left + right operands
- ConditionalExpression: test, consequent, alternate
- MemberExpression: object
- TemplateLiteral: each expression

## Where to Fix
`ExpressionHandler` / `AssignmentBuilder` — create DERIVES_FROM edges when building EXPRESSION nodes.

## Config
Mini-MLA (Don → Dijkstra → Uncle Bob → Kent ∥ Rob → 4-Review → Vadim)
