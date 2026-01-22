# User Request: REG-99

**Linear Issue:** REG-99
**Title:** NodeFactory: Add ClassNode and migrate CLASS creation

## Task

Add `NodeFactory.createClass()` method and migrate all CLASS node creation.

## Current State

CLASS nodes created inline in:
- `GraphBuilder.ts:408` - class declarations
- `GraphBuilder.ts:456` - external class references

## Changes Required

1. Add `ClassNode.create()` static method in `packages/core/src/core/nodes/ClassNode.ts`
2. Add `NodeFactory.createClass()` wrapper
3. Update `GraphBuilder.bufferClassDeclarationNodes()`
4. Update `GraphBuilder.bufferClassNodes()`

## Acceptance Criteria

- [ ] ClassNode has static `create()` method with validation
- [ ] NodeFactory.createClass() exists
- [ ] No inline CLASS object literals in codebase
- [ ] Tests pass

## Context

This is part of the NodeFactory migration (REG-98 parent task). NodeFactory migration blocks MVP because inline node creation causes UI bugs.
