# Don Melton Analysis: Module Path Resolution Duplication (REG-320)

## Summary

Analyzed duplicated module path resolution logic across 4 files:
1. `JSModuleIndexer.resolveModulePath()`
2. `MountPointResolver.resolveImportSource()`
3. `IncrementalModuleIndexer.tryResolve()` + `resolveModule()`
4. `FunctionCallResolver.resolveModulePath()`

All implement the same core algorithm with slight variations. This is a clear DRY violation.

## Side-by-Side Comparison

### 1. JSModuleIndexer.resolveModulePath()

**Location:** `packages/core/src/plugins/indexing/JSModuleIndexer.ts:242-257`

```typescript
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
```

**Characteristics:**
- Input: absolute base path (already resolved from relative import)
- Uses filesystem `existsSync()` for verification
- Returns original path if nothing found (caller must handle)
- Extension order: `.js`, `.mjs`, `.jsx`, `.ts`, `.tsx`
- Index files: `index.js`, `index.ts`, `index.mjs`, `index.tsx`

### 2. MountPointResolver.resolveImportSource()

**Location:** `packages/core/src/plugins/enrichment/MountPointResolver.ts:67-91`

```typescript
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
```

**Characteristics:**
- Input: raw import specifier + containing file path
- Handles relative path resolution internally
- Filters out external packages (returns `null`)
- Uses filesystem `existsSync()` for verification
- Returns `null` if not found
- Extension order: same as JSModuleIndexer
- Index files: same order

**Key difference:** Combines "is relative import?" check with path resolution.

### 3. IncrementalModuleIndexer.tryResolve() + resolveModule()

**Location:** `packages/core/src/plugins/indexing/IncrementalModuleIndexer.ts:55-105`

```typescript
private resolveModule(fromFile: string, importPath: string, projectRoot: string): string | null {
  // Absolute path (starts with /)
  if (importPath.startsWith('/')) {
    const fullPath = join(projectRoot, importPath);
    return this.tryResolve(fullPath);
  }

  // Relative path (starts with . or ..)
  if (importPath.startsWith('.')) {
    const fromDir = dirname(fromFile);
    const resolved = resolve(fromDir, importPath);
    return this.tryResolve(resolved);
  }

  // Bare specifier heuristic
  if (importPath.includes('/') && !importPath.startsWith('node:')) {
    const candidate = join(projectRoot, importPath);
    const resolved = this.tryResolve(candidate);
    if (resolved) return resolved;
  }

  return null;
}

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
```

**Characteristics:**
- Split into two methods: specifier classification + actual resolution
- Supports absolute paths rooted at projectRoot
- Supports bare specifier heuristic (monorepo aliases)
- **MISSING:** `.ts`, `.tsx`, `.mjs`, `.jsx` extensions (BUG - only supports `.js`)
- **MISSING:** `index.ts`, `index.tsx`, `index.mjs` (BUG - only `index.js`)
- Uses `extname()` to check if path already has extension

### 4. FunctionCallResolver.resolveModulePath()

**Location:** `packages/core/src/plugins/enrichment/FunctionCallResolver.ts:356-372`

```typescript
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
```

**Characteristics:**
- Uses `Set<string>` fileIndex instead of filesystem (in-memory lookup)
- Cleaner single-loop implementation
- **MISSING:** `.mjs`, `index.mjs`, `index.tsx`
- Extension order: `''`, `.js`, `.ts`, `.jsx`, `.tsx`, `/index.js`, `/index.ts`

## Differences Summary Table

| Feature | JSModuleIndexer | MountPointResolver | IncrementalModuleIndexer | FunctionCallResolver |
|---------|----------------|-------------------|-------------------------|---------------------|
| Input type | Absolute path | Import specifier + file | Import specifier + file + projectRoot | Dir + specifier + fileIndex |
| Relative import handling | External | Internal | Internal | External |
| External package filter | No | Yes (returns null) | Yes (returns null) | No |
| Bare specifier support | No | No | Yes (monorepo heuristic) | No |
| Verification method | `existsSync` | `existsSync` | `existsSync` | `Set.has()` |
| `.js` | Yes | Yes | Yes | Yes |
| `.mjs` | Yes | Yes | No | No |
| `.jsx` | Yes | Yes | No | Yes |
| `.ts` | Yes | Yes | No | Yes |
| `.tsx` | Yes | Yes | No | Yes |
| `index.js` | Yes | Yes | Yes | Yes |
| `index.ts` | Yes | Yes | No | Yes |
| `index.mjs` | Yes | Yes | No | No |
| `index.tsx` | Yes | Yes | No | No |
| Return on not found | Original path | `null` | `null` | `null` |

## What Should Be Extracted

### Core Shared Utility

Create `packages/core/src/utils/moduleResolution.ts`:

```typescript
export interface ModuleResolutionOptions {
  /**
   * When true, use filesystem existsSync().
   * When false, use provided fileIndex Set.
   */
  useFilesystem?: boolean;

  /**
   * Set of known file paths (used when useFilesystem=false).
   */
  fileIndex?: Set<string>;

  /**
   * Extensions to try (in order).
   * Default: ['', '.js', '.mjs', '.jsx', '.ts', '.tsx']
   */
  extensions?: string[];

  /**
   * Index files to try (in order).
   * Default: ['index.js', 'index.ts', 'index.mjs', 'index.tsx']
   */
  indexFiles?: string[];
}

/**
 * Resolve a base path to an actual file by trying extensions and index files.
 *
 * @param basePath - Absolute path (without extension) to resolve
 * @param options - Resolution options
 * @returns Resolved path or null if not found
 */
export function resolveModulePath(
  basePath: string,
  options?: ModuleResolutionOptions
): string | null;

/**
 * Check if import specifier is a relative import.
 */
export function isRelativeImport(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Resolve relative import specifier to absolute base path.
 */
export function resolveRelativeSpecifier(
  specifier: string,
  containingFile: string
): string {
  return resolve(dirname(containingFile), specifier);
}
```

### What Stays Specific to Each Caller

1. **JSModuleIndexer:**
   - The "return original path" behavior (instead of null) - could be handled by caller
   - npm package detection (`package::` prefix) stays in processFile()

2. **MountPointResolver:**
   - External package filtering (`!isRelativeImport()`) stays in caller
   - Can use `resolveRelativeSpecifier()` + `resolveModulePath()`

3. **IncrementalModuleIndexer:**
   - Bare specifier heuristic (monorepo support) - unique to this plugin
   - Absolute path handling (`/` prefix -> projectRoot) - unique to this plugin
   - **Should adopt full extension list** (currently only `.js`)

4. **FunctionCallResolver:**
   - Already uses in-memory fileIndex - can use `resolveModulePath()` with `useFilesystem: false`
   - **Should adopt full extension list** (missing `.mjs`, `index.mjs`, `index.tsx`)

## Concerns and Complications

### 1. Return Value Inconsistency

JSModuleIndexer returns the **original path** when nothing found, while others return `null`.

**Recommendation:** Shared utility should return `null` for consistency. JSModuleIndexer caller can fall back to original path if needed.

### 2. Filesystem vs In-Memory

FunctionCallResolver uses a pre-built `Set<string>` instead of filesystem checks. This is a performance optimization (no I/O during enrichment).

**Recommendation:** Support both via options. Default to filesystem.

### 3. Extension Order Matters

Different plugins have slightly different extension orders. Need to standardize.

**Recommendation:** Use most complete list as default:
```typescript
const DEFAULT_EXTENSIONS = ['', '.js', '.mjs', '.jsx', '.ts', '.tsx'];
const DEFAULT_INDEX_FILES = ['index.js', 'index.ts', 'index.mjs', 'index.tsx'];
```

### 4. IncrementalModuleIndexer is Incomplete

It only supports `.js` files. This is a bug introduced during implementation.

**Recommendation:** Fix as part of this refactoring by using shared utility.

### 5. Bare Specifier Support

Only IncrementalModuleIndexer handles bare specifiers (monorepo aliases). This is specialized behavior.

**Recommendation:** Keep bare specifier logic in IncrementalModuleIndexer. The shared utility only handles the final resolution step.

### 6. Test Coverage

- MountPointResolver has good test coverage (in test file, uses a mock `resolveImportSource`)
- JSModuleIndexer has no direct tests for `resolveModulePath`
- Need tests for shared utility

**Recommendation:** Create unit tests for the shared utility that cover all edge cases from MountPointResolver.test.js.

## Recommended Implementation Plan

1. Create `packages/core/src/utils/moduleResolution.ts` with:
   - `resolveModulePath()` - core resolution logic
   - `isRelativeImport()` - utility check
   - `resolveRelativeSpecifier()` - utility for relative path resolution

2. Create `test/unit/utils/moduleResolution.test.js` with comprehensive tests

3. Update callers in order:
   - MountPointResolver (simplest - just uses core resolution)
   - JSModuleIndexer (needs to handle "return original" behavior)
   - FunctionCallResolver (needs `useFilesystem: false` option)
   - IncrementalModuleIndexer (keep bare specifier logic, use utility for final resolution)

4. Verify all existing tests pass

## Scope Estimate

- Shared utility creation: ~30 lines
- Test file: ~100 lines
- JSModuleIndexer update: ~5 line change
- MountPointResolver update: ~10 line change (remove method, use utility)
- FunctionCallResolver update: ~5 line change
- IncrementalModuleIndexer update: ~10 lines (fix extension list bug)

**Total: Small refactoring, low risk.**
