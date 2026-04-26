# Rob Pike - Implementation Report

## Summary

Implemented REG-150 + REG-151: `reportIssue()` API for validation plugins to persist issues as graph nodes.

## Changes Made

### 1. packages/types/src/plugins.ts

Added `IssueSpec` interface for validation plugins to report issues:

```typescript
export interface IssueSpec {
  category: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  file: string;
  line: number;
  column?: number;
  targetNodeId?: string;
  context?: Record<string, unknown>;
}
```

Extended `PluginContext` with optional `reportIssue` method:

```typescript
reportIssue?(issue: IssueSpec): Promise<string>;
```

### 2. packages/types/src/edges.ts

Added `AFFECTS` edge type to the `EDGE_TYPE` constant:

```typescript
AFFECTS: 'AFFECTS',
```

This edge connects ISSUE nodes to the affected code nodes.

### 3. packages/core/src/Orchestrator.ts

In `runPhase()`, added `reportIssue` function to context during VALIDATION phase:

- Simple inline function (no class abstraction, per Linus's review)
- Creates ISSUE node via `NodeFactory.createIssue()`
- Creates AFFECTS edge if `targetNodeId` is provided
- Returns the created issue node ID

### 4. packages/core/src/plugins/validation/SQLInjectionValidator.ts

Updated the validator to use the new API:

1. Updated `metadata.creates` to declare `['issue:security']` nodes and `['AFFECTS']` edges
2. When vulnerability detected, calls `context.reportIssue()` if available
3. Counts created issue nodes for the result
4. Maintains backward compatibility by still returning issues in metadata

## Design Decisions

1. **Inline function over class**: Following Linus's guidance - simple inline function is sufficient. No need for IssueReporter class abstraction.

2. **Backward compatibility**: SQLInjectionValidator still returns issues in metadata for any consumers that depend on that format.

3. **Optional reportIssue**: The method is optional on PluginContext, so existing plugins continue to work.

4. **AFFECTS edge direction**: Issue -> AffectedNode (issue AFFECTS the code)

## Files Modified

1. `/packages/types/src/plugins.ts` - Added IssueSpec interface, extended PluginContext
2. `/packages/types/src/edges.ts` - Added AFFECTS edge type
3. `/packages/core/src/Orchestrator.ts` - Added reportIssue to VALIDATION phase context
4. `/packages/core/src/plugins/validation/SQLInjectionValidator.ts` - Uses reportIssue API

## Testing

Run the tests with:
```bash
node --test test/unit/SQLInjectionValidator.test.js
```

The implementation follows existing patterns and maintains backward compatibility.
