# Kent Beck - Test Engineer Report for REG-150/REG-151

## Summary of Test Strategy

Based on the approved plan and Linus's review, tests cover:
1. **`reportIssue` function behavior** - Unit tests for inline function that creates ISSUE nodes
2. **Issue lifecycle** - Integration tests verifying issues cleared on file reanalysis
3. **SQLInjectionValidator with reportIssue** - Validator calling `reportIssue()` and backward compatibility

Key insight: No `IssueReporter` class needed. Just inline function in Orchestrator.

## Test Files

### 1. test/unit/plugins/reportIssue.test.js (NEW)
Tests for reportIssue function:
- ISSUE node creation with correct fields
- AFFECTS edge creation when targetNodeId provided
- No edge when targetNodeId absent
- Deterministic IDs (same input = same ID)
- Query support by type and file

### 2. test/integration/issue-lifecycle.test.js (NEW)
Integration tests:
- Issue nodes have `file` field
- Issues cleared when file reanalyzed
- Issues preserved for untouched files
- Issue ID stability on reanalysis
- Issue removal when code is fixed
- AFFECTS edge lifecycle

### 3. test/unit/SQLInjectionValidator.test.js (UPDATE)
Additional tests:
- Validator calls `context.reportIssue()` when available
- Backward compatibility: works without reportIssue
- Still returns issues in metadata when reportIssue used
- AFFECTS edge points to vulnerable CALL node
- Issue context includes nondeterministicSources

## Critical Files for Implementation

1. `packages/core/src/Orchestrator.ts` - Add reportIssue to pluginContext for VALIDATION phase
2. `packages/types/src/plugins.ts` - Add IssueSpec interface and reportIssue to PluginContext
3. `packages/types/src/edges.ts` - Add AFFECTS edge type
4. `packages/core/src/plugins/validation/SQLInjectionValidator.ts` - Use context.reportIssue()

## Test Code

Full test implementations provided. Tests are designed to:
- Document expected behavior clearly
- Guide implementation (TDD)
- Verify backward compatibility
- Test edge cases (null/undefined targetNodeId, etc.)
