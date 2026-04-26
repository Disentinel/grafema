# REG-489: Вадим auto — Completeness Review

## Verdict: APPROVE (with one minor note)

---

## Feature completeness: OK

### Acceptance Criteria Verification

**AC1: All MODULE nodes survive through analysis (330/330)**
Satisfied. The `protected_types: ["MODULE"]` guard in `handle_commit_batch` skips deletion for MODULE nodes. Verified in `rfdb_server.rs` lines 1532–1542.

**AC2: Disconnected nodes < 10%**
Satisfied by design — CONTAINS and DEPENDS_ON edges from MODULE survive because the MODULE node itself is never deleted. The edge preservation Rust test (`test_commit_batch_protected_node_edges_preserved`) validates this.

**AC3: No performance regression from REG-487 fix**
Satisfied. The guard `if !protected_types.is_empty()` (line 1534) means zero overhead for all callers not using the feature. INDEXING, ENRICHMENT, and VALIDATION phases pass no `protectedTypes` and are entirely unaffected.

**AC4: Ghost edges eliminated**
Satisfied — ghost edges occurred because MODULE nodes were deleted while their edges remained in the index. With MODULE preserved, the edges point to existing nodes.

### All six call sites updated correctly

| File | Change | Status |
|------|--------|--------|
| `rfdb_server.rs` | `protected_types: Vec<String>` field + deletion loop guard | Done |
| `client.ts` | `commitBatch()`, `_sendCommitBatch()`, fast-path, chunked-path, `BatchHandle.commit()` | Done |
| `JSASTAnalyzer.ts` | Sequential path passes `['MODULE']` | Done |
| `PhaseRunner.ts` | `runPluginWithBatch` passes `['MODULE']` for ANALYSIS phase | Done |
| `types/rfdb.ts` | `IRFDBClient.commitBatch` signature updated | Done |
| `types/plugins.ts` | `GraphBackend.commitBatch` signature updated | Done |

One extra file updated that the original plan didn't list: `RFDBServerBackend.ts` — correctly passes `protectedTypes` through to the client. This is necessary and not scope creep.

---

## Test coverage: OK (with one note)

### Tests are meaningful

**Rust tests (3):**
- `test_commit_batch_protected_types_preserves_nodes` — verifies delta counts (1 removed, not 2), MODULE exists, old FUNCTION deleted, new FUNCTION added. Tests the exact invariant.
- `test_commit_batch_empty_protected_types_legacy_behavior` — confirms backward compatibility: both nodes deleted when `protected_types: []`.
- `test_commit_batch_protected_node_edges_preserved` — validates cross-file edge (SERVICE→MODULE) survival, which is the core connectivity requirement.

**TypeScript integration tests (3):**
- Happy path: MODULE survives commitBatch with `protectedTypes: ['MODULE']`.
- Baseline/regression detection: without `protectedTypes`, MODULE is deleted (the test will fail if the fix is ever accidentally removed).
- DEPENDS_ON inter-module edge survival.

All tests assert specific behaviors, not just "it doesn't crash."

### Note: tests access private implementation details

The TypeScript test (`REG489ModuleSurvival.test.js`) accesses `backend._client` (a private property) and calls `client._batchFiles.add('app.js')`. The `_batchFiles.add()` call is actually redundant — `client.batchNode({ file: 'app.js' })` already auto-adds the file to `_batchFiles` (client.ts line 1068). The manual add doesn't cause failures, but it is misleading: it implies `_batchFiles` must be managed manually when it isn't.

This fragility (reaching into private API) is a test quality concern, not a correctness concern. The tests pass and correctly validate the protocol. Not a blocker.

### What tests do NOT cover

- Incremental re-analysis idempotency (Don's "Test 3" from Step 5 was not implemented — `REG489IncrementalIdempotency.test.js` does not exist). This was listed in the plan but was not part of the acceptance criteria, and the behavior is covered logically (INDEXING's commitBatch with no protectedTypes correctly replaces MODULE, then ANALYSIS's commitBatch with `['MODULE']` preserves it). Not a blocker.

---

## Commit quality: PENDING

No REG-489 commit exists yet — all changes are in the working tree. The changes are logically atomic and ready to commit as one unit. No issues with commit hygiene.

No TODO/FIXME/HACK introduced by this task. The `TODO` in JSASTAnalyzer line 221 (`sideEffects: unknown[]; // TODO: define SideEffectInfo`) is pre-existing, not from REG-489.

---

## One minor gap: `CommitBatchRequest` interface not updated

`packages/types/src/rfdb.ts` line 276 defines `CommitBatchRequest`:

```typescript
export interface CommitBatchRequest extends RFDBRequest {
  cmd: 'commitBatch';
  changedFiles: string[];
  nodes: WireNode[];
  edges: WireEdge[];
  tags?: string[];
}
```

This interface was not updated with `protectedTypes?: string[]`. The `IRFDBClient.commitBatch` at line 505 in the same file was updated. Since `CommitBatchRequest` is the wire-level request format, it should include the new field for documentation completeness.

This does not affect correctness — the wire protocol works via `_send()` which serializes the object directly, not via this interface. TypeScript compilation succeeds. This is a documentation coherence gap, not a functional gap.

**Verdict on this gap: Does not block approval.** The fix is functionally complete. The interface gap is pre-existing technical debt pattern (it was also missing `deferIndex` before this task).

---

## Summary

The implementation precisely targets the root cause identified in the bug report: `commitBatch`'s delete-then-add semantics destroying MODULE nodes created in INDEXING phase. The fix is minimal, backward-compatible, and covers all ANALYSIS phase commit paths (JSASTAnalyzer's sequential path + PhaseRunner's generic wrapper for other ANALYSIS plugins).

The Dijkstra-identified gap (PhaseRunner must also protect MODULE) is correctly implemented in `PhaseRunner.ts` line 98.

**APPROVE.**
