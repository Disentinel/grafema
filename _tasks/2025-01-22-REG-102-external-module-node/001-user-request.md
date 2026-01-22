# User Request: REG-102

## Linear Issue

**REG-102**: NodeFactory: Add ExternalModuleNode and migrate EXTERNAL_MODULE creation

## Task

Add `NodeFactory.createExternalModule()` method and migrate EXTERNAL_MODULE creation.

## Current State

EXTERNAL_MODULE nodes created inline in:
- `GraphBuilder.ts:526` - for non-relative imports

## Changes Required

1. Create `ExternalModuleNode.ts` in `packages/core/src/core/nodes/`
2. Add `NodeFactory.createExternalModule()` wrapper
3. Update `GraphBuilder.bufferImportNodes()`

## Acceptance Criteria

- [ ] ExternalModuleNode class exists with static `create()` and `validate()`
- [ ] NodeFactory.createExternalModule() exists
- [ ] No inline EXTERNAL_MODULE object literals
- [ ] Tests pass
