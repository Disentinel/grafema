# Re-Approval: Incomplete Fix in REG-254

## Status: REJECT - Incomplete Fix

The fix addressed duplication in `query.ts` but **left another duplicate in `impact.ts`**.

## Issues Found

### 1. Duplicate in impact.ts NOT Fixed

**Location:** `/Users/vadimr/grafema-worker-5/packages/cli/src/commands/impact.ts` lines 316-362

**Problem:**
- `impact.ts` contains its own `findContainingFunction` implementation
- This is the SAME function Rob was supposed to remove from ALL CLI commands
- Both query.ts and impact.ts now call the containing function, but impact.ts still has duplicate code

**Evidence:**
```bash
$ grep -r "findContainingFunction" /Users/vadimr/grafema-worker-5/packages/cli/src --include="*.ts"
/packages/cli/src/commands/impact.ts:        const container = await findContainingFunction(backend, callNode.id);
/packages/cli/src/commands/impact.ts:async function findContainingFunction(  <-- DUPLICATE
```

### 2. What Rob Did (incomplete)

✅ Fixed query.ts - imports from @grafema/core
✅ Added README.md documentation
✅ Added DECLARES edge handling to core function
✅ Added test for DECLARES edge
❌ **MISSED:** impact.ts still has duplicate implementation

### 3. Original Goal (REG-254)

From Linus review: "CLI uses core's `findContainingFunction` (no duplicate implementation)"

This is NOT satisfied. We have:
- ✅ query.ts - uses core
- ❌ impact.ts - still duplicate

## Approval Checklist

- [x] README.md added to `packages/core/src/queries/`
- [ ] **CLI uses core's `findContainingFunction` (no duplicate implementation)** ← FAILED
  - query.ts: ✅ fixed
  - impact.ts: ❌ still has duplicate at line 316
- [x] DECLARES edge handling in core + test
- [ ] Tests verify NO duplication across CLI

## Decision

**REJECTED** - Rob fixed query.ts but left impact.ts untouched. This is a scope creep issue:
- Rob didn't search for OTHER uses of the same function
- Just fixed the one in front of him (query.ts)
- Left impact.ts with identical duplicate code

## Next Steps

1. Rob must search ALL CLI commands for findContainingFunction duplication
2. Update impact.ts to import from @grafema/core
3. Remove the duplicate implementation at line 316
4. Re-run tests to confirm all paths work

This is a **thoroughness issue**, not a correctness issue. The code Rob wrote is correct - he just didn't complete the scope.

---

**Signed:** Linus Torvalds (Code Review)
**Date:** 2026-02-01
