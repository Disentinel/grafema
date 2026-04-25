# Kent Beck - Test Report

## REG-172: JSModuleIndexer uses dist/ instead of src/ for TypeScript projects

---

## Summary

Tests written for `resolveSourceEntrypoint` utility function. All tests are currently **failing** as expected in TDD workflow - the implementation does not exist yet.

---

## Test File Created

**Location:** `/test/unit/plugins/discovery/resolveSourceEntrypoint.test.ts`

**Line count:** ~280 lines

---

## Test Structure

Tests organized into logical groups:

### 1. TypeScript project detection (2 tests)
- `should return src/index.ts for TypeScript project with standard structure`
- `should return null for JavaScript project (no tsconfig.json)`

### 2. Package.json source field (2 tests)
- `should prefer source field over standard candidates`
- `should ignore source field if file does not exist`

### 3. TSX file support (2 tests)
- `should find src/index.tsx for React TypeScript projects`
- `should prefer .ts over .tsx when both exist`

### 4. Alternative source locations (3 tests)
- `should find lib/index.ts when src/ does not exist`
- `should prefer src/ over lib/ when both exist`
- `should find root-level index.ts as last resort`

### 5. No source files found (2 tests)
- `should return null when TypeScript project has only compiled output`
- `should return null when no standard source candidates exist`

### 6. Monorepo package support (2 tests)
- `should resolve source for individual monorepo package`
- `should return null for package without tsconfig.json`

### 7. main.ts variants (2 tests)
- `should find src/main.ts when index.ts does not exist`
- `should prefer index.ts over main.ts`

### 8. Edge cases (2 tests)
- `should handle empty package.json object`
- `should handle .mts extension`

**Total: 17 test cases**

---

## Test Run Results

```
node --import tsx --test test/unit/plugins/discovery/resolveSourceEntrypoint.test.ts

SyntaxError: The requested module '@grafema/core' does not provide an export named 'resolveSourceEntrypoint'
```

**Status:** FAILING (expected in TDD - implementation pending)

---

## Test Design Decisions

### 1. Real filesystem instead of mocks
Tests use `mkdtempSync` to create temporary directories with real files. This ensures:
- Tests verify actual filesystem behavior
- No mock/production code divergence
- Tests serve as documentation of real behavior

### 2. Complete cleanup
Each test uses `beforeEach`/`afterEach` to:
- Create fresh temp directory before each test
- Delete all temp files after each test
- Ensure test isolation

### 3. Test naming convention
Names follow pattern: `should [expected behavior] [context]`
- Communicates intent clearly
- Documents expected behavior
- Serves as specification

### 4. Comprehensive edge cases
Tests cover:
- Standard TypeScript projects (`src/index.ts`)
- React projects (`.tsx` files)
- Alternative conventions (`lib/`, `main.ts`)
- Monorepo packages
- ESM TypeScript (`.mts`)
- Missing/invalid source files

---

## Acceptance Criteria Coverage

| Acceptance Criteria | Test Coverage |
|---------------------|---------------|
| TypeScript project with `main: "dist/index.js"` and `src/index.ts` exists -> analyze `src/index.ts` | `should return src/index.ts for TypeScript project with standard structure` |
| If `src/index.ts` doesn't exist, fall back to `package.json.main` | `should return null when TypeScript project has only compiled output` |
| For JavaScript projects (no tsconfig.json), behavior is unchanged | `should return null for JavaScript project (no tsconfig.json)` |
| Monorepo support: each package checks its own tsconfig.json | `should resolve source for individual monorepo package` |

---

## What Implementation Needs to Do

Based on these tests, the implementation must:

1. **Check for `tsconfig.json`** - return `null` if not present
2. **Check `source` field** in package.json first (if exists and file exists)
3. **Try standard candidates** in priority order:
   - `src/index.ts`
   - `src/index.tsx`
   - `src/index.mts`
   - `src/main.ts`
   - `src/main.tsx`
   - `lib/index.ts`
   - `lib/index.tsx`
   - `index.ts`
   - `index.tsx`
   - `index.mts`
   - `main.ts`
   - `main.tsx`
4. **Return `null`** if no candidate exists

---

## Export Requirement

Tests import from `@grafema/core`:
```typescript
import { resolveSourceEntrypoint } from '@grafema/core';
```

Implementation must be exported from `/packages/core/src/index.ts`:
```typescript
export { resolveSourceEntrypoint } from './plugins/discovery/resolveSourceEntrypoint.js';
```

---

## Next Steps

1. Rob Pike implements `resolveSourceEntrypoint.ts`
2. Run tests until all pass
3. Integration with `SimpleProjectDiscovery.ts` and `ServiceDetector.ts`

---

**Kent Beck**
*Tests communicate intent. Implementation follows.*
