# RFD-9: Client Batch API

## Task Description

Client Phase C. Batch operations and blast radius query.

**~200 LOC, ~15 tests**

### Subtasks

1. `beginBatch()`, `commitBatch(tags?)`, `abortBatch()` methods
2. `CommitDelta` type definition + parsing
3. `findDependentFiles(changedFiles)` for C4 blast radius (client-side fallback)
4. Auto-commit detection (AddNodes without BeginBatch)

### Validation

- Batch → commit → delta correct
- Batch → abort → nothing committed
- AddNodes without batch → auto-commit
- **Integration: TS client → Rust server → batch round-trip**

### Dependencies

← T3.1 (RFD-8: Rust batch), T1.3 (Request IDs)
