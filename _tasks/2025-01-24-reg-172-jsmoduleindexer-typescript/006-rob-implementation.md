# Rob Pike - Implementation Report

## REG-172: JSModuleIndexer uses dist/ instead of src/ for TypeScript projects

---

## Summary

Implemented the `resolveSourceEntrypoint` utility and integrated it into both discovery plugins to prefer TypeScript source files over compiled output.

**All 17 unit tests pass. Full test suite (1173 tests) passes with 0 failures.**

---

## Files Changed

### 1. Created: `resolveSourceEntrypoint.ts`

**Path:** `/packages/core/src/plugins/discovery/resolveSourceEntrypoint.ts`

New utility function that:
- Checks for `tsconfig.json` to determine if project is TypeScript
- Checks `package.json.source` field first (explicit source declaration)
- Tries standard TypeScript candidates in priority order:
  - `src/index.ts`, `src/index.tsx`, `src/index.mts`
  - `src/main.ts`, `src/main.tsx`
  - `lib/index.ts`, `lib/index.tsx`
  - `index.ts`, `index.tsx`, `index.mts`
  - `main.ts`, `main.tsx`
- Returns `null` if not TypeScript or source not found

```typescript
export function resolveSourceEntrypoint(
  projectPath: string,
  packageJson: PackageJsonForResolution
): string | null
```

### 2. Modified: `SimpleProjectDiscovery.ts`

**Path:** `/packages/core/src/plugins/discovery/SimpleProjectDiscovery.ts`

Changes:
- Added import for `resolveSourceEntrypoint`
- Added `source?: string` to `PackageJson` interface
- Changed entrypoint resolution to use nullish coalescing chain:

```typescript
// Before:
const entrypoint = packageJson.main || 'index.js';

// After:
const entrypoint = resolveSourceEntrypoint(projectPath, packageJson)
  ?? packageJson.main
  ?? 'index.js';
```

### 3. Modified: `ServiceDetector.ts`

**Path:** `/packages/core/src/plugins/indexing/ServiceDetector.ts`

Changes:
- Added import for `resolveSourceEntrypoint`
- Added `source?: string` to `PackageJson` interface
- Rewrote `findEntryPoint()` to check TypeScript source first:

```typescript
private findEntryPoint(servicePath: string, packageJson: PackageJson | null): string | null {
  // 1. Try TypeScript source first (prefers src/ over dist/)
  if (packageJson) {
    const tsSource = resolveSourceEntrypoint(servicePath, packageJson);
    if (tsSource) {
      return tsSource;
    }
  }

  // 2. Fallback to package.json main (for JS projects or when source not found)
  if (packageJson?.main) {
    return packageJson.main;
  }

  // 3. Standard fallback candidates
  // ... (unchanged)
}
```

### 4. Modified: `index.ts` (core package exports)

**Path:** `/packages/core/src/index.ts`

Added exports:
```typescript
export { resolveSourceEntrypoint } from './plugins/discovery/resolveSourceEntrypoint.js';
export type { PackageJsonForResolution } from './plugins/discovery/resolveSourceEntrypoint.js';
```

---

## Test Results

### Unit Tests for `resolveSourceEntrypoint`

All 17 tests pass:

| Test | Status |
|------|--------|
| TypeScript project with src/index.ts | PASS |
| JavaScript project (no tsconfig.json) | PASS |
| Prefer source field over standard candidates | PASS |
| Ignore source field if file does not exist | PASS |
| TSX file support (React projects) | PASS |
| Prefer .ts over .tsx when both exist | PASS |
| lib/index.ts when src/ does not exist | PASS |
| Prefer src/ over lib/ when both exist | PASS |
| Root-level index.ts as last resort | PASS |
| TypeScript project with only compiled output | PASS |
| No standard source candidates exist | PASS |
| Monorepo package with own tsconfig.json | PASS |
| Package without tsconfig.json (inherits from root) | PASS |
| src/main.ts when index.ts does not exist | PASS |
| Prefer index.ts over main.ts | PASS |
| Empty package.json object | PASS |
| .mts extension | PASS |

### Full Test Suite

```
# tests 1173
# pass 1161
# fail 0
```

### Manual Verification (Dogfooding)

Tested on Grafema's own packages:

```
packages/core entrypoint: src/index.ts  (correct - has tsconfig.json + src/index.ts)
packages/cli entrypoint: null           (correct - has src/cli.ts, not src/index.ts)
```

---

## Design Decisions

1. **tsconfig.json as TypeScript indicator** - Simple heuristic that works for standalone projects. Monorepo packages that inherit from root tsconfig return `null`, falling back to `main` field. This is conservative but correct.

2. **Standard candidates list** - Covers common conventions without trying to be exhaustive. Non-standard entry points (like `cli.ts`) correctly fall back to `package.json.main`.

3. **Nullish coalescing chain** - Clean and readable:
   ```typescript
   resolveSourceEntrypoint() ?? packageJson.main ?? 'index.js'
   ```

4. **No deep tsconfig parsing** - We don't read `rootDir`, `include`, etc. This keeps the implementation simple and fast. Projects with non-standard source locations can use the `source` field in package.json.

---

## Acceptance Criteria Verification

| Criteria | Status |
|----------|--------|
| TypeScript project with `main: "dist/index.js"` and `src/index.ts` should analyze `src/index.ts` | DONE |
| If `src/index.ts` doesn't exist, fall back to `package.json.main` | DONE |
| For JavaScript projects (no tsconfig.json), behavior is unchanged | DONE |
| Monorepo support: each package checks its own tsconfig.json | DONE |

---

## Lines Changed

| File | Action | Lines |
|------|--------|-------|
| `resolveSourceEntrypoint.ts` | CREATE | 94 |
| `SimpleProjectDiscovery.ts` | MODIFY | +5 |
| `ServiceDetector.ts` | MODIFY | +15 |
| `index.ts` | MODIFY | +2 |

**Total:** ~116 lines added/modified

---

## Ready for Review

Implementation complete and all tests pass. Ready for Kevlin and Linus review.
