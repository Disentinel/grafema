# RFD-11: Steve Jobs Review -- Plan Phase

**Reviewing:** Don's Plan (002) + Joel's Tech Spec (003)

**Default stance: REJECT. Looking for fundamental errors, corner-cutting, and architectural gaps.**

---

## Primary Questions

### 1. Does this align with project vision?

**YES.** "AI should query the graph, not read code." RFD-11 is THE GATE -- switching from v1 to v2 engine behind the same wire protocol. This is pure infrastructure. The vision isn't at risk; the question is whether the plan gets it right.

### 2. Did we cut corners?

**Two concerns found:**

**Concern A: `node_count()` / `edge_count()` approximation.**

Joel specifies:
```
node_count: self.store.node_count() - self.pending_tombstone_nodes.len()
```
This is wrong when pending tombstoned nodes don't actually exist in the store (were already deleted). The count goes negative or undercounts.

**Verdict:** LOW RISK. v1's `node_count()` also includes deleted nodes (the comment says "including deleted"). The approximation is acceptable for stats -- it's not used for correctness. But ADD A COMMENT explaining the approximation and why it's acceptable.

**Concern B: BeginBatch/AbortBatch deferred as "nice to have".**

Joel says: "If BeginBatch/AbortBatch are 'nice to have' vs 'must have', consider deferring."

The task spec (001-user-request.md) explicitly lists BeginBatch, CommitBatch, AbortBatch as required for T4.1c. Deferring is cutting a corner.

**Verdict:** These should be implemented as specified. However, they can be simple session-state operations -- no need for complex server-side buffering. BeginBatch creates a pending batch, CommitBatch (existing) commits it atomically, AbortBatch clears it. Keep in plan.

### 3. Are there fundamental architectural gaps?

**Concern C: `find_by_attr()` metadata filtering is O(M * F) with JSON parsing.**

v1 uses IndexSet for declared fields -- O(1) lookup by metadata value. v2's plan falls back to O(n) JSON parsing per node for metadata_filters. This is a REGRESSION for the Grafema pipeline which relies heavily on metadata queries.

**Verdict:** ACCEPTABLE FOR MVP. The metadata filtering happens in-memory on an already-filtered set (by type + file). For most real queries, M is small (hundreds, not millions). The regression is measurable but not blocking. Joel correctly identifies this in Risk 4. However, THIS MUST BE A TRACKED TECH DEBT ITEM -- future v2 segment-level field indexes.

**Concern D: Adding `clear()`, `is_endpoint()`, `reachability()`, `declare_fields()` to GraphStore trait.**

Joel recommends adding these 4 methods to GraphStore instead of using downcasting. But these are NOT core graph operations -- they're engine-specific utilities:
- `clear()` -- destructive operation, not a query
- `is_endpoint()` -- Grafema-specific business logic, not storage
- `reachability()` -- just BFS with backward option, already composable from existing methods
- `declare_fields()` -- v1-specific optimization, v2 has zone maps

Adding business logic to a storage trait is the wrong direction. It couples the storage layer to application semantics.

**Verdict:** MINOR ISSUE. Use downcasting for these 4 methods instead. Keep GraphStore pure (storage operations only). Add `as_any()`/`as_any_mut()` to the trait, and downcast in the 4 specific handlers. This is ~20 more LOC but architecturally cleaner.

Alternatively: keep `clear()` and `declare_fields()` on GraphStore (they ARE storage operations). Move `is_endpoint()` and `reachability()` to handler-level logic using existing GraphStore methods.

### 4. Complexity Check (MANDATORY)

| Operation | Iteration Space | Verdict |
|-----------|----------------|---------|
| `find_by_type` | O(S * N_per_shard) | OK -- same as v1 |
| `find_by_attr` | O(S * N_per_shard + M * F) | YELLOW -- metadata JSON parse per node |
| `get_all_edges` | O(total_edges) | RED FLAG -- but same as v1 |
| `count_nodes_by_type` | O(total_nodes) | YELLOW -- v1 uses IndexSet for O(1) |
| `count_edges_by_type` | O(total_edges) | YELLOW -- v1 uses IndexSet for O(1) |
| `bfs` | O(V + E reachable) | OK -- same as v1 |
| `neighbors` | O(E_out) | OK -- targeted query |

The YELLOW items are regressions from v1. They're acceptable for the switchover (correctness first, optimization second) but must be tracked as tech debt.

### 5. Would shipping this embarrass us?

**NO.** The plan is thorough, well-analyzed, with proper risk identification. The 14-commit plan is atomic and testable. The type conversion layer is mechanical and safe. The pending tombstone approach for individual deletes is a reasonable compromise.

---

## Mandatory Architecture Checklist

1. **Complexity Check:** O(n) scans exist but are inherited from v1 patterns, not introduced. ACCEPTABLE.
2. **Plugin Architecture:** N/A (infrastructure change, not plugin).
3. **Extensibility:** Adding new engine versions is straightforward with the trait-object approach. GOOD.
4. **No brute-force:** The plan uses targeted queries (node_to_shard routing, bloom filters in segments) where possible. ACCEPTABLE.

---

## DECISION: APPROVE WITH CONDITIONS

The plan is architecturally sound. The trait-object approach (`dyn GraphStore`) is the correct Rust pattern for this switchover. The phased plan is well-ordered. The risk analysis is honest.

**Conditions for approval (non-blocking, can be addressed during implementation):**

1. **Do not add `is_endpoint()` and `reachability()` to GraphStore trait.** These are application logic, not storage operations. Either:
   - (a) Implement them as free functions that take `&dyn GraphStore`, or
   - (b) Use downcast for the 2 handlers that need them

2. **Keep BeginBatch/AbortBatch in scope.** They're in the task spec. They're simple session-state operations.

3. **Track metadata filtering regression as tech debt.** Create a Linear issue for v2 field indexes when implementing Phase 1.3.

4. **Add edge counts to v2 CommitDelta.** Joel identified this in Risk 3. Do Option A (add to CommitDelta), not Option B (approximate).

These conditions do not require plan revision. They are implementation-time decisions that the engineers can handle.

---

**Reviewer:** Steve Jobs (High-level Review)
**Date:** 2026-02-14
**Verdict:** APPROVE WITH CONDITIONS
**Next step:** Escalate to user (Vadim) for final confirmation
