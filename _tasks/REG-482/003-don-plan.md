# Don Plan: Plugin Applicability Filter (REG-482)

## Goal

Add filtering logic to skip ANALYSIS plugins that don't apply to the current service, based on package dependencies. A constant-factor optimization — keep it minimal.

## Problem

Currently, all 10 ANALYSIS plugins run for every service:
- ExpressAnalyzer runs on Rust-only services (wastes time)
- NestJSRouteAnalyzer runs on services without NestJS (parses files, returns empty)
- SQLiteAnalyzer runs on services without SQLite (silent skip pattern)

**Cost:** Wasted CPU on irrelevant analysis. Each plugin parses all MODULE nodes even when patterns can't exist.

## Solution: Dependency-Based Skip in PhaseRunner

Add filtering logic in `PhaseRunner.runPhase()` BEFORE executing each plugin.

**Decision:** Use `plugin.metadata.covers` field (already exists, used by PackageCoverageValidator) to match against service dependencies.

### Where to Add Filter

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/PhaseRunner.ts`
**Line:** Between 317-328 (in the `for` loop that executes plugins)

**Current code:**
```typescript
// Execute plugins sequentially (non-ENRICHMENT phases or non-batch backends)
for (let i = 0; i < phasePlugins.length; i++) {
  const plugin = phasePlugins[i];

  // Selective enrichment: skip enrichers whose consumed types didn't change
  if (phaseName === 'ENRICHMENT' && supportsBatch) {
    if (this.shouldSkipEnricher(plugin, accumulatedTypes)) {
      logger.debug(
        `[SKIP] ${plugin.metadata.name} — no changes in consumed types [${(plugin.metadata.consumes ?? []).join(', ')}]`
      );
      continue;
    }
  }

  onProgress({ ... });
  const delta = await this.executePlugin(plugin, context, phaseName);
  ...
}
```

**Add filtering logic after line 320** (after the ENRICHMENT skip check).

### Filter Logic (Pseudo-code)

```typescript
// NEW: Plugin applicability filter for ANALYSIS phase
if (phaseName === 'ANALYSIS') {
  const covers = plugin.metadata.covers;

  // Skip if plugin declares covers but none match service dependencies
  if (covers && covers.length > 0) {
    const serviceDeps = extractServiceDependencies(context);
    const hasOverlap = covers.some(pkg => serviceDeps.has(pkg));

    if (!hasOverlap) {
      logger.debug(
        `[SKIP] ${plugin.metadata.name} — no covered packages in service dependencies`
      );
      continue;
    }
  }
}
```

**Rules:**
1. Only applies to ANALYSIS phase (ENRICHMENT has separate skip logic)
2. Plugins WITHOUT `covers` field → always run (backward compatible)
3. Plugins WITH `covers` but empty array → always run (edge case)
4. Plugins WITH `covers` → check overlap with service deps → skip if no match

### Extracting Service Dependencies

Need helper function to get dependency list from context.

**Where dependencies live:**
- Discovery plugins return `ServiceInfo` with `metadata.packageJson`
- `DiscoveryManager.buildIndexingUnits()` spreads service, preserving all fields (line 72)
- `Orchestrator.runBatchPhase()` creates `UnitManifest` from `IndexingUnit`, preserves spread (line 378)
- Available at: `(context.manifest as UnitManifest).service.metadata?.packageJson?.dependencies`

**Helper function:**
```typescript
private extractServiceDependencies(context: Partial<PluginContext>): Set<string> {
  const manifest = context.manifest as any;
  const packageJson = manifest?.service?.metadata?.packageJson;

  if (!packageJson?.dependencies) {
    return new Set();
  }

  return new Set(Object.keys(packageJson.dependencies));
}
```

**Edge cases:**
- Service without package.json → empty Set → plugins with `covers` will skip
- Service with empty dependencies → empty Set → skip
- Non-service unit (raw entrypoint) → no metadata → empty Set → skip

This is CORRECT behavior — if there's no package.json, framework-specific analyzers shouldn't run.

## Which Plugins Need `covers` Updates

**Location:** `/Users/vadimr/grafema-worker-1/packages/core/src/plugins/analysis/`

| Plugin | Current `covers` | Should Be |
|--------|------------------|-----------|
| JSASTAnalyzer | (none) | (none) — base parser, always run |
| ExpressRouteAnalyzer | (none) | `['express']` |
| ExpressResponseAnalyzer | (none) | `['express']` |
| ExpressAnalyzer | (none) | `['express']` |
| NestJSRouteAnalyzer | (none) | `['@nestjs/common', '@nestjs/core']` |
| SocketIOAnalyzer | (none) | `['socket.io']` |
| DatabaseAnalyzer | (none) | `['pg', 'mysql', 'mysql2']` |
| SQLiteAnalyzer | `['sqlite3', 'better-sqlite3']` | (already has) |
| FetchAnalyzer | (none) | (none) — uses standard `fetch()`, no package |
| ServiceLayerAnalyzer | (none) | (none) — pattern-based, not package-based |
| ReactAnalyzer | (none) | `['react']` |
| RustAnalyzer | (none) | (special case, see below) |

**Notes:**
- SQLiteAnalyzer ALREADY has `covers` — no change needed
- FetchAnalyzer and ServiceLayerAnalyzer analyze patterns, not packages — no `covers`
- JSASTAnalyzer is base parser — no `covers`, must always run

### Special Case: RustAnalyzer

RustAnalyzer checks file extensions (`.rs`), not npm packages.

**Current logic:**
```typescript
// RustAnalyzer.ts, line ~150
for (const module of modules) {
  if (!module.file?.endsWith('.rs')) continue;
  // ... analyze Rust file
}
```

**Decision:** Leave as-is. Rust files won't have MODULE nodes unless there's a Rust service, and RustAnalyzer already has file extension check. Adding `covers: ['rust-crate-name']` doesn't make sense since Cargo.toml deps aren't in npm packageJson.

**Future:** If we add Cargo.toml parsing to discovery, can add `covers` for Rust packages.

## Implementation Steps

### Step 1: Add Helper Method to PhaseRunner

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/PhaseRunner.ts`
**Location:** After `shouldSkipEnricher()` method (around line 185)

```typescript
/**
 * Extract service dependencies from ANALYSIS phase manifest.
 * Returns Set of package names from package.json dependencies.
 */
private extractServiceDependencies(
  context: Partial<PluginContext>
): Set<string> {
  const manifest = context.manifest as any;
  const packageJson = manifest?.service?.metadata?.packageJson;

  if (!packageJson?.dependencies) {
    return new Set();
  }

  return new Set(Object.keys(packageJson.dependencies));
}
```

### Step 2: Add Filter Logic in runPhase()

**File:** `/Users/vadimr/grafema-worker-1/packages/core/src/PhaseRunner.ts`
**Location:** After line 328 (after ENRICHMENT skip check)

```typescript
// Plugin applicability filter for ANALYSIS phase (REG-482)
if (phaseName === 'ANALYSIS') {
  const covers = plugin.metadata.covers;

  // Skip if plugin covers specific packages but none are in service dependencies
  if (covers && covers.length > 0) {
    const serviceDeps = this.extractServiceDependencies(context);
    const hasOverlap = covers.some(pkg => serviceDeps.has(pkg));

    if (!hasOverlap) {
      logger.debug(
        `[SKIP] ${plugin.metadata.name} — no covered packages in service dependencies`,
        { covers, serviceDeps: [...serviceDeps] }
      );
      continue;
    }
  }
}
```

### Step 3: Update Plugin Metadata

Add `covers` field to 7 plugins:

1. **ExpressRouteAnalyzer.ts** (line ~70)
   ```typescript
   get metadata(): PluginMetadata {
     return {
       name: 'ExpressRouteAnalyzer',
       phase: 'ANALYSIS',
       covers: ['express'],  // NEW
       creates: { ... },
       dependencies: ['JSASTAnalyzer']
     };
   }
   ```

2. **ExpressResponseAnalyzer.ts** (line ~45)
   ```typescript
   covers: ['express'],  // NEW
   ```

3. **ExpressAnalyzer.ts** (line ~70)
   ```typescript
   covers: ['express'],  // NEW
   ```

4. **NestJSRouteAnalyzer.ts** (line ~70)
   ```typescript
   covers: ['@nestjs/common', '@nestjs/core'],  // NEW
   ```

5. **SocketIOAnalyzer.ts** (line ~55)
   ```typescript
   covers: ['socket.io'],  // NEW
   ```

6. **DatabaseAnalyzer.ts** (line ~55)
   ```typescript
   covers: ['pg', 'mysql', 'mysql2'],  // NEW
   ```

7. **ReactAnalyzer.ts** (line ~42)
   ```typescript
   covers: ['react'],  // NEW
   ```

**NO CHANGES:**
- JSASTAnalyzer (base parser)
- FetchAnalyzer (standard API)
- ServiceLayerAnalyzer (pattern-based)
- RustAnalyzer (file extension check)
- SQLiteAnalyzer (already has `covers`)

## Testing Strategy

### Unit Test: extractServiceDependencies()

**File:** `test/unit/PhaseRunner.test.js` (create if doesn't exist)

Test cases:
1. Service with dependencies → returns Set with packages
2. Service without packageJson → returns empty Set
3. Service with empty dependencies → returns empty Set
4. Non-service unit (entrypoint) → returns empty Set

### Integration Test: Plugin Skip Logic

Mock scenario:
- Service with `{ dependencies: { express: "4.18.0" } }`
- Plugins: ExpressAnalyzer (covers: ['express']), NestJSRouteAnalyzer (covers: ['@nestjs/common'])
- Expected: ExpressAnalyzer runs, NestJSRouteAnalyzer skips

### Smoke Test: Real Analysis

Run `grafema analyze` on:
1. Express-only project → verify NestJS/React/SocketIO analyzers skip
2. React-only project → verify Express/NestJS/SocketIO analyzers skip
3. Rust-only project → verify all JS/TS analyzers skip (no MODULE nodes created)

Check debug logs for `[SKIP]` messages.

## Edge Cases

### 1. Service Without package.json

**Scenario:** Raw entry point without package.json (e.g., standalone script)
**Behavior:** `extractServiceDependencies()` returns empty Set → all plugins with `covers` skip
**Correct?** YES. If no dependencies, framework-specific analyzers shouldn't run.

### 2. Monorepo with Shared Dependencies

**Scenario:** Service imports `express` but it's in root package.json, not service package.json
**Behavior:** Service packageJson has no `express` dependency → ExpressAnalyzer skips
**Correct?** NO — this is a gap.

**Solution:** Out of scope for REG-482. Note as known limitation. Future: REG-483 to handle monorepo dependency resolution.

### 3. Plugin with Multiple Covers

**Example:** `covers: ['pg', 'mysql', 'mysql2']`
**Behavior:** Plugin runs if ANY package matches (OR logic)
**Correct?** YES. DatabaseAnalyzer should run if ANY database client is present.

### 4. Scoped Packages

**Example:** Service has `@nestjs/common`, plugin covers `['@nestjs/common', '@nestjs/core']`
**Behavior:** Match found → plugin runs
**Correct?** YES. `Set.has()` exact match works for scoped packages.

### 5. Subpath Imports

**Example:** Service imports `lodash/map`, package.json has `lodash`
**Behavior:** `extractServiceDependencies()` returns `'lodash'` (key from package.json) → match works
**Correct?** YES. Dependencies are package names, not import paths.

## Non-Goals (Out of Scope)

1. **File extension filtering** — RustAnalyzer already handles this, no generalization needed
2. **Monorepo dependency resolution** — defer to REG-483
3. **Config-based plugin enable/disable** — already handled by plugin loading
4. **Dynamic plugin applicability** — no `isApplicable()` interface, keep it simple
5. **ENRICHMENT phase filtering** — already has selective enrichment (RFD-16)
6. **VALIDATION phase filtering** — validation runs on full graph, not per-service

## Minimal Change Set

**Files changed: 9**

1. `PhaseRunner.ts` — add helper + filter logic (~25 lines)
2. `ExpressRouteAnalyzer.ts` — add `covers` (1 line)
3. `ExpressResponseAnalyzer.ts` — add `covers` (1 line)
4. `ExpressAnalyzer.ts` — add `covers` (1 line)
5. `NestJSRouteAnalyzer.ts` — add `covers` (1 line)
6. `SocketIOAnalyzer.ts` — add `covers` (1 line)
7. `DatabaseAnalyzer.ts` — add `covers` (1 line)
8. `ReactAnalyzer.ts` — add `covers` (1 line)
9. `PhaseRunner.test.js` — unit tests (~50 lines)

**Total LOC change: ~90 lines**

## Expected Impact

**Before:** All 10 ANALYSIS plugins run for all services.

**After (example scenarios):**

### Express-only Service
- **Run:** JSASTAnalyzer, ExpressAnalyzer, ExpressRouteAnalyzer, ExpressResponseAnalyzer, FetchAnalyzer, ServiceLayerAnalyzer (6/10)
- **Skip:** NestJSRouteAnalyzer, SocketIOAnalyzer, DatabaseAnalyzer, ReactAnalyzer (4/10)
- **Savings:** 40% reduction

### React-only Service
- **Run:** JSASTAnalyzer, ReactAnalyzer, FetchAnalyzer, ServiceLayerAnalyzer (4/10)
- **Skip:** All Express/NestJS/Socket/DB analyzers (6/10)
- **Savings:** 60% reduction

### Rust-only Service
- **Run:** RustAnalyzer only (1/10)
- **Skip:** All JS/TS analyzers (9/10)
- **Savings:** 90% reduction (but already fast due to no MODULE nodes)

**Note:** Actual time savings depend on how long each plugin takes. Plugins that parse all files get biggest win.

## Questions for User

1. Should this apply ONLY to ANALYSIS phase, or also INDEXING? (My recommendation: ANALYSIS only, INDEXING is fast)
2. Monorepo dependency resolution — acknowledge as known limitation or blocker? (My recommendation: known limitation, defer to future task)
3. Test coverage — unit tests enough, or need integration test suite? (My recommendation: unit tests + manual smoke test)

## Next Steps After Approval

1. Kent writes tests for `extractServiceDependencies()` and skip logic
2. Rob implements PhaseRunner changes + plugin metadata updates
3. Manual smoke test on Express, React, and Rust projects
4. Check debug logs for correct skip behavior
5. Update Linear with any discovered gaps (monorepo case)

---

**Complexity:** O(1) per plugin per service. Constant-factor optimization, no algorithmic complexity.

**Risk:** LOW. Backward compatible (plugins without `covers` always run), no behavioral changes for existing graphs.

**Effort:** Small (1-2 hours implementation + tests).
