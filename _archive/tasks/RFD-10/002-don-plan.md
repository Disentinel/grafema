# Don Melton Plan: RFD-10 T3.3 Client Snapshot API

> Date: 2026-02-14
> Status: PLAN
> Scope: ~150 LOC client code, ~10 tests

---

## 1. Current State Analysis

### Rust Server Side (storage_v2)

ManifestStore already has all four snapshot operations implemented and tested:

| Method | Signature | Location |
|--------|-----------|----------|
| `tag_snapshot` | `(&mut self, version: u64, tags: HashMap<String, String>) -> Result<()>` | manifest.rs:899 |
| `find_snapshot` | `(&self, tag_key: &str, tag_value: &str) -> Option<u64>` | manifest.rs:883 |
| `list_snapshots` | `(&self, filter_tag: Option<&str>) -> Vec<SnapshotInfo>` | manifest.rs:890 |
| `diff_snapshots` | `(&self, from_version: u64, to_version: u64) -> Result<SnapshotDiff>` | manifest.rs:942 |

Rust types already defined:
- `SnapshotInfo` (version, created_at, tags, stats) -- manifest.rs:321
- `SnapshotDiff` (from_version, to_version, added/removed node/edge segments, stats) -- manifest.rs:494
- `ManifestStats` (total_nodes, total_edges, node_segment_count, edge_segment_count) -- manifest.rs:259

### Rust Server Binary (rfdb_server.rs)

**The server binary does NOT handle snapshot commands yet.** The `Request` enum (rfdb_server.rs:52) has no `DiffSnapshots`, `TagSnapshot`, `FindSnapshot`, or `ListSnapshots` variants. The storage_v2 module is not imported by the server binary at all -- the current server uses v1 storage (`rfdb::graph::GraphEngine`).

### TypeScript Client (packages/rfdb/ts/client.ts)

No snapshot methods exist. The client has no `commitBatch`, no snapshot types, nothing v2-related beyond protocol v2 multi-database commands (`hello`, `createDatabase`, etc.).

### Types Package (packages/types/src/rfdb.ts)

`RFDBCommand` union type has no snapshot commands. `IRFDBClient` interface has no snapshot methods.

---

## 2. Critical Architecture Decision

**The Rust server does not currently use storage_v2 at all.** This means we cannot test snapshot commands end-to-end against a running server. We have two options:

**Option A: Add server commands + client methods (full vertical slice)**
- Add 4 Request variants to rfdb_server.rs
- Wire them to ManifestStore methods
- Add client methods
- End-to-end tests against running server

**Option B: Client-only (as specified in T3.3)**
- Add client methods that send the right wire format
- Add TypeScript types
- Unit tests that validate wire format and type contracts
- Server-side handlers deferred (they're trivial delegation)

**Recommendation: Option B with a twist.** The T3.3 spec says "~150 LOC, ~10 tests" and is scoped as a TS-only task. The server handlers are trivial (5-line delegation each) and belong in a separate task when storage_v2 is wired into the server. However, we should structure the client code so it works correctly once the server supports it.

The client already has the pattern for this: `hello()`, `createDatabase()`, etc. all cast `RFDBCommand` and send commands that may or may not be supported. The same pattern applies here.

---

## 3. Implementation Plan

### 3.1 Type Definitions (~40 LOC)

Add to `packages/types/src/rfdb.ts`:

```typescript
// Add to RFDBCommand union:
| 'diffSnapshots'
| 'tagSnapshot'
| 'findSnapshot'
| 'listSnapshots'

// New types:
export type SnapshotRef = number | { tag: string; value: string };

export interface SnapshotStats {
  totalNodes: number;
  totalEdges: number;
  nodeSegmentCount: number;
  edgeSegmentCount: number;
}

export interface SegmentInfo {
  segmentId: number;
  recordCount: number;
  byteSize: number;
  nodeTypes: string[];
  filePaths: string[];
  edgeTypes: string[];
}

export interface SnapshotDiff {
  fromVersion: number;
  toVersion: number;
  addedNodeSegments: SegmentInfo[];
  removedNodeSegments: SegmentInfo[];
  addedEdgeSegments: SegmentInfo[];
  removedEdgeSegments: SegmentInfo[];
  statsFrom: SnapshotStats;
  statsTo: SnapshotStats;
}

export interface SnapshotInfo {
  version: number;
  createdAt: number;
  tags: Record<string, string>;
  stats: SnapshotStats;
}

// Response types:
export interface DiffSnapshotsResponse extends RFDBResponse { ... }
export interface FindSnapshotResponse extends RFDBResponse { version: number | null; }
export interface ListSnapshotsResponse extends RFDBResponse { snapshots: SnapshotInfo[]; }

// Add to IRFDBClient interface:
diffSnapshots(from: SnapshotRef, to: SnapshotRef): Promise<SnapshotDiff>;
tagSnapshot(version: number, tags: Record<string, string>): Promise<void>;
findSnapshot(tagKey: string, tagValue: string): Promise<number | null>;
listSnapshots(filter?: string): Promise<SnapshotInfo[]>;
```

### 3.2 Client Methods (~50 LOC)

Add to `packages/rfdb/ts/client.ts`:

```typescript
// Helper (private or module-level):
function resolveSnapshotRef(ref: SnapshotRef): Record<string, unknown> {
  if (typeof ref === 'number') return { version: ref };
  return { tagKey: ref.tag, tagValue: ref.value };
}

// 4 methods:
async diffSnapshots(from: SnapshotRef, to: SnapshotRef): Promise<SnapshotDiff>
async tagSnapshot(version: number, tags: Record<string, string>): Promise<void>
async findSnapshot(tagKey: string, tagValue: string): Promise<number | null>
async listSnapshots(filter?: string): Promise<SnapshotInfo[]>
```

Each method follows the existing pattern: call `this._send()` with command name, cast response.

### 3.3 Re-exports (~10 LOC)

Update `packages/rfdb/ts/protocol.ts` and `packages/rfdb/ts/index.ts` to re-export new types.

### 3.4 Tests (~10 tests, ~60 LOC)

Test file: `packages/rfdb/ts/client.test.ts` (extend existing).

Since the server doesn't support these commands yet, tests focus on:

1. **resolveSnapshotRef() — number input** -> `{ version: N }`
2. **resolveSnapshotRef() — tag input** -> `{ tagKey, tagValue }`
3. **SnapshotDiff type contract** — construct valid SnapshotDiff, verify fields
4. **SnapshotInfo type contract** — construct valid SnapshotInfo, verify fields
5. **SnapshotStats type contract** — verify stats shape
6. **SnapshotRef discriminated union** — number vs object discrimination
7. **tagSnapshot sends correct wire format** — version + tags
8. **findSnapshot response parsing** — version or null
9. **listSnapshots with filter** — filter string passed correctly
10. **diffSnapshots with mixed refs** — number + tag ref combination

The existing test file uses extracted helper functions to test serialization without a running server (see the `mapNodeForWireFormat` pattern). We follow the same approach: extract the `resolveSnapshotRef` helper and test it directly, plus type construction tests.

---

## 4. Files Modified

| File | Change |
|------|--------|
| `packages/types/src/rfdb.ts` | Add 4 commands to union, add 7 type definitions, extend IRFDBClient |
| `packages/rfdb/ts/client.ts` | Add resolveSnapshotRef helper, 4 snapshot methods, new imports |
| `packages/rfdb/ts/protocol.ts` | Re-export new types |
| `packages/rfdb/ts/index.ts` | Re-export new types |
| `packages/rfdb/ts/client.test.ts` | Add ~10 snapshot API tests |

---

## 5. Mapping to Rust Types

Client types must match Rust wire format (camelCase JS <-> snake_case Rust via serde rename):

| TypeScript | Rust | Notes |
|------------|------|-------|
| `SnapshotDiff.fromVersion` | `SnapshotDiff.from_version` | serde camelCase |
| `SnapshotDiff.addedNodeSegments` | `SnapshotDiff.added_node_segments` | Array of SegmentDescriptor |
| `SnapshotInfo.createdAt` | `SnapshotInfo.created_at` | Unix epoch seconds |
| `SnapshotStats.totalNodes` | `ManifestStats.total_nodes` | Same fields, different name |
| `SegmentInfo.segmentId` | `SegmentDescriptor.segment_id` | Subset of fields |

**Note:** SegmentInfo is a simplified view of Rust's SegmentDescriptor. We expose segmentId, recordCount, byteSize, nodeTypes[], filePaths[], edgeTypes[] but not segmentType or shardId (internal details).

---

## 6. Risks

1. **Server doesn't support these commands yet.** Calling any snapshot method on current server will return an error. This is expected and documented. The `hello()` response should eventually include `"snapshots"` in features array when server support lands.

2. **Type mismatch risk.** The Rust serde serialization uses `#[serde(rename_all = "camelCase")]` on the server's Response enum, so field names will be camelCase in the wire format. Our TS types must match exactly. Risk is low because we control both sides.

3. **SegmentDescriptor fields.** Rust SegmentDescriptor has `node_types: HashSet<String>` but HashSet serializes to JSON array. Our TS type uses `string[]`. This is correct -- serde serializes HashSet as array.

---

## 7. Out of Scope

- Server-side command handlers (separate task when storage_v2 is integrated)
- `deleteSnapshot` (mentioned in client-spec but not in T3.3 subtasks)
- Integration tests against running server (requires server support)
- Modifying `GraphBackend` interface in core package

---

## 8. Commit Strategy

Single commit: "feat(rfdb): Add client snapshot API types and methods (RFD-10)"

This is a 1-point task. One atomic commit with types + methods + tests.
