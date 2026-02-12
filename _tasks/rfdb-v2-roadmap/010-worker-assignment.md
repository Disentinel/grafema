# RFDB v2: Worker Assignment Plan

> 3 workers, 25 tasks, 97 story points
> Critical path: ~68 pts

---

## Workers

| Worker | Role | Language | Loaded |
|--------|------|----------|--------|
| **W1** | Rust Primary | Rust | Always (critical path) |
| **W2** | TS Primary | TS | M1, M3-M5 (free during M2) |
| **W3** | Analyzer → Rust Secondary | TS/Rust | M1, M5-M6 (free during M2-M4) |

---

## Full Assignment

### M1: Foundation (all parallel)

```
W1: [RFD-1  T1.1 Segment Format      ] 8pts  Rust
W2: [RFD-2  T1.2 Enricher Contract   ] 3pts  TS
    [RFD-3  T1.3 Client Request IDs  ] 1pt   TS
W3: [RFD-4  T1.4 Semantic ID v2      ] 5pts  TS
```

**Sync S1:** Segment format frozen, enricher contract stable, semantic ID v2 validated.

---

### M2: Storage Engine (W1 sequential, W2/W3 free)

```
W1: [RFD-5  T2.1 Manifest    ] 3pts → [RFD-6  T2.2 Single-Shard ] 8pts → [RFD-7  T2.3 Multi-Shard] 5pts
W2: ~~~~~~~~~~~~~~~~~~~~~~~~~~~~ backlog (REG-xxx) ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
W3: ~~~~~~~~~~~~~~~~~~~~~~~~~~~~ backlog (REG-xxx) ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
```

**16 pts sequential Rust.** W2/W3 work on Grafema v0.2 backlog. Do NOT invent make-work inside RFDB.

---

### M3: Incremental Core

```
W1: [RFD-8  T3.1 Tombstones+Batch    ] 5pts  Rust
     ↓ unblocks W2
W2:  ·····[RFD-9  T3.2 Client Batch  ] 2pts  TS
           [RFD-10 T3.3 Client Snap   ] 1pt   TS  (parallel with T3.2)
W3: ~~~~~~~~~~~~~~~~~~~~~~~~~~~~ backlog ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
```

**Sync S2:** Batch protocol wire format frozen.

---

### M4: Integration Gate ★

```
W1: [RFD-11 T4.1 Wire Protocol v3 ██████████] 8pts  Rust  ← HIGHEST RISK
     ↓ unblocks W2+W3
W2:  ·····[RFD-12 T4.2 Semantic Wire ] 2pts  TS  ┐
           [RFD-13 T4.3 Streaming     ] 2pts  TS  ┤ parallel
W3:  ·····                                        │
     ·····[RFD-14 T4.4 Gate Validation] 3pts      ┘ after T4.1-3 + T3.2-3
```

**Sync S3 ★:** ALL 120+ tests pass. v2 replaces v1. Performance baseline established.

---

### M5 + M6: Enrichment + Performance (OVERLAP)

```
W1: [RFD-15 T5.1 Virtual Shards      ] 5pts  Rust
     ↓
    [RFD-23 T7.1 Migration Tool       ] 3pts  Rust  (can start early, only needs T4.1)

W2: [RFD-16 T5.2 Orchestrator Batch  ] 5pts  TS
     ↓ unblocks T5.3 + T5.4
    [RFD-17 T5.3 Dependency Propagation] 2pts  TS  ┐
    [RFD-18 T5.4 Guarantee Integration ] 2pts ←W3  ┤ parallel (T5.4 can go to W3)
     ↓                                             │
    [RFD-19 T5.5 Enrichment Validation ] 3pts      ┘ after T5.1-4

W3: [RFD-20 T6.1 Background Compaction] 8pts  Rust  ← parallel with M5!
     ↓
    [RFD-21 T6.2 Resource Adaptation  ] 3pts  Rust
     ↓
    [RFD-22 T6.3 Benchmark Suite      ] 2pts  Rust
```

**3 parallel streams!** This is peak utilization.

**Sync S4:** Enrichment pipeline validated.
**Sync S5:** Compaction + resources stable.

---

### M7: Validation & Release

```
W1: [RFD-24 T7.2 Real Codebase Validation ] 5pts  ← needs M5+M6+T7.1
     ↓
    [RFD-25 T7.3 Stress Test               ] 3pts  ← needs M6
W2: ~~~~~~~~~~~~~~~~~~~~~~~~~~~~ free / backlog ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
W3: ~~~~~~~~~~~~~~~~~~~~~~~~~~~~ free / assist T7.2 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
```

**Sync S6 ★:** Real codebase validated. Ready for production.

---

## Visual Timeline

```
Points →  0    5    10   15   20   25   30   35   40   45   50   55   60   65   70
          │    │    │    │    │    │    │    │    │    │    │    │    │    │    │
W1 Rust:  [T1.1···][T2.1][T2.2·········][T2.3····][T3.1····][T4.1··········][T5.1····][T7.1··][T7.2····][T7.3··]
                                                                             │                  │
W2 TS:    [T1.2][T1.3]~~ backlog ~~~~~~~~[T3.2][T3.3]·[T4.2][T4.3]·[T5.2····][T5.3][T5.5··]  │
                                                                     │                         │
W3 Mixed: [T1.4····]~~~~~~ backlog ~~~~~~~~~~~~~~[T4.4··]···[T5.4]·[T6.1··········][T6.2··][T6.3]
                                                                                            │
          ╟═══════╢══════════════════════╢════════╢══════════╢═══════════════════╢═══════════╢
            M1           M2                M3        M4            M5 + M6            M7
          (parallel)  (Rust only)       (Rust→TS)  (Gate ★)    (3 streams!)      (converge)
```

---

## Idle Time Summary

| Worker | Idle During | Action |
|--------|-------------|--------|
| **W1** | Never | Critical path, always loaded |
| **W2** | M2 (~16pts) | Work on Grafema backlog (REG-xxx) |
| **W3** | M2 + M3 + part of M4 (~25pts) | Work on Grafema backlog (REG-xxx) |

**Total idle:** W2 ~16pts, W3 ~25pts → **~41 pts available for backlog work** during RFDB v2 development.

---

## Task-to-RFD Quick Reference

| Task | RFD | Worker | Milestone | Pts |
|------|-----|--------|-----------|-----|
| T1.1 Segment Format | RFD-1 | W1 | M1 | 8 |
| T1.2 Enricher Contract | RFD-2 | W2 | M1 | 3 |
| T1.3 Client Request IDs | RFD-3 | W2 | M1 | 1 |
| T1.4 Semantic ID v2 | RFD-4 | W3 | M1 | 5 |
| T2.1 Manifest | RFD-5 | W1 | M2 | 3 |
| T2.2 Single-Shard | RFD-6 | W1 | M2 | 8 |
| T2.3 Multi-Shard | RFD-7 | W1 | M2 | 5 |
| T3.1 Tombstones+Batch | RFD-8 | W1 | M3 | 5 |
| T3.2 Client Batch | RFD-9 | W2 | M3 | 2 |
| T3.3 Client Snapshots | RFD-10 | W2 | M3 | 1 |
| T4.1 Wire Protocol v3 | RFD-11 | W1 | M4 | 8 |
| T4.2 Semantic ID Wire | RFD-12 | W2 | M4 | 2 |
| T4.3 Streaming | RFD-13 | W2 | M4 | 2 |
| T4.4 Gate Validation | RFD-14 | W3 | M4 | 3 |
| T5.1 Virtual Shards | RFD-15 | W1 | M5 | 5 |
| T5.2 Orchestrator Batch | RFD-16 | W2 | M5 | 5 |
| T5.3 Dependency Prop. | RFD-17 | W2 | M5 | 2 |
| T5.4 Guarantee Integ. | RFD-18 | W3 | M5 | 2 |
| T5.5 Enrichment Valid. | RFD-19 | W2 | M5 | 3 |
| T6.1 Compaction | RFD-20 | W3 | M6 | 8 |
| T6.2 Resources | RFD-21 | W3 | M6 | 3 |
| T6.3 Benchmarks | RFD-22 | W3 | M6 | 2 |
| T7.1 Migration | RFD-23 | W1 | M7 | 3 |
| T7.2 Real Codebase | RFD-24 | W1 | M7 | 5 |
| T7.3 Stress Test | RFD-25 | W1 | M7 | 3 |

---

## Notes

1. **W1 is the bottleneck.** Everything depends on Rust track. If W1 slows down, everything slides.
2. **M2 is the desert.** ~16pts of sequential Rust. W2/W3 should work on Grafema backlog, not RFDB make-work.
3. **M5+M6 is peak utilization** — 3 parallel streams (Rust shards, TS orchestrator, Rust compaction).
4. **T4.1 is highest risk** (8pts, ~120 test adaptations). Decomposed into 5 sub-tasks (T4.1a-e).
5. **T7.1 can start early** — only depends on T4.1, not on M5/M6. W1 can do it between T5.1 and T7.2.
6. **v2 stays opt-in** (`--engine v2`) until M6 compaction delivers performance parity.
