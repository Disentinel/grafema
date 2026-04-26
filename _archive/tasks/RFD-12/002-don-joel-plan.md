# RFD-12: Don + Joel Plan — Client Semantic ID Wire Format

## Analysis

### Current State
- **Wire format:** `WireNode { id, nodeType, name, file, exported, metadata }` — no semantic ID field
- **Rust v2 storage:** `NodeRecordV2 { semantic_id, id: u128, ... }` — has semantic_id first-class
- **Client hack:** `originalId` in node metadata, `_origSrc`/`_origDst` in edge metadata
- **Problem:** Client sends semantic ID as `WireNode.id` → server hashes to u128 → server returns u128 as decimal string → client needs metadata hack to recover original

### Target State
- `WireNode` gets optional `semanticId` field
- Server populates from v2 storage on read, uses on write
- Edge responses include resolved semantic IDs for `src`/`dst`
- Protocol v3 handshake enables semantic ID behavior
- No metadata hacks in v3 code path

## Technical Plan

### Rust Changes (~80 LOC, ~5 tests)

#### 1. NodeRecord: add `semantic_id` (storage/mod.rs)
```rust
pub struct NodeRecord {
    ...
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_id: Option<String>,  // NEW
}
```
All existing construction sites set `semantic_id: None` (backward compat).

#### 2. V2↔V1 conversions (engine_v2.rs)
- `node_v2_to_v1`: populate `semantic_id` from `NodeRecordV2.semantic_id`
- `node_v1_to_v2`: if `v1.semantic_id` is set, use it; otherwise synthetic `format!("{}:{}@{}"...)`

#### 3. WireNode: add `semantic_id` (rfdb_server.rs)
```rust
pub struct WireNode {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_id: Option<String>,  // NEW
    ...
}
```

#### 4. Wire conversions (rfdb_server.rs)
- `record_to_wire_node`: include `semantic_id` from NodeRecord
- `wire_node_to_record`: use `semantic_id` for NodeRecord, hash for `id` if present

#### 5. Edge semantic ID resolution (rfdb_server.rs)
For handlers returning edges (`GetOutgoingEdges`, `GetIncomingEdges`, `GetAllEdges`):
- Capture `session.protocol_version` before closure
- If >= 3, resolve each edge's `src`/`dst` u128 → semantic string via `engine.get_node()`
- Fallback: keep u128 decimal string (no node found)

**Complexity:** O(edges × 1) per edge endpoint lookup. `get_node()` is O(1) hash lookup.
For `getOutgoingEdges`/`getIncomingEdges`: small result sets (10-50 edges typically). Fine.
For `getAllEdges`: debugging command, not hot path. Fine.

#### 6. Hello protocol v3 (rfdb_server.rs)
```rust
Response::HelloOk {
    ok: true,
    protocol_version: 3,  // was 2
    features: vec!["multiDatabase", "ephemeral", "semanticIds"],
}
```

#### 7. Rust tests (~5 tests)
- Semantic ID roundtrip: add node with semanticId → get node → verify semanticId present
- Edge resolution: add nodes with semanticId → add edge → getOutgoingEdges → verify src/dst are semantic strings
- Hello v3 response
- Backward compat: node without semanticId still works

### TypeScript Changes (~200 LOC, ~5 tests)

#### 8. Types (packages/types/src/rfdb.ts)
```typescript
export interface WireNode {
  id: string;
  semanticId?: string;  // NEW: v3 wire format
  nodeType: NodeType;
  name: string;
  file: string;
  exported: boolean;
  metadata: string;
}
// Strict v3 type for type-safe v3 code paths
export type WireNodeV3 = Omit<WireNode, 'semanticId'> & { semanticId: string };
export type WireEdgeV3 = WireEdge; // src/dst are semantic IDs in v3
```

#### 9. Protocol negotiation (RFDBServerBackend.ts)
- Add `protocolVersion: number` field
- In `connect()`: after successful connection, call `hello(3)`
- Store negotiated version
- If hello fails (v1 server without hello), default to v1

#### 10. addNodes v3 path (RFDBServerBackend.ts)
```typescript
// v3: set semanticId, clean metadata
semanticId: String(id),
metadata: JSON.stringify(rest),  // NO originalId

// v2 degraded: keep existing hack
metadata: JSON.stringify({ originalId: String(id), ...rest }),
```

#### 11. addEdges v3 path (RFDBServerBackend.ts)
```typescript
// v3: no _origSrc/_origDst
metadata: JSON.stringify({
  ...rest,
  ...(typeof metadata === 'object' && metadata !== null ? metadata : {})
}),

// v2 degraded: keep existing hack
```

#### 12. _parseNode v3 path (RFDBServerBackend.ts)
```typescript
// v3: use semanticId directly
const humanId = wireNode.semanticId || wireNode.id;
// No need to extract originalId from metadata

// v2 degraded: existing behavior
```

#### 13. _parseEdge v3 path (RFDBServerBackend.ts)
```typescript
// v3: src/dst are already semantic IDs
return {
  src: wireEdge.src,
  dst: wireEdge.dst,
  type: wireEdge.edgeType,
  metadata: rest,
};

// v2 degraded: extract _origSrc/_origDst
```

#### 14. TS tests (~5 tests)
- v3 addNodes: semanticId set, no originalId in metadata
- v3 _parseNode: uses semanticId from wire
- v3 addEdges: no _origSrc/_origDst in metadata
- v3 _parseEdge: uses src/dst directly
- v2 degraded path: metadata hacks still work

### Backward Compatibility
- **v3 client → v3 server:** Clean path, no hacks
- **v3 client → v2 server:** Hello returns protocolVersion=2 → client uses metadata hacks (existing behavior)
- **v2 client → v3 server:** Server returns semanticId (optional field, ignored by v2 client) + u128 id (as before)

### Risk
- **LOW:** Adding optional fields is non-breaking
- **MEDIUM:** Edge resolution performance for `getAllEdges` — acceptable (debugging command)
- **LOW:** Existing tests should continue passing (v2 path preserved)

## Commit Plan
1. `feat(rfdb): add semantic_id to NodeRecord and wire format (RFD-12)` — Rust changes
2. `feat(rfdb-client): v3 wire format with native semantic IDs (RFD-12)` — TS changes
3. `test(rfdb): semantic ID roundtrip and v3 protocol tests (RFD-12)` — tests
