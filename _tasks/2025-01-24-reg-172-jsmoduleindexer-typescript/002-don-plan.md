# Don Melton - Tech Lead Analysis

## REG-172: JSModuleIndexer uses dist/ instead of src/ for TypeScript projects

---

## 1. Current State Analysis

### How Entrypoints Work Now

There are **two discovery paths** for service entrypoints:

#### Path A: SimpleProjectDiscovery (Default)

**File:** `/packages/core/src/plugins/discovery/SimpleProjectDiscovery.ts`

```typescript
// Line 73: Always uses package.json main field
const entrypoint = packageJson.main || 'index.js';
```

This is the **primary problem location**. It blindly trusts `package.json.main`, which in TypeScript projects points to compiled output.

**Flow:**
1. `SimpleProjectDiscovery.execute()` reads `package.json`
2. Uses `main` field as entrypoint (line 73)
3. Creates `ServiceInfo.metadata.entrypoint` pointing to `dist/index.js`
4. Orchestrator passes this to JSModuleIndexer

#### Path B: ServiceDetector (Fallback)

**File:** `/packages/core/src/plugins/indexing/ServiceDetector.ts`

```typescript
// Line 206-235: findEntryPoint() method
private findEntryPoint(servicePath: string, packageJson: PackageJson | null): string | null {
  // 1. Из package.json main
  if (packageJson?.main) {
    return packageJson.main;  // <-- SAME BUG
  }

  // 2. Стандартные entry points (fallback)
  const candidates = [
    'src/index.js',
    'src/index.ts',   // TS candidates exist!
    'src/server.js',
    'src/server.ts',
    ...
  ];
```

ServiceDetector **has partial TypeScript awareness** (it checks for `.ts` candidates), but ONLY as fallback when `main` is missing. The problem: `main` is almost always present in TS projects.

### Where JSModuleIndexer Receives Entrypoint

**File:** `/packages/core/src/plugins/indexing/JSModuleIndexer.ts`

```typescript
// Line 229-235: Execute method
const entrypoint = service.path;  // From manifest

const absoluteEntrypoint = entrypoint.startsWith('/')
  ? entrypoint
  : join(projectPath, entrypoint);
```

JSModuleIndexer **does not determine** the entrypoint. It receives it from the discovery phase via `context.manifest.service.path`. The indexer itself is innocent - it just uses what it's given.

### The Resolution Chain

```
package.json
    ↓
SimpleProjectDiscovery (reads main: "dist/index.js")
    ↓
Orchestrator.buildIndexingUnits() (creates IndexingUnit with path)
    ↓
JSModuleIndexer (receives dist/index.js, indexes it)
```

---

## 2. Where Exactly the Change Should Be Made

### Primary Fix Location: `SimpleProjectDiscovery.ts`

**File:** `/packages/core/src/plugins/discovery/SimpleProjectDiscovery.ts`
**Lines:** 70-74

Current:
```typescript
const packageJson: PackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const serviceName = packageJson.name || 'unnamed-service';
const entrypoint = packageJson.main || 'index.js';
```

Should become:
```typescript
const packageJson: PackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const serviceName = packageJson.name || 'unnamed-service';
const entrypoint = resolveSourceEntrypoint(projectPath, packageJson);
```

Where `resolveSourceEntrypoint()` is a new function that:
1. Checks if `tsconfig.json` exists
2. If TypeScript: prefers source candidates over `main`
3. Falls back to `main` only if source not found

### Secondary Fix Location: `ServiceDetector.ts`

**File:** `/packages/core/src/plugins/indexing/ServiceDetector.ts`
**Method:** `findEntryPoint()` (lines 206-235)

Same logic applies. Current code checks `main` first, should check TypeScript source first.

---

## 3. High-Level Approach

### The Right Solution: Teach Discovery to Prefer Source

**Philosophy:** Discovery plugins should understand the project type and choose appropriate entrypoints. JSModuleIndexer should remain agnostic.

### Implementation Steps

1. **Create utility function** `resolveTypescriptEntrypoint(projectPath: string, packageJson: PackageJson): string | null`
   - Check for `tsconfig.json` existence
   - Try `source` or `module` fields in package.json (used by bundlers)
   - Try standard source candidates: `src/index.ts`, `src/index.tsx`, etc.
   - Optionally parse `tsconfig.json.include` or `rootDir` for hints
   - Return null if not TypeScript or source not found

2. **Update `SimpleProjectDiscovery.execute()`**
   ```typescript
   // Try TypeScript source first
   let entrypoint = resolveTypescriptEntrypoint(projectPath, packageJson);
   // Fallback to package.json main
   if (!entrypoint) {
     entrypoint = packageJson.main || 'index.js';
   }
   ```

3. **Update `ServiceDetector.findEntryPoint()`**
   - Same pattern: TypeScript source first, then `main`, then candidates

4. **Add tests** for:
   - TypeScript project with `main: "dist/index.js"` and `src/index.ts` existing
   - TypeScript project with only `dist/` (no source) - should use `main`
   - Non-TypeScript project - should use `main` as before
   - Project with `source` field in package.json
   - Monorepo with multiple packages (each with own tsconfig)

---

## 4. Edge Cases to Consider

### 4.1 Monorepos with Multiple tsconfig.json

**Situation:** Each package has its own `tsconfig.json`

**Solution:** Check for `tsconfig.json` **in the service directory**, not project root. ServiceDetector already scopes to each service directory.

### 4.2 Projects Using `source` or `module` Fields

**Situation:** Some projects (especially libraries) use:
```json
{
  "main": "dist/index.js",
  "module": "dist/index.esm.js",
  "source": "src/index.ts"
}
```

**Solution:** Check `source` field first (it's explicitly the source!), then `module` if it points to `.ts`, then try candidates.

### 4.3 tsconfig.json with `rootDir` Configuration

**Situation:**
```json
{
  "compilerOptions": {
    "rootDir": "./lib"
  }
}
```

**Solution:**
- **Phase 1 (MVP):** Don't parse tsconfig.json, just try standard candidates
- **Phase 2 (if needed):** Parse `rootDir` and use it as hint

We should NOT over-engineer. Standard candidates (`src/`, root) cover 99% of projects.

### 4.4 Projects Without src/ Folder

**Situation:** Some projects use `lib/` or root-level TypeScript

**Solution:** Candidate list should include:
```typescript
const TS_CANDIDATES = [
  'src/index.ts',
  'src/index.tsx',
  'src/index.mts',
  'lib/index.ts',
  'index.ts',
  'index.tsx',
  'index.mts',
  'src/main.ts',
  'main.ts',
];
```

### 4.5 Mixed JS/TS Projects

**Situation:** Project has `tsconfig.json` but entrypoint is `.js`

**Solution:** If TypeScript candidates don't exist, fall back to `main` or JS candidates. The existence of `tsconfig.json` alone doesn't guarantee TS entrypoint.

---

## 5. What NOT to Do (Scope Limits)

### DO NOT:

1. **Modify JSModuleIndexer** - It's not the indexer's job to determine entrypoints. It should remain a pure "index what you're given" plugin.

2. **Parse tsconfig.json deeply** - Phase 1 doesn't need to understand TypeScript configuration. Just check existence and try standard paths.

3. **Add new dependencies** - Use Node.js built-ins only (`fs.existsSync`, `path.join`).

4. **Change Orchestrator flow** - The fix is entirely in discovery plugins.

5. **Support exotic setups** - If someone has `"rootDir": "./weird/path/to/src"`, that's edge case for Phase 2.

6. **Break existing behavior for JS projects** - This must be purely additive. Projects without `tsconfig.json` must behave exactly as before.

---

## 6. Alignment Check

### Does This Align With Project Vision?

**"AI should query the graph, not read code."**

Yes. By indexing source instead of compiled output:
- Graph contains semantic information (types, interfaces, decorators)
- TypeScript-specific constructs become queryable
- Source maps/debug info not needed

**"Every function must be documented for LLM-based agents."**

The new `resolveTypescriptEntrypoint()` function must have clear docstring explaining:
- When to use it
- What it returns
- What it falls back to

### TDD Approach

Kent Beck should write tests FIRST for:
1. TypeScript project detection
2. Source entrypoint resolution
3. Fallback behavior
4. Edge cases (monorepo, mixed, no-src)

---

## 7. Summary

| Component | Action | Priority |
|-----------|--------|----------|
| `SimpleProjectDiscovery.ts` | Add TS source resolution before `main` | **Primary** |
| `ServiceDetector.ts` | Same fix for consistency | Secondary |
| New utility function | `resolveTypescriptEntrypoint()` | **Primary** |
| Tests | Cover all 4 acceptance criteria | **Primary** |
| JSModuleIndexer | **No changes** | - |

**Estimated complexity:** Small (< 100 LOC)
**Risk:** Low - additive change with fallback to existing behavior
**Dependencies:** None

---

## 8. Next Steps

1. Joel expands this into detailed technical spec with exact code locations and function signatures
2. Kent writes tests for TypeScript project detection and source resolution
3. Rob implements the fix
4. Reviewers verify no regression for JS-only projects

**Ready for Joel's technical plan.**
