# User Request: REG-105

## Linear Issue

**REG-105**: NodeFactory: Add EnumNode and migrate ENUM creation

## Task

Add `NodeFactory.createEnum()` method and migrate all ENUM node creation.

## Current State

ENUM nodes created inline in:
- `GraphBuilder.ts:1157` - enum declarations
- `TypeScriptVisitor.ts` - enum collection

## Changes Required

1. Create `EnumNode.ts` in `packages/core/src/core/nodes/`
2. Add `NodeFactory.createEnum()` wrapper
3. Update `GraphBuilder.bufferEnumNodes()`
4. Update `TypeScriptVisitor`

## Acceptance Criteria

- [ ] EnumNode class exists with static `create()` and `validate()`
- [ ] NodeFactory.createEnum() exists
- [ ] No inline ENUM object literals
- [ ] Tests pass
