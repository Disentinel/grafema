# Joel Spolsky - Technical Specification

## REG-172: JSModuleIndexer uses dist/ instead of src/ for TypeScript projects

---

## Executive Summary

This specification details the implementation of TypeScript source file detection for Grafema's discovery phase. The fix is purely additive, affecting only two files with a shared utility function.

**Total estimated changes:** ~80 lines of new code + ~20 lines of test code

---

## 1. New File: `resolveSourceEntrypoint.ts`

**Location:** `/packages/core/src/plugins/discovery/resolveSourceEntrypoint.ts`

### 1.1 Purpose

Utility function that determines the correct source entrypoint for a project, preferring TypeScript source over compiled output.

### 1.2 Interface Definition

```typescript
/**
 * Extended PackageJson interface for source resolution
 */
interface PackageJsonForResolution {
  main?: string;
  source?: string;    // Used by bundlers like Parcel
  module?: string;    // ESM entry (sometimes points to source)
  types?: string;     // Type declarations hint
  typings?: string;   // Alternative to types
}

/**
 * Resolves the source entrypoint for a project, preferring TypeScript source
 * over compiled output.
 *
 * Resolution order:
 * 1. If no tsconfig.json exists -> return null (not a TypeScript project)
 * 2. Check package.json "source" field
 * 3. Check standard TypeScript source candidates
 * 4. Return null if no source found (caller should fallback to main)
 *
 * @param projectPath - Absolute path to the project/service directory
 * @param packageJson - Parsed package.json content
 * @returns Source entrypoint relative to projectPath, or null if not found
 *
 * @example
 * // TypeScript project with src/index.ts
 * resolveSourceEntrypoint('/path/to/project', { main: 'dist/index.js' })
 * // Returns: 'src/index.ts'
 *
 * @example
 * // JavaScript project (no tsconfig.json)
 * resolveSourceEntrypoint('/path/to/project', { main: 'index.js' })
 * // Returns: null
 */
export function resolveSourceEntrypoint(
  projectPath: string,
  packageJson: PackageJsonForResolution
): string | null;
```

### 1.3 Implementation Steps

```typescript
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Standard TypeScript source candidates in priority order.
 *
 * Order rationale:
 * - src/ is the most common convention
 * - lib/ is used by some projects
 * - root-level is fallback
 * - main.ts is less common than index.ts
 */
const TS_SOURCE_CANDIDATES = [
  'src/index.ts',
  'src/index.tsx',
  'src/index.mts',
  'src/main.ts',
  'src/main.tsx',
  'lib/index.ts',
  'lib/index.tsx',
  'index.ts',
  'index.tsx',
  'index.mts',
  'main.ts',
  'main.tsx',
] as const;

export function resolveSourceEntrypoint(
  projectPath: string,
  packageJson: { source?: string; main?: string }
): string | null {
  // Step 1: Check for TypeScript project indicator
  const tsconfigPath = join(projectPath, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    return null; // Not a TypeScript project
  }

  // Step 2: Check package.json "source" field (explicit source declaration)
  if (packageJson.source) {
    const sourcePath = join(projectPath, packageJson.source);
    if (existsSync(sourcePath)) {
      return packageJson.source;
    }
  }

  // Step 3: Try standard TypeScript source candidates
  for (const candidate of TS_SOURCE_CANDIDATES) {
    const candidatePath = join(projectPath, candidate);
    if (existsSync(candidatePath)) {
      return candidate;
    }
  }

  // Step 4: Not found - caller should fallback to main
  return null;
}
```

### 1.4 Exports

Add to `/packages/core/src/plugins/discovery/index.ts` (if exists) or ensure proper import in affected files.

---

## 2. Modification: `SimpleProjectDiscovery.ts`

**File:** `/packages/core/src/plugins/discovery/SimpleProjectDiscovery.ts`

### 2.1 Import Addition

**Location:** After line 5 (after existing imports)

```typescript
import { resolveSourceEntrypoint } from './resolveSourceEntrypoint.js';
```

### 2.2 Code Change

**Location:** Line 73

**Current code:**
```typescript
const entrypoint = packageJson.main || 'index.js';
```

**New code:**
```typescript
// Prefer TypeScript source over compiled output
const entrypoint = resolveSourceEntrypoint(projectPath, packageJson)
  ?? packageJson.main
  ?? 'index.js';
```

### 2.3 Full Context (lines 70-75)

**Before:**
```typescript
try {
  const packageJson: PackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const serviceName = packageJson.name || 'unnamed-service';
  const entrypoint = packageJson.main || 'index.js';

  // Используем NodeFactory для создания SERVICE ноды
```

**After:**
```typescript
try {
  const packageJson: PackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const serviceName = packageJson.name || 'unnamed-service';
  // Prefer TypeScript source over compiled output
  const entrypoint = resolveSourceEntrypoint(projectPath, packageJson)
    ?? packageJson.main
    ?? 'index.js';

  // Используем NodeFactory для создания SERVICE ноды
```

### 2.4 Interface Update (Optional)

If we want type safety for the `source` field, update the `PackageJson` interface at line 32:

```typescript
interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  source?: string;  // ADD THIS
  description?: string;
  dependencies?: Record<string, string>;
}
```

---

## 3. Modification: `ServiceDetector.ts`

**File:** `/packages/core/src/plugins/indexing/ServiceDetector.ts`

### 3.1 Import Addition

**Location:** After line 8 (after existing imports)

```typescript
import { resolveSourceEntrypoint } from '../discovery/resolveSourceEntrypoint.js';
```

### 3.2 Method Rewrite: `findEntryPoint()`

**Location:** Lines 206-235

**Current implementation:**
```typescript
private findEntryPoint(servicePath: string, packageJson: PackageJson | null): string | null {
  // 1. Из package.json main
  if (packageJson?.main) {
    return packageJson.main;
  }

  // 2. Стандартные entry points
  const candidates = [
    'src/index.js',
    'src/index.ts',
    // ... more candidates
  ];

  for (const candidate of candidates) {
    if (existsSync(join(servicePath, candidate))) {
      return candidate;
    }
  }

  return null;
}
```

**New implementation:**
```typescript
/**
 * Находит entry point сервиса
 *
 * Resolution priority:
 * 1. TypeScript source (via resolveSourceEntrypoint)
 * 2. package.json main field
 * 3. Standard fallback candidates
 */
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
  const candidates = [
    'src/index.js',
    'src/index.ts',
    'src/server.js',
    'src/server.ts',
    'src/main.js',
    'src/main.ts',
    'index.js',
    'index.ts',
    'server.js',
    'server.ts',
    'app.js',
    'app.ts'
  ];

  for (const candidate of candidates) {
    if (existsSync(join(servicePath, candidate))) {
      return candidate;
    }
  }

  return null;
}
```

### 3.3 Interface Update (Optional)

Add `source` field to `PackageJson` interface at line 32-36:

```typescript
interface PackageJson {
  name?: string;
  main?: string;
  source?: string;  // ADD THIS
  [key: string]: unknown;
}
```

---

## 4. Test Specification

**File:** `/test/unit/plugins/discovery/resolveSourceEntrypoint.test.ts`

### 4.1 Test Setup

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { resolveSourceEntrypoint } from '@grafema/core';
```

### 4.2 Test Cases

| # | Test Case | Setup | Expected |
|---|-----------|-------|----------|
| 1 | TypeScript project with src/index.ts | tsconfig.json + src/index.ts + package.json{main:"dist/index.js"} | Returns `'src/index.ts'` |
| 2 | TypeScript project with source field | tsconfig.json + lib/main.ts + package.json{source:"lib/main.ts"} | Returns `'lib/main.ts'` |
| 3 | JavaScript project (no tsconfig) | package.json{main:"index.js"} only | Returns `null` |
| 4 | TypeScript project without source files | tsconfig.json + package.json{main:"dist/index.js"} (no src/) | Returns `null` |
| 5 | TypeScript project with root index.ts | tsconfig.json + index.ts | Returns `'index.ts'` |
| 6 | Monorepo package with own tsconfig | packages/foo/tsconfig.json + packages/foo/src/index.ts | Returns `'src/index.ts'` |
| 7 | TSX entrypoint (React) | tsconfig.json + src/index.tsx | Returns `'src/index.tsx'` |

### 4.3 Test Implementation

```typescript
describe('resolveSourceEntrypoint', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-ts-resolve-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return src/index.ts for TypeScript project', () => {
    // Setup: TypeScript project
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'src/index.ts'), 'export const x = 1;');

    const result = resolveSourceEntrypoint(tempDir, { main: 'dist/index.js' });

    assert.strictEqual(result, 'src/index.ts');
  });

  it('should return null for JavaScript project', () => {
    // Setup: JS project (no tsconfig.json)
    writeFileSync(join(tempDir, 'index.js'), 'module.exports = {};');

    const result = resolveSourceEntrypoint(tempDir, { main: 'index.js' });

    assert.strictEqual(result, null);
  });

  it('should prefer source field over standard candidates', () => {
    // Setup: Project with custom source field
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    mkdirSync(join(tempDir, 'lib'));
    writeFileSync(join(tempDir, 'lib/main.ts'), 'export const x = 1;');
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'src/index.ts'), 'export const y = 2;');

    const result = resolveSourceEntrypoint(tempDir, {
      main: 'dist/index.js',
      source: 'lib/main.ts'
    });

    assert.strictEqual(result, 'lib/main.ts');
  });

  it('should return null when no source files exist', () => {
    // Setup: TypeScript project with only compiled output
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    mkdirSync(join(tempDir, 'dist'));
    writeFileSync(join(tempDir, 'dist/index.js'), 'exports.x = 1;');

    const result = resolveSourceEntrypoint(tempDir, { main: 'dist/index.js' });

    assert.strictEqual(result, null);
  });

  it('should find root-level index.ts', () => {
    // Setup: Root-level TypeScript
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    writeFileSync(join(tempDir, 'index.ts'), 'export const x = 1;');

    const result = resolveSourceEntrypoint(tempDir, { main: 'dist/index.js' });

    assert.strictEqual(result, 'index.ts');
  });

  it('should handle TSX files for React projects', () => {
    // Setup: React TypeScript project
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'src/index.tsx'), 'export const App = () => <div/>;');

    const result = resolveSourceEntrypoint(tempDir, { main: 'dist/index.js' });

    assert.strictEqual(result, 'src/index.tsx');
  });

  it('should prefer .ts over .tsx when both exist', () => {
    // Setup: Both .ts and .tsx exist
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'src/index.ts'), 'export const x = 1;');
    writeFileSync(join(tempDir, 'src/index.tsx'), 'export const App = () => <div/>;');

    const result = resolveSourceEntrypoint(tempDir, { main: 'dist/index.js' });

    // .ts comes before .tsx in candidates list
    assert.strictEqual(result, 'src/index.ts');
  });
});
```

---

## 5. Integration Test Specification

**File:** `/test/integration/TypeScriptProjectDiscovery.test.ts`

### 5.1 End-to-End Test

```typescript
describe('TypeScript Project Discovery Integration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-ts-integration-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should discover src/index.ts as entrypoint for TypeScript project', async () => {
    // Setup: Full TypeScript project
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test-ts-project',
      main: 'dist/index.js'
    }));
    writeFileSync(join(tempDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { outDir: './dist' }
    }));
    mkdirSync(join(tempDir, 'src'));
    writeFileSync(join(tempDir, 'src/index.ts'), `
      export function hello(): string {
        return 'Hello';
      }
    `);

    // Execute discovery
    const discovery = new SimpleProjectDiscovery();
    const mockGraph = new MockGraphBackend();
    const result = await discovery.execute({
      graph: mockGraph,
      projectPath: tempDir,
      phase: 'DISCOVERY'
    });

    // Verify
    assert.strictEqual(result.success, true);
    const service = result.metadata?.services?.[0];
    assert.ok(service, 'Should discover a service');
    assert.ok(
      service.metadata.entrypoint.endsWith('src/index.ts'),
      `Entrypoint should be src/index.ts, got: ${service.metadata.entrypoint}`
    );
  });

  it('should preserve JavaScript project behavior', async () => {
    // Setup: JavaScript project (no tsconfig)
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'test-js-project',
      main: 'index.js'
    }));
    writeFileSync(join(tempDir, 'index.js'), 'module.exports = {};');

    // Execute discovery
    const discovery = new SimpleProjectDiscovery();
    const mockGraph = new MockGraphBackend();
    const result = await discovery.execute({
      graph: mockGraph,
      projectPath: tempDir,
      phase: 'DISCOVERY'
    });

    // Verify: Behavior unchanged
    assert.strictEqual(result.success, true);
    const service = result.metadata?.services?.[0];
    assert.ok(service, 'Should discover a service');
    assert.ok(
      service.metadata.entrypoint.endsWith('index.js'),
      `Entrypoint should be index.js, got: ${service.metadata.entrypoint}`
    );
  });
});
```

---

## 6. Acceptance Criteria Mapping

| Acceptance Criteria | Implementation |
|---------------------|----------------|
| Given a TypeScript project with `main: "dist/index.js"` and `src/index.ts` exists, the indexer should analyze `src/index.ts` | `resolveSourceEntrypoint()` checks for tsconfig.json, returns `src/index.ts` if exists |
| If `src/index.ts` doesn't exist, fall back to `package.json.main` | `resolveSourceEntrypoint()` returns `null`, caller falls back to `main` |
| For JavaScript projects (no tsconfig.json), behavior is unchanged | Early return `null` when tsconfig.json doesn't exist |
| Monorepo support: each package checks its own tsconfig.json | `resolveSourceEntrypoint()` takes `projectPath` per service, not root |

---

## 7. Execution Order

### Phase 1: Kent Beck - Tests (TDD)

1. Create `/test/unit/plugins/discovery/resolveSourceEntrypoint.test.ts`
2. Write all 7 unit tests (all should fail initially)
3. Create `/test/integration/TypeScriptProjectDiscovery.test.ts`
4. Write 2 integration tests (should fail)

### Phase 2: Rob Pike - Implementation

1. Create `/packages/core/src/plugins/discovery/resolveSourceEntrypoint.ts`
2. Implement function per specification
3. Run unit tests until all pass
4. Modify `SimpleProjectDiscovery.ts` (add import, change line 73)
5. Modify `ServiceDetector.ts` (add import, rewrite `findEntryPoint()`)
6. Run integration tests until all pass
7. Run full test suite to verify no regressions

### Phase 3: Verification

1. Test on actual TypeScript project (e.g., Grafema itself)
2. Verify JavaScript projects unchanged
3. Manual verification of graph output

---

## 8. Files Changed Summary

| File | Action | Lines Changed |
|------|--------|---------------|
| `/packages/core/src/plugins/discovery/resolveSourceEntrypoint.ts` | CREATE | ~50 lines |
| `/packages/core/src/plugins/discovery/SimpleProjectDiscovery.ts` | MODIFY | +2 lines (import + logic) |
| `/packages/core/src/plugins/indexing/ServiceDetector.ts` | MODIFY | +1 import, ~10 lines in method |
| `/test/unit/plugins/discovery/resolveSourceEntrypoint.test.ts` | CREATE | ~100 lines |
| `/test/integration/TypeScriptProjectDiscovery.test.ts` | CREATE | ~80 lines |

**Total:** ~240 lines added, ~10 lines modified

---

## 9. Risk Assessment

| Risk | Mitigation |
|------|------------|
| Breaking JS projects | Early null return + fallback chain ensures unchanged behavior |
| Monorepo edge cases | Each service path checked independently |
| Performance (filesystem checks) | Only 1 tsconfig check + max 12 candidate checks per service |
| Missing edge cases | Comprehensive test coverage with 7+ test cases |

---

## 10. Non-Goals (Explicitly Out of Scope)

1. **Deep tsconfig.json parsing** - We don't read `rootDir` or `include`
2. **Workspace references** - TypeScript project references not supported
3. **Custom source locations** - Only standard candidates + `source` field
4. **Build tool integration** - No Webpack/Vite/etc config parsing
5. **JSModuleIndexer changes** - Indexer remains agnostic to source resolution

---

**Ready for Kent Beck to write tests.**
