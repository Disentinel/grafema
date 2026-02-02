# REG-185: Rob Pike Implementation Report - Include/Exclude Pattern Filtering

## Summary

Implemented glob-based file filtering for the JSModuleIndexer. All 24 new tests pass, plus existing tests remain green.

## Files Modified

### 1. `packages/types/src/plugins.ts`

Added `include` and `exclude` fields to `OrchestratorConfig` interface:

```typescript
include?: string[];   // Glob patterns to include (whitelist)
exclude?: string[];   // Glob patterns to exclude (blacklist)
```

**Note**: Original JSDoc had `{js,jsx}` in examples which caused TypeScript parser errors due to brace parsing. Changed to simpler examples.

### 2. `packages/core/src/config/ConfigLoader.ts`

Changes:
- Added `include` and `exclude` fields to `GrafemaConfig` interface
- Added `validatePatterns()` function for validation:
  - Throws on non-array values
  - Throws on non-string array elements
  - Throws on empty/whitespace-only strings
  - Warns (doesn't throw) on empty include array
- Added validation call after `validateServices()` in both YAML and JSON paths
- Updated `mergeConfig()` to pass through patterns (with `null ?? undefined` conversion)

### 3. `packages/core/src/plugins/indexing/JSModuleIndexer.ts`

Changes:
- Added `minimatch` import
- Added private fields: `includePatterns`, `excludePatterns`, `projectPath`
- Added `shouldSkipFile()` method:
  - Normalizes path to relative (with Windows backslash handling)
  - Checks exclude patterns first (any match = skip)
  - Checks include patterns next (must match at least one)
  - Uses `{ dot: true }` option for dotfile support
- Updated `execute()`:
  - Sets `projectPath` for pattern matching
  - Reads patterns from config
  - Logs when filtering is enabled
  - Calls `shouldSkipFile()` at top of DFS loop

## Test Results

### ConfigLoader Tests
```
# tests 69
# pass 69
# fail 0
```

New tests added: 14 (in "Include/Exclude patterns (REG-185)" suite)

### JSModuleIndexer Tests
```
# tests 16
# pass 16
# fail 0
```

New tests added: 10 (in "Include/Exclude Pattern Filtering (REG-185)" suite)

### Combined Run
```
# tests 85 (both files)
# pass 85
# fail 0
```

## Commits Made

1. `feat(core): add include/exclude glob patterns for file filtering (REG-185)`
   - Implementation changes to types, ConfigLoader, JSModuleIndexer

2. `test(core): add tests for include/exclude pattern filtering (REG-185)`
   - Test additions to ConfigLoader.test.ts and JSModuleIndexer.test.ts

## Issues Encountered and Resolved

### 1. TypeScript Parser Error in JSDoc

**Issue**: Original JSDoc example `"**/*.{js,jsx}"` caused TypeScript errors at build time:
```
src/plugins.ts(164,43): error TS1131: Property or signature expected.
```

**Resolution**: Changed JSDoc examples to simpler patterns without brace expansion.

### 2. YAML null vs undefined

**Issue**: Test expected `config.exclude` to be `undefined` when YAML has `exclude:` (no value), but YAML parser returns `null`.

**Resolution**: Changed merge logic to use `user.include ?? undefined` which converts `null` to `undefined`.

## Filtering Behavior Summary

| Scenario | Result |
|----------|--------|
| File matches exclude pattern | SKIP |
| Include specified, file doesn't match | SKIP |
| Include specified, file matches | PROCESS |
| No patterns | PROCESS (default behavior) |
| File matches both include and exclude | SKIP (exclude wins) |

## Key Implementation Decisions

1. **Exclude checked before include**: More efficient and matches user expectation that exclude "wins".

2. **Pattern matching on relative paths**: All patterns match against paths relative to project root for portability.

3. **Windows path normalization**: Backslashes converted to forward slashes before matching.

4. **Dotfile support**: `{ dot: true }` option passed to minimatch so patterns can match dotfiles.

5. **Entrypoint not special-cased**: If entrypoint matches exclude, it's skipped. This is documented behavior per Joel's spec.
