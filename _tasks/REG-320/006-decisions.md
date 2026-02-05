# REG-320 Design Decisions

## Responses to Vadim's Review

### Critical Issue #3: IncrementalModuleIndexer Directory Return

**Question:** Is returning directory paths intentional?

**Answer:** NO - it's a bug. If `tryResolve` returns a directory path, the downstream code (`calculateFileHash`, `parseImports`) would fail because they use `readFileSync` which errors on directories. The current behavior simply hasn't been hit in practice because most directories have index files.

**Decision:** The refactoring fixes this bug by returning `null` instead of directory paths. This is a bug fix, not a behavioral change.

### Critical Issue #13: Missing Validation

**Decision:** Add validation that throws if `useFilesystem: false` but no `fileIndex` provided. Fail fast is better than silent wrong results.

### Issue #1: Double FS Check

**Decision:** Include `''` (empty string) in DEFAULT_EXTENSIONS. Callers should NOT pre-check - let utility handle it. Update JSModuleIndexer wrapper to not include the redundant pre-check.

### Issue #9: Naming

**Decision:** Keep `resolveModulePath` as the utility name. It's what developers expect for module resolution. The callers can keep their private method names (they're implementation details).

### Issue #10: Type Safety

**Decision:** Use JSDoc documentation for now. Discriminated union adds complexity for marginal benefit in this internal utility.

### Issue #11 & #12: Missing Extensions

**Decision:** Add `.cjs` to direct extensions and `index.jsx`, `index.cjs` to index files for completeness. Small cost, prevents future bugs.

## Final Extension Lists

```typescript
const DEFAULT_EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'];
const DEFAULT_INDEX_FILES = ['index.js', 'index.ts', 'index.mjs', 'index.cjs', 'index.jsx', 'index.tsx'];
```

## Implementation Order

1. Write tests FIRST (TDD - tests fail initially)
2. Create utility (implement until tests pass)
3. Update MountPointResolver (safest, good test coverage)
4. Update JSModuleIndexer (handle fallback)
5. Update FunctionCallResolver (in-memory mode)
6. Update IncrementalModuleIndexer (fixes extension bug)
7. Run full test suite

## Approved by

- Steve Jobs: ✅ APPROVED
- Vadim Reshetnikov: ✅ APPROVED (with fixes above)
