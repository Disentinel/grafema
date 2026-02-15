# RFD-14: T4.4 Integration Gate Validation

## Source
Linear issue RFD-14, Milestone M4: Integration Gate

## Description

Comprehensive validation after M4. All tracks converge.

**~15 tests + benchmark report**

### Subtasks

1. Full test suite: all Rust tests + all TS tests + integration
2. **Benchmark suite: v2 vs v1 performance comparison** (query latency, write throughput, memory)
3. Stress test: synthetic graph 100K nodes / 700K edges
4. Crash recovery test: kill during batch → restart → correct state
5. Concurrent clients test: two TS clients → same server → independent batches
6. **Semantic ID isolation test:** Run v2 engine with v1 semantic IDs first → validate. Then run with v2 semantic IDs → validate. Compare results. Separates storage engine bugs from ID format bugs.

### Dependencies

← T4.1, T4.2, T4.3, T3.2, T3.3

### Context

This is the integration gate for RFDB v2 — all tracks (Rust storage engine, TS client, protocol) must be validated together. The gate ensures v2 is production-ready before further work proceeds.
