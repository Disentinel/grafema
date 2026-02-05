# Joel Spolsky Technical Plan: Module Path Resolution Utility (REG-320)

## Executive Summary

Extract duplicated module path resolution logic from 4 files into a shared utility. This is a straightforward refactoring with clear benefits: reduced duplication, consistent behavior, and fixing extension bugs in IncrementalModuleIndexer and FunctionCallResolver.

**Complexity:** O(k) where k is the number of extensions to try (constant, k=6 for direct extensions + 4 for index files = 10 filesystem checks worst case)

**Risk Level:** LOW - Pure extraction, existing tests will validate behavior preservation

## Files to Change

### 1. NEW FILE: `packages/core/src/utils/moduleResolution.ts`

**Purpose:** Shared module resolution utilities

**Exports:**
```typescript
export interface ModuleResolutionOptions {
  useFilesystem?: boolean;        // Default: true
  fileIndex?: Set<string>;        // Used when useFilesystem=false
  extensions?: string[];          // Default: ['.js', '.mjs', '.jsx', '.ts', '.tsx']
  indexFiles?: string[];          // Default: ['index.js', 'index.ts', 'index.mjs', 'index.tsx']
}

export function resolveModulePath(
  basePath: string,
  options?: ModuleResolutionOptions
): string | null;

export function isRelativeImport(specifier: string): boolean;

export function resolveRelativeSpecifier(
  specifier: string,
  containingFile: string
): string;
```

**Implementation Details:**

1. **resolveModulePath()** - Core resolution logic:
   - Input: absolute base path (no extension)
   - Algorithm:
     ```
     1. Try direct path (existsSync or fileIndex.has)
     2. For each extension in extensions array:
        - Try basePath + extension
     3. For each indexFile in indexFiles array:
        - Try join(basePath, indexFile)
     4. Return null if nothing found
     ```
   - Returns: resolved path or null
   - Complexity: O(k) where k = extensions.length + indexFiles.length (typically 10)

2. **isRelativeImport()** - Simple check:
   ```typescript
   return specifier.startsWith('./') || specifier.startsWith('../');
   ```
   - Complexity: O(1)

3. **resolveRelativeSpecifier()** - Path resolution helper:
   ```typescript
   return resolve(dirname(containingFile), specifier);
   ```
   - Complexity: O(1)

**Default Values:**
```typescript
const DEFAULT_EXTENSIONS = ['.js', '.mjs', '.jsx', '.ts', '.tsx'];
const DEFAULT_INDEX_FILES = ['index.js', 'index.ts', 'index.mjs', 'index.tsx'];
```

**File Size:** ~100 lines including JSDoc comments

---

### 2. UPDATE: `packages/core/src/plugins/indexing/JSModuleIndexer.ts`

**Current:** Lines 242-257 contain `resolveModulePath()` method

**Changes:**

**Step 2.1:** Add import at top of file (after line 15):
```typescript
import { resolveModulePath } from '../../utils/moduleResolution.js';
```

**Step 2.2:** Replace method body (lines 242-257):
```typescript
// OLD (REMOVE):
private resolveModulePath(path: string): string {
  if (existsSync(path)) return path;
  // Try JavaScript extensions
  if (existsSync(path + '.js')) return path + '.js';
  if (existsSync(path + '.mjs')) return path + '.mjs';
  if (existsSync(path + '.jsx')) return path + '.jsx';
  // Try TypeScript extensions
  if (existsSync(path + '.ts')) return path + '.ts';
  if (existsSync(path + '.tsx')) return path + '.tsx';
  // Try index files
  if (existsSync(join(path, 'index.js'))) return join(path, 'index.js');
  if (existsSync(join(path, 'index.ts'))) return join(path, 'index.ts');
  if (existsSync(join(path, 'index.mjs'))) return join(path, 'index.mjs');
  if (existsSync(join(path, 'index.tsx'))) return join(path, 'index.tsx');
  return path;
}

// NEW (REPLACE WITH):
private resolveModulePath(path: string): string {
  const resolved = resolveModulePath(path, {
    useFilesystem: true,
    extensions: ['', '.js', '.mjs', '.jsx', '.ts', '.tsx']
  });
  return resolved || path; // Fall back to original path if not found
}
```

**Rationale:** JSModuleIndexer is unique in returning the original path when resolution fails (instead of null). This behavior is preserved by the fallback.

**Complexity:** Still O(k), just delegated to shared utility

---

### 3. UPDATE: `packages/core/src/plugins/enrichment/MountPointResolver.ts`

**Current:** Lines 67-91 contain `resolveImportSource()` method

**Changes:**

**Step 3.1:** Add import at top of file (after line 23):
```typescript
import { resolveModulePath, isRelativeImport, resolveRelativeSpecifier } from '../../utils/moduleResolution.js';
```

**Step 3.2:** Simplify method body (lines 67-91):
```typescript
// OLD (REMOVE):
private resolveImportSource(importSource: string, containingFile: string): string | null {
  // Only handle relative imports
  if (!importSource.startsWith('./') && !importSource.startsWith('../')) {
    return null;  // External package
  }

  const dir = dirname(containingFile);
  const basePath = resolve(dir, importSource);

  // Try direct path
  if (existsSync(basePath)) return basePath;

  // Try extensions
  for (const ext of ['.js', '.mjs', '.jsx', '.ts', '.tsx']) {
    if (existsSync(basePath + ext)) return basePath + ext;
  }

  // Try index files
  for (const indexFile of ['index.js', 'index.ts', 'index.mjs', 'index.tsx']) {
    const indexPath = join(basePath, indexFile);
    if (existsSync(indexPath)) return indexPath;
  }

  return null;
}

// NEW (REPLACE WITH):
private resolveImportSource(importSource: string, containingFile: string): string | null {
  // Only handle relative imports
  if (!isRelativeImport(importSource)) {
    return null;  // External package
  }

  const basePath = resolveRelativeSpecifier(importSource, containingFile);
  return resolveModulePath(basePath, {
    useFilesystem: true,
    extensions: ['', '.js', '.mjs', '.jsx', '.ts', '.tsx']
  });
}
```

**Cleanup:** Remove now-unused imports (lines 22-23):
- Remove: `import { dirname, resolve, join } from 'path';`
- Remove: `import { existsSync } from 'fs';`

**Complexity:** O(k) - same as before, just cleaner

---

### 4. UPDATE: `packages/core/src/plugins/indexing/IncrementalModuleIndexer.ts`

**Current:** Lines 55-105 contain `resolveModule()` and `tryResolve()` methods

**BUG TO FIX:** Only supports `.js` extension (missing `.ts`, `.tsx`, `.mjs`, `.jsx`)

**Changes:**

**Step 4.1:** Add import at top of file (after line 12):
```typescript
import { resolveModulePath, isRelativeImport } from '../../utils/moduleResolution.js';
```

**Step 4.2:** Replace `tryResolve()` method (lines 84-105):
```typescript
// OLD (REMOVE):
private tryResolve(basePath: string): string | null {
  if (existsSync(basePath)) {
    if (!extname(basePath)) {
      // Try as directory with index.js
      const indexPath = join(basePath, 'index.js');
      if (existsSync(indexPath)) return indexPath;
      // Try adding .js
      if (existsSync(basePath + '.js')) return basePath + '.js';
    }
    return basePath;
  }

  // Try with .js extension
  if (existsSync(basePath + '.js')) return basePath + '.js';

  // Try as directory
  const indexPath = join(basePath, 'index.js');
  if (existsSync(indexPath)) return indexPath;

  return null;
}

// NEW (REPLACE WITH):
private tryResolve(basePath: string): string | null {
  return resolveModulePath(basePath, {
    useFilesystem: true,
    extensions: ['', '.js', '.mjs', '.jsx', '.ts', '.tsx']
  });
}
```

**Step 4.3:** Update `resolveModule()` to preserve specialized logic (lines 55-78):
- Keep absolute path handling (`startsWith('/')`)
- Keep relative path handling (`startsWith('.')`)
- Keep bare specifier heuristic (monorepo support)
- Only replace the `tryResolve()` call (no logic change)

**Cleanup:** Remove now-unused imports:
- Remove: `import { extname } from 'path';` (if not used elsewhere)
- Keep: `existsSync` is still used in line 85 for the direct check

**Bug Fixed:** Now supports full extension list instead of just `.js`

**Complexity:** O(k) per resolution attempt (same as before, but now correct)

---

### 5. UPDATE: `packages/core/src/plugins/enrichment/FunctionCallResolver.ts`

**Current:** Lines 356-372 contain `resolveModulePath()` method

**BUG TO FIX:** Missing `.mjs`, `index.mjs`, `index.tsx`

**Changes:**

**Step 5.1:** Add import at top of file (after line 17):
```typescript
import { resolveModulePath } from '../../utils/moduleResolution.js';
```

**Step 5.2:** Replace method body (lines 356-372):
```typescript
// OLD (REMOVE):
private resolveModulePath(
  currentDir: string,
  specifier: string,
  fileIndex: Set<string>
): string | null {
  const basePath = resolve(currentDir, specifier);
  const extensions = ['', '.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts'];

  for (const ext of extensions) {
    const testPath = basePath + ext;
    if (fileIndex.has(testPath)) {
      return testPath;
    }
  }

  return null;
}

// NEW (REPLACE WITH):
private resolveModulePath(
  currentDir: string,
  specifier: string,
  fileIndex: Set<string>
): string | null {
  const basePath = resolve(currentDir, specifier);
  return resolveModulePath(basePath, {
    useFilesystem: false,
    fileIndex: fileIndex,
    extensions: ['', '.js', '.mjs', '.jsx', '.ts', '.tsx']
  });
}
```

**Note:** Keep the method signature as-is to maintain compatibility with caller at line 415. The shared utility's `useFilesystem: false` mode handles the `fileIndex` lookup.

**Bug Fixed:** Now includes `.mjs` and full index file list

**Complexity:** O(k) where k = 10 (extensions + index files)

---

### 6. NEW FILE: `test/unit/utils/moduleResolution.test.js`

**Purpose:** Comprehensive unit tests for the new utility

**Test Structure:**
```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveModulePath, isRelativeImport, resolveRelativeSpecifier } from '../../../packages/core/src/utils/moduleResolution.js';
```

**Test Cases:**

1. **Basic functionality:**
   - Resolve exact path (file exists)
   - Resolve with `.js` extension
   - Resolve with `.ts` extension
   - Resolve with `.mjs` extension
   - Resolve with `.jsx` extension
   - Resolve with `.tsx` extension

2. **Index files:**
   - Resolve to `index.js`
   - Resolve to `index.ts`
   - Resolve to `index.mjs`
   - Resolve to `index.tsx`

3. **Not found:**
   - Return null when file doesn't exist

4. **File index mode (in-memory):**
   - Resolve from Set instead of filesystem
   - Should NOT hit filesystem when `useFilesystem: false`

5. **Custom options:**
   - Custom extension list
   - Custom index file list
   - Empty path prefix (default behavior)

6. **Helper functions:**
   - `isRelativeImport()` - test `./`, `../`, and non-relative
   - `resolveRelativeSpecifier()` - test path resolution

**Test Pattern:** Follow MountPointResolver.test.js structure:
- Use mock file system (Set of known paths)
- Test both filesystem and in-memory modes
- Clear, descriptive test names
- Assert both positive and negative cases

**File Size:** ~150 lines

---

## Implementation Order

**CRITICAL:** Must follow TDD principles - tests first!

1. **Create utility file** (`packages/core/src/utils/moduleResolution.ts`)
   - Implement core functions
   - Add JSDoc comments
   - Export interfaces and functions

2. **Write tests** (`test/unit/utils/moduleResolution.test.js`)
   - Cover all edge cases from Don's analysis
   - Tests must pass before proceeding

3. **Update MountPointResolver** (simplest - pure delegation)
   - Import utility
   - Replace method
   - Remove duplicate code
   - Run existing tests: `node --test test/unit/plugins/enrichment/MountPointResolver.test.js`

4. **Update JSModuleIndexer** (handle "return original" behavior)
   - Import utility
   - Add fallback logic
   - Run tests (if any exist)

5. **Update FunctionCallResolver** (use `useFilesystem: false` mode)
   - Import utility
   - Update to use fileIndex mode
   - Run tests: `node --test test/unit/FunctionCallResolver.test.js`

6. **Update IncrementalModuleIndexer** (fixes extension bug)
   - Import utility
   - Replace `tryResolve()`
   - Verify full extension support
   - Run tests (if any exist)

7. **Run full test suite** to ensure no regressions:
   ```bash
   npm test
   ```

---

## Verification Strategy

### Before Changes:
1. Run existing tests to establish baseline
2. Document which tests exist for each file
3. Note current behavior (especially edge cases)

### After Each File Update:
1. Run that file's specific tests
2. Check that behavior is preserved
3. Verify extension bugs are fixed (IncrementalModuleIndexer, FunctionCallResolver)

### After All Changes:
1. Run full test suite
2. Verify all 4 callers use the same logic
3. Check that MountPointResolver tests still pass (REG-318 fix preserved)

---

## Edge Cases & Concerns

### 1. Return Value Consistency

**Issue:** JSModuleIndexer returns original path on failure, others return null

**Solution:** Shared utility returns null. JSModuleIndexer wraps with fallback:
```typescript
return resolveModulePath(path, options) || path;
```

### 2. Filesystem vs In-Memory

**Issue:** FunctionCallResolver uses pre-built Set, others use existsSync

**Solution:** `useFilesystem` option. When false, use `fileIndex.has()` instead of `existsSync()`

**Implementation:**
```typescript
const exists = options.useFilesystem
  ? existsSync(testPath)
  : options.fileIndex?.has(testPath) ?? false;
```

### 3. Extension Order

**Issue:** Different files had different orders (now irrelevant bugs)

**Solution:** Use most complete list as default. Order matters for performance but not correctness.

**Chosen Order:**
- Direct extensions: `''`, `.js`, `.mjs`, `.jsx`, `.ts`, `.tsx`
- Index files: `index.js`, `index.ts`, `index.mjs`, `index.tsx`

**Rationale:** JS first (most common), then TS. `.mjs` after `.js` for ESM projects.

### 4. Bare Specifier Support

**Issue:** IncrementalModuleIndexer handles bare specifiers (monorepo aliases)

**Solution:** Keep that logic in IncrementalModuleIndexer's `resolveModule()` method. The shared utility only handles the final resolution step (after classification).

**Not Extracted:**
- Absolute path handling (`/` → projectRoot)
- Bare specifier heuristic (`includes('/')` check)
- These are specialized to IncrementalModuleIndexer's use case

### 5. Performance

**Concern:** Does shared utility add overhead?

**Analysis:**
- Before: 10 `existsSync()` calls worst case
- After: 10 `existsSync()` calls worst case (same)
- No extra function call overhead (inlined by V8)
- Complexity: O(k) where k=10 (unchanged)

**Conclusion:** Zero performance impact

### 6. Import Cycles

**Concern:** Could this create circular dependencies?

**Analysis:**
- Utility is in `packages/core/src/utils/` (leaf package)
- Only imports Node.js builtins (`fs`, `path`)
- No Grafema internal imports
- All 4 callers are higher in dependency tree

**Conclusion:** No risk of cycles

---

## Testing Strategy

### Unit Tests (new file)

**File:** `test/unit/utils/moduleResolution.test.js`

**Coverage:**
1. Filesystem mode (useFilesystem: true)
   - Exact path exists
   - Extension resolution (.js, .ts, .tsx, .mjs, .jsx)
   - Index file resolution (all 4 variants)
   - File not found (return null)

2. In-memory mode (useFilesystem: false)
   - Same tests as filesystem mode
   - Verify it uses fileIndex, NOT filesystem
   - Edge case: fileIndex undefined

3. Options handling
   - Default extensions
   - Custom extensions
   - Default index files
   - Custom index files

4. Helper functions
   - isRelativeImport: `./`, `../`, `lodash`, `@scope/pkg`
   - resolveRelativeSpecifier: various relative paths

**Test Pattern:**
```javascript
describe('resolveModulePath', () => {
  describe('Filesystem mode', () => {
    it('should resolve exact path', () => { ... });
    it('should try .js extension', () => { ... });
    // etc.
  });

  describe('In-memory mode', () => {
    it('should use fileIndex instead of filesystem', () => { ... });
    // etc.
  });
});
```

### Integration Tests (existing)

**MountPointResolver.test.js:**
- Already has comprehensive tests (REG-318)
- Should pass without modification
- Verifies import resolution logic still works

**FunctionCallResolver.test.js:**
- Existing tests should pass
- Verify in-memory fileIndex mode works

**No existing tests for:**
- JSModuleIndexer.resolveModulePath
- IncrementalModuleIndexer.tryResolve

**Strategy:** Rely on unit tests + integration tests that use these plugins

---

## Rollback Plan

If anything breaks:

1. **Identify broken caller** (which of the 4 files)
2. **Revert that single file** (git checkout)
3. **Keep utility and tests** (they're reusable)
4. **Fix issue** and re-apply

**Low Risk Because:**
- Each file updated independently
- Existing tests validate behavior
- Pure extraction (no logic changes except bug fixes)
- Small scope (~100 lines of shared code)

---

## Success Metrics

1. **All existing tests pass** (MountPointResolver, FunctionCallResolver, etc.)
2. **New utility has 100% test coverage**
3. **Extension bugs fixed:**
   - IncrementalModuleIndexer now supports `.ts`, `.tsx`, `.mjs`, `.jsx`
   - FunctionCallResolver now supports `.mjs`, `index.mjs`, `index.tsx`
4. **Code reduction:** ~80 lines removed (duplicates), ~100 lines added (shared + tests)
5. **Behavioral consistency:** All 4 callers use identical resolution logic

---

## Time Estimate

- Utility creation: 30 minutes
- Test file: 1 hour
- Update 4 callers: 1 hour (15 min each)
- Verification & cleanup: 30 minutes

**Total: 3 hours**

---

## Big-O Complexity Analysis

### resolveModulePath()

**Worst Case:** O(k) where k = extensions.length + indexFiles.length

**Typical:** k = 10 (6 extensions + 4 index files)

**Per Resolution Attempt:**
- Try direct path: O(1) filesystem check
- Try each extension: O(1) × 6 = O(6)
- Try each index file: O(1) × 4 = O(4)
- Total: O(10) = O(1) constant time

**Note:** Filesystem I/O dominates, but count is constant. Early exit if file found.

### isRelativeImport()

**Complexity:** O(1) - two string prefix checks

### resolveRelativeSpecifier()

**Complexity:** O(1) - path.resolve() and path.dirname() are O(1) for typical path lengths

### Overall Impact

**Before refactoring:**
- Each plugin: O(k) resolution
- Different k values (some incomplete)

**After refactoring:**
- All plugins: O(k) resolution
- Same k value (complete list)
- No asymptotic change, just correctness improvement

---

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Tests fail after change | Low | Medium | Revert specific file, investigate |
| Performance regression | Very Low | Low | Same algorithm, measured with tests |
| Import cycle created | Very Low | High | Utility has no internal deps |
| Behavior difference in edge case | Low | Medium | Comprehensive test coverage |
| Extension bug not actually fixed | Very Low | Low | Verify with new tests |

**Overall Risk:** LOW - Straightforward refactoring with clear benefits

---

## Dependencies

**Required:**
- Node.js built-ins: `fs`, `path`
- No external dependencies

**Blocked By:**
- Nothing - can implement immediately

**Blocks:**
- Nothing - pure refactoring, no downstream impact

---

## Documentation Updates

### Code Comments

Each function in utility needs JSDoc:
```typescript
/**
 * Resolve a base path to an actual file by trying extensions and index files.
 *
 * @param basePath - Absolute path (without extension) to resolve
 * @param options - Resolution options (filesystem vs in-memory, extensions, index files)
 * @returns Resolved file path or null if not found
 *
 * @example
 * // Filesystem mode (default)
 * resolveModulePath('/app/utils')
 * // → '/app/utils.js' (if exists)
 *
 * @example
 * // In-memory mode (for enrichment plugins)
 * resolveModulePath('/app/utils', {
 *   useFilesystem: false,
 *   fileIndex: new Set(['/app/utils.ts'])
 * })
 * // → '/app/utils.ts'
 */
```

### README / CHANGELOG

**Not needed** - Internal utility, no public API change

---

## Final Checklist

Before marking task complete:

- [ ] Utility file created with full JSDoc
- [ ] Test file created with >90% coverage
- [ ] All 4 callers updated
- [ ] MountPointResolver.test.js passes
- [ ] FunctionCallResolver.test.js passes
- [ ] Full test suite passes (`npm test`)
- [ ] Extension bugs verified fixed
- [ ] Code review requested (Kevlin Henney)
- [ ] High-level review (Steve + Vadim)

---

## Notes for Kent Beck (Test Engineer)

**Test-First Approach:**

1. Write `test/unit/utils/moduleResolution.test.js` FIRST
2. Run tests (they will fail - utility doesn't exist yet)
3. Implement utility until tests pass
4. Then update callers

**Test Coverage Goals:**
- Branch coverage: 100%
- All edge cases from Don's analysis
- Both filesystem and in-memory modes
- Helper functions

**Test Data:**
- Use temporary directories (or mocks)
- Clean up after tests
- Fast execution (<100ms for full suite)

---

## Notes for Rob Pike (Implementation)

**Implementation Principles:**

1. **Simple over clever:** Straightforward loop, early return
2. **Match existing patterns:** Follow MountPointResolver style
3. **Clear variable names:** `basePath`, `testPath`, `exists`
4. **No premature optimization:** Readable code > micro-optimizations

**Code Style:**
- TypeScript strict mode
- Explicit types (no `any`)
- Single responsibility (each function does one thing)
- Comments only where logic is non-obvious

**Error Handling:**
- Return null on failure (don't throw)
- Caller decides how to handle (fallback, log, etc.)

---

## Questions for Reviewers

1. **Steve Jobs / Вадим Решетников:**
   - Does this align with "reuse before build" principle?
   - Is the shared utility abstract enough for future uses?

2. **Kevlin Henney:**
   - Is the interface clean and obvious?
   - Any naming improvements?
   - Test coverage sufficient?

---

## Appendix: Full File Diff Summary

### Files Modified: 4
1. `packages/core/src/plugins/indexing/JSModuleIndexer.ts` - 15 lines changed
2. `packages/core/src/plugins/enrichment/MountPointResolver.ts` - 24 lines removed, 6 added
3. `packages/core/src/plugins/indexing/IncrementalModuleIndexer.ts` - 22 lines removed, 5 added
4. `packages/core/src/plugins/enrichment/FunctionCallResolver.ts` - 17 lines removed, 7 added

### Files Created: 2
1. `packages/core/src/utils/moduleResolution.ts` - 100 lines (new)
2. `test/unit/utils/moduleResolution.test.js` - 150 lines (new)

### Net Change:
- Removed: ~78 lines (duplicates)
- Added: ~250 lines (utility + tests)
- **Net: +172 lines** (but eliminates 4 duplicates, adds comprehensive tests)

---

## Conclusion

This is a **low-risk, high-value refactoring**:
- Eliminates DRY violation
- Fixes extension bugs
- Improves consistency
- Adds test coverage
- No performance impact
- Clear implementation path

**Ready for Kent Beck to write tests.**
