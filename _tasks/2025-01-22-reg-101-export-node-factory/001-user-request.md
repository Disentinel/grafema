# User Request: REG-101

## Linear Issue

**REG-101**: NodeFactory: Add ExportNode and migrate EXPORT creation

## Task

Add `NodeFactory.createExport()` method and migrate all EXPORT node creation.

## Current State

EXPORT nodes created inline in:

* `GraphBuilder.ts:551-610` - multiple export types (default, named, all)
* `ImportExportVisitor.ts` - multiple locations

## Changes Required

1. Verify `ExportNode.create()` exists
2. Add `NodeFactory.createExport()` wrapper if missing
3. Update `GraphBuilder.bufferExportNodes()` - 4 inline creations
4. Update `ImportExportVisitor`

## Acceptance Criteria

- [ ] ExportNode has static `create()` method with validation
- [ ] NodeFactory.createExport() exists
- [ ] No inline EXPORT object literals in codebase
- [ ] Tests pass
