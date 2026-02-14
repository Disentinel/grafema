# Rob Pike Implementation Report: RFD-10 T3.3 Client Snapshot API

> Date: 2026-02-14
> Status: DONE
> Tests: 15 new (22 total), all passing

---

## Summary

Added 4 snapshot operations to the RFDB TypeScript client: `diffSnapshots`, `tagSnapshot`, `findSnapshot`, `listSnapshots`. Plus 7 supporting types, re-exports, and 15 tests.

## Files Modified

### 1. `packages/types/src/rfdb.ts`

**RFDBCommand union** — added 4 snapshot commands:
- `'diffSnapshots' | 'tagSnapshot' | 'findSnapshot' | 'listSnapshots'`

**New types** (7 total):
- `SnapshotRef` — discriminated union: `number | { tag: string; value: string }`
- `SnapshotStats` — mirrors Rust `ManifestStats` (totalNodes, totalEdges, nodeSegmentCount, edgeSegmentCount)
- `SegmentInfo` — simplified Rust `SegmentDescriptor` (segmentId, recordCount, byteSize, nodeTypes[], filePaths[], edgeTypes[])
- `SnapshotDiff` — mirrors Rust `SnapshotDiff` (from/to versions, added/removed segment lists, stats for both)
- `SnapshotInfo` — mirrors Rust `SnapshotInfo` (version, createdAt, tags, stats)
- `DiffSnapshotsResponse`, `FindSnapshotResponse`, `ListSnapshotsResponse` — response wrappers extending `RFDBResponse`

**IRFDBClient interface** — added 4 methods:
- `diffSnapshots(from: SnapshotRef, to: SnapshotRef): Promise<SnapshotDiff>`
- `tagSnapshot(version: number, tags: Record<string, string>): Promise<void>`
- `findSnapshot(tagKey: string, tagValue: string): Promise<number | null>`
- `listSnapshots(filterTag?: string): Promise<SnapshotInfo[]>`

### 2. `packages/rfdb/ts/client.ts`

**New imports** — `SnapshotRef`, `SnapshotDiff`, `SnapshotInfo`, `DiffSnapshotsResponse`, `FindSnapshotResponse`, `ListSnapshotsResponse`

**New private helper** — `_resolveSnapshotRef(ref: SnapshotRef)`:
- number -> `{ version: N }`
- `{ tag, value }` -> `{ tagKey, tagValue }`

**4 new methods** — all follow existing `_send()` pattern:
- `diffSnapshots()` — sends `from` and `to` as resolved refs, returns `diff` field
- `tagSnapshot()` — sends `version` + `tags`, returns void
- `findSnapshot()` — sends `tagKey` + `tagValue`, returns `version` (number | null)
- `listSnapshots()` — optionally sends `filterTag`, returns `snapshots` array

### 3. `packages/rfdb/ts/protocol.ts`

Re-exported all 8 new types from `@grafema/types`.

### 4. `packages/rfdb/ts/index.ts`

Re-exported all 8 new types from `./protocol.js`.

### 5. `packages/rfdb/ts/client.test.ts`

**15 new tests** across 3 describe blocks:

**Snapshot API -- resolveSnapshotRef** (4 tests):
- Number ref -> `{ version }`
- Tag ref -> `{ tagKey, tagValue }`
- Version 0 edge case (not falsy)
- Union discrimination (typeof check)

**Snapshot API -- Type Contracts** (5 tests):
- SnapshotStats shape validation
- SegmentInfo shape validation (including HashSet -> string[] arrays)
- SnapshotDiff full shape with mixed segment lists
- SnapshotInfo with populated tags
- SnapshotInfo with empty tags

**Snapshot API -- Wire Format** (6 tests):
- tagSnapshot payload structure
- findSnapshot response (found / not found)
- listSnapshots payload (with filter / without filter)
- diffSnapshots with mixed refs (number + tag)

## Wire Format Mapping

| TypeScript field | Rust field | Rust struct | Notes |
|-----------------|------------|-------------|-------|
| `SnapshotDiff.fromVersion` | `from_version` | `SnapshotDiff` | serde camelCase when wrapped |
| `SnapshotDiff.toVersion` | `to_version` | `SnapshotDiff` | serde camelCase when wrapped |
| `SnapshotDiff.addedNodeSegments` | `added_node_segments` | `SnapshotDiff` | Vec<SegmentDescriptor> |
| `SnapshotDiff.statsFrom` | `stats_from` | `SnapshotDiff` | ManifestStats |
| `SnapshotInfo.createdAt` | `created_at` | `SnapshotInfo` | Unix epoch seconds (u64) |
| `SnapshotStats.totalNodes` | `total_nodes` | `ManifestStats` | u64 |
| `SegmentInfo.segmentId` | `segment_id` | `SegmentDescriptor` | u64 |
| `SegmentInfo.nodeTypes` | `node_types` | `SegmentDescriptor` | HashSet<String> -> string[] |

**Note on serde:** The Rust manifest.rs structs do NOT have `#[serde(rename_all = "camelCase")]`. The server binary (rfdb_server.rs) uses per-field `#[serde(rename)]` on its Response variants. When snapshot commands are added to the server, the Response variants will need explicit rename attributes or Wire* wrapper types to produce camelCase JSON. The TS types are defined as camelCase to match the planned wire format.

## Build & Test Results

- `pnpm --filter @grafema/types build` -- clean
- `pnpm --filter @grafema/rfdb-client build` -- clean
- `pnpm --filter @grafema/core build` -- clean
- `node --test packages/rfdb/ts/client.test.ts` -- 22/22 pass (15 new)

## Out of Scope

- Server-side command handlers (server uses v1 storage, no storage_v2 integration yet)
- `deleteSnapshot` (not in T3.3 scope)
- Integration tests against running server (requires server support)
