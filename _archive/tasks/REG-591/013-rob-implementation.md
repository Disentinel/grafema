# REG-591: Implementation Report

**Author:** Rob Pike, Implementation Engineer
**Date:** 2026-03-01
**Status:** IMPLEMENTED --- ready for review

---

## Summary

Implemented the Plugin API for domain analyzers in core-v2 across 5 logical changes. All changes compile cleanly and existing tests pass.

---

## Change 1: argValues in expressions.ts

**File:** `packages/core-v2/src/visitors/expressions.ts`

- Added `TemplateLiteral` to the `@babel/types` import list
- Added `argValues` extraction loop before the CALL node construction
- Handles `StringLiteral`, zero-expression `TemplateLiteral` (with cooked/raw fallback), and everything else as `null`
- Added `argValues` field to CALL node metadata alongside existing `arguments` and `chained` fields
- Invariant: `argValues.length === call.arguments.length` always holds

---

## Change 2: DomainPlugin interfaces in types.ts

**File:** `packages/core-v2/src/types.ts`

- Added `File` to the existing `@babel/types` import
- Added `DomainPluginResult` interface: `{ nodes: GraphNode[], edges: GraphEdge[], deferred?: DeferredRef[] }`
- Added `DomainPlugin` interface: `{ name: string, analyzeFile(fileResult, ast): DomainPluginResult }`
- Full JSDoc on both interfaces documenting contracts and when/when-not to use

**File:** `packages/core-v2/src/index.ts`

- Exported `DomainPlugin` and `DomainPluginResult` types
- Exported `WalkOptions` type from `./walk.js`

---

## Change 3: walkFile hook in walk.ts

**File:** `packages/core-v2/src/walk.ts`

- Added `DomainPlugin` to type imports
- Added `WalkOptions` interface: `{ domainPlugins?: readonly DomainPlugin[], strict?: boolean }`
  - Per Uncle Bob's recommendation: parameter object instead of positional args
  - Old `strict = true` positional parameter replaced by `options?.strict ?? true`
  - All existing callers use 3-arg form `walkFile(code, file, registry)` --- backward compatible
- Changed `walkFile` signature from `(code, file, registry, strict)` to `(code, file, registry, options?)`
- After Stage 2 resolution and loop element derivation, calls `runDomainPlugins()` if plugins present
- Extracted `runDomainPlugins()` as a standalone helper function:
  - Runs each plugin sequentially
  - Catches plugin errors (non-fatal, logged to stderr)
  - Validates plugin result shape (must have `nodes` and `edges` arrays)
  - Merges plugin nodes/edges/deferred into FileResult
  - Later plugins see earlier plugin output

---

## Change 4: ExpressPlugin implementation

**File:** `packages/core/src/plugins/domain/ExpressPlugin.ts` (NEW)

- Implements `DomainPlugin` interface
- Uses data flow approach (from 009-don-dataflow-update.md) instead of hardcoded `EXPRESS_OBJECTS` set
- `_findExpressVarNames(fileResult)`:
  - Phase 1: single-hop detection via ASSIGNED_FROM edges from VARIABLE to CALL('express') or CALL('express.Router')
  - Phase 2: alias chain BFS by node ID (from 011-don-final-fixes.md) to avoid shadowing false positives
  - Final conversion back to name-keyed map for `analyzeFile`
- `analyzeFile`: scans CALL nodes where `metadata.object` is in the express variable names map
  - HTTP methods (get/post/put/delete/patch/options/head/all) produce `http:route` nodes
  - `use` method produces `express:mount` nodes
  - EXPOSES edges from MODULE to http:route, MOUNTS edges from MODULE to express:mount
- Node ID format includes column for uniqueness (from 006 Gap 5): `{file}->http:route->{METHOD}:{path}#{line}:{column}`
- Documents the `let app; app = express()` limitation (from 011 Gap 1)

**File:** `packages/core/src/plugins/domain/index.ts` (NEW)

- Barrel export for `ExpressPlugin`

---

## Change 5: CoreV2Analyzer wiring

**File:** `packages/core/src/plugins/analysis/CoreV2Analyzer.ts`

- Added `DomainPlugin` type import from `@grafema/core-v2`
- Added `ExpressPlugin` import from `../domain/ExpressPlugin.js`
- Added `DOMAIN_PLUGIN_REGISTRY` map: `{ express: new ExpressPlugin() }`
- In `execute()`: reads `config.domains` array, resolves to plugin instances, logs warnings for unknown plugins
- Passes `domainPlugins` to `walkFile` via `WalkOptions`: `walkFile(code, filePath, jsRegistry, { domainPlugins })`
- Updated `metadata.creates.nodes` to include `'http:route'`, `'express:mount'`
- Updated `metadata.creates.edges` to include `'EXPOSES'`, `'MOUNTS'`

---

## Build Verification

- `pnpm --filter @grafema/core-v2 build` --- clean
- `pnpm --filter @grafema/core build` --- clean
- All existing tests pass (scope, element-of)

---

## Files Changed

| File | Action | Lines Changed |
|------|--------|---------------|
| `packages/core-v2/src/visitors/expressions.ts` | Modified | +19 (argValues extraction + TemplateLiteral import) |
| `packages/core-v2/src/types.ts` | Modified | +64 (DomainPlugin + DomainPluginResult interfaces) |
| `packages/core-v2/src/index.ts` | Modified | +3 (type exports) |
| `packages/core-v2/src/walk.ts` | Modified | +65 (WalkOptions, signature change, runDomainPlugins helper) |
| `packages/core/src/plugins/domain/ExpressPlugin.ts` | Created | 265 lines |
| `packages/core/src/plugins/domain/index.ts` | Created | 1 line |
| `packages/core/src/plugins/analysis/CoreV2Analyzer.ts` | Modified | +25 (imports, registry, config wiring) |

---

## Design Decisions

1. **WalkOptions over positional args:** Per Uncle Bob's guidance, used a parameter object to avoid a 5-parameter function signature. This keeps the API stable for future additions.

2. **runDomainPlugins as extracted helper:** Keeps the main walkFile body from growing further. The helper is pure (no side effects beyond console.error for error logging).

3. **Data flow over heuristic:** The ExpressPlugin uses ASSIGNED_FROM edge traversal to find express variables, not a hardcoded name set. This is strictly more precise --- a variable named `app` that holds a plain object will NOT produce false positive routes.

4. **Node ID includes column:** Per Gap 5 from 006, same-line routes get unique IDs via the column disambiguator.

5. **Alias BFS by node ID:** Per Gap 2 from 011, Phase 2 tracks variables by node ID instead of name to avoid false positives from variable shadowing in nested scopes.
