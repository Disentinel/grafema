# REG-106: NodeFactory: Add DecoratorNode and migrate DECORATOR creation

## Task

Add `NodeFactory.createDecorator()` method and migrate all DECORATOR node creation.

## Current State

DECORATOR nodes created inline in:

* `GraphBuilder.ts:1183` - decorator nodes
* `TypeScriptVisitor.ts` - decorator collection

## Changes Required

1. Create `DecoratorNode.ts` in `packages/core/src/core/nodes/`
2. Add `NodeFactory.createDecorator()` wrapper
3. Update `GraphBuilder.bufferDecoratorNodes()`
4. Update `TypeScriptVisitor`

## Acceptance Criteria

- [ ] DecoratorNode class exists with static `create()` and `validate()`
- [ ] NodeFactory.createDecorator() exists
- [ ] No inline DECORATOR object literals
- [ ] Tests pass
