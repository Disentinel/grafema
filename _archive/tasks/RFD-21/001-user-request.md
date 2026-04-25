# RFD-21: T6.2 Resource Adaptation

## Linear Issue
https://linear.app/reginaflow/issue/RFD-21/t62-resource-adaptation

## Description

Resource Adaptation (Track 1, Rust). RFDB Phase 8. Adaptive parameters based on system resources.

**~400 LOC, ~12 tests**

### Subtasks

1. ResourceManager: monitor RAM, CPU
2. Adaptive write buffer, shard thresholds, compaction threads
3. Memory pressure handling
4. Prefetch strategy

### Validation

- Low-memory (512MB) → works, slower
- High-memory (64GB) → larger batches, faster
- **No OOM: enforce limits, degrade gracefully**

### Dependencies

← T6.1 (Compaction) — **Done**
