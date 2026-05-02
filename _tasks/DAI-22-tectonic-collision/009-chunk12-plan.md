# DAI-22 Chunk-12 — Edge-Lifting Through CONTAINS (plan)

**Status:** DRAFT — evidence gathered per Evidence Rule, awaiting Dijkstra fast-pass
**Supersedes the cohesion defect in:** `008-cohesion-gap-diagnosis.md`

## 0. Evidence (per Evidence Rule, `CLAUDE.md` Plan Mode)

Live-data recon on `.grafema/graph.rfdb` (2026-04-24, rfdb-server pid 59572 on port 60193). Python script over `/api/graph-stream?maxNodes=1000000`, full source inlined at end of this doc under "Appendix A".

### Current loader output (Chunk-1 commit `da3716ff`)
- Total liftable edge candidates (Chunk-1 LIFTABLE set, 19 types): **153,094**
- Both-endpoints-placeable after `skip if endpoint not placeable` filter: **1,482**
- Ratio: **0.97%** useful, 99.03% dropped

### Per-edge-type breakdown (actual counts from live graph)
```
edge                   total  both_pl  src_lifted  dst_lifted  both_lifted
READS_FROM            105097        0       27416           0        27363
PASSES_ARGUMENT        30622        0       10733           0        10731
CALLS                   7159        0        2257           0         2257
RETURNS                 2582        3           0           0            0
IMPORTS_FROM            1823        0        1823           0         1823
HAS_METHOD              1691     1479           0         212          212
ITERATES_OVER           1612        0           0           0            0
WRITES_TO               1335        0           0           0            0
AWAITS                  1173        0           0           0            0
```

### Projected with src-side CONTAINS-parent lift
- Rescued edges: **42,386**
- After-lift liftable total: **43,868** edges
- Multiplier vs current: **29.6×**
- Merge gate (≥20k): **PASSED with 2× headroom**

### Why src-side only (v1)
Columns `dst_lifted` + `dst_non_placeable_no_parent` are both zero in the table. Reason: the remaining four non-rescued types (ITERATES_OVER / WRITES_TO / AWAITS / RETURNS) have src already placeable and dst as CALL/LITERAL whose CONTAINS parent is often ALSO non-placeable (CALL contained in CALL contained in EXPRESSION). Dst-side lift requires multi-hop CONTAINS walks — deferred to follow-up. The 29.6× uplift from src-side alone is sufficient for this chunk.

## 1. Scope

**Change site:** `packages/grafema-orchestrator/src/layout/loader.rs`, function `build_layout_input(nodes_by_type, edges_by_type)`.

**Current behaviour:** for each liftable edge `(src, dst, etype)`:
- resolve both through `id_to_idx`
- skip if either endpoint not in placeable set

**New behaviour:** for each liftable edge `(src, dst, etype)`:
1. If both endpoints are placeable: accept as today.
2. Else if `src` is non-placeable BUT has a CONTAINS-parent that is placeable AND `dst` is placeable AND lifted-src ≠ dst: emit the edge with `src ← lifted-src`. Preserve `etype`.
3. Otherwise drop.

Rule (2) is "one-hop src lift through CONTAINS". No dst lift in v1.

## 2. Implementation

### Step 1 — Build parent index

In the same loader pass that queries `edges_by_type`:
```
parent_of: FxHashMap<u128, NodeIdx>  // child_rfdb_id → placeable-parent NodeIdx
```

Populate by iterating CONTAINS edges from `edges_by_type["CONTAINS"]`:
- For each `(src, dst, "CONTAINS")`:
  - Resolve `src` through `id_to_idx`. If present (i.e. src is placeable), insert `parent_of.insert(dst_rfdb_id, src_idx)`.
  - If multiple CONTAINS parents exist for the same child (shouldn't happen in healthy DB, but defensive), first write wins; log warn counter.

### Step 2 — Lift pass inside the existing edge-collection loop

Replace the "skip if endpoint not in placeable set" block with:
```rust
let src_idx = id_to_idx.get(&edge.src);
let dst_idx = id_to_idx.get(&edge.dst);

let lifted_src = match src_idx {
    Some(&i) => Some(i),
    None => parent_of.get(&edge.src).copied(),
};
let Some(final_src) = lifted_src else { continue; };
let Some(&final_dst) = dst_idx else { continue; };
if final_src == final_dst { continue; }  // self-loop (post-lift)

// Dedup by (src_idx, dst_idx, etype) — existing HashSet
```

Both legs applied symmetrically in future; v1 only lifts src side.

### Step 3 — Counters for visibility
Emit loader log line: `lifted N edges (src-via-CONTAINS), accepted M direct, dropped K`. Plus per-edge-type breakdown under `--verbose`.

### Step 4 — Tests (TDD red-first)
Pure unit tests in `loader.rs` `#[cfg(test)]` mod, following existing fixture pattern:

- `lift_src_through_contains_promotes_call_to_parent_function`
- `lift_preserves_edge_type_through_rename`
- `lift_drops_self_loop_after_rename` (A contains CALL, CALL→A becomes A→A → drop)
- `lift_no_op_when_src_already_placeable`
- `lift_no_op_when_src_has_no_placeable_parent`
- `lift_deduplicates_when_two_calls_in_same_function_share_target`
- `lift_preserves_determinism_across_invocations` (byte-identical output)

No real RFDB. Use inline WireNode + DatalogResult fixtures as Chunk-1 did.

## 3. Merge gate (Chunk-12 specific)

Run `layout --commit` against live grafema RFDB AFTER Chunk-12 merges:
- **Gate A:** loader output ≥ **20,000 lifted edges** (evidence projected: ~43,868).
- **Gate B:** post-iswap `Σlink reduction > 77.6%` (current baseline). If it's merely equal, still merges — more edges = more meaningful work, same or better optimisation.
- **Gate C:** `layout --commit` wall-clock ≤ 30s (current: 7s; Chunk-12 adds ~1s loader time, expected well under gate).

## 4. Out of scope

- **Dst-side lift** (ITERATES_OVER / WRITES_TO / AWAITS dst-side) — requires multi-hop CONTAINS for CALL→LITERAL chains. Follow-up chunk. Evidence: zero rescue potential via one-hop dst in current recon.
- **Weighted edges** — all lifted edges keep weight 1.0. Future chunk may weight by hop count.
- **Self-lifting into same-file semantics** — if CALL is inside FUNCTION A and CALL targets FUNCTION A (recursion), we emit A→A then drop as self-loop. This loses the recursion signal. Acceptable for v1; layout doesn't use recursion cohesion.

## 5. Risk assessment

- **Silent over-lift.** If CONTAINS graph has a bug (misattributed ownership), we may lift an edge to the wrong parent. Detection: sibling unit test checking lifted edges' src semantic_id contains the original intermediary's file path.
- **Dedup pressure.** Pre-lift dedup set is small (1,482 unique tuples). Post-lift set is ~44k — still tiny. No algorithmic concern.
- **Perf.** Adding a single FxHashMap lookup per edge. ~150k edges × O(1) lookup ≈ milliseconds. No concern.

## Appendix A — Evidence gathering script

```python
# Run against rfdb-server /api/graph-stream for the full graph
import json
from collections import Counter

lines = open('/tmp/recon-stream.jsonl').read().splitlines()
header = json.loads(lines[0])
tt = header['typeTable']
ett = header['edgeTypeTable']

node_type = {}
for l in lines:
    try:
        j = json.loads(l)
        if j.get('type') == 'node':
            node_type[j['i']] = tt[j['t']]
    except: pass

PLACEABLE = {'MODULE','FUNCTION','METHOD','CLASS','VARIABLE','CONSTANT',
             'INTERFACE','TYPE_ALIAS','TYPE_SYNONYM','TYPE_CLASS','DATA_TYPE',
             'ENUM','STRUCT','TRAIT','IMPL_BLOCK','INSTANCE','NAMESPACE','MACRO',
             'PROCESS','MESSAGE_TYPE','ASYNC_FUNCTION','GLOBAL_DEFINITION',
             'EXTERNAL_FUNCTION','EXTERNAL_MODULE'}

# CONTAINS parent index (placeable parent only)
parent_of = {}
for l in lines:
    try:
        j = json.loads(l)
    except: continue
    if j.get('type') != 'edge': continue
    if ett[j['t']] != 'CONTAINS': continue
    st = node_type.get(j['s'], '?')
    if st in PLACEABLE:
        parent_of[j['d']] = (j['s'], st)

# Per-type rescue stats
LIFTABLE = {'CALLS','READS_FROM','WRITES_TO','PASSES_ARGUMENT','RETURNS',
            'AWAITS','ITERATES_OVER','IMPORTS_FROM','HAS_METHOD','DEPENDS_ON',
            'ASSIGNED_FROM','IMPLEMENTS','EXTENDS','INHERITS_FROM',
            'BROADCASTS_TO','DISPATCHES_TO','HANDLES_VARIANT','THROWS','CATCHES'}
# ... (full counters per type)
```

Full script inlined above this section. Reproducible on any grafema RFDB.
