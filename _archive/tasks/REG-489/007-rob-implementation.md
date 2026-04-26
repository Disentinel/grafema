# REG-489: Rob Pike — Implementation Report

All changes per the plan (003-don-plan.md + 005-plan-revision.md). Six files modified.
Both Rust and TypeScript builds pass clean.

---

## File 1: Rust Server

**File:** `packages/rfdb-server/src/bin/rfdb_server.rs`

### 1a. CommitBatch enum variant (line ~214)

Added `protected_types: Vec<String>` field with `#[serde(default, rename = "protectedTypes")]`.
Wire-compatible: old clients omitting the field get an empty vec via `#[serde(default)]`.

### 1b. Dispatch match (line ~1293)

Updated pattern destructure and `handle_commit_batch` call to pass `protected_types`.

### 1c. Function signature (line ~1497)

Added `protected_types: Vec<String>` parameter to `handle_commit_batch`.

### 1d. Deletion loop skip logic (line ~1531)

Added guard before the existing deletion block:

```rust
if !protected_types.is_empty() {
    if let Some(node) = engine.get_node(*id) {
        if let Some(ref nt) = node.node_type {
            if protected_types.contains(nt) {
                continue;
            }
        }
    }
}
```

Zero overhead when `protected_types` is empty (all existing callers).

### 1e. Tests (14 instances)

Added `protected_types: vec![],` to all 14 `Request::CommitBatch` struct literals in test code.
Required because direct struct construction (unlike serde deserialization) needs all fields.

---

## File 2: TypeScript Client

**File:** `packages/rfdb/ts/client.ts`

- `commitBatch()` signature: added `protectedTypes?: string[]` third parameter
- `_sendCommitBatch()` signature: added `protectedTypes?: string[]` sixth parameter
- Fast-path `_send('commitBatch', {...})`: added `...(protectedTypes?.length ? { protectedTypes } : {})`
- Chunked-path `_send('commitBatch', {...})`: added `...(i === 0 && protectedTypes?.length ? { protectedTypes } : {})` (only first chunk triggers deletion, so only first chunk needs protectedTypes)
- `BatchHandle.commit()`: added `protectedTypes?: string[]` parameter, passed through to `_sendCommitBatch`

---

## File 3: JSASTAnalyzer

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

Updated the per-module `commitBatch` call (line ~396) to pass `['MODULE']` as third argument.
The `executeParallel` path does not call `commitBatch` directly (PhaseRunner wraps it).

---

## File 4: PhaseRunner

**File:** `packages/core/src/PhaseRunner.ts`

In `runPluginWithBatch` (line ~98), added:

```typescript
const protectedTypes = phaseName === 'ANALYSIS' ? ['MODULE'] : undefined;
const delta = await graph.commitBatch(tags, deferIndex, protectedTypes);
```

This covers all ANALYSIS plugins that do NOT manage their own batch (i.e., everything except JSASTAnalyzer). INDEXING, ENRICHMENT, and VALIDATION phases pass `undefined` (no protection).

---

## File 5: Types

**File:** `packages/types/src/rfdb.ts`

Updated `IRFDBClient.commitBatch` signature (line ~505):
```typescript
commitBatch(tags?: string[], deferIndex?: boolean, protectedTypes?: string[]): Promise<CommitDelta>;
```

**File:** `packages/types/src/plugins.ts`

Updated `GraphBackend.commitBatch` signature (line ~326):
```typescript
commitBatch?(tags?: string[], deferIndex?: boolean, protectedTypes?: string[]): Promise<CommitDelta>;
```

---

## File 6: RFDBServerBackend

**File:** `packages/core/src/storage/backends/RFDBServerBackend.ts`

Updated `commitBatch` method signature (line ~776) to accept and pass through `protectedTypes`.

---

## Build Verification

- `cargo build --release` in `packages/rfdb-server`: success (pre-existing warnings only)
- `pnpm build`: success, all packages compile clean
