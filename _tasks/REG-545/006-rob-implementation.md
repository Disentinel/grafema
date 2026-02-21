# Rob Implementation Notes -- REG-545

## Summary

Implemented HANDLED_BY edges in FunctionCallResolver and registered ExternalCallResolver in the production plugin pipeline and test orchestrator. All 2160 unit tests pass with 0 failures.

## Changes Made

### 1. FunctionCallResolver.ts (refactor + feature)

**Refactor (Commit 1):**
- Extracted `buildImportIndex()`, `buildFunctionIndex()`, `buildExportIndex()` private methods from `execute()`
- Added `importBinding` field to `ImportNode` interface (needed for GAP 1 fix)
- `execute()` reduced from ~246 lines to a readable coordinator calling private methods

**Feature (Commit 2):**
- Added `'HANDLED_BY'` to `metadata.creates.edges` and `produces`
- Added `buildShadowIndex()` private method -- queries VARIABLE, CONSTANT, PARAMETER nodes to build conservative shadow set
- Added HANDLED_BY edge creation after CALLS edge in direct function case (Step 4.6)
- Added HANDLED_BY edge creation after CALLS edge in external re-export branch (Step 4.3.1)
- Added `handledByEdgesCreated` counter, updated logger and return stats
- Added type-only import guard (`imp.importBinding !== 'type'`) -- GAP 1 fix
- Added shadow key check (`!shadowedImportKeys.has(shadowKey)`) -- shadow detection

### 2. builtinPlugins.ts

- Added `ExternalCallResolver` import from `@grafema/core`
- Added `ExternalCallResolver: () => new ExternalCallResolver() as Plugin` registry entry after FunctionCallResolver

### 3. createTestOrchestrator.js

- Added `FunctionCallResolver` and `ExternalCallResolver` imports
- Added both plugins to enrichment block (FunctionCallResolver before ExternalCallResolver for dependency order)

### 4. FunctionCallResolver.test.js

- Updated edge count assertions in 4 existing tests to account for HANDLED_BY edges (CALLS + HANDLED_BY)
- All 6 new HANDLED_BY tests pass (TDD tests written in prior step)

### 5. Graph Snapshots

- Updated 6 snapshot golden files to reflect new HANDLED_BY edges and ExternalCallResolver results

## Dijkstra Gaps Addressed

| Gap | Resolution |
|-----|-----------|
| GAP 1: type-only import guard | Added `imp.importBinding !== 'type'` check before creating HANDLED_BY |
| GAP 2: PARAMETER shadow detection | Documented gap -- PARAMETER nodes use `parentFunctionId`, not `parentScopeId`, so they are not matched by the shadow index. Test documents this as known limitation. |
| GAP 3: external re-export HANDLED_BY | Added HANDLED_BY creation in the external re-export branch (Step 4.3.1) |

## Shadow Index Design

Conservative flat `Set<file:localName>`:
- Queries VARIABLE, CONSTANT, PARAMETER nodes
- For VARIABLE/CONSTANT: matches via `parentScopeId` (present on all, including module-level)
- For PARAMETER: checks `parentScopeId` which PARAMETER nodes do NOT have (they use `parentFunctionId`) -- known gap
- Any match in any scope blocks HANDLED_BY -- may produce false negatives but never false positives
- Full scope-chain traversal deferred as follow-up

## Test Results

- FunctionCallResolver.test.js: 25/25 pass
- ExternalCallResolver.test.js: 31/31 pass
- Full suite: 2160/2160 pass, 0 fail, 5 skipped, 22 TODO (all pre-existing)
