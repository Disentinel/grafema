# REG-489: Don Melton — Implementation Plan

## Executive Summary

**Root Cause**: `commitBatch` uses file-path as the atomic replacement unit. INDEXING and ANALYSIS phases both commit batches for the same file paths. ANALYSIS's commit deletes ALL nodes for a file (including MODULE created by INDEXING), then adds only analysis nodes — no MODULE.

**Solution**: Add `protectedTypes: string[]` to the `commitBatch` wire protocol. When the server deletes nodes for a changed file, it skips any node whose type is in `protectedTypes`. The analysis phase passes `protectedTypes: ['MODULE']` to preserve INDEXING-phase structural nodes.

**Why this is the right solution** (vs alternatives):
- Approach A (re-create MODULE in analysis batch): incomplete — also destroys CONTAINS/DEPENDS_ON edges, requires analysis to know about indexing's edge structure.
- Approach B (additive mode): breaks incremental re-analysis — old analysis nodes accumulate instead of being replaced.
- Approach C (virtual file prefixes): breaks all file-based queries, massive downstream impact.
- Approach E (two-tier commit with separate deletion key): more complex than D, same correctness.

---

## Acceptance Criteria Verification

1. All MODULE nodes survive through analysis (330/330) — satisfied by `protectedTypes: ['MODULE']`
2. Disconnected nodes < 10% — satisfied because CONTAINS/DEPENDS_ON edges survive with MODULE
3. No performance regression — no extra round-trips, no extra index builds
4. Ghost edges eliminated — edges survive because MODULE (their src/dst) is never deleted

---

## Scope of Change

Four files touch points:

| File | Language | Scope of Change |
|------|----------|-----------------|
| `packages/rfdb-server/src/bin/rfdb_server.rs` | Rust | Add field to CommitBatch struct + skip protected types in deletion loop |
| `packages/rfdb/ts/client.ts` | TypeScript | Add `protectedTypes?` param to `commitBatch()` and `_sendCommitBatch()` |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | TypeScript | Pass `protectedTypes: ['MODULE']` in per-module `graph.commitBatch()` calls |
| Tests (new) | TypeScript/JS | Two test files verifying the fix |

PhaseRunner does NOT need changes — it doesn't wrap JSASTAnalyzer (`managesBatch: true`). The protected types flow directly through JSASTAnalyzer's own batch management.

---

## Step 1: Rust Server (`rfdb_server.rs`)

### 1a. Add `protected_types` to CommitBatch enum variant

Current:
```rust
CommitBatch {
    #[serde(rename = "changedFiles")]
    changed_files: Vec<String>,
    nodes: Vec<WireNode>,
    edges: Vec<WireEdge>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default, rename = "fileContext")]
    file_context: Option<String>,
    #[serde(default, rename = "deferIndex")]
    defer_index: bool,
},
```

After:
```rust
CommitBatch {
    #[serde(rename = "changedFiles")]
    changed_files: Vec<String>,
    nodes: Vec<WireNode>,
    edges: Vec<WireEdge>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default, rename = "fileContext")]
    file_context: Option<String>,
    #[serde(default, rename = "deferIndex")]
    defer_index: bool,
    /// Node types to preserve during deletion phase.
    /// Nodes of these types will not be deleted even if their file is in changedFiles.
    /// Use for cross-phase structural nodes (e.g., "MODULE") that must survive
    /// when a later phase replaces analysis nodes for the same file.
    #[serde(default, rename = "protectedTypes")]
    protected_types: Vec<String>,
},
```

### 1b. Update `handle_commit_batch` function signature

Current:
```rust
fn handle_commit_batch(
    engine: &mut dyn GraphStore,
    mut changed_files: Vec<String>,
    nodes: Vec<WireNode>,
    edges: Vec<WireEdge>,
    file_context: Option<String>,
    defer_index: bool,
) -> Response {
```

After:
```rust
fn handle_commit_batch(
    engine: &mut dyn GraphStore,
    mut changed_files: Vec<String>,
    nodes: Vec<WireNode>,
    edges: Vec<WireEdge>,
    file_context: Option<String>,
    defer_index: bool,
    protected_types: Vec<String>,
) -> Response {
```

### 1c. Update call site in the dispatch match (rfdb_server.rs ~line 1290)

Current:
```rust
Request::CommitBatch { changed_files, nodes, edges, tags: _, file_context, defer_index } => {
    with_engine_write(&session, |engine| {
        handle_commit_batch(engine, changed_files, nodes, edges, file_context, defer_index)
    })
```

After:
```rust
Request::CommitBatch { changed_files, nodes, edges, tags: _, file_context, defer_index, protected_types } => {
    with_engine_write(&session, |engine| {
        handle_commit_batch(engine, changed_files, nodes, edges, file_context, defer_index, protected_types)
    })
```

### 1d. Update deletion loop in `handle_commit_batch` (rfdb_server.rs ~line 1516–1559)

Current deletion section:
```rust
for file in &changed_files {
    let attr_query = AttrQuery { ... file: Some(file.clone()), ... };
    let old_ids = engine.find_by_attr(&attr_query);

    for id in &old_ids {
        if let Some(node) = engine.get_node(*id) { ... }
        // delete edges
        engine.delete_node(*id);
        nodes_removed += 1;
    }
}
```

After:
```rust
for file in &changed_files {
    let attr_query = AttrQuery { ... file: Some(file.clone()), ... };
    let old_ids = engine.find_by_attr(&attr_query);

    for id in &old_ids {
        // Skip deletion for protected node types (cross-phase structural nodes)
        if !protected_types.is_empty() {
            if let Some(node) = engine.get_node(*id) {
                if let Some(ref nt) = node.node_type {
                    if protected_types.contains(nt) {
                        continue; // preserve this node and its edges
                    }
                }
            }
        }

        if let Some(node) = engine.get_node(*id) {
            if let Some(ref nt) = node.node_type {
                changed_node_types.insert(nt.clone());
            }
        }
        // delete edges (existing logic unchanged)
        ...
        engine.delete_node(*id);
        nodes_removed += 1;
    }
}
```

**Performance note**: The extra `get_node` call only happens when `protected_types` is non-empty. When empty (legacy behavior), zero overhead. This keeps the INDEXING phase's commitBatch at identical performance.

---

## Step 2: TypeScript Client (`packages/rfdb/ts/client.ts`)

### 2a. Update `commitBatch()` signature (line ~1097)

Current:
```typescript
async commitBatch(tags?: string[], deferIndex?: boolean): Promise<CommitDelta> {
```

After:
```typescript
async commitBatch(tags?: string[], deferIndex?: boolean, protectedTypes?: string[]): Promise<CommitDelta> {
```

Pass `protectedTypes` through to `_sendCommitBatch`:
```typescript
return this._sendCommitBatch(changedFiles, allNodes, allEdges, tags, deferIndex, protectedTypes);
```

### 2b. Update `_sendCommitBatch()` signature (line ~1117)

Current:
```typescript
async _sendCommitBatch(
    changedFiles: string[],
    allNodes: WireNode[],
    allEdges: WireEdge[],
    tags?: string[],
    deferIndex?: boolean,
): Promise<CommitDelta> {
```

After:
```typescript
async _sendCommitBatch(
    changedFiles: string[],
    allNodes: WireNode[],
    allEdges: WireEdge[],
    tags?: string[],
    deferIndex?: boolean,
    protectedTypes?: string[],
): Promise<CommitDelta> {
```

### 2c. Update both `_send('commitBatch', {...})` calls in `_sendCommitBatch`

Both the fast-path and chunked-path `_send` calls need `protectedTypes` added:

```typescript
const response = await this._send('commitBatch', {
    changedFiles, nodes: allNodes, edges: allEdges, tags,
    ...(deferIndex ? { deferIndex: true } : {}),
    ...(protectedTypes && protectedTypes.length > 0 ? { protectedTypes } : {}),
});
```

Same pattern for the chunked loop (only on the first chunk where changedFiles is sent).

### 2d. Update `GraphBackend` interface (if it's defined in `@grafema/types`)

The `commitBatch` signature in the `GraphBackend` interface must match. Find it:

```typescript
// In packages/types/src/... (wherever GraphBackend is defined)
commitBatch?(tags?: string[], deferIndex?: boolean, protectedTypes?: string[]): Promise<CommitDelta>;
```

---

## Step 3: JSASTAnalyzer (`packages/core/src/plugins/analysis/JSASTAnalyzer.ts`)

### 3a. Update per-module commitBatch call (line ~396–399)

Current:
```typescript
await graph.commitBatch(
    ['JSASTAnalyzer', 'ANALYSIS', task.data.module.file],
    deferIndex,
);
```

After:
```typescript
await graph.commitBatch(
    ['JSASTAnalyzer', 'ANALYSIS', task.data.module.file],
    deferIndex,
    ['MODULE'],  // Protect MODULE nodes created by INDEXING phase (REG-489)
);
```

### 3b. Check `executeParallel` path (parallel parsing mode)

There is a separate code path `executeParallel` for `context.parallelParsing`. Check if it also calls `commitBatch` and apply the same `['MODULE']` protection.

---

## Step 4: Types Package (`packages/types/src/...`)

Locate the `GraphBackend` interface definition and update the `commitBatch` method signature to include the optional `protectedTypes` parameter.

---

## Step 5: Tests

### Test 1: Unit test for `handle_commit_batch` with `protected_types` (Rust)

Location: In `rfdb_server.rs` test module, add a new `#[test]` function.

Test scenario:
1. Create a MODULE node for `app.js` (simulating INDEXING phase)
2. Call `handle_commit_batch` with `changed_files: ["app.js"]`, nodes = [FUNCTION node], `protected_types = ["MODULE"]`
3. Assert: MODULE node still exists, FUNCTION node exists, CONTAINS edge still exists
4. Assert: `nodes_removed` count = 0 (MODULE was skipped)

### Test 2: Integration test verifying cross-phase survival (TypeScript)

Location: `test/unit/REG489ModuleSurvival.test.js`

Test scenario:
1. Run Orchestrator with `forceAnalysis: true` on a fixture directory with JS files
2. Assert: All MODULE nodes exist after full analysis pipeline completes
3. Assert: All CONTAINS edges (SERVICE→MODULE) exist
4. Assert: No ghost edges (edges pointing to non-existent nodes)
5. Assert: Analysis time is within 20% of REG-487 baseline (performance not regressed)

### Test 3: Verify incremental re-analysis idempotency

Location: `test/unit/REG489IncrementalIdempotency.test.js`

Test scenario:
1. Run analysis on fixture directory
2. Run analysis AGAIN with same files (forceAnalysis: false, files unchanged)
3. Assert: MODULE count unchanged (not doubled or lost)
4. Assert: FUNCTION count unchanged (old analysis nodes replaced, not accumulated)

---

## Correctness Invariants

After this fix, the following must hold for every file `X.ts`:

| Condition | Before Fix | After Fix |
|-----------|-----------|-----------|
| MODULE node exists after full pipeline | NO (only 14/330) | YES (330/330) |
| CONTAINS (SERVICE→MODULE) edge exists | NO | YES (edge preserved with MODULE) |
| DEPENDS_ON (MODULE→MODULE) edges exist | NO | YES (edge preserved with MODULE) |
| FUNCTION nodes exist | YES | YES (unchanged, analysis nodes not protected) |
| SCOPE nodes exist | YES | YES |
| Re-analysis removes stale analysis nodes | YES | YES (FUNCTION/SCOPE/etc. still deleted and replaced) |
| Re-analysis preserves MODULE | N/A (it was already lost) | YES |

---

## Risk Assessment

**Low risk** — change is additive and backward-compatible:
- Empty `protected_types` = zero behavior change (existing commits unaffected)
- `#[serde(default)]` on the Rust field means old clients sending no `protectedTypes` still work
- Optional parameter in TypeScript client means callers not passing it get legacy behavior
- Only JSASTAnalyzer's batch calls change behavior; INDEXING, ENRICHMENT, VALIDATION unchanged

**Edge case: incremental re-analysis of changed file**
When a file X.ts changes:
1. INDEXING re-runs for X.ts with `commitBatch` (no protectedTypes) → replaces MODULE with updated hash/metadata
2. ANALYSIS re-runs for X.ts with `commitBatch(protectedTypes: ['MODULE'])` → replaces FUNCTION/SCOPE/etc., preserves new MODULE
Correct.

**Edge case: file deleted from codebase**
If X.ts is removed, INDEXING would not run for it on re-analysis. The old MODULE and analysis nodes persist. This is existing behavior, unchanged by this fix. Separately addressed by incremental re-analysis cleanup (different issue).

---

## Implementation Order

1. Rust server change (Step 1) — foundation, enables the protocol extension
2. Build rfdb-server (`cargo build` in packages/rfdb-server)
3. TypeScript client change (Step 2) — exposes the new parameter
4. Types package update (Step 4) — ensures interface matches
5. JSASTAnalyzer change (Step 3) — uses the new parameter
6. Write Rust unit test (Step 5, Test 1)
7. Run `pnpm build` then run integration tests (Step 5, Tests 2+3)
8. Verify with full analysis run: MODULE count should be 330/330, disconnected nodes < 10%

---

## What We Are NOT Doing

- Not changing the delete-then-add semantics of commitBatch (they're correct for single-phase)
- Not changing how INDEXING phase commits (no protectedTypes needed there)
- Not changing the ENRICHMENT or VALIDATION phase batch behavior
- Not adding protectedTypes to PhaseRunner's generic `runPluginWithBatch` — unnecessary, JSASTAnalyzer manages its own batch
- Not refactoring JSModuleIndexer to use different node types or namespaces
- Not changing the `file` field on any nodes
- No architectural changes to the multi-phase pipeline

---

## Note on IMPORT/EXPORT Nodes

The task brief asked: "what about IMPORT/EXPORT nodes also created in indexing?"

Finding: **JSModuleIndexer does NOT create IMPORT or EXPORT nodes.** These are created exclusively by JSASTAnalyzer (ANALYSIS phase) through ModuleRuntimeBuilder and ImportExportVisitor. JSModuleIndexer's `metadata.creates` confirms: `nodes: ['MODULE'], edges: ['CONTAINS', 'DEPENDS_ON']`.

So there is no IMPORT/EXPORT survival problem. Only MODULE needs protection.

---

## Summary of Wire Protocol Change

```
commitBatch message (before):
{
  "changedFiles": ["src/X.ts"],
  "nodes": [...],
  "edges": [...],
  "deferIndex": true
}

commitBatch message (after, for ANALYSIS phase):
{
  "changedFiles": ["src/X.ts"],
  "nodes": [...],
  "edges": [...],
  "deferIndex": true,
  "protectedTypes": ["MODULE"]  // NEW: server preserves MODULE nodes during deletion
}
```

The change is minimal, backward-compatible, and precisely targeted at the root cause.
