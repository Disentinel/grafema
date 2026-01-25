# Don Melton - Technical Analysis

## Current State Analysis

### What REG-95 Actually Delivered

REG-95 (ISSUE nodes MVP) was PARTIALLY completed:

**Implemented:**
1. `packages/core/src/core/nodes/IssueNode.ts` - Contract class with:
   - `generateId()` - Deterministic SHA256 hash-based ID
   - `create()` - Node factory with validation
   - `parseId()`, `isIssueType()`, `validate()`, `getCategories()`
2. `packages/core/src/core/NodeFactory.ts` - `createIssue()` method
3. `IssueNodeRecord` interface in IssueNode.ts

**NOT Implemented:**
1. Types not exported from `packages/types`
2. `AFFECTS` edge type not in edges.ts
3. `reportIssue()` not on PluginContext
4. Orchestrator does NOT provide `reportIssue()` to plugins

### How MODULE Node Lifecycle Works

From `FileNodeManager.ts`:
1. On reanalysis, `clearFileNodesIfNeeded()` clears ALL nodes for that file
2. No exclusions - every node with that file field is deleted
3. This is the pattern we should follow for issues

## Architectural Decision: Issue Lifecycle (REG-150)

### Recommendation: Option 1 - Orchestrator Auto-Clearing

**Reasoning:**
1. Matches MODULE/FUNCTION/CLASS lifecycle pattern
2. Issues have `file` field - they'll be cleared automatically
3. Simpler plugin contract - plugins just create issues
4. Hash-based IDs make it safe (same issue = same ID = upsert)

The current `clearFileNodesIfNeeded()` ALREADY clears issue nodes because they have a `file` field. **No code change needed for clearing behavior!**

## High-Level Plan

1. Complete REG-95 type definitions (types package)
2. Implement `reportIssue()` inline in Orchestrator (REG-150)
3. Write lifecycle verification tests (REG-150)
4. Migrate SQLInjectionValidator (REG-151)

## Implementation Order

**REG-150 FIRST, then REG-151**

1. REG-150 establishes the infrastructure (`reportIssue()`, lifecycle rules)
2. REG-151 is the first consumer of that infrastructure

## Risks and Considerations

1. VALIDATION phase runs AFTER clearing - this is correct
2. Cross-file issues: edge dst might become invalid if target node deleted
3. Hash stability: code movement changes ID (probably correct behavior)
