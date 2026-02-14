# RFD-7: T2.3 Multi-Shard

## Linear Issue
- **ID:** RFD-7
- **Title:** T2.3: Multi-Shard
- **Milestone:** M2: Storage Engine
- **Estimate:** 5 Points
- **Labels:** Track 1: Rust
- **Dependencies:** <- T2.2 (Single-Shard) DONE
- **Blocks:** -> T4.1 (Wire Protocol v3 Integration)

## Scope

RFDB Phase 3. Directory-based sharding with fan-out queries.

**~800 LOC, ~20 tests**

### Subtasks

1. Shard planner: file list -> shard assignments (directory-based)
2. Multi-shard queries: fan-out + merge
3. Parallel shard writes (rayon)
4. Cross-shard point lookup via bloom filters

### Validation

* Deterministic: same files -> same plan
* Completeness: every file in exactly one shard
* Parallel correctness: N workers = sequential result
* Query completeness: node findable regardless of shard
* Shard plan stability: small change -> minimal reassignment
