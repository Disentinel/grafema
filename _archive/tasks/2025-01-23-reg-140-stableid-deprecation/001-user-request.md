# REG-140: Complete stableId deprecation or document dual-ID period

## Summary

`stableId` is marked as deprecated but still actively used in 10+ core files.

## Problem

FunctionVisitor.ts line 46:

```typescript
stableId?: string;  // Deprecated: id now contains semantic ID
```

But stableId is still used in:

* VersionManager.ts (core versioning/diffing logic)
* ValueDomainAnalyzer.ts (scope matching)
* ASTWorker.ts (function tracking)
* FunctionNode.ts (factory method)
* ClassVisitor.ts (method tracking)
* IncrementalAnalysisPlugin.ts (getNodesByStableId interface)

Total: **25 files** reference stableId.

## Options

### Option A: Complete Migration

* Remove stableId field entirely
* Update all consumers to use `id` field
* Breaking change - requires version bump

### Option B: Document Dual-ID Period

* Keep both `id` (semantic) and `stableId` (legacy)
* Document that stableId will be removed in version X
* Add deprecation warnings in code

## Acceptance Criteria

- [ ] Audit all 25 files for stableId usage
- [ ] Decide migration strategy (A or B)
- [ ] Implement chosen strategy
- [ ] Update documentation

## Context

From REG-127 code review.
