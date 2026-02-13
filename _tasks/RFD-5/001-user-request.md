# RFD-5: T2.1 Manifest + Snapshot Chain

## Linear Issue
- **ID:** RFD-5
- **Title:** T2.1: Manifest + Snapshot Chain
- **Milestone:** M2: Storage Engine
- **Estimate:** 3 Points
- **Labels:** Track 1: Rust
- **Dependencies:** ← T1.1 (Segment Format) — DONE

## Scope

RFDB Phase 1. Immutable snapshot chain with tags.

**~500 LOC, ~25 tests**

### Subtasks

1. Manifest JSON format: segment registry + stats + tags
2. Manifest chain: sequential version numbers (v1, v2, v3...)
3. Snapshot tags: optional key-value pairs per manifest
4. `current.json` atomic pointer (symlink or atomic rename)
5. Snapshot = immutable view of active segments
6. Diff computation: compare two manifests → added/removed segments
7. FindSnapshot (tag → number), ListSnapshots (filter by tag)
8. GC bookkeeping: old segments → gc/ directory

### Validation

* Crash simulation: kill mid-write → `current.json` always valid
* Concurrent reads: one thread reads + another swaps → no torn reads
* GC safety: segments in gc/ not referenced by any snapshot
* Version monotonicity: snapshot numbers always increase
* **Diff correctness: DiffSnapshots returns exact added/removed/modified**
