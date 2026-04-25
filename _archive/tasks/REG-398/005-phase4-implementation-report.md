# REG-398 Phase 4: Implementation Report

## Summary

Added `DeclareFields` wire command and metadata field indexes to RFDB. Plugins can now declare which metadata fields they write, and the server builds in-memory secondary indexes for O(1) field-value lookups instead of O(n) JSON parsing. **Field declarations are persisted in `metadata.json`** and automatically restored on database reopen.

## Changes

### Modified: `packages/rfdb-server/src/storage/mod.rs`
- Added `FieldDecl` struct (name, field_type, node_types) with `PartialEq` derive
- Added `FieldType` enum (String, Bool, Int, Id)

### Modified: `packages/rfdb-server/src/storage/writer.rs`
- Extended `GraphMetadata` with `field_declarations: Vec<FieldDecl>` field
- `#[serde(default, skip_serializing_if = "Vec::is_empty")]` for backward compat with old metadata.json files

### Modified: `packages/rfdb-server/src/graph/index_set.rs`
- Added `field_indexes: HashMap<String, HashMap<String, Vec<usize>>>` to `IndexSet`
- Extended `rebuild_from_segment()` to accept `&[FieldDecl]` parameter
- During rebuild, parses metadata JSON for declared fields and builds field indexes
- Respects `node_types` restriction (only indexes matching node types)
- Added `has_field_index()`, `find_by_field()` methods
- Added 2 unit tests: `test_field_index_basic`, `test_field_index_with_node_type_filter`

### Modified: `packages/rfdb-server/src/graph/engine.rs`
- Added `declared_fields: Vec<FieldDecl>` field to `GraphEngine`
- Added `declare_fields()` method — stores declarations and triggers immediate index rebuild
- Added `declared_fields()` getter
- **`open()`: loads `field_declarations` from persisted `GraphMetadata`, passes to `rebuild_from_segment`** — field indexes are rebuilt automatically on reopen
- **`flush()`: copies `declared_fields` into `metadata.field_declarations` before writing** — declarations survive database close/reopen cycle
- Updated `find_by_attr()` segment search: uses field index for candidate narrowing when:
  1. A metadata filter matches a declared field
  2. The declaration covers the query's node type (unrestricted or matching)
  3. Falls back to JSON parsing for undeclared fields
- Simplified candidate narrowing logic (removed redundant type/file index skip optimization — always check all column filters since field index is now the primary candidate source)
- Added 5 integration tests: `test_declare_fields_ephemeral`, `test_field_index_after_flush`,
  `test_field_index_with_node_type_restriction`, `test_field_index_survives_reopen`,
  `test_declare_fields_triggers_index_rebuild`

### Modified: `packages/rfdb-server/src/bin/rfdb_server.rs`
- Added `WireFieldDecl` struct for wire protocol
- Added `DeclareFields` variant to `Request` enum
- Added handler: converts `WireFieldDecl` → `FieldDecl`, calls `engine.declare_fields()`
- Added 1 protocol test: `test_declare_fields_command`

### Modified: `packages/rfdb-server/src/lib.rs`
- Re-exported `FieldDecl`, `FieldType`

### Modified: `packages/types/src/rfdb.ts`
- Added `'declareFields'` to `RFDBCommand` union
- Added `FieldDeclaration` interface
- Added `declareFields()` to `IRFDBClient` interface

### Modified: `packages/rfdb/ts/client.ts`
- Added `declareFields()` method implementation
- Imported `FieldDeclaration` type

## Design Decisions

1. **In-memory field indexes, not segment format v2**: Field indexes are built from metadata JSON during rebuild. This avoids touching the segment binary format while delivering the same query performance benefit. Segment format v2 can be a follow-up optimization if metadata parsing during rebuild becomes a bottleneck (unlikely for <1M nodes).

2. **Field declarations are persisted in `metadata.json`**: Declarations are stored alongside node/edge counts and timestamps. On reopen, they are loaded automatically and field indexes are rebuilt. This eliminates silent performance degradation — a database that was declared once stays declared. Calling `DeclareFields` again replaces declarations (schema evolution).

3. **Backward compatible metadata format**: `field_declarations` uses `#[serde(default, skip_serializing_if = "Vec::is_empty")]` — old metadata.json files without this field are handled gracefully (empty declarations = no field indexes = same behavior as before).

4. **Node type restriction on field declarations**: `FieldDecl.node_types` allows restricting indexing to specific node types (e.g., "object" only for CALL nodes). The engine checks this restriction before using a field index as candidate source to avoid false negatives.

5. **First indexed field used as candidate source**: When multiple metadata filters exist, the first one with a field index is used for candidate narrowing. The remaining filters (indexed or not) are checked as remaining filters.

## Test Results

238 tests pass:
- 206 unit tests (7 new: 2 in index_set, 5 in engine)
- 22 protocol tests (1 new: declare_fields_command)
- 10 doc tests (2 ignored)

## Complexity Analysis

- **Rebuild cost**: O(N × F) where N = nodes, F = declared fields. For 100K nodes, 5 fields: ~500K JSON parses during rebuild (~500ms). Acceptable since rebuild happens only on open/flush.
- **Query cost with field index**: O(K) where K = matching nodes. For "object=express" among 50K CALL nodes, K might be ~200. No JSON parsing needed.
- **Query cost without field index**: Falls back to O(candidates) JSON parsing (same as Phase 3).
- **Memory**: ~48 bytes per indexed value entry. For 100K nodes, 5 fields, ~3 values each: ~7.2 MB.

## Usage Example

```typescript
// In Orchestrator, before analysis (or skip — declarations are persisted):
await client.declareFields([
  { name: 'object', fieldType: 'string', nodeTypes: ['CALL'] },
  { name: 'method', fieldType: 'string', nodeTypes: ['CALL'] },
  { name: 'async', fieldType: 'bool', nodeTypes: ['FUNCTION'] },
  { name: 'scopeType', fieldType: 'string', nodeTypes: ['SCOPE'] },
  { name: 'importType', fieldType: 'string', nodeTypes: ['IMPORT'] },
]);

// Later, in enricher — uses field index O(1) instead of JSON parse O(n):
const expressRoutes = await client.findByAttr({
  nodeType: 'CALL',
  object: 'express',
  method: 'get',
});

// On next database open — field indexes are rebuilt automatically
// from persisted declarations. No need to call declareFields again.
```
