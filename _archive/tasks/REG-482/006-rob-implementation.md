# Rob Implementation Report: REG-482

**Date:** 2026-02-16

## Summary

Implemented the plugin applicability filter for the ANALYSIS phase. The filter skips ANALYSIS plugins whose `covers` packages don't match the service's package.json dependencies, reducing unnecessary work on irrelevant analyzers.

## Changes Made

### 1. PhaseRunner.ts (core logic)

**File:** `packages/core/src/PhaseRunner.ts`

**`extractServiceDependencies()` method** (lines 171-194):
- Navigates `context.manifest.service.metadata.packageJson` safely via typed casts
- Merges `dependencies` + `devDependencies` + `peerDependencies` into a single `Set<string>`
- Type-guards each field (`typeof fieldValue === 'object'`) per Dijkstra's recommendation
- Returns empty Set when no packageJson exists (correct: framework analyzers should skip)

**ANALYSIS filter** (lines 355-367):
- Placed after the existing ENRICHMENT skip check in the sequential plugin loop
- Phase-guarded: only runs when `phaseName === 'ANALYSIS'`
- Plugins without `covers` or with empty `covers` always run (backward compatible)
- Uses `covers.some(pkg => serviceDeps.has(pkg))` for OR logic (any match = run)
- Logs skipped plugins at debug level with the `[SKIP]` prefix (matches existing pattern)

### 2. Plugin metadata updates (6 files)

| Plugin | File | `covers` Added |
|--------|------|---------------|
| ExpressAnalyzer | `plugins/analysis/ExpressAnalyzer.ts` | `['express']` |
| ExpressRouteAnalyzer | `plugins/analysis/ExpressRouteAnalyzer.ts` | `['express']` |
| ExpressResponseAnalyzer | `plugins/analysis/ExpressResponseAnalyzer.ts` | `['express']` |
| NestJSRouteAnalyzer | `plugins/analysis/NestJSRouteAnalyzer.ts` | `['@nestjs/common', '@nestjs/core']` |
| SocketIOAnalyzer | `plugins/analysis/SocketIOAnalyzer.ts` | `['socket.io', 'socket.io-client']` |
| ReactAnalyzer | `plugins/analysis/ReactAnalyzer.ts` | `['react']` |

### Plugins NOT modified (correct per revised plan)

- **JSASTAnalyzer** -- base parser, must always run
- **DatabaseAnalyzer** -- pattern-based (`db.query()` etc.), not package-specific
- **SQLiteAnalyzer** -- already has `covers: ['sqlite3', 'better-sqlite3']`
- **FetchAnalyzer** -- standard `fetch()` API, no package dependency
- **ServiceLayerAnalyzer** -- filename-pattern-based, not package-specific
- **SocketAnalyzer** -- uses Node.js built-in `net` module, pattern-based
- **SystemDbAnalyzer** -- internal API patterns, not package-specific
- **RustAnalyzer** -- file extension check (`.rs`), not npm-based
- **IncrementalAnalysisPlugin** -- infrastructure plugin

## Verification

- **Build:** `pnpm build` passes cleanly, no TypeScript errors
- **Tests:** All 2022 tests pass, 0 failures, 5 skipped, 22 todo

## Design Decisions

1. **`extractServiceDependencies` called per-plugin** -- could be hoisted before the loop for micro-optimization, but kept inside to match the existing pattern where context is accessed per-plugin. The Set construction is O(d) where d = dependency count, negligible compared to actual plugin execution.

2. **No caching of serviceDeps across loop iterations** -- for the same reason. Could add if profiling shows it matters, but the inner loop runs at most ~15 times per service.

3. **Exact string matching** -- `Set.has()` gives O(1) exact match. Prefix matching (`express` matching `express-session`) was considered and rejected per revised plan: explicit is predictable. Known limitation for edge cases where only sub-packages exist without the main package.
