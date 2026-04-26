# REG-110: Migrate OBJECT_LITERAL and ARRAY_LITERAL to NodeFactory

## Task

Use existing `NodeFactory.createObjectLiteral()` and `NodeFactory.createArrayLiteral()` methods.

## Current State

OBJECT_LITERAL and ARRAY_LITERAL nodes created inline in:

* `GraphBuilder.ts:1247` - object literal nodes
* `GraphBuilder.ts:1316` - array literal nodes

## Changes Required

1. Update `GraphBuilder.bufferObjectLiteralNodes()` to use `NodeFactory.createObjectLiteral()`
2. Update `GraphBuilder.bufferArrayLiteralNodes()` to use `NodeFactory.createArrayLiteral()`

Note: Factory methods already exist for these types.

## Acceptance Criteria

- [ ] GraphBuilder uses NodeFactory.createObjectLiteral()
- [ ] GraphBuilder uses NodeFactory.createArrayLiteral()
- [ ] No inline object/array literal objects
- [ ] Tests pass
