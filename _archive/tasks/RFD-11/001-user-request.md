# RFD-11: T4.1 Wire Protocol v3 Integration

## Task

★ THE GATE. After T4.1, v2 engine fully replaces v1 behind same wire protocol. ALL ~120 existing tests must pass.

~500 LOC refactor, ~20 new tests + ~120 adapted

## Sub-Tasks

- **T4.1a** — GraphEngine Trait Implementation + Unit Tests (~15 tests)
- **T4.1b** — Protocol Handler Switchover + Adapted Tests (~120 adapted)
- **T4.1c** — New Protocol Commands (BeginBatch, CommitBatch, AbortBatch, DiffSnapshots, TagSnapshot, FindSnapshot, ListSnapshots, QueryEdges, FindDependentFiles) (~12 new tests)
- **T4.1d** — Ephemeral Database Support (~3 tests)
- **T4.1e** — Test Adaptation for Removed Commands (~5 tests)

## Dependencies

← T2.3 (Multi-Shard, RFD-7), T3.1 (Tombstones + Batch Commit, RFD-8)

## Validation

- ALL ~120 existing tests pass (adapted for removed commands)
- Wire backward compat: v1/v2 clients work unchanged
- Batch commit: 10-file batch → atomic
- Streaming: 50K nodes → chunked, client reassembles
- Benchmark: protocol overhead vs v1
