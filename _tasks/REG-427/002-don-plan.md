# Don's Plan: REG-427 — TypeScript class declarations not extracted as CLASS nodes

## Root Cause Analysis

The issue is **NOT in ClassVisitor** — it works correctly (71 tests pass). The problem is upstream:

**TypeScript files are never indexed because the entrypoint resolution fails.**

### The Pipeline

```
SimpleProjectDiscovery → resolves entrypoint → JSModuleIndexer → DFS from entrypoint → JSASTAnalyzer
```

### Where It Breaks

1. `resolveSourceEntrypoint()` checks for `tsconfig.json`. No tsconfig → returns `null`
2. Fallback: `packageJson.main ?? 'index.js'` — hardcoded `.js`
3. `JSModuleIndexer` gets `index.js`, but only `index.ts` exists
4. `processFile('index.js')` → ENOENT → silently skipped → `modulesCreated: 0`
5. No modules → no analysis → no CLASS nodes → 0 results

### Evidence

```
# JS test (passes):    modulesCreated: 1
# TS test (fails):     modulesCreated: 0
```

## Fix

**Single change in `JSModuleIndexer`**: resolve the entrypoint through `resolveModulePath()` before starting DFS.

### File: `packages/core/src/plugins/indexing/JSModuleIndexer.ts` (lines 285-293)

**Before:**
```typescript
const absoluteEntrypoint = entrypoint.startsWith('/')
  ? entrypoint
  : join(projectPath, entrypoint);

// ... DFS starts with absoluteEntrypoint
const stack: StackItem[] = [{ file: absoluteEntrypoint, depth: 0 }];
```

**After:**
```typescript
const rawEntrypoint = entrypoint.startsWith('/')
  ? entrypoint
  : join(projectPath, entrypoint);

// Resolve entrypoint to actual file (handles .js → .ts redirect, REG-427)
const absoluteEntrypoint = existsSync(rawEntrypoint)
  ? rawEntrypoint
  : (resolveModulePathUtil(rawEntrypoint, { useFilesystem: true }) ?? rawEntrypoint);

// ... DFS starts with resolved entrypoint
const stack: StackItem[] = [{ file: absoluteEntrypoint, depth: 0 }];
```

### Why This Fix Is Correct

1. **Uses existing infrastructure**: `resolveModulePathUtil` already handles TS extension redirects (REG-426)
2. **Minimal change**: Only the entrypoint resolution, not the whole DFS
3. **No false positives**: Only triggers when the original entrypoint doesn't exist
4. **Backward compatible**: If `index.js` exists, nothing changes

### What It Fixes

- `index.js` → `index.ts` (TS redirect from REG-426)
- `dist/index.js` → `src/index.ts` (still needs resolveSourceEntrypoint, but ENOENT won't crash)
- Any `.mjs` → `.mts`, `.cjs` → `.cts` redirects

## Tests

1. **Fix the quick test** (`test/unit/ts-class-quick.test.js`): Use `index.ts` as filename (entrypoint match)
2. **New test cases**:
   - `.ts` file with classes → CLASS nodes extracted
   - `.ts` file with abstract class → CLASS node with correct metadata
   - `.ts` file with `extends` → DERIVES_FROM edge
   - `.ts` file with access modifiers (`private`, `protected`) → methods still extracted
3. **Existing tests must still pass**: All 71 class tests + full unit suite

## Scope

- **Config:** Mini-MLA (medium complexity, localized change)
- **Files changed:** 1 (JSModuleIndexer.ts)
- **Test files:** 1 new test file (TypeScript-specific class extraction)
- **Risk:** LOW — only affects non-existent entrypoint resolution, existing paths unchanged

## NOT in scope

- Removing the `tsconfig.json` gate from `resolveSourceEntrypoint` (separate issue)
- Glob-based discovery for projects without entrypoints (config.yaml `services` handles this)
- Class-specific features (already working once files are indexed)
