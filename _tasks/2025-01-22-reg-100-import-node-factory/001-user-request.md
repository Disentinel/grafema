# User Request: REG-100

## Linear Issue

**REG-100: NodeFactory: Add ImportNode and migrate IMPORT creation**

## Task

Add `NodeFactory.createImport()` method and migrate all IMPORT node creation.

## Current State

IMPORT nodes created inline in:

* `GraphBuilder.ts:503` - import nodes
* `ImportExportVisitor.ts` - multiple locations

## Changes Required

1. Verify `ImportNode.create()` exists (check `packages/core/src/core/nodes/ImportNode.ts`)
2. Add `NodeFactory.createImport()` wrapper if missing
3. Update `GraphBuilder.bufferImportNodes()`
4. Update `ImportExportVisitor`

## Acceptance Criteria

- [ ] ImportNode has static `create()` method with validation
- [ ] NodeFactory.createImport() exists
- [ ] No inline IMPORT object literals in codebase
- [ ] Tests pass
