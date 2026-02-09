# REG-398 Phase 5: Implementation Report

## Summary

Added `fields` to `PluginMetadata` so plugins can declare which metadata fields they write. The Orchestrator collects all field declarations from plugins and sends `DeclareFields` to RFDB before analysis starts. This completes the end-to-end pipeline: plugins declare fields → Orchestrator sends to RFDB → RFDB builds indexes → enrichers get O(1) metadata lookups.

## Changes

### Modified: `packages/types/src/plugins.ts`
- Added `fields?: FieldDeclaration[]` to `PluginMetadata` interface
- Added `declareFields?(fields: FieldDeclaration[]): Promise<number>` to `GraphBackend` interface
- Added import of `FieldDeclaration` from `rfdb.ts`

### Modified: `packages/core/src/storage/backends/RFDBServerBackend.ts`
- Added `declareFields()` method delegating to `this.client.declareFields()`
- Added `FieldDeclaration` import
- Fixed TypeScript type error: `NodeQuery` → `AttrQuery` cast for `queryNodes()` (caused by Phase 3's index signature on `AttrQuery`)

### Modified: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
- Added `fields` to metadata declaring the top-7 metadata fields:
  - `object` (string, CALL nodes)
  - `method` (string, CALL nodes)
  - `async` (bool, FUNCTION/METHOD nodes)
  - `scopeType` (string, SCOPE nodes)
  - `importType` (string, IMPORT nodes)
  - `exportType` (string, EXPORT nodes)
  - `parentScopeId` (id, FUNCTION/METHOD/SCOPE/VARIABLE nodes)

### Modified: `packages/core/src/Orchestrator.ts`
- Added `declarePluginFields()` private method:
  - Collects `fields` from all plugins
  - Deduplicates by field name (last declaration wins)
  - Calls `graph.declareFields()` if available
- Called `declarePluginFields()` after `registerPluginNodes()` in both `run()` and `runMultiRoot()` paths

## Design Decisions

1. **JSASTAnalyzer declares fields, not individual enrichers**: JSASTAnalyzer is the plugin that creates CALL, FUNCTION, SCOPE, IMPORT, EXPORT nodes with these metadata fields. Enrichers read these fields but don't create them.

2. **Deduplication by field name**: If multiple plugins declare the same field, the last declaration wins. This handles the case where a future plugin might extend an existing field's node type coverage.

3. **Optional `declareFields` on GraphBackend**: The method is optional (`declareFields?`) so non-RFDB backends (e.g., test backends) don't need to implement it. The Orchestrator checks for its existence before calling.

4. **Called before analysis, after plugin registration**: Field declarations are sent after `registerPluginNodes()` (which creates plugin graph nodes) and before the DISCOVERY phase. This ensures indexes are ready before any data enters the graph.

## Test Results

- Rust: 238 tests pass (unchanged from Phase 4)
- TypeScript: 1603 pass, 3 fail (pre-existing, unrelated — REG-116, REG-309)
- All packages compile clean (types, rfdb, core)

## End-to-End Flow

```
1. Orchestrator.run()
2. registerPluginNodes()          — grafema:plugin nodes in graph
3. declarePluginFields()          — collect fields from all plugins
   → graph.declareFields([...])   — send to RFDB
   → client.declareFields([...])  — wire protocol DeclareFields command
   → engine.declare_fields(...)   — store in declared_fields
   → index_set.rebuild(...)       — build field indexes
4. DISCOVERY phase
5. INDEXING phase
6. ANALYSIS phase (JSASTAnalyzer) — nodes created with metadata
7. flush()                        — field declarations persisted in metadata.json
   → index_set.rebuild(...)       — field indexes rebuilt from new segment
8. ENRICHMENT phase               — findByAttr uses field indexes for O(1) lookup
9. VALIDATION phase
10. flush()                       — final persist
```
