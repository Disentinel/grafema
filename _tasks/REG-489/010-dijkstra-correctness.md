# Dijkstra Correctness Review — REG-489

**Verdict: APPROVE with one documented concern**

---

## Functions Reviewed

| Function / Location | Verdict |
|---|---|
| `handle_commit_batch` (Rust, rfdb_server.rs:1497) | APPROVE — with analysis below |
| `commitBatch` (TS, client.ts:1097) | APPROVE |
| `_sendCommitBatch` (TS, client.ts:1117) | APPROVE |
| `BatchHandle.commit` (TS, client.ts:1311) | APPROVE |
| `PhaseRunner.runPluginWithBatch` (PhaseRunner.ts:75) | NOTE — see issue #1 |
| JSASTAnalyzer pool handler (JSASTAnalyzer.ts:388) | APPROVE |
| JSASTAnalyzer.executeParallel (JSASTAnalyzer.ts:511) | ISSUE — see issue #2 |
| Rust test: `test_commit_batch_protected_types_preserves_nodes` | APPROVE |
| Rust test: `test_commit_batch_empty_protected_types_legacy_behavior` | APPROVE |
| Rust test: `test_commit_batch_protected_node_edges_preserved` | APPROVE |
| TS test: REG489ModuleSurvival.test.js | APPROVE — with note on edge case gap |

---

## Input Enumeration

### `handle_commit_batch` parameters

| Parameter | Possible values | Handled? |
|---|---|---|
| `changed_files` | empty vec | YES — outer loop runs 0 times, no deletion, no crash |
| `changed_files` | file not in DB | YES — `find_by_attr` returns empty vec, inner loop skips |
| `changed_files` | file in DB | YES — standard path |
| `nodes` | empty vec | YES — `nodes_added = 0`, no panic |
| `edges` | empty vec | YES — no edge iteration |
| `protected_types` | empty vec | YES — `!is_empty()` guard short-circuits, zero overhead |
| `protected_types` | type not in DB | YES — no nodes match, `continue` never fires |
| `protected_types` | ALL types in file | YES — all nodes skipped, nothing deleted; old nodes remain alongside new ones |
| `protected_types: ["MODULE"]` | MODULE node has `node_type: None` | SAFE — `if let Some(ref nt)` fails, node is NOT protected, gets deleted |

The last row is worth explicit notation: a MODULE node with `node_type: None` would not be protected. This is acceptable because the real-world MODULE nodes created by JSModuleIndexer always set `node_type = Some("MODULE")`.

---

## Condition Completeness

### Deletion loop decision tree

For each node `id` found in `old_ids` (nodes belonging to a changed file):

```
1. protected_types.is_empty()?
   YES → skip protection check entirely (fast path)
   NO  →
       2. engine.get_node(id) returns Some(node)?
          NO  → node vanished between find_by_attr and get_node (race impossible — single-threaded engine write lock)
                RESULT: falls through to second get_node call below, which also returns None
                        → changed_node_types not updated, edges deleted if any, delete_node called on ghost id
                        This is pre-existing behavior, unchanged by this PR. Not a regression.
          YES →
              3. node.node_type is Some(nt)?
                 NO  → type-less node, falls through — NOT protected
                 YES →
                     4. protected_types.contains(nt)?
                        YES → continue (skip this node entirely)
                        NO  → falls through to deletion
```

**Gap found: `node_type: None` node in protected file**

A node with no `node_type` field will NOT be protected regardless of `protected_types`. This is not a regression — it is consistent with the pre-existing behavior where untyped nodes were always deleted. Since MODULE nodes always have a type, this does not affect correctness for the stated fix. But it is a subtle semantic: "protectedTypes" protects by type string match only, not by structural membership. If a future caller expects `protectedTypes: ["MODULE"]` to also protect type-less nodes alongside MODULE nodes, they will be surprised. The behavior is correct for the current use case.

### Edge deletion during non-protected node removal

When a FUNCTION node is deleted, the code deletes all its outgoing and incoming edges, including the `MODULE→FUNCTION CONTAINS` edge. This edge connects the protected MODULE to the deleted FUNCTION.

**Critical question from the task brief:** After FUNCTION is deleted (along with its `MODULE→FUNCTION CONTAINS` edge), and the analysis batch re-creates FUNCTION with the same semantic ID — does it also re-create the `MODULE→FUNCTION CONTAINS` edge?

**Answer: YES, and this is verified by the code.**

In `CoreBuilder.ts:60–74`, JSASTAnalyzer's graph builder explicitly creates `MODULE→CONTAINS→FUNCTION` edges using `module.id` as the source and the new function's id as destination. These edges are buffered in the batch and written by the server's add-nodes/add-edges phase of `handle_commit_batch` (which runs after the deletion phase). Therefore:

1. Old `MODULE→fn_old CONTAINS` edge: deleted (when fn_old is deleted, its incoming edge from MODULE is caught by `get_incoming_edges`)
2. New `MODULE→fn_new CONTAINS` edge: re-created by the batch payload
3. External `SERVICE→MODULE CONTAINS` edge: preserved (SERVICE is not in `changed_files`, MODULE is protected — neither endpoint is deleted)

This is the correct behavior. The Rust test `test_commit_batch_protected_node_edges_preserved` verifies exactly this scenario.

---

## Edge Cases by Construction

### Case 1: `protected_types` contains a type not present in the file

`changed_files: ["app.js"]`, `protected_types: ["MODULE"]`, but app.js has no MODULE nodes.

Result: `find_by_attr` returns FUNCTION, SCOPE, etc. None of them match "MODULE". `protected_types.contains(nt)` returns false for all. All non-MODULE nodes are deleted normally. Correct.

### Case 2: `protected_types` contains ALL types (everything protected)

`protected_types: ["MODULE", "FUNCTION", "SCOPE", ...]` covering every node type for `app.js`.

Result: Every node in `old_ids` hits `continue`. `nodes_removed = 0`, `edges_removed = 0`. New nodes from the batch are then ADDED. This means the file now has both the old nodes AND the new nodes — they accumulate. There is no de-duplication.

**This is a semantic concern.** If `changedFiles` contains a file but all its types are protected, the delete-then-add contract is broken: old nodes are not deleted. This is not a bug for the current use case (`protectedTypes: ["MODULE"]` only protects MODULE, everything else is deleted normally). But it is a footgun for future callers who might over-specify protectedTypes. Not a blocking issue — it is correct by the current spec.

### Case 3: Empty `changedFiles` with non-empty `protectedTypes`

`changed_files: []`, `protected_types: ["MODULE"]`.

Result: Outer `for file in &changed_files` loop runs zero times. No deletion occurs. New nodes/edges from the batch are added. The `protectedTypes` field is irrelevant. This is existing behavior for empty changedFiles — correct and unchanged.

### Case 4: Multiple protected types

`protected_types: ["MODULE", "SERVICE"]`.

Result: `protected_types.contains(nt)` works on a Vec, which is O(n) where n = number of protected types. For n=1 or n=2 (the realistic cases), this is fine. At extreme n (e.g., 100 protected types × millions of nodes), this would be O(n) per node. Not a current concern but worth noting for documentation.

### Case 5: Protected node that also appears in the new nodes being added (duplicate)

Scenario: MODULE is protected (not deleted), and the batch also includes a new MODULE node with the same semantic ID.

Result: The protected MODULE survives the deletion phase. Then the add-nodes phase runs. If the server's `add_node` implementation upserts (replaces existing node by semantic ID), the old MODULE is overwritten with new data — effectively an update. If it errors on duplicate, the batch fails.

**This scenario is explicitly handled and CORRECT for the intended use case.** When a file X.ts changes, the INDEXING phase commits first (no protectedTypes), which REPLACES the old MODULE with the updated MODULE. Then the ANALYSIS phase commits with `protectedTypes: ["MODULE"]`, which does NOT include a MODULE node in its batch payload (JSASTAnalyzer does not create MODULE nodes). So the duplicate scenario does not arise in practice.

However, if someone were to call `commitBatch` with `protectedTypes: ["MODULE"]` AND include a MODULE node in the batch, the behavior depends on the server's upsert semantics. This is not tested. Not a current bug, but worth a comment in the code.

---

## Issue #1: PhaseRunner Also Applies `protectedTypes: ['MODULE']` for ANALYSIS Phase

**Location:** `PhaseRunner.ts:98`

```typescript
const protectedTypes = phaseName === 'ANALYSIS' ? ['MODULE'] : undefined;
const delta = await graph.commitBatch(tags, deferIndex, protectedTypes);
```

**Finding:** Don's plan explicitly stated: *"PhaseRunner does NOT need changes — it doesn't wrap JSASTAnalyzer (managesBatch: true)."*

The implementation adds `protectedTypes` to PhaseRunner anyway. This is not incorrect, because when `managesBatch: true`, PhaseRunner's `runPluginWithBatch` short-circuits at line 83–87 and never reaches the `protectedTypes` line. So for JSASTAnalyzer, PhaseRunner's protection code is dead code.

But for OTHER ANALYSIS-phase plugins (if any) that do NOT set `managesBatch: true`, PhaseRunner will now pass `protectedTypes: ['MODULE']` to their batch commits. This is a behavioral change beyond the stated scope of REG-489.

**Completeness table for ANALYSIS-phase plugins without `managesBatch`:**

| Plugin type | Old behavior | New behavior | Correct? |
|---|---|---|---|
| Plugin with `managesBatch: true` | PhaseRunner skips batch | PhaseRunner skips batch (unchanged) | YES |
| Plugin without `managesBatch`, phaseName='ANALYSIS' | delete-all on changed files | preserves MODULE nodes | POSSIBLY UNEXPECTED |
| Plugin without `managesBatch`, phaseName != 'ANALYSIS' | delete-all | delete-all (unchanged) | YES |

**Verdict on Issue #1:** The change is strictly more correct (MODULE preservation is the right behavior for any ANALYSIS-phase plugin), but it is an undocumented scope expansion. If there are no other ANALYSIS-phase plugins that run through PhaseRunner without `managesBatch`, this is harmless. The correctness risk is LOW but it should be documented.

---

## Issue #2: `executeParallel` in JSASTAnalyzer Does NOT Use `commitBatch`

**Location:** `JSASTAnalyzer.ts:511–589`

The standard (non-parallel) path in JSASTAnalyzer wraps each module analysis in `beginBatch` / `commitBatch(['MODULE'])`. The `executeParallel` path (used when `context.parallelParsing === true`) does NOT do this — it calls `graphBuilder.build()` directly without any batch management.

Don's plan noted: *"Check if executeParallel also calls commitBatch and apply the same ['MODULE'] protection."*

**Finding:** The `executeParallel` path does not call `commitBatch` at all. This means:
- If `parallelParsing` is enabled, nodes are added directly (unbatched), with no delete-then-add semantics
- There is no risk of MODULE deletion in this path, because there is no `changedFiles`-based deletion happening
- But there is also no stale node cleanup — old FUNCTION/SCOPE nodes from previous analysis runs are NOT removed in the parallel path

This is a pre-existing issue with `executeParallel` and is not a regression introduced by REG-489. The `executeParallel` path was already incomplete before this PR. REG-489 does not make it worse, but it also does not fix it for the parallel case.

**Verdict on Issue #2:** Not a regression. The parallel path was already not using batch semantics. However, the comment in Don's plan suggested this should be checked and fixed. The implementation did NOT address this path. If `parallelParsing` is ever used in production, MODULE survival is not guaranteed by this fix.

---

## Loop Termination Analysis

**`for file in &changed_files`**: terminates because `changed_files` is a finite `Vec<String>`.

**`for id in &old_ids`**: terminates because `old_ids` is a finite `Vec<NodeId>` returned by `find_by_attr`.

**`for edge in get_outgoing_edges(*id, None)`**: terminates because each node has a finite number of edges.

**`for edge in get_incoming_edges(*id, None)`**: same.

No infinite loops possible by construction.

---

## Invariant Verification

**Invariant:** After `handle_commit_batch` completes, for any file in `changed_files`, only nodes NOT in `protected_types` have been replaced.

**Proof by enumeration:**

- Nodes of types in `protected_types`: skipped via `continue`, not deleted, not in `nodes_removed`. New nodes from batch may or may not include the same type. If they do, upsert semantics apply (existing behavior).
- Nodes of types NOT in `protected_types`: deleted, their edges deleted (both directions), `nodes_removed` incremented. New nodes from batch are then added.
- Nodes NOT in `changed_files`: untouched (outer loop only iterates over `changed_files`).

**Invariant holds for the intended use case.**

---

## Test Coverage Assessment

### Rust tests (rfdb_server.rs:4513–4704)

| Scenario | Tested? |
|---|---|
| Protected node survives | YES (`test_commit_batch_protected_types_preserves_nodes`) |
| Non-protected node is deleted | YES (same test, `nodes_removed == 1`) |
| Empty protectedTypes = legacy behavior | YES (`test_commit_batch_empty_protected_types_legacy_behavior`) |
| Edges from external node to protected node survive | YES (`test_commit_batch_protected_node_edges_preserved`) |
| MODULE→new_FUNCTION edge re-created in batch | YES (same test, asserts on `MODULE -> new FUNCTION CONTAINS`) |
| Protected node with `node_type: None` | NOT TESTED |
| Multiple files in changedFiles, some with MODULE some without | NOT TESTED |
| All types protected (accumulation scenario) | NOT TESTED |

The untested cases are edge cases that do not affect correctness for the stated use case.

### TypeScript integration tests (REG489ModuleSurvival.test.js)

| Scenario | Tested? |
|---|---|
| MODULE survives when protectedTypes includes MODULE | YES (test 1) |
| MODULE deleted without protectedTypes (regression baseline) | YES (test 2) |
| DEPENDS_ON edge between two MODULE nodes survives | YES (test 3) |
| SERVICE→MODULE CONTAINS edge survives | YES (test 1 also covers this) |
| MODULE→FUNCTION CONTAINS edge re-created by analysis batch | NOT DIRECTLY TESTED |
| Incremental re-analysis: MODULE count unchanged | NOT TESTED in this file (was planned as REG489IncrementalIdempotency.test.js) |

**Gap:** The planned `REG489IncrementalIdempotency.test.js` is absent. Don's plan listed it as Test 3. Its absence means the idempotency guarantee is not verified at the integration level.

---

## Summary of Issues Found

| # | Severity | Location | Description |
|---|---|---|---|
| 1 | LOW | PhaseRunner.ts:98 | PhaseRunner applies `protectedTypes: ['MODULE']` to ALL ANALYSIS-phase plugins without `managesBatch`. Undocumented scope expansion. Not incorrect, but not planned. |
| 2 | MEDIUM | JSASTAnalyzer.ts:executeParallel | `executeParallel` path does not use `commitBatch` — MODULE survival is not guaranteed when `parallelParsing: true`. Pre-existing issue, not a regression. Don's plan flagged this but implementation did not address it. |
| 3 | LOW | Test coverage | `REG489IncrementalIdempotency.test.js` absent — idempotency not integration-tested. |
| 4 | LOW | Semantic note | Node with `node_type: None` is not protected even if caller intends it to be. Consistent with type-string-match semantics, but undocumented. |

---

## Conclusion

The core implementation is **correct for the stated use case**: JSASTAnalyzer's serial (non-parallel) analysis path correctly preserves MODULE nodes by passing `protectedTypes: ['MODULE']` to `commitBatch`. The Rust server correctly skips deletion of typed protected nodes. The MODULE→FUNCTION CONTAINS edge is correctly handled: the old edge is deleted with the old FUNCTION, and JSASTAnalyzer's GraphBuilder re-creates the new MODULE→FUNCTION CONTAINS edge in the batch payload.

Issue #2 (executeParallel) is the most significant concern. If `parallelParsing` is used in production, the fix does not apply. This warrants a follow-up issue or an explicit note in the code that the parallel path is out of scope.

**Verdict: APPROVE** — the primary regression is fixed correctly. Issue #2 should be tracked as a follow-up.
