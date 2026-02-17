## Dijkstra Correctness Review (v2)

**Verdict:** APPROVE

**Functions reviewed:**
- `collect_and_write_data()` — APPROVE (extracted shared helper, behavior preserved)
- `flush()` after extraction — APPROVE (behavior identical to pre-refactor)
- `flush_data_only()` after extraction — APPROVE (behavior identical to pre-refactor)
- `rebuild_indexes()` — APPROVE (unchanged from v1)
- Orchestrator `run()` — APPROVE (gap #1 resolved)
- Orchestrator `runMultiRoot()` — APPROVE (gap #1 resolved in both paths)

**Previous gaps:**
- Gap 1 (optimization miss): RESOLVED
- Gap 2 (latent risk): STILL OPEN — acceptable, precondition holds in all current activation paths

---

### 1. Gap #1 Resolution: `_isEmptyGraph()` ordering

**Verified locations:**
- `run()` at Orchestrator.ts:188-196: `_deferIndexing` set at line 189, `graphInitializer.init()` at line 196
- `runMultiRoot()` at Orchestrator.ts:308-316: `_deferIndexing` set at line 309, `graphInitializer.init()` at line 316

Both paths now check BEFORE `graphInitializer.init()`. Comments on both lines read:
`"Must check BEFORE graphInitializer.init() which adds plugin nodes to delta."`

**Input enumeration for `_isEmptyGraph()` at the new call site:**

| Scenario | Graph state at call site | `_isEmptyGraph()` result | `_deferIndexing` result | Correct? |
|----------|--------------------------|--------------------------|------------------------|----------|
| `forceAnalysis=true` (any run) | Graph cleared by `clear()` on line 182 | NOT called (short-circuit `||`) | `true` | YES |
| `forceAnalysis=false`, first-ever run | Segment empty, delta empty (init not called yet) | `nodeCount()=0` → `true` | `true` | YES — GAP CLOSED |
| `forceAnalysis=false`, incremental run | Segment has existing nodes | `nodeCount()>0` → `false` | `false` | YES |
| `forceAnalysis=false`, `nodeCount()` throws | Exception caught in `_isEmptyGraph()` catch block | returns `true` (conservative) | `true` | YES — fails safe |

**The `forceAnalysis=false, first-ever run` case is the exact scenario gap #1 described.** Before fix: `graphInitializer.init()` had already added 20-35 plugin nodes to delta, so `nodeCount()` returned >0, `_isEmptyGraph()=false`, deferred indexing incorrectly disabled. After fix: delta is empty at call site, `nodeCount()=0`, deferred indexing correctly enabled.

**GAP #1: RESOLVED.**

---

### 2. `collect_and_write_data()` extraction — behavioral equivalence verification

The v1 review relied on the fact that `flush()` and `flush_data_only()` shared identical data-collection code. That identity was visual (same 120 lines of source). The extraction replaces textual duplication with a shared call. I must verify the extracted code is exactly what was in both callers and that nothing was added, removed, or reordered.

**Enumeration of all operations performed by `collect_and_write_data()`:**

1. **Early return: empty delta** (line 741-743) — `delta_log.is_empty()` → `Ok(false)`
2. **Early return: ephemeral** (line 746-749) — `is_ephemeral()` → clear delta log, `Ok(false)`
3. **Node collection from segment** (lines 759-795) — skip deleted, skip delta-overridden; construct `NodeRecord`
4. **Node collection from delta** (lines 800-806) — live delta nodes only
5. **Edge collection from delta** (lines 815-821) — `edges_map` with delta-first priority
6. **Edge collection from segment** (lines 824-855) — skip deleted edges, don't overwrite delta
7. **Close old segments** (lines 860-861) — set to `None` before overwriting
8. **Write to disk** (lines 864-877) — `write_nodes`, `write_edges`, `write_metadata`
9. **Update `metadata`** (lines 869-875)
10. **Clear delta state** (lines 880-885) — `delta_log`, `delta_nodes`, `delta_edges`, `deleted_segment_ids`, `deleted_segment_edge_keys`, `edge_keys`
11. **Reload segments** (lines 888-889)
12. **Reset `ops_since_flush`** (line 892)
13. **Return `Ok(true)`** (line 894)

**What `flush()` now does (after extraction):**

```rust
fn flush(&mut self) -> Result<()> {
    if !self.collect_and_write_data()? {  // steps 1-13 above
        return Ok(());
    }
    // Rebuild index_set from new segment
    self.index_set.clear();
    if let Some(ref nodes_seg) = self.nodes_segment {
        self.index_set.rebuild_from_segment(nodes_seg, &self.declared_fields);
    }
    // Rebuild adjacency, reverse_adjacency, and edge_keys
    self.adjacency.clear();
    self.reverse_adjacency.clear();
    // edge_keys already cleared in collect_and_write_data
    if let Some(ref edges_seg) = self.edges_segment {
        for idx in 0..edges_seg.edge_count() { ... }
    }
    Ok(())
}
```

**What `flush_data_only()` now does (after extraction):**

```rust
fn flush_data_only(&mut self) -> Result<()> {
    if !self.collect_and_write_data()? {  // steps 1-13 above
        return Ok(());
    }
    // SKIP index/adjacency rebuild
    Ok(())
}
```

**Pre-refactor contract for `flush()`:** data write + index rebuild.
**Post-refactor contract for `flush()`:** `collect_and_write_data()` + index rebuild. Data write is inside `collect_and_write_data()`. Index rebuild is in `flush()` body as before.

**Pre-refactor contract for `flush_data_only()`:** data write only (no index rebuild).
**Post-refactor contract for `flush_data_only()`:** `collect_and_write_data()` only. Data write is inside. No index rebuild. Same contract.

**Critical check — `edge_keys` in `flush()` after extraction:**

The comment at `flush()` line 1280 reads: `// edge_keys already cleared in collect_and_write_data`

This is correct. `collect_and_write_data()` clears `edge_keys` at line 885. Then `flush()` proceeds to rebuild adjacency and re-inserts into `edge_keys` at line 1293. The clearing happens inside the helper, the rebuild happens in `flush()` body. Ordering is preserved.

**Edge case: `collect_and_write_data()` returns `Ok(false)` (early exit)**

When `delta_log.is_empty()` or ephemeral: helper returns `false`. Both `flush()` and `flush_data_only()` do `if !... { return Ok(()); }`. Neither attempts index rebuild on empty-delta path. This matches pre-refactor behavior (both had the same early-exit guards at the top).

**Verdict: behavioral equivalence confirmed. APPROVE.**

---

### 3. New correctness issues from refactoring

**`maybe_auto_flush()` calls `flush()`, not `flush_data_only()`:**

`maybe_auto_flush()` is triggered by `add_nodes()` (line 906) and `add_edges()` (line 1203) via the ops threshold (`usize::MAX` — effectively disabled) or 80% memory pressure.

`handle_commit_batch` with `defer_index=true` calls `add_nodes()` and `add_edges()` before calling `flush_data_only()`. If memory pressure triggers during those calls, `maybe_auto_flush()` will call `flush()` (with index rebuild), not `flush_data_only()`.

**Is this a new bug introduced by the refactoring?** No. This existed before the extraction. The refactoring did not change `maybe_auto_flush()`, `add_nodes()`, or `add_edges()`. This is a pre-existing issue unrelated to the tech debt fixes under review.

**Is this a correctness risk?** In practice: `AUTO_FLUSH_THRESHOLD = usize::MAX` (disabled). Memory flush at 80% is possible but would trigger a full `flush()` that rebuilds indexes — which is MORE work than deferred but NOT incorrect. It does not corrupt data. The worst outcome: a mid-bulk-load index rebuild is an unnecessary performance cost, not a correctness violation.

**No new correctness issues introduced by the four tech debt fixes.**

---

### Summary

| Gap from v1 | Status | Evidence |
|-------------|--------|----------|
| Gap 1: `_isEmptyGraph()` called after `graphInitializer.init()` | RESOLVED | Both `run()` (line 189) and `runMultiRoot()` (line 309) now call `_isEmptyGraph()` before `graphInitializer.init()`. First-run without `--force` now correctly activates deferred indexing. |
| Gap 2: `find_by_attr` misses segment nodes when `defer_index=true` on non-empty graph | STILL OPEN — ACCEPTABLE | Not exploitable. `defer_index=true` is only activated when graph is empty (`forceAnalysis` or first run). Precondition holds in all current activation paths. |

**No new correctness issues introduced by the four tech debt fixes:**
1. `collect_and_write_data()` extraction — behavioral equivalence verified by enumeration
2. `eprintln!` → `tracing::info!` — pure observability change, no behavioral effect
3. `@internal` on `_sendCommitBatch` — documentation only, no behavioral effect
4. `_isEmptyGraph()` moved before `graphInitializer.init()` — closes gap #1, no regressions

**Verdict: APPROVE**
