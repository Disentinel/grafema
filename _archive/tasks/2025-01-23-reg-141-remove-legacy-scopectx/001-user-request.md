# User Request: REG-141

Remove legacy scopeCtx parameter from analyzeFunctionBody.

## From Linear Issue

### Summary
Remove dual scope tracking - consolidate to ScopeTracker only.

### Problem
`analyzeFunctionBody` has two parallel scope tracking mechanisms:
- `scopeCtx` is used for `generateSemanticId()` calls (legacy)
- `scopeTracker` (from collections) is used for semantic ID generation (new)

This creates confusion and maintenance burden.

### Solution
1. Remove `scopeCtx` parameter from `analyzeFunctionBody`
2. Remove `generateSemanticId()` method if no longer needed
3. Use only `scopeTracker` from collections for all scope operations

### Acceptance Criteria
- [ ] Remove scopeCtx parameter
- [ ] Update all callers of analyzeFunctionBody
- [ ] All existing tests pass
- [ ] No behavior change
