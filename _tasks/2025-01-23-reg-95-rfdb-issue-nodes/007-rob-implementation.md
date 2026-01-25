# Rob Pike's Implementation Report: REG-95 ISSUE Nodes

## Summary

Implemented the core ISSUE nodes feature as specified in Joel's technical plan (003-joel-tech-plan.md) with MVP scope from clarifications (005-clarifications.md).

## What Was Implemented

### Step 1: packages/types/src/nodes.ts
- Added `IssueSeverity` type: `'error' | 'warning' | 'info'`
- Added `IssueNodeRecord` interface with fields:
  - `type: \`issue:\${string}\``
  - `severity: IssueSeverity`
  - `category: string`
  - `message: string`
  - `plugin: string`
  - `targetNodeId?: string`
  - `createdAt: number` (only createdAt, no lastSeenAt per MVP)
  - `context?: Record<string, unknown>`
- Added `IssueNodeRecord` to `NodeRecord` union

### Step 2: packages/types/src/edges.ts
- Added `AFFECTS: 'AFFECTS'` to EDGE_TYPE
- Added `AffectsEdge` interface

### Step 3: packages/types/src/plugins.ts
- Added `IssueSpec` interface for plugin issue reporting
- Extended `PluginContext` with optional `reportIssue?(issue: IssueSpec): Promise<string>` method

### Step 4: packages/core/src/core/nodes/NodeKind.ts
- Added ISSUE_* types to NAMESPACED_TYPE:
  - `ISSUE_SECURITY: 'issue:security'`
  - `ISSUE_PERFORMANCE: 'issue:performance'`
  - `ISSUE_STYLE: 'issue:style'`
  - `ISSUE_SMELL: 'issue:smell'`
- Added `isIssueType()` helper function

### Step 5: packages/core/src/core/nodes/IssueNode.ts (NEW FILE)
Created IssueNode contract class following GuaranteeNode pattern with:
- `generateId()` - deterministic SHA256 hash-based ID generation
- `create()` - create issue node with validation
- `parseId()` - parse issue ID into category and hash
- `isIssueType()` - check if type is issue:*
- `validate()` - validate node structure
- `getCategories()` - return known categories

### Step 6: packages/core/src/core/nodes/index.ts
- Exported IssueNode and related types
- Added isIssueType to exports

### Step 7: packages/core/src/core/NodeFactory.ts
- Added `IssueOptions` interface
- Added `createIssue()` method
- Updated `validate()` to handle issue:* types dynamically

### Step 8: packages/core/src/index.ts
- Exported IssueNode, IssueNodeRecord, IssueSeverity, IssueType
- Exported isIssueType helper

## Test Results

### IssueNode.test.js
All **56 tests pass**:
- ID Generation (7 tests): deterministic, unique, proper format
- Node Creation (14 tests): required fields, defaults, validation errors
- ID Parsing (8 tests): valid parsing, invalid handling
- Type Checking (13 tests): issue types recognized, non-issue types rejected
- Validation (7 tests): valid nodes pass, invalid nodes report errors
- getCategories (5 tests): returns expected categories

### NodeFactoryIssue.test.js
All **19 tests pass**:
- Basic creation (3 tests)
- Different types (5 tests)
- ID generation (2 tests)
- Validation via NodeFactory (2 tests)
- Error handling (5 tests)
- Node properties (2 tests)

**Total: 75 tests passing**

## Key Implementation Details

1. **ID Format**: `issue:<category>#<12-char-sha256-hash>`
   - Hash computed from: `plugin|file|line|column|message`
   - Ensures deterministic IDs across analysis runs

2. **MVP Scope Applied**:
   - Only `createdAt`, no `lastSeenAt` (as per 005-clarifications.md)
   - `reportIssue` is optional on PluginContext (backward compatible)

3. **Pattern Followed**: Matched GuaranteeNode exactly for consistency

4. **Name Truncation**: Message truncated to 100 chars for `name` field; full message preserved in `message` field

## Files Changed

| Package | File | Action |
|---------|------|--------|
| types | `src/nodes.ts` | Modified: Added IssueSeverity, IssueNodeRecord |
| types | `src/edges.ts` | Modified: Added AFFECTS |
| types | `src/plugins.ts` | Modified: Added IssueSpec, extended PluginContext |
| core | `src/core/nodes/NodeKind.ts` | Modified: Added issue types, isIssueType |
| core | `src/core/nodes/IssueNode.ts` | **NEW**: Node contract class |
| core | `src/core/nodes/index.ts` | Modified: Export IssueNode, isIssueType |
| core | `src/core/NodeFactory.ts` | Modified: Added createIssue, updated validate |
| core | `src/index.ts` | Modified: Exported IssueNode and related |

## Issues Encountered

1. **Unrelated TypeScript Errors**: The core package has pre-existing compilation errors in validator files (EvalBanValidator, NodeCreationValidator, TypeScriptDeadCodeValidator) related to `ValidationSummary` type. These are unrelated to this feature and should be addressed separately.

2. **Test Execution**: Used `npx tsx` to run tests since compiled output wasn't available due to unrelated errors. All tests pass.

## Not Implemented (Per MVP Scope)

- `lastSeenAt` timestamp (deferred to Phase 2)
- `IssueReporter` utility class (orchestrator integration - not in MVP)
- SQLInjectionValidator migration (Phase 2)
- Issue lifecycle management (Phase 2)

## Next Steps

1. Fix unrelated TypeScript errors in validator files
2. Build and verify full compilation
3. Phase 2: IssueReporter utility, SQLInjectionValidator migration
