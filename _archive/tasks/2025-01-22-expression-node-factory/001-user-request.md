# User Request: REG-107

## Task

NodeFactory: Add ExpressionNode and migrate EXPRESSION creation

## Issue Details

- **ID**: REG-107
- **URL**: https://linear.app/reginaflow/issue/REG-107/nodefactory-add-expressionnode-and-migrate-expression-creation
- **Status**: Backlog
- **Labels**: Improvement

## Description

Add `NodeFactory.createExpression()` method and migrate all EXPRESSION node creation.

### Current State

EXPRESSION nodes created inline in:
- `GraphBuilder.ts:846` - data flow expressions (MemberExpression, BinaryExpression, etc.)

### Changes Required

1. Create `ExpressionNode.ts` in `packages/core/src/core/nodes/`
2. Add `NodeFactory.createExpression()` wrapper
3. Update `GraphBuilder.bufferAssignmentEdges()`

### Acceptance Criteria

- [ ] ExpressionNode class exists with static `create()` and `validate()`
- [ ] NodeFactory.createExpression() exists
- [ ] No inline EXPRESSION object literals
- [ ] Tests pass
