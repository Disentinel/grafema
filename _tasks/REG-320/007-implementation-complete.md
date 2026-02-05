# REG-320 Implementation Complete

## Summary

Extracted duplicated module path resolution logic into a shared utility at `packages/core/src/utils/moduleResolution.ts`.

## Files Changed

### Created
- `packages/core/src/utils/moduleResolution.ts` - New shared utility
- `test/unit/utils/moduleResolution.test.js` - 49 comprehensive tests

### Modified
- `packages/core/src/index.ts` - Added exports for new utility
- `packages/core/src/plugins/enrichment/MountPointResolver.ts` - Uses shared utility
- `packages/core/src/plugins/indexing/JSModuleIndexer.ts` - Uses shared utility
- `packages/core/src/plugins/indexing/IncrementalModuleIndexer.ts` - Uses shared utility
- `packages/core/src/plugins/enrichment/FunctionCallResolver.ts` - Uses shared utility

## Utility API

```typescript
// Core resolution
resolveModulePath(basePath: string, options?: ModuleResolutionOptions): string | null;

// Helpers
isRelativeImport(specifier: string): boolean;
resolveRelativeSpecifier(specifier: string, containingFile: string, options?): string | null;

// Options
interface ModuleResolutionOptions {
  useFilesystem?: boolean;  // Default: true
  fileIndex?: Set<string>;  // Required when useFilesystem=false
  extensions?: string[];    // Default: ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']
  indexFiles?: string[];    // Default: ['index.js', 'index.ts', 'index.mjs', 'index.cjs', 'index.jsx', 'index.tsx']
}
```

## Bugs Fixed

1. **IncrementalModuleIndexer** - Now supports all extensions (.ts, .tsx, .mjs, .jsx, .cjs)
   - Previously only supported `.js` and `index.js`

2. **FunctionCallResolver** - Now supports all extensions and index files
   - Previously missing `.mjs`, `index.mjs`, `index.cjs`, `index.jsx`, `index.tsx`

3. **IncrementalModuleIndexer directory bug** - No longer returns directory paths
   - Previously could return directory path if it existed but had no index file

## Test Results

- **49 new tests** for module resolution utility - all passing
- **9 MountPointResolver tests** - all passing (unchanged behavior)
- **58 total tests** run - all passing

## Acceptance Criteria

- [x] Shared utility created
- [x] JSModuleIndexer uses shared utility
- [x] MountPointResolver uses shared utility
- [x] IncrementalModuleIndexer uses shared utility
- [x] FunctionCallResolver uses shared utility
- [x] All existing tests pass

## Technical Details

- Extensions are tried in order: `''`, `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`
- Index files tried in order: `index.js`, `index.ts`, `index.mjs`, `index.cjs`, `index.jsx`, `index.tsx`
- Supports both filesystem mode (default) and in-memory mode (for enrichment)
- Throws error if `useFilesystem=false` but no `fileIndex` provided
- Returns `null` if not found (callers handle fallback if needed)
