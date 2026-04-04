# Node-Level Incremental Reanalysis

**Date**: 2026-04-04
**Context**: Discussion during REG-576 fix — blast radius analysis showed 256s re-analysis for 10-line change in 2 files.

## Problem

When a file changes, the orchestrator re-analyzes the entire file and re-runs resolution broadly. For a 10-line change in `traceDataflow.ts` (~850 lines, ~1800 nodes), we:

1. Parse entire file from scratch
2. Delete all old nodes/edges for the file
3. Commit ~1800 new nodes + ~4000 edges
4. Re-run resolution (scope unclear — possibly broader than needed)
5. Re-derive all 670 DEPENDS_ON edges
6. Compact all shards once at the end

Total: ~256s for 10 changed lines.

## Current Architecture

### What we have

- **Generation watermark** (`_generation` on nodes/edges) — file-level change detection
- **`_source` metadata** on derived edges — who created them (analyzer, js-resolution, etc.)
- **`defer_index=true`** during analysis — all commits skip index rebuilds
- **Single compaction** at end of analysis with `segment_threshold: 1` (force all shards)
- **Separate `grafema resolve`** command (REG-812) — retry resolution without re-parsing

### Compaction strategy (verified in code)

- `commitBatch` always uses `defer_index=true` during analysis (main.rs:804-1673)
- Compaction runs ONCE after all phases: analysis → resolution → diagnostics → derived edges → compact (main.rs:1632-1636)
- Uses `segment_threshold: 1` to force-compact all shards
- Resolve phase skips compaction entirely (just `rebuild_indexes`) to avoid OOM
- Pre-resolve compaction was experimentally proven 2x slower (174s→305s) due to write buffer index invalidation (main.rs:845-857)

### Phase timing breakdown (approximate for 2-file change)

```
Parse 2 files:           ~2s    (Haskell parser)
Commit nodes/edges:      ~10s   (defer_index, write buffer only)
Resolution:              ~30s   (cross-file CALLS, IMPORTS_FROM)
Derived edges:           ~5s    (670 DEPENDS_ON)
Diagnostics:             ~5s    (20746 unresolved warnings)
Compact (all shards):    ~200s  (L0→L1 merge + index rebuild on 320K nodes)
Total:                   ~256s
```

**Compaction dominates** — 78% of total time. This is the real bottleneck.

## Proposed: Node-Level Diff

Instead of replacing ALL nodes/edges for a changed file, compute a diff and commit only changes.

### Algorithm

1. **Parse new file** → full AST → full node/edge list (can't avoid — AST is holistic)
2. **Load old nodes** for this file from RFDB (by file attribute)
3. **Match by semantic ID**:
   - Same semantic ID + same content hash → UNCHANGED
   - Same semantic ID + different content hash → MODIFIED
   - New semantic ID → ADDED
   - Missing semantic ID → DELETED
4. **Commit only the diff**: add new, update modified, tombstone deleted
5. **Re-resolve only affected nodes**: ADDED/MODIFIED CALL nodes need resolution

### Line shift problem

Adding N lines in the middle shifts all nodes below by N lines. Options:

1. **Ignore line shift** — positions go stale (bad for IDE integration)
2. **Bulk position update** — cheap metadata-only update, but still touches many nodes
3. **Relative positions** — store offset from function start, not absolute line (architectural change)
4. **Position as derived metadata** — don't store in RFDB, compute on-demand from source file

### Expected savings

For our 10-line change example:

| Phase | File-level (now) | Node-level diff | Savings |
|-------|-----------------|-----------------|---------|
| Parse | 2s | 2s | 0 |
| Commit | 10s (1800 nodes) | ~0.5s (~50 nodes) | 9.5s |
| Resolution | 30s (~800 CALLs) | ~0.5s (~4 new CALLs) | 29.5s |
| Derived edges | 5s (all 670) | ~0.1s (affected only) | 4.9s |
| Compact | 200s (full) | ~20s (less data to merge) | 180s |
| **Total** | **256s** | **~23s** | **~233s** |

**Key insight**: smaller commits → less L0 data → faster compaction. The node-level diff wins mostly through reducing compaction work, not just resolution.

## Edge-Level Provenance (complementary)

Node-level diff solves "what changed in this file". But cross-file impact requires knowing "which derived edges depend on this file's data".

### `_input_files` on derived edges

Each derived edge records which files it was derived from:

```
CALLS(dataflow-handlers.ts:CALL → traceDataflow.ts:FUNCTION)
  _source: "cross-file-calls"
  _input_files: ["dataflow-handlers.ts", "traceDataflow.ts"]
```

When file X changes:
1. Node-level diff within file X (as above)
2. Find derived edges with `_input_files` containing X → stale edges
3. Delete stale edges
4. Re-run only affected resolvers for affected scope
5. No duplicates, no dangling references

### How to populate `_input_files`

**Runtime instrumentation** (preferred):
- Wrap resolver's graph API (getNode, getOutgoingEdges, queryNodes)
- Wrapper logs which files the resolver actually reads
- Attach logged files to emitted edges as `_input_files` metadata
- Resolver code unchanged — instrumentation is in the runtime layer

**Static analysis of resolvers** (supplementary):
- Analyze resolver Haskell code with grafema-haskell-analyzer
- Extract edge types read (from `getOutgoingEdges` calls) and produced (from `emitEdge` calls)
- Gives TYPE-level DAG (resolver execution order), not INSTANCE-level scope
- Useful for topological sort of resolver pipeline, but not sufficient for incremental invalidation

## Implementation Phases

### Phase 1: Node-level diff in orchestrator (Rust)
- After parsing, diff new nodes against old by semantic ID
- Commit only added/modified/deleted nodes
- Re-resolve only affected CALL/IMPORT nodes
- **Impact**: reduces commit size and resolution scope, compaction gets less data

### Phase 2: `_input_files` runtime instrumentation (Haskell)
- Instrument resolver runtime to log file reads
- Attach `_input_files` to emitted edges
- Orchestrator uses this for selective invalidation
- **Impact**: cross-file edges correctly maintained without global re-resolution

### Phase 3: Incremental compaction (Rust/RFDB)
- Compact only shards with enough new L0 segments (respect threshold, don't force-compact all)
- In-place metadata updates for line shifts (no tombstone + re-insert)
- **Impact**: compaction time proportional to change size, not graph size

## Related Issues

- **RFD-20**: Background compaction (Done) — core L0→L1 infrastructure
- **RFD-34**: Automatic GC scheduling (Backlog) — related to compaction triggers
- **RFD-55**: Per-level read path (Done) — LSM-tree indexes, related to compaction perf
- **REG-812**: Separate `grafema resolve` command (Done) — partial incremental support
- **0c0ac95a**: Persist GenerationTracker for incremental analysis (recent commit)

## Open Questions

1. **Semantic ID stability**: are semantic IDs stable across edits? If function is renamed, old semantic ID disappears and new one appears — is that handled correctly?
2. **Content hash**: what to hash for "same content"? Full AST subtree? Or just signature (name + params)?
3. **Compaction proportionality**: will smaller commits actually make compaction faster? Or does L0→L1 merge have fixed overhead?
4. **Cross-language**: Haskell and Rust analyzers have different output formats — can node-level diff work uniformly?
