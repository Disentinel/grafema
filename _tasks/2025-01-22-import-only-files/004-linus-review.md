# Linus Review - REG-119: Import-Only Files Cache Bug

## Verdict: APPROVED

## Analysis

### The Bug
The `_cacheCleared` flag in JSASTAnalyzer is a one-way gate that prevents re-analysis on subsequent `forceAnalysis=true` calls.

**Current behavior (broken):**
```typescript
if (forceAnalysis && !this._cacheCleared) {
  this.analyzedModules.clear();
  this._cacheCleared = true;  // ← THIS LOCKS IT FOREVER
}
```

First run: clears cache, sets flag to true
Second run: condition fails, cache not cleared, modules skipped

**Impact:** Import-only files get zero nodes on re-analysis because they're already in `analyzedModules`.

### The Fix
Remove the flag entirely:
```typescript
if (forceAnalysis) {
  this.analyzedModules.clear();
}
```

### Why This Is Correct
1. **Semantically sound**: `forceAnalysis=true` means "ignore all caches." The old code violated this contract.
2. **No side effects**: The flag was an over-optimization. Clearing every time is the correct behavior.
3. **Makes idempotent**: Running analysis twice with `forceAnalysis=true` now produces identical results.
4. **No edge cases**: There's no legitimate reason to skip clearing because we already cleared once.

### Root Cause
Incomplete understanding of the `forceAnalysis` contract. Someone assumed "we only need to clear once per session" without considering:
- Multiple analysis runs in the same session
- The purpose of `forceAnalysis` (clear everything, rebuild from scratch)

### What Could Go Wrong
Nothing. This is the correct fix, not a workaround. All existing tests should pass, and the failing test should now pass.

## Approved
Remove `_cacheCleared` field, constructor initialization, and the condition. Just clear when `forceAnalysis=true`.
