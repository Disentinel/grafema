# Gate B Plan — Datalog v2 storage & materialization

**Status:** Gate A complete (51/51 v2 ≡ v1, commit `da8732a0`) → Gate B planning. Companion to
`rfdb-datalog-engine-v2-spec.md` §8 + §13 Gate B, and `rfdb-datalog-gate-a-plan.md`. Design 2026-06-06.

## Goal (spec §13 Gate B)

Persist derived (IDB) facts and **`@materialize` write-back** into the graph; compaction by ⊕;
run isolation. **Exit:** `depends/2` on dogfood produces `DEPENDS_ON` edges **identical** to the
orchestrator's in-memory derivation, which is then disabled behind `RFDB_DATALOG_V2`.

## Key scoping insight — stage B into B.1 (minimal exit) + B.2 (heavy format, defer to Gate C)

The grounded write-path (Explore, 2026-06-06) shows the Gate B **exit criterion is reachable with
NO segment-format change**:

- The orchestrator already derives `DEPENDS_ON` in-memory from `IMPORTS_FROM` + a file→module map
  and commits it via the **existing** `commit_batch` with provenance stamped in edge metadata
  `_source="module-dependencies", _generation=<gen>` (`grafema-orchestrator/src/main.rs:1733-1793`,
  commit at `:1781`).
- `depends/2` is a **boolean, graph-native binary predicate** → `@materialize(edge_type="DEPENDS_ON")`
  writes derived facts AS real `DEPENDS_ON` edges through the same `commit_batch_ext` 9-phase path
  (`multi_shard.rs:2124`), with provenance in metadata. **BoolTag carries no tag bytes**, so no
  segment-format change, no compaction-⊕, no binding-table-on-disk is needed for this exit.

The heavy §8 apparatus — segment provenance columns + `(semiring_id,len,bytes)` tag encoding +
compaction-⊕ fold + persisted binding table — is only load-bearing for **non-boolean tags**
(Count/Conf, Gate C) and **non-graph-native predicates** (arity ≥ 3). So defer it to where it's
actually needed (Gate C), per the measure-first / minimal-storage-change discipline used all session.

## B.1 — Minimal materialization (achieves the Gate B exit)

| # | Item | Builds on (file:line) | New? |
|---|---|---|---|
| 1 | `stdlib/depends.dl`: `@materialize(edge_type="DEPENDS_ON") depends(A,B) :- edge(A,B,"IMPORTS_FROM")` (+ module mapping to match the orchestrator's module→module shape) | parser_ext already parses `@materialize` | rule |
| 2 | `@materialize` write-back in the executor: derived `depends` facts → `WireEdge{type:"DEPENDS_ON", metadata:{_source:rule_ast_hash,_generation:run_id}}` → `commit_batch` | `commit_batch_ext` multi_shard.rs:2124; orchestrator pattern main.rs:1767-1781 | glue |
| 3 | `rule_ast_hash`: hash of the normalized rule AST (whitespace/var-rename invariant) | spec §8.1 | small |
| 4 | Run isolation: stage the write-back under the run's generation, single atomic manifest flip after all strata land | VersionPins manifest.rs:68; commit_edit atomic flip manifest.rs:1600-1659 | wiring |
| 5 | Differential: `depends/2` via v2 vs orchestrator DEPENDS_ON on dogfood — id-set equality | the Gate A differential harness (differential.rs) | test |

**B.1 Exit:** v2 `depends/2` DEPENDS_ON edge set ≡ orchestrator derivation on `.grafema/grafema.rfdb`;
orchestrator derivation then gated behind `RFDB_DATALOG_V2` (deleted only after Gate E + one release, P3).

## B.2 — Full §8 storage format (defer; couple to Gate C tags)

Needed when predicates carry non-boolean tags or aren't graph-native:
- Segment format v2: provenance column (`rule_ast_hash`/`generation`) + tag `(semiring_id u16,len u16,bytes)`
  + `tx_created`/`tx_invalidated`. New footer field before `footer_index_size` (forward-compat, types.rs:212).
- SegmentType stays {Nodes,Edges} (derived facts are graph-native); a relational CF only for arity ≥ 3 (lazy).
- Compaction-⊕: replace the newest-wins dedup in `merge_node_segments`/`merge_edge_segments`
  (compaction/merge.rs:26-34 / 56-64) with a ⊕-fold accumulator on tags; CountTag negatives generalize
  tombstones; non-invertible tags use logical invalidation.
- Binding table: predicate → (semiring_id, schema, defining rule_ast_hashes); changed hash ⇒ re-derive
  affected portion (§9.3).
- Format migration tool `rfdb migrate-segments` (offline, idempotent, resumable; §8.6).

## Risks / boundaries

- B.1 reuses the committed, MVCC-correct write path — low risk, no on-disk format churn.
- The orchestrator `depends` shape is **module→module** with a file→module mapping (main.rs:1736-1764);
  the `.dl` rule must reproduce that mapping (likely needs a `module_of(file)` join or the rule operates on
  MODULE nodes + IMPORTS_FROM), not raw file→file. Pin the exact shape against the orchestrator before coding.
- Provenance-in-metadata (B.1) vs provenance-in-segment-column (B.2): B.1's metadata stamp matches what the
  orchestrator does today, so the differential compares apples to apples.

## DECISION (2026-06-06): full §8 now (not staged)

User chose to build the full §8 storage apparatus now rather than the B.1-minimal-then-defer path —
paying the on-disk format cost up front so Gate C tags (Count/Conf) drop in without a later segment-format
migration. Note for honesty: for BoolTag (Gate B's only tag) the non-trivial parts are degenerate —
compaction-⊕ on a boolean idempotent tag ≅ the existing newest-wins dedup, and the provenance/tag bytes are
empty/trivial — so they are built as SCAFFOLDING exercised for real only at Gate C.

**Sequencing (each piece compile+test gated, independently verified before the next):**
1. **Segment format v2 foundation** — forward-compatible footer extension (new fields BEFORE
   `footer_index_size`, types.rs:212): per-record provenance `(rule_ast_hash u32|plugin_id, generation u64)`
   + tag `(semiring_id u16, len u16, bytes)` + `tx_created/tx_invalidated`. Writer writes them (default/empty
   for non-derived EDB), reader reads with defaults for old segments, v1 segments read-only OK, unknown
   `semiring_id` ⇒ E-FMT-001. Round-trip + v1-compat tests. **No compaction/materialize change yet.**
2. **Binding table** — manifest-level `predicate → (semiring_id, schema, defining rule_ast_hashes)` (§9.3).
3. **Compaction-⊕** — generalize `merge_*_segments` (merge.rs:26-34/56-64) to fold tags by ⊕ (BoolTag ⊕ =
   the current newest-wins; the fold is the seam Gate C's CountTag needs). Fold == explicit-fold fixture test.
4. **@materialize write-back + run isolation** — executor writes derived `depends` facts (graph-native edges,
   provenance stamped) staged under the run generation; single atomic manifest flip (commit_edit, manifest.rs:1600);
   crash GC by generation (mostly exists, MVCC).
5. **Migration tool** `rfdb migrate-segments` (offline, idempotent, resumable; §8.6).
6. **depends/2 differential** (exit) — `@materialize(edge_type="DEPENDS_ON") depends(...)` reproducing the
   orchestrator's module→module shape (main.rs:1736-1764) ≡ orchestrator DEPENDS_ON on dogfood; then gate the
   orchestrator derivation behind `RFDB_DATALOG_V2`.

First workflow = step 1 (segment format v2 foundation) — the riskiest, format-first.
