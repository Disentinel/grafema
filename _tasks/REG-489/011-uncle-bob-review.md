## Uncle Bob — Code Quality Review: REG-489 (Module Survival / protectedTypes)

**Verdict:** APPROVE with noted tech debt

---

## File Sizes

| File | Lines | Status |
|------|-------|--------|
| `packages/rfdb-server/src/bin/rfdb_server.rs` | 4705 | CRITICAL — pre-existing, not introduced by this PR |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | 4111 | CRITICAL — pre-existing, not introduced by this PR |
| `packages/rfdb/ts/client.ts` | 1328 | MUST SPLIT — pre-existing |
| `packages/core/src/storage/backends/RFDBServerBackend.ts` | 879 | MUST SPLIT — pre-existing |
| `packages/types/src/rfdb.ts` | 524 | MUST SPLIT — pre-existing |
| `packages/types/src/plugins.ts` | 381 | OK |
| `test/unit/REG489ModuleSurvival.test.js` | 179 | OK |

The file size violations are all pre-existing debt. This PR did not introduce new violations and did not meaningfully worsen any file. Tech debt issues exist and should be tracked separately — they are outside the scope of REG-489.

---

## Method-Level Review

### `handle_commit_batch` — `rfdb_server.rs:1497`

**Estimated length:** ~133 lines (lines 1497–1629).

This is over the 50-line threshold but is NOT new — the function existed before. The REG-489 addition is the skip block at lines 1532–1542. The block itself is clear:

```rust
if !protected_types.is_empty() {
    if let Some(node) = engine.get_node(*id) {
        if let Some(ref nt) = node.node_type {
            if protected_types.contains(nt) {
                continue;
            }
        }
    }
}
```

**Issue — Redundant `get_node` call.** After this guard block, the code immediately calls `engine.get_node(*id)` again at line 1544 to record changed node types. This means every non-protected node incurs two lookups. The guard should store the result, or the guard block should be merged with the existing lookup. This is a minor inefficiency but a clarity violation: the same operation is performed twice in the same loop body without reason.

**Nesting depth:** The protection check is 4 levels deep (for → if → if let → if let → if). This is one level beyond the 2-level guideline. An early-continue extracted into a named helper (`is_node_protected(id, &protected_types, engine) -> bool`) would reduce depth and name the concept.

**Recommendation:** REFACTOR (minor) — the double `get_node` is the only real issue.

---

### `_sendCommitBatch` — `client.ts:1117`

**Length:** ~58 lines (lines 1117–1175). Marginally over threshold.

The `protectedTypes` integration is correct. The conditional spread pattern used is consistent with the existing `deferIndex` pattern directly above it:

```typescript
...(deferIndex ? { deferIndex: true } : {}),
...(protectedTypes?.length ? { protectedTypes } : {}),
```

Symmetry is good. The logic for the chunked path (lines 1160) correctly applies `protectedTypes` only on the first chunk (`i === 0`), which is sound — only the first chunk triggers the deletion phase with `changedFiles`.

No new issues introduced here.

---

### `runPluginWithBatch` — `PhaseRunner.ts:75`

**Length:** ~31 lines (lines 75–105). OK.

The phase-check pattern is clean:

```typescript
const protectedTypes = phaseName === 'ANALYSIS' ? ['MODULE'] : undefined;
const delta = await graph.commitBatch(tags, deferIndex, protectedTypes);
```

This is readable and intent is clear. However, the string literal `'ANALYSIS'` is used here as a magic string. The codebase likely has a phase name convention — this should use a constant if one exists. This is a minor naming concern, not a blocker.

---

### JSASTAnalyzer ANALYZE_MODULE handler — `JSASTAnalyzer.ts:388`

The change is:

```typescript
await graph.commitBatch(
  ['JSASTAnalyzer', 'ANALYSIS', task.data.module.file],
  deferIndex,
  ['MODULE'],
);
```

This is the site where `managesBatch` plugins pass `['MODULE']` directly. The string `'MODULE'` is a magic constant here, as it is in PhaseRunner. Consistent. No new issues.

---

### `commitBatch` — `RFDBServerBackend.ts:776`

Pure pass-through, 3 lines:

```typescript
async commitBatch(tags?: string[], deferIndex?: boolean, protectedTypes?: string[]): Promise<CommitDelta> {
    if (!this.client) throw new Error('Not connected to RFDB server');
    return this.client.commitBatch(tags, deferIndex, protectedTypes);
}
```

Clean, matches existing pattern.

---

## Type Interface Gap

**`CommitBatchRequest` in `packages/types/src/rfdb.ts` (lines 276–282) is missing `protectedTypes`:**

```typescript
export interface CommitBatchRequest extends RFDBRequest {
  cmd: 'commitBatch';
  changedFiles: string[];
  nodes: WireNode[];
  edges: WireEdge[];
  tags?: string[];
  // MISSING: protectedTypes?: string[];
  // MISSING: deferIndex?: boolean;
}
```

Both `deferIndex` and `protectedTypes` are omitted from this interface. This appears to be pre-existing for `deferIndex` (it was added before this PR without updating the interface). REG-489 adds `protectedTypes` to the wire protocol but does not update this interface either.

This interface is used for type documentation/tooling, not for the actual wire serialization (which uses raw object spread in `_sendCommitBatch`). The code works without it. However, the interface is now stale — it no longer accurately represents the protocol. This should be noted as tech debt.

---

## Test Quality

`test/unit/REG489ModuleSurvival.test.js` is well-structured:

- Three distinct scenarios: protection active, legacy (no protection), and edge preservation
- Each scenario is independently set up — no shared state between `it` blocks beyond `beforeEach`
- Assertion messages are descriptive and include runtime values (`Found ${modulesAfter.length}`)
- The test directly accesses `client._batchFiles` (private field via underscore convention) to simulate the file registration that would normally happen through the plugin layer. This is acceptable for testing internal protocol behavior, but it couples the test to the client's internal structure

**One naming concern:** the test describe blocks use "edge preservation with protectedTypes" but the scenario tested is specifically about inter-MODULE edges (`DEPENDS_ON`), not about all edges from protected nodes. Edges from protected nodes TO non-protected nodes (i.e., `CONTAINS` from MODULE to FUNCTION) are deleted when the FUNCTION is deleted. This behavior is correct and is tested implicitly, but the describe label is slightly misleading.

The Rust tests in `rfdb_server.rs` (lines 4505–4705) are thorough. The two new test functions:
- `test_commit_batch_protected_types_preserves_nodes` — covers the primary scenario correctly
- `test_commit_batch_empty_protected_types_legacy_behavior` — correctly establishes the backward-compatibility contract

The delta assertion `assert_eq!(delta.nodes_removed, 1)` in the first Rust test is important — it proves the MODULE does NOT count as removed, not just that it survives.

---

## Patterns and Naming

**Good:**
- `protected_types` (Rust) / `protectedTypes` (TS) naming is consistent across all layers
- The opt-in pattern (empty = legacy behavior) is backward-compatible and explicitly tested
- JSDoc on `commitBatch` is updated at the TypeScript client layer

**Concern — Magic strings:**
- `'MODULE'` appears as a hardcoded string literal in three separate locations: JSASTAnalyzer, PhaseRunner, and Rust tests. If `MODULE` is ever renamed or if other node types need protection, the caller must know to update all three. A shared constant (e.g., `NODE_TYPE.MODULE`) would be cleaner. This is a low-priority concern given the current codebase style.

**Concern — `is_node_protected` is not extracted:**
The protection logic in the Rust deletion loop is an unnamed pattern. Extracting it into a small inline helper or a named closure would make the loop easier to scan.

---

## Summary

| Area | Status |
|------|--------|
| File sizes | Pre-existing debt; no regressions introduced |
| `handle_commit_batch` skip logic | Correct; minor: double `get_node` call |
| `_sendCommitBatch` | Correct; chunk handling is sound |
| `runPluginWithBatch` | Correct; minor: magic phase-name string |
| `RFDBServerBackend.commitBatch` | Clean pass-through |
| `CommitBatchRequest` interface | Stale — missing `protectedTypes` and `deferIndex` |
| Test coverage | Good; 3 scenarios, meaningful assertions |
| Naming | Consistent across layers; magic node-type strings are a style concern |

**Overall: APPROVE.** The change is focused, backward-compatible, and does what it claims. The double `get_node` call is a minor inefficiency, the missing interface fields are tech debt carried forward from before this PR, and the magic strings are consistent with surrounding code style. None of these rise to a reject.
