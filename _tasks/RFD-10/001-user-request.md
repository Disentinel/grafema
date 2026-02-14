# RFD-10: T3.3 — Client Snapshot API

## Source

Linear issue RFD-10 (RFDB team, RFDB v2 project, M3: Incremental Core milestone)

## Description

Client Phase E. Snapshot operations: diff, tag, find, list.

**~150 LOC, ~10 tests**

### Subtasks

1. `diffSnapshots(from, to)` — by number or by tag
2. `tagSnapshot(tags)`, `findSnapshot(tag, value)`, `listSnapshots(filter?)`
3. `SnapshotDiff` type definition
4. Snapshot reference types (number | {tag, value})

### Validation

- tag -> find -> diff workflow
- Diff by number = diff by resolved tag
- listSnapshots with filter -> correct subset

### Dependencies

- RFD-5 (T2.1: Manifest + Snapshot Chain) — DONE
- RFD-8 (T3.1: Tombstones + Batch Commit) — DONE

### Blocks

- RFD-14 (T4.4: Integration Gate Validation)
