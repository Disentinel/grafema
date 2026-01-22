# Joel Spolsky - Detailed Implementation Plan for REG-130

## 1. EXECUTIVE SUMMARY

**Root Cause:** `JSModuleIndexer.ts` line 77 instantiates `Walker` without parser plugin configuration, unlike all other parsers in the codebase.

**Fix Complexity:** Minimal - single line change matching established patterns.

## 2. THE BUG

**File:** `packages/core/src/plugins/indexing/JSModuleIndexer.ts`

**Current Code (Line 77):**
```typescript
this.walker = new Walker();
```

**Problem:** No TypeScript plugin configured.

## 3. THE FIX

**Line 77 - AFTER:**
```typescript
this.walker = new Walker({
  plugins: ['jsx', 'typescript']
});
```

## 4. STEP-BY-STEP IMPLEMENTATION

### Step 1: Update JSModuleIndexer Constructor
- Modify line 77 in `packages/core/src/plugins/indexing/JSModuleIndexer.ts`
- Change from `new Walker()` to `new Walker({ plugins: ['jsx', 'typescript'] })`

### Step 2: Rebuild TypeScript
- Run `npm run build`

### Step 3: Test the Fix
- Run: `node --test test/unit/EnumNodeMigration.test.js`
- Both failing tests should now pass

## 5. VERIFICATION CHECKLIST

- [ ] JSModuleIndexer.ts line 77 is modified
- [ ] Build succeeds: `npm run build`
- [ ] Test: `node --test test/unit/EnumNodeMigration.test.js` passes
- [ ] Full test suite passes: `npm test`

## 6. RISKS

**Low Risk:** Adding missing plugin configuration can only ADD functionality, not break existing functionality. Full test suite provides coverage.
