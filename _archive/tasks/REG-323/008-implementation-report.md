# REG-323 Implementation Report

## Summary

Refactored ExpressRouteAnalyzer to use byte offset (`start`) instead of line/column for matching route handlers to FUNCTION nodes, and moved HANDLED_BY edge creation to a new enricher plugin.

## Changes Made

### 1. FunctionNodeRecord Interface (`packages/types/src/nodes.ts`)
- Added optional `start?: number` field for byte offset storage

### 2. FunctionVisitor (`packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts`)
- Added `start?: number` to FunctionInfo interface
- Store `node.start` for both FunctionDeclaration and ArrowFunctionExpression handlers

### 3. ExpressRouteAnalyzer (`packages/core/src/plugins/analysis/ExpressRouteAnalyzer.ts`)
- Added `handlerStart?: number` and `handlerName?: string` to EndpointNode interface
- When creating endpoints:
  - For inline handlers (ArrowFunctionExpression/FunctionExpression): store `actualHandler.start` as `handlerStart`
  - For named handlers (Identifier references): store handler name as `handlerName`
- Store handler identification in http:route node metadata
- Removed O(n) line/column-based HANDLED_BY edge creation (moved to enricher)

### 4. ExpressHandlerLinker Enricher (`packages/core/src/plugins/enrichment/ExpressHandlerLinker.ts`)
- New enricher plugin that creates HANDLED_BY edges between routes and handlers
- Strategy:
  - For routes with `handlerStart`: match by file + byte offset
  - For routes with `handlerName`: match by file + function name
- Builds lookup maps per file for O(n+m) complexity instead of O(n*m)
- Note: Handler fields are read from top level (not nested under metadata) because
  serialization/deserialization spreads metadata fields to the node's top level

### 5. Plugin Registration
- Exported ExpressHandlerLinker from `packages/core/src/index.ts`
- Added to default plugins in `packages/core/src/config/ConfigLoader.ts`
- Added to BUILTIN_PLUGINS in `packages/cli/src/commands/analyze.ts`

### 6. Tests (`test/unit/plugins/analysis/ExpressRouteAnalyzer-HANDLED_BY.test.js`)
- Fixed bug in test file (incorrect `db` variable reference)
- Added ExpressHandlerLinker to test setup
- Added test cases for:
  - Named function handlers
  - Wrapped handlers (asyncHandler pattern)

## Architecture Improvements

| Aspect | Before | After |
|--------|--------|-------|
| HANDLED_BY creation | Analysis phase (ExpressRouteAnalyzer) | Enrichment phase (ExpressHandlerLinker) |
| Handler matching | Line/column (fragile) | Byte offset (stable) |
| Complexity | O(n*m) per file | O(n+m) per file |
| ScopeTracker dependency | None (used line/column) | None (uses byte offset) |

## Acceptance Criteria

- [x] HANDLED_BY edge created through positional matching (byte offset)
- [x] Line/column lookup removed from ExpressRouteAnalyzer
- [x] Works for named handlers (via name-based lookup)
- [x] Works for anonymous/inline handlers (via byte offset)
- [x] Works for wrapped handlers (asyncHandler pattern)

### 7. TestRFDB Helper (`test/helpers/TestRFDB.js`)
- Added `_parseNode` method to `TestDatabaseBackend` to parse wire format nodes
- This ensures test infrastructure matches `RFDBServerBackend` behavior
- Metadata fields are parsed and spread to the node's top level

### 8. rfdb-server CLI (`packages/rfdb-server/src/bin/rfdb_server.rs`)
- Added `-V`/`--version` flag to print version from Cargo.toml
- Added `-h`/`--help` flag to print usage information

## Notes

- All 5 tests pass with the HANDLED_BY edge creation
- The middleware HANDLED_BY edges are still created by ExpressRouteAnalyzer (uses name-based lookup, which works well for middleware)
- The enricher follows Grafema's established pattern: analysis creates nodes with positional data, enrichment creates cross-references
- Wire format serialization: When node data is stored, all fields (including nested `metadata` object) are flattened into a single JSON metadata string. On retrieval, `_parseNode` spreads this back to top-level properties.
