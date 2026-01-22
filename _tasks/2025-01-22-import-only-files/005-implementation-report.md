# Implementation Report - REG-119

## Summary

Fixed the bug where files with only imports were not being processed on re-analysis.

## Root Cause

The `_cacheCleared` flag in `JSASTAnalyzer` was a one-way gate that prevented cache clearing on subsequent `forceAnalysis=true` runs:

```typescript
// BEFORE (broken)
if (forceAnalysis && !this._cacheCleared) {
  this.analyzedModules.clear();
  this._cacheCleared = true;  // Locks permanently
}
```

After the first run, `_cacheCleared = true` caused the condition to fail on subsequent runs, so `analyzedModules` was never cleared again. Modules stayed in the cache and were skipped.

## Fix Applied

Removed the `_cacheCleared` flag entirely:

```typescript
// AFTER (fixed)
if (forceAnalysis) {
  this.analyzedModules.clear();
}
```

### Changes Made

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

1. Removed field declaration `private _cacheCleared: boolean;`
2. Removed constructor initialization `this._cacheCleared = false;`
3. Simplified execute() logic to unconditionally clear when `forceAnalysis = true`

## Test Results

```
# tests 15
# pass 14
# fail 1
```

**Target test PASSES:** `should handle file with only imports` ✓

**Unrelated test FAILS:** `should preserve net:request singleton across re-analysis`
- This is a pre-existing issue - `NetworkRequestNode.ts` is untracked (feature in development)
- Not related to this fix

## Verification

The import-only files test now correctly:
1. First analysis: creates IMPORT nodes
2. Second analysis: creates same IMPORT nodes (idempotent)
3. Counts match after both runs
