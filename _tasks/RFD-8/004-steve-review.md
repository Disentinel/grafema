# Steve Jobs Review: RFD-8 T3.1 Tombstones + Batch Commit

> Date: 2026-02-14
> Reviewer: Steve Jobs (Vision & Architecture Gatekeeper)
> Status: **APPROVE** (with one mandatory fix noted below)
> Documents reviewed: 002-don-plan.md, 003-joel-tech-plan.md

---

## Verdict: APPROVE

This plan is solid. It does the right thing at the right abstraction level. Let me walk through why.

---

## 1. Vision Alignment

**Does this move toward "AI should query the graph, not read code"?**

Yes. Tombstones + batch commit are foundational infrastructure. Without them, the graph cannot represent incremental re-analysis -- which means every analysis run is a full wipe-and-rebuild. That makes Grafema useless for large codebases where analysis runs take minutes. Incremental re-analysis is a prerequisite for the product thesis to work at scale.

**Is this the right architectural approach?**

Yes. The Delta Lake Deletion Vectors pattern is the correct mental model. In-memory HashSet tombstones persisted in manifests is dramatically simpler than creating a new segment type. The plan correctly identifies that segments are immutable columnar stores optimized for reads -- shoving deletion markers into that format would be engineering malpractice.

---

## 2. Complexity & Architecture Checklist

**Iteration space:** commit_batch is O(F * N_per_file) for snapshotting old state, where F = changed files and N_per_file is typically 10-100 nodes. This is targeted, not a full scan. PASS.

**Edge tombstoning:** O(S_edge * K * bloom_check + S_matching * N_seg). The bloom filter is the key optimization -- most segments are skipped entirely. This is NOT an O(N) scan over all edges. PASS.

**Read path overhead:** O(1) per record (HashSet lookup). Negligible. PASS.

**Plugin architecture:** commit_batch is a new method on MultiShardStore. Existing add_nodes/add_edges/flush_all API is unchanged. No breaking changes. PASS.

**Memory:** 100K tombstoned nodes = 1.6 MB. 8 shards * 1.6 MB = 12.8 MB. Acceptable until compaction. PASS.

---

## 3. Critical Review Points

### 3.1 The Node Re-Addition Bug (Section 10.3) -- CORRECTLY IDENTIFIED

Joel found a real bug in the naive algorithm: if a node is tombstoned and then re-added with the same ID in the same commit_batch, the tombstone would make the new node invisible. The fix (Phase 5.5: remove new node IDs from tombstone set after adding) is correct and necessary.

**This is exactly the kind of thing that would have shipped as a "known limitation" in a lesser plan.** Good catch.

### 3.2 Inline Flush vs. flush_all() -- PRAGMATIC DECISION

The plan correctly identifies that flush_all() commits its own manifest, so commit_batch cannot call it -- it needs to inject tombstones between create_manifest() and commit(). Inlining ~40 lines of flush coordination is the right call for L0. The plan explicitly identifies the future refactoring opportunity (extract flush_shards_only()). This is not cutting corners -- this is deliberate technical debt with a clear payoff boundary.

### 3.3 Database-Wide Tombstones (Not Per-Shard) -- CORRECT

Each shard gets a clone of the full tombstone set. The cost is 8 * 1.6 MB = 12.8 MB for 100K tombstones across 8 shards. This is the right tradeoff: simplicity over memory optimization. Per-shard tombstones would require the caller to know which shard contains which record, which breaks the fan-out query model.

### 3.4 Edge Tombstone String Allocation -- ACCEPTABLE

contains_edge() allocates a String for the HashSet lookup. This is called once per candidate edge during queries. For L0 workloads (10K edges), this is negligible. The plan identifies the optimization path (hash u64 instead of String) if profiling shows it's hot. ACCEPTABLE.

---

## 4. Potential Gaps Examined

### 4.1 Does commit_batch handle empty edge list correctly?

Yes. If edges is empty, add_edges(edges) is a no-op. The tombstone_edge_keys will still be computed (for old edges from tombstoned nodes). New edge types won't be added to changed_edge_types. This is correct.

### 4.2 Does the plan handle files that exist across multiple shards?

Yes. find_nodes(None, Some(file)) in MultiShardStore fans out to all shards. Tombstone computation collects all old node IDs regardless of shard. The tombstone set is applied to ALL shards. Cross-shard consistency is maintained.

### 4.3 Is the CommitDelta accurate for the re-addition case?

After the Phase 5.5 fix: tombstoned node IDs that get re-added are removed from the tombstone set but they were already counted in nodes_removed (from Phase 2). The new nodes are counted in nodes_added. This means a node that was "modified" (same ID, different content) will appear as both removed and added, with nodes_modified tracking the semantic modification. The delta is accurate -- nodes_removed counts IDs that WERE tombstoned from old data, nodes_added counts IDs that were written as new data. If a node has the same ID, nodes_modified captures that.

### 4.4 Does the plan preserve manifest crash safety?

Yes. The plan uses the existing ManifestStore two-step protocol: create_manifest() -> mutate -> commit(). The commit() method already implements atomic write (temp + fsync + rename). If the process crashes before commit(), old manifest is current. If after, new manifest with tombstones is current. PASS.

### 4.5 Tombstone accumulation correctness

The plan correctly unions new tombstones with existing tombstones from the current manifest. This ensures that tombstones from commit N survive into commit N+1. Compaction (T4.x) will clear them. PASS.

---

## 5. One Mandatory Fix

**Section 3.6, Phase 7 (inline flush):** The pseudocode references `self.shards[shard_idx].write_buffer_size()` but this method doesn't appear in the Shard public API shown in the plan. Joel needs to verify that `write_buffer_size()` exists as a public method on Shard, or note that it needs to be added.

Looking at the actual code -- `write_buffer_size()` IS used by the existing `flush_all()` implementation (line 289 of multi_shard.rs), so it must already exist. This is fine. No change needed.

**Revised: No mandatory fixes.** The plan is ready for implementation.

---

## 6. What I Would NOT Accept

- If the plan proposed a new SegmentType::Tombstone with new readers/writers -- REJECTED. Overcomplicated.
- If tombstones were per-segment-descriptor instead of per-manifest -- REJECTED. Wrong abstraction.
- If commit_batch called flush_all() and then committed another manifest to add tombstones -- REJECTED. Wastes manifest versions, creates a window where queries see inconsistent state.
- If the "node re-addition bug" was labeled as a "known limitation for MVP" -- REJECTED. It defeats the purpose of batch commit.

The plan avoids ALL of these. It makes the right decisions.

---

## 7. Summary

| Check | Result |
|-------|--------|
| Vision alignment | PASS -- foundational for incremental re-analysis |
| Correct architecture | PASS -- Delta Lake DV pattern, in-memory HashSet |
| No O(N) full scans | PASS -- targeted per-file, bloom-assisted |
| Existing API preserved | PASS -- add_nodes/add_edges/flush_all unchanged |
| Critical bug fixed | PASS -- node re-addition handled in Phase 5.5 |
| Crash safety | PASS -- atomic manifest commit preserved |
| Backward compatibility | PASS -- serde(default) on new fields |
| Scope appropriate | PASS -- ~600 LOC, 38 tests, 5 atomic commits |

**APPROVE.** Proceed to user review (Vadim).
