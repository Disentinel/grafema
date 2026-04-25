# Uncle Bob Review: REG-259 Package Coverage Tracking

## Executive Summary

**CRITICAL ISSUES FOUND:**

Five files exceed hard limits (>300 lines). This task will modify files already violating size constraints. We must address the file size crisis before proceeding with implementation.

**Recommendation:** REJECT implementation until critical files are split. 6k-line files happen when we ignore 1200-line files.

---

## File-Level Review (HARD LIMITS)

### CRITICAL: Orchestrator.ts
- **File size:** 1248 lines — **CRITICAL** (416% over limit)
- **Status:** MUST SPLIT before ANY modifications
- **Risk:** Modifying a 1200-line god object creates cascading technical debt

**Action Required:**
This file needs architectural refactoring BEFORE we add coverage tracking. The file combines:
1. Discovery coordination
2. Phase execution
3. Batch management
4. Worker pool management
5. Resource registry creation
6. Graph backend initialization
7. Progress reporting

**Split Strategy (proposed):**
1. Extract `DiscoveryCoordinator` (discovery + service resolution) → 200 lines
2. Extract `ResourceManager` (resource registry + routing map) → 150 lines
3. Keep orchestration logic in `Orchestrator` → 400 lines
4. Extract `WorkerPoolManager` (parallel config + worker spawning) → 200 lines
5. Leave `PhaseRunner` as is (already extracted)

**Estimated effort:** 2-3 days to split safely with tests

### CRITICAL: ConfigLoader.ts
- **File size:** 645 lines — **CRITICAL** (215% over limit)
- **Status:** MUST SPLIT
- **Issues:** Combines config loading, validation, version checking, defaults

**Split Strategy:**
1. `ConfigValidator.ts` — all validation functions (200 lines)
2. `ConfigDefaults.ts` — DEFAULT_CONFIG constant (150 lines)
3. `ConfigLoader.ts` — loading logic only (200 lines)

### CRITICAL: PhaseRunner.ts
- **File size:** 448 lines — **CRITICAL** (149% over limit)
- **Status:** MUST SPLIT
- **Recently created:** Extracted from Orchestrator (RFD-16, STEP 2.5)

**Split Strategy:**
1. `EnrichmentQueue.ts` — dependency propagation logic (150 lines)
2. `BatchExecutor.ts` — runPluginWithBatch + batch handling (100 lines)
3. `PhaseRunner.ts` — main execution loop (200 lines)

### CRITICAL: SQLiteAnalyzer.ts
- **File size:** 417 lines — **CRITICAL** (139% over limit)
- **Status:** MUST SPLIT before adding `covers` field
- **Task Impact:** We need to modify metadata in this file

**Split Strategy:**
1. `SQLitePatternDetector.ts` — pattern detection logic (200 lines)
   - `detectOperationType()`
   - `extractTableName()`
   - `extractTemplateLiteral()`
   - `getObjectName()`
2. `SQLiteAnalyzer.ts` — orchestration + node creation (200 lines)

**Method-level issues in SQLiteAnalyzer:**
- `analyzeModule()`: 246 lines (lines 101-347) — **MUST SPLIT**
  - Extract Promise-wrapped pattern detection → separate method
  - Extract query node creation → separate method
  - Extract function containment logic → separate method

### WARNING: plugins.ts
- **File size:** 354 lines — **MUST SPLIT** (118% over limit)
- **Task Impact:** Adding `covers?: string[]` to PluginMetadata (minimal change)
- **Status:** Type definitions file, mostly interfaces

**Action:**
This file is borderline. Since we're only adding ONE field to an interface, we can defer split to tech debt. Create Linear issue for future split.

**Proposed split (future):**
1. `plugin-metadata.ts` — PluginMetadata, PluginPhase, PLUGIN_PHASE
2. `plugin-context.ts` — PluginContext, Logger, IssueSpec
3. `plugin-result.ts` — PluginResult, helper functions
4. `plugin-config.ts` — OrchestratorConfig, ServiceDefinition

### OK: Other files
- `builtinPlugins.ts`: 106 lines — **OK**
- `index.ts`: 383 lines — **WARNING** (128% over limit, but export-only, defer)

---

## Method-Level Review

### SQLiteAnalyzer.ts (file we're modifying)

**Method: analyzeModule() — Lines 101-347**
- **Length:** 246 lines — **MUST SPLIT**
- **Issues:**
  - Two nested CallExpression visitors (pattern 1 + pattern 2)
  - Query extraction duplicated in both visitors
  - Function containment logic mixed with AST traversal
- **Recommendation:** REFACTOR before adding coverage field

**Split Plan for analyzeModule():**
1. Extract `detectDirectDbCalls()` — pattern 1 detection
2. Extract `detectPromiseWrappedDbCalls()` — pattern 2 detection
3. Extract `createQueryNode()` — deduplication of query parsing
4. Extract `findContainingFunctions()` — function containment
5. Keep `analyzeModule()` as coordinator

**Complexity:**
- Nesting depth: 4 levels (try → traverse → visitor → inner visitor)
- Duplication: Query extraction code appears twice
- Mixed concerns: AST traversal + graph node creation + edge creation

---

## Risk Assessment

### HIGH RISK: Modifying Orchestrator/PhaseRunner without splitting

**Scenario:** We add `coveredPackages` tracking to 1248-line Orchestrator.

**Consequences:**
- File becomes 1300+ lines
- Harder to test coverage tracking in isolation
- Coverage logic buried in god object
- Next feature adds another 50 lines → 1350 lines
- Cycle continues → 6k-line file (we've seen this before)

**Probability:** 90% — this is exactly how technical debt accumulates

### MEDIUM RISK: Modifying SQLiteAnalyzer without splitting

**Scenario:** Add `covers: ['better-sqlite3']` to metadata.

**Direct Impact:** +1 line to metadata getter
**Indirect Impact:** None if we only modify metadata

**Safe Path:**
1. Add `covers` field to metadata — **SAFE** (1 line change)
2. Create tech debt issue for SQLiteAnalyzer split
3. Do NOT touch `analyzeModule()` method

### LOW RISK: Adding covers field to PluginMetadata

**Change:** Add optional `covers?: string[]` to interface
**Impact:** 1 line in 354-line file
**Safe:** Yes, interface extension is non-invasive

---

## Recommendations

### Option 1: REJECT — Fix file sizes first (RECOMMENDED)

**Rationale:**
- Root Cause Policy: Fix from roots, not symptoms
- Modifying oversized files makes them worse
- This task is small enough to defer

**Actions:**
1. STOP implementation of REG-259
2. Create Linear issues for file splits:
   - REG-XXX: Split Orchestrator.ts (1248 → 3x 300-line files)
   - REG-XXX: Split ConfigLoader.ts (645 → 3x 200-line files)
   - REG-XXX: Split PhaseRunner.ts (448 → 3x 150-line files)
   - REG-XXX: Split SQLiteAnalyzer.ts (417 → 2x 200-line files)
   - REG-XXX: Split plugins.ts (354 → 4x 90-line files)
3. Complete splits before implementing REG-259
4. Estimated total effort: 1 week

**ROI:**
- Prevents accumulation of more debt
- Makes coverage tracking testable in isolation
- Follows project principles (TDD, Clean Code)

### Option 2: APPROVE with Tech Debt — Minimal changes only

**Conditions (NON-NEGOTIABLE):**
1. Do NOT modify Orchestrator.ts or PhaseRunner.ts
2. Do NOT modify ConfigLoader.ts
3. Add `covers` field to PluginMetadata interface ONLY
4. Add `covers` metadata to SQLiteAnalyzer metadata getter ONLY
5. Store `coveredPackages` in **NEW FILE** (not Orchestrator)
6. Create 5 Linear issues for file splits (v0.2 label)

**Safe Implementation Path:**
1. `packages/types/src/plugins.ts`: Add `covers?: string[]` to PluginMetadata
2. `packages/core/src/plugins/analysis/SQLiteAnalyzer.ts`: Add `covers: ['better-sqlite3']`
3. Create **NEW FILE** `packages/core/src/core/PackageCoverageTracker.ts` for coverage logic
4. Export from `packages/core/src/index.ts`
5. Tests in dedicated test file

**No changes to:**
- Orchestrator.ts (1248 lines — too big to touch)
- PhaseRunner.ts (448 lines — too big to touch)
- ConfigLoader.ts (645 lines — too big to touch)

**Linear issues created:**
- Tag all as: label=`Tech Debt`, version=`v0.2`, team=`Reginaflow`

---

## Coverage Tracking Implementation (if Option 2 approved)

### New File: PackageCoverageTracker.ts

```typescript
/**
 * PackageCoverageTracker - tracks which npm packages are covered by analysis plugins
 *
 * Purpose: Help users understand which packages have dedicated analyzers.
 *
 * Usage:
 *   const tracker = new PackageCoverageTracker();
 *   const coverage = tracker.analyzeCoverage(plugins, packageJson);
 *   // coverage.covered: ['better-sqlite3', 'express']
 *   // coverage.uncovered: ['axios', 'lodash']
 */

import type { PluginMetadata } from '@grafema/types';

export interface CoverageResult {
  covered: string[];
  uncovered: string[];
  total: number;
}

export class PackageCoverageTracker {
  getCoveredPackages(plugins: PluginMetadata[]): Set<string> {
    const covered = new Set<string>();
    for (const plugin of plugins) {
      if (plugin.covers) {
        for (const pkg of plugin.covers) {
          covered.add(pkg);
        }
      }
    }
    return covered;
  }

  analyzeCoverage(
    plugins: PluginMetadata[],
    dependencies: Record<string, string>
  ): CoverageResult {
    const covered = this.getCoveredPackages(plugins);
    const allPackages = Object.keys(dependencies);
    const uncovered = allPackages.filter(pkg => !covered.has(pkg));

    return {
      covered: Array.from(covered).sort(),
      uncovered: uncovered.sort(),
      total: allPackages.length,
    };
  }
}
```

**Rationale:**
- Isolated in dedicated file (testable)
- No modification to oversized files
- Single Responsibility
- ~60 lines total

---

## Estimated Scope

### Option 1 (Fix files first):
- File splits: 5 files × 1-2 days = 5-10 days
- REG-259 implementation: 1 day
- **Total: 6-11 days**

### Option 2 (Minimal changes + tech debt):
- Add `covers` field: 2 hours
- Create `PackageCoverageTracker.ts`: 4 hours
- Tests: 2 hours
- Create 5 Linear issues: 1 hour
- **Total: 1 day**
- **Future cost:** 5-10 days for file splits (deferred to v0.2)

---

## Decision Required

**Question for user:**

We have a file size crisis. Five files exceed the 300-line hard limit, including files we need to modify. Do we:

1. **Fix the root cause** — Split oversized files first, then implement feature (6-11 days)
2. **Defer to tech debt** — Minimal changes only, create Linear issues for splits (1 day + future cost)

**Uncle Bob's recommendation:** Option 1 (Root Cause Policy)

**Pragmatic alternative:** Option 2 with STRICT scope limits

**UNACCEPTABLE:** Modifying Orchestrator.ts (1248 lines) or PhaseRunner.ts (448 lines) without splitting them first.
