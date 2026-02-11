# Rob Implementation Report - Phase 3: Standard Rules Library

## Summary

Implemented the standard Datalog rules library loader per Kent's test specifications. All 12 tests pass.

## Implementation

### Files Changed

1. **`packages/core/src/guarantees/index.ts`** - Library loader implementation
2. **`packages/core/package.json`** - Updated build script to copy YAML files
3. **`packages/core/src/index.ts`** - Added exports (already present from prior work)

### Key Decisions

1. **Lazy loading with caching**: Rules are loaded on first access to `getStandardRule()` or `listStandardRules()`, then cached in a module-level `Map<string, StandardRule>`.

2. **ESM-compatible file resolution**: Used `import.meta.url` with `fileURLToPath` to resolve the YAML file path relative to the compiled module, matching existing patterns in `RFDBServerBackend.ts` and `ASTWorkerPool.ts`.

3. **Build script update**: Added YAML file copying to the build process since TypeScript doesn't copy non-TS assets:
   ```bash
   find src -name '*.yaml' -exec sh -c 'mkdir -p dist/$(dirname ${1#src/}) && cp $1 dist/${1#src/}' _ {} \;
   ```

4. **Fresh array return**: `listStandardRules()` returns `[...rules.keys()]` to ensure callers can't mutate the internal cache.

5. **Null safety**: Empty string or non-existent rule IDs return `null` without throwing.

## Test Results

```
# tests 12
# suites 5
# pass 12
# fail 0
```

All test groups pass:
- `getStandardRule()`: 3/3 tests
- `listStandardRules()`: 3/3 tests
- Rule content validation: 3/3 tests
- Edge cases: 3/3 tests

## Commit

```
feat(core): Add standard Datalog rules library for cardinality guarantees

Implements getStandardRule() and listStandardRules() to load reusable
Datalog rules for detecting O(N^2) patterns.

REG-314
```

## Next Steps

Phase 3 implementation complete. Ready for Linus review.
