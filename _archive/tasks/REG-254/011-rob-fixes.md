# Fix Report: Linus Review Issues (REG-254)

## Issues Fixed (Updated after second review)

### Additional Fixes (from second Linus review)

**Found duplicates in:**
- `impact.ts` - lines 201, 316 (fixed)
- `explore.tsx` - lines 789, 832, 867 (fixed)

**Changes Made:**
1. `impact.ts` - Added import, removed duplicate `findContainingFunction` (52 lines)
2. `explore.tsx` - Added imports, removed duplicate `findContainingFunction` (33 lines) + `findCallsInFunction` (40 lines)
3. Fixed type compatibility (CallerInfo -> NodeInfo) with explicit mapping

**Verification:**
```bash
grep -r "findContainingFunction\|findCallsInFunction" packages/cli/src --include="*.ts" --include="*.tsx"
```
All usages now import from `@grafema/core`, no local implementations remain.

---

### 1. Added README.md

**File:** `/Users/vadimr/grafema-worker-5/packages/core/src/queries/README.md`

Created documentation explaining graph structure for query utilities:
- Function containment hierarchy (FUNCTION -> HAS_SCOPE -> SCOPE -> CONTAINS/DECLARES)
- Call resolution (CALLS edges)
- Backward traversal patterns for finding containing functions

### 2. Fixed CLI findContainingFunction Duplication

**Investigation:**
- CLI version (lines 462-511 in query.ts) included DECLARES edge handling
- Core version only handled CONTAINS and HAS_SCOPE edges
- DECLARES is needed because: `SCOPE -> DECLARES -> VARIABLE` (not CONTAINS)

**Solution:**
1. Updated core's `findContainingFunction.ts` to include DECLARES edge traversal
2. Added test for VARIABLE containment via DECLARES edge
3. Removed duplicate function from CLI (56 lines removed)
4. Updated CLI to import and use `findContainingFunctionCore` from @grafema/core

**Files Modified:**
- `/Users/vadimr/grafema-worker-5/packages/core/src/queries/findContainingFunction.ts` - Added DECLARES to edge types
- `/Users/vadimr/grafema-worker-5/packages/cli/src/commands/query.ts` - Removed duplicate, using core import
- `/Users/vadimr/grafema-worker-5/test/unit/queries/findContainingFunction.test.ts` - Added DECLARES test

### 3. Build and Verification

```bash
pnpm build               # Success
node --import tsx --test test/unit/queries/*.test.ts  # 36 tests pass
```

New test added:
```
should find container for VARIABLE via DECLARES edge
```

## Summary

- Created README.md documenting graph query utilities
- Unified findContainingFunction implementation (CLI now uses core)
- Core function now correctly handles DECLARES edges for variables
- All tests pass (36/36)
