# User Request: REG-104

## Linear Issue

**REG-104: NodeFactory: Add TypeNode and migrate TYPE creation**

## Task

Add `NodeFactory.createType()` method and migrate all TYPE alias node creation.

## Current State

TYPE nodes created inline in:

* `GraphBuilder.ts:1132` - type alias declarations
* `TypeScriptVisitor.ts` - type alias collection

## Changes Required

1. Create `TypeNode.ts` in `packages/core/src/core/nodes/`
2. Add `NodeFactory.createType()` wrapper
3. Update `GraphBuilder.bufferTypeAliasNodes()`
4. Update `TypeScriptVisitor`

## Acceptance Criteria

- [ ] TypeNode class exists with static `create()` and `validate()`
- [ ] NodeFactory.createType() exists
- [ ] No inline TYPE object literals
- [ ] Tests pass
