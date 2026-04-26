# User Request: REG-103

## Linear Issue

**REG-103: NodeFactory: Add InterfaceNode and migrate INTERFACE creation**

## Task

Add `NodeFactory.createInterface()` method and migrate all INTERFACE node creation.

## Current State

INTERFACE nodes created inline in:
- `GraphBuilder.ts:1075` - interface declarations
- `GraphBuilder.ts:1107` - external interface references
- `GraphBuilder.ts:1221` - interface implements references
- `TypeScriptVisitor.ts` - interface collection

## Changes Required

1. Create `InterfaceNode.ts` in `packages/core/src/core/nodes/`
2. Add `NodeFactory.createInterface()` wrapper
3. Update `GraphBuilder.bufferInterfaceNodes()`
4. Update `GraphBuilder.bufferImplementsEdges()`
5. Update `TypeScriptVisitor`

## Acceptance Criteria

- [ ] InterfaceNode class exists with static `create()` and `validate()`
- [ ] NodeFactory.createInterface() exists
- [ ] No inline INTERFACE object literals
- [ ] Tests pass
