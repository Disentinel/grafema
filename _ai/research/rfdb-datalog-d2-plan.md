> ⚠️ **SUPERSEDED (2026-06-08) — read this first.** This workflow-generated plan leads with
> "scope" (ship `changed_files` so the server's base SCAN is sublinear). Grounding showed that
> optimizes the WRONG axis: `increment::diff_base` already yields the minimal base delta, and the
> cost of `depends.dl` is the JOIN (1644 edges, 97s), not the scan. The real blocker was cross-run
> acquisition of `prev`+`prev_snapshot` in a stateless dispatcher — and the self-pinned-snapshot
> approach this plan assumed (§2.3/§2.4) is circular on deletions + fragile (tags reset per commit,
> manifest GC keeps 3). **Implemented instead via approach (d): an in-engine pinned
> `(ReadSnapshot, Evaluation)` cache** on the long-lived per-DB engine — no API/wire/orchestrator
> change. Landed in `c01cb273`, `6cf0cb58`, `8ec9d11e`. Authoritative status + design:
> `rfdb-datalog-RESUME.md` (Gate D block). The §5 per-rule envelope table below is still useful;
> the rest is historical. Lesson: don't optimize the scan when the join dominates.

# Datalog v2 Gate D2 — Work-Proportional Phase-9 `@materialize` (Implementation Plan)

**Goal:** make the orchestrator's phase-9 `DEPENDS_ON` derivation work-proportional to the
reanalysis delta. Today phase-9 calls `materialize_datalog("")` (main.rs:1747-1750) which the
server turns into a **full fixpoint over the entire committed snapshot** every run. We feed it
the orchestrator's already-computed **changed-file scope** so the server maintains the derived
edges incrementally (`maintain_incremental` / DRed) instead of full-evaluating, falling back to
full eval per-rule outside the monotone envelope and when scope is absent.

Branch: `feat/datalog`. All commits keep Gate A byte-identical. Nothing pushed.

---

## 0. The load-bearing finding (read first)

There are **two different notions of "scope"** and they do NOT compose for free:

- **What the orchestrator has cheaply:** `changed_files: Vec<PathBuf>` (main.rs:451, in scope at
  phase-9, also used at 1848 as `is_incremental = changed_files.len() < files.len()`). These are
  *file paths*.
- **What `maintain_incremental` needs:** a `BaseDelta` = asserted/retracted **edge tuples**
  `[Value::Id(src), Value::Str(type), Value::Id(dst)]` and node tuples, keyed by
  `fact_id(EDGE_PRED_ID, &tuple)` (increment.rs:187-192, 57-62, value.rs:68, storage_glue.rs:80-98).
  These are *u128 node ids + edge tuples*, i.e. a base **delta**, not a file list.
- **`all_imports_from_edges`** (main.rs:1044, populated 1078-1596) is the current-run
  IMPORTS_FROM endpoints **as semantic-id strings** — NOT u128 ids, and NOT a delta (it is the
  full current-run set, not "what changed vs. last run"). Per `ground:orchestrator-phase9` it is
  "current-run edges only".

**Consequence — the cheapest sound D2 is server-side scope, NOT a client-supplied edge delta.**
We do NOT ship a `ΔIMPORTS_FROM` edge delta from the orchestrator (it would require resolving
sids→u128 and reconstructing retractions, neither of which the orchestrator has). Instead we ship
`scope = changed_files` (a `Vec<String>` the orchestrator already holds) and let the **server**
derive the `BaseDelta` by diffing the two pinned snapshots **restricted to the IMPORTS_FROM /
node facts whose `file` attribute is in scope.** The server already owns `diff_base` over two
`BorrowedLsmStorageView`s (engine_v2.rs:514-518); we add a *scoped* variant of that diff. This
keeps the maintain machinery byte-identical and moves all id-resolution to the side that has the
ids.

> If a future commit wants a true client-supplied `ΔIMPORTS_FROM`, the seam in §2 (a
> `maintain_datalog_v2_scoped` that takes a pre-built `BaseDelta`) already accepts one — it is
> just that D2 builds the `BaseDelta` server-side from `changed_files`, not client-side. See
> Risks §8.

---

## 1. API / wire change

### 1.1 Server request type (the wire schema)

`rfdb_server.rs:263-265`:

```rust
MaterializeDatalog {
    source: String,
},
```

→ change to:

```rust
MaterializeDatalog {
    source: String,
    /// Optional scope: file paths whose facts changed this run. When present AND non-empty,
    /// the server attempts incremental maintenance restricted to these files' base facts,
    /// falling back to full eval per-rule outside the monotone envelope. Absent/None ⇒ legacy
    /// full-snapshot evaluation (back-compat).
    #[serde(default)]
    scope: Option<Vec<String>>,
},
```

**Why backward-compatible (proven by `ground:rfdb-client-wire-protocol`):**
- The Request enum already uses `#[serde(tag = "cmd")]` + `#[serde(default)]` on optional fields
  throughout (rfdb_server.rs:83-86, 102/109/133). Named-msgpack decode (`rmp_serde::from_slice`,
  rfdb_server.rs:3283) silently sets a missing key to its default. Old client (no `scope` key) ⇒
  `scope = None`. New client → old server: the extra `scope` key is ignored.
- `Vec<String>` (not a new struct) → no new type to keep (De)serializable; minimal blast radius.

### 1.2 Client (orchestrator) method

`rfdb.rs:762-766`:

```rust
pub async fn materialize_datalog(&mut self, source: &str) -> Result<u32> {
    let params = serde_json::json!({ "source": source });
    let resp = self.send_command("materializeDatalog", params).await?;
    Ok(resp.count.unwrap_or(0))
}
```

→ add a scoped overload (keep the old one as a thin wrapper so existing callers/tests don't
churn):

```rust
pub async fn materialize_datalog(&mut self, source: &str) -> Result<u32> {
    self.materialize_datalog_scoped(source, None).await
}

pub async fn materialize_datalog_scoped(
    &mut self,
    source: &str,
    scope: Option<&[String]>,
) -> Result<u32> {
    let params = match scope {
        Some(files) => serde_json::json!({ "source": source, "scope": files }),
        None => serde_json::json!({ "source": source }),
    };
    let resp = self.send_command("materializeDatalog", params).await?;
    Ok(resp.count.unwrap_or(0))
}
```

`send_command` flattens `params` into the `RequestEnvelope` (rfdb.rs:122-129), so `scope` lands
as a top-level msgpack key matching the server's flattened `Request` variant. `to_vec_named`
(rfdb.rs:444) emits it as a named field. No protocol bump.

### 1.3 Capability gating

Reuse the existing `datalogV2Materialize` capability (rfdb_server.rs:1193-1199;
`supports_datalog_v2_materialize`, rfdb.rs:754-756). Because `scope` is *additive and optional*,
a v2-materialize server that predates D2 still works: it deserializes `scope` (it has the field
after this PR) but, if older, ignores the unknown key and full-evals — **identical observable
result, just slower.** Therefore **no new capability flag is strictly required** for correctness.

**Optional hardening:** add `datalogV2MaterializeScoped` to the Hello features
(rfdb_server.rs:1193-1199) *only* if we want the orchestrator to skip building the scope vector
when the server can't exploit it (a micro-optimization, not correctness). Recommend **deferring**
this flag to keep the surface minimal; the orchestrator always sends `scope` and old servers
harmlessly ignore it. (Flagged as open question §8.)

---

## 2. Server seam — scope → `BaseDelta` → `maintain_incremental`, bypassing two-snapshot diff

The maintain machinery (`maintain_incremental`, exec.rs:1559-1568) **does not call `diff_base`
internally** (confirmed `ground:maintain-incremental-engine`); the caller supplies the
`BaseDelta`. Today the only caller, `maintain_datalog_v2` (engine_v2.rs:488-531), builds it via
`diff_base(&prev_view, &cur_view)` (engine_v2.rs:518) — a **full** two-snapshot scan. The whole
D2 server win is: **build a scope-restricted `BaseDelta` instead of a full one.**

### 2.1 New scoped diff (increment.rs)

`diff_base` (increment.rs:215-226) scans the *full* node/edge runs of both views and set-diffs
them. Add a sibling that filters to in-scope files, reusing the exact same `scan_weighted` + `diff`
internals so the delta tuples are byte-identical to what `diff_base` would produce for those facts:

```rust
/// Like `diff_base`, but restrict the diffed base facts to those whose `file` attribute is in
/// `scope` (edges: either endpoint's file in scope; nodes: the node's file in scope). The
/// monotone-maintenance guarantee is preserved IFF every base fact that changed between the two
/// snapshots has its file in `scope` — which the orchestrator's changed_files set guarantees,
/// since a fact can only change when its defining file is re-analyzed (Risks §8).
pub(crate) fn diff_base_scoped(
    prev: &dyn StorageView,
    cur: &dyn StorageView,
    scope: &std::collections::HashSet<String>,
) -> BaseDelta { /* scan_weighted(...).filter(file ∈ scope) → diff(...) for nodes & edges */ }
```

Files are resolved per fact: nodes carry `file` directly (storage_glue.rs:80-98:
`[id, type, name, file]`); edges carry only `[src, type, dst]`, so an edge is "in scope" iff the
`file` of either endpoint node (looked up in the corresponding view) is in `scope`. This is the
one place that needs an id→file lookup, and it is on the **server**, which has the node table.

### 2.2 New scoped maintain entry (engine_v2.rs)

Refactor `maintain_datalog_v2` (engine_v2.rs:488-531) to split delta-construction from
maintenance, then add a scoped entry:

```rust
pub fn maintain_datalog_v2_scoped(
    &self,
    source: &str,
    prev: &Evaluation,
    prev_snapshot: ReadSnapshot,
    scope: &std::collections::HashSet<String>,   // empty ⇒ behaves like full diff_base
    limits: EvalLimits,
) -> Result<Option<Evaluation>, EvalError> {
    // identical to maintain_datalog_v2 (lines 496-517) up to the two views, then:
    let base_delta = if scope.is_empty() {
        increment::diff_base(&prev_view, &cur_view)        // full = existing behavior
    } else {
        increment::diff_base_scoped(&prev_view, &cur_view, scope)
    };
    if base_delta.is_empty() {
        return Ok(Some(prev.clone()));                     // nothing changed ⇒ prior result holds
    }
    maintain_incremental::<BoolTag>(prev, &prev_view, &cur_view, &base_delta,
                                    &plans, &rules, &strat, limits)
}
```

`maintain_datalog_v2` becomes `self.maintain_datalog_v2_scoped(.., &HashSet::new(), ..)` so the
Gate-C proof keeps exercising the same path with empty scope = full diff. **No change to
`maintain_incremental` (exec.rs) or `increment::delta_view*` is required** — the only new code is
`diff_base_scoped` and the scoped engine entry. The envelope guard (`Ok(None)` on negation or >1
stratum, exec.rs:1571-1576) is preserved verbatim and remains the per-rule recompute trigger
(§5).

### 2.3 The cross-run blocker (must be solved here or D2 falls back to full eval)

`maintain_*` needs **`prev: &Evaluation` and `prev_snapshot: ReadSnapshot` from the previous
materialize run.** The dispatcher today has neither (`eval_datalog_v2_materialize` is stateless,
engine_v2.rs:417-473). Per `ground:depends-and-packs-rules`, binding-table persistence write-side
exists (`store_in_tags`, commit `76659214`) but **load-side is unconfirmed** and the prior
`Evaluation`/snapshot are NOT persisted across requests.

**D2 decision — reconstruct `prev` from the already-materialized edges (no new cross-run
storage):** the currently-materialized `DEPENDS_ON` edges *are* `depends/2`'s prior `Evaluation`
(this is exactly the identity `eval_datalog_v2_materialize_incremental` already relies on,
engine_v2.rs:624-631: "the prior derived state IS the currently-materialized edges of the spec
types"). And `prev_snapshot` is the **snapshot pinned at the *start* of the previous successful
materialize** — equivalently, for a `@materialize` whose only base relation is IMPORTS_FROM, the
prev base view can be reconstructed as `cur_view minus base_delta`. Concretely the dispatcher:

1. Pins `cur_snapshot = self.snapshot()`.
2. Reconstructs `prev: Evaluation` for each `@materialize` predicate by reading the current
   materialized edges of `spec.edge_type` via `get_edges_by_type_at(&cur_snapshot, type)`
   (multi_shard.rs:1321-1350) and projecting them back into head tuples (inverse of
   `plan_writeback`). For `depends/2` a `DEPENDS_ON(src,dst)` edge ⇒ row `[Id(src), Id(dst)]`.
3. Sets `prev_snapshot = cur_snapshot` for the purpose of the diff — but because we need a true
   *previous base*, we instead **synthesize `prev_view` = the scoped delta applied in reverse.**

> **Simpler, sound fallback chosen for the first D2 landing:** rather than reconstruct a perfect
> `prev_snapshot`, the dispatcher computes the **base delta directly from scope** (the
> IMPORTS_FROM / node facts in `scope` at `cur_snapshot`) treated as *asserted*, plus the
> orphan-removal pass below for *retracted*. This makes the **insertion** half of DRed exact and
> work-proportional, and bounds the **deletion** half to scope. See §2.4. This avoids any
> cross-run `Evaluation` storage and is the cheapest sound seam.

### 2.4 Concrete dispatcher seam (`eval_datalog_v2_materialize`, engine_v2.rs:417-473)

Add `scope: Option<&[String]>` to `eval_datalog_v2_materialize` and branch:

- **`scope` is `None` or empty:** unchanged full path (lines 422-472). Preserves
  empty-scope = full-eval fallback and the existing 50/50 / empty-source test
  (rfdb_server.rs:7194-7246, must still return `written == 1`).
- **`scope` is `Some(non-empty)`:** call the new
  `eval_datalog_v2_materialize_incremental_scoped`:

```rust
pub fn eval_datalog_v2_materialize_incremental_scoped(
    &mut self,
    source: &str,
    scope: &[String],
    limits: EvalLimits,
) -> Result<(usize, usize), EvalError> {
    // 1. build prev Evaluation from currently-materialized edges of each @materialize type
    //    (get_edges_by_type_at, inverse of plan_writeback)  — engine_v2.rs:624-631 pattern
    // 2. base_delta = diff_base_scoped(prev_base_view, cur_view, scope_set)
    //    where prev_base_view is the scoped reverse of base_delta (insertion-exact; deletion
    //    bounded to scope) — §2.3
    // 3. maintained = maintain_incremental::<BoolTag>(&prev, &prev_view, &cur_view,
    //                     &base_delta, &plans, &rules, &strat, limits)?;
    //    if maintained.is_none()  ⇒ per-rule outside envelope ⇒ FALL BACK to full
    //        eval_datalog_v2_materialize_incremental(source, limits)  (engine_v2.rs:586-662)
    // 4. project maintained.relations → new_edges (plan_writeback)
    // 5. WRITE-BACK delta (§3): diff new_edges vs currently-materialized edges by
    //    (src,dst,type); delete_edge removed; add_edges added; single flush()
}
```

Key points:
- **Bypasses the full two-snapshot `diff_base`** (the engine_v2.rs:518 call) — the scope set is
  the only thing scanned, so the diff is O(scope), not O(base).
- **Per-rule recompute fallback is in-band** (step 3): if `maintain_incremental` returns
  `Ok(None)` (negation/multi-stratum), we call the existing **full** incremental write-back
  (`eval_datalog_v2_materialize_incremental`, engine_v2.rs:586-662) for *that program*. Since
  D2's program is the bundled single `depends/2` rule (monotone, single stratum — §5), the common
  path stays incremental; mixed packs degrade gracefully per-program.

### 2.5 Dispatcher + handler threading

- `dispatch_materialize_datalog` (rfdb_server.rs:2828-2859): add `scope: Option<&[String]>`
  param, leave the kill-switch gate and empty-source→`DEPENDS_DL` substitution (lines 2851-2855)
  untouched, and route: `Some(non-empty)` → scoped path, else existing
  `eval_datalog_v2_materialize`.
- Handler `Request::MaterializeDatalog { source }` (rfdb_server.rs:1645-1656): destructure
  `{ source, scope }`, pass `scope.as_deref()` into `dispatch_materialize_datalog`.

---

## 3. Write-back (atomic, reuses the proven pattern)

Reuse `eval_datalog_v2_materialize_incremental`'s Phase-2 verbatim (engine_v2.rs:643-662): for the
maintained relations, project to `new_edges` via `plan_writeback`, diff against
`get_edges_by_type_at(&snapshot, type)` by `(src, dst, edge_type)` (engine_v2.rs:620-639), then:

```rust
for (s, d, t) in &removed { self.delete_edge(*s, *d, t); }      // tombstone pending
if !added.is_empty() {
    let v1 = added.iter().map(edge_v2_to_v1).collect();
    self.add_edges(v1, true);                                   // buffer
}
self.flush()?;                                                  // ONE manifest advance
```

This is the established atomicity unit (engine_v2.rs:901-948, 1081-1125;
`ground:incremental-writeback-and-proof`): tombstones + additions reach disk together under one
`commit_edit`, abort-no-commit on flush failure (`E-MAT-005`). The scoped path differs from the
existing incremental path **only in how `new_edges` is produced** (maintained vs full eval); the
commit is byte-identical, so we factor the Phase-2 block into a private helper
`commit_edge_delta(&mut self, new_edges, edge_types, snapshot) -> Result<(usize,usize)>` and call
it from both the existing `..._incremental` and the new `..._incremental_scoped`. No new
`commit_batch_ext` call shape is introduced.

---

## 4. Orchestrator change — phase-9 wire (main.rs:1744-1756)

Variables confirmed in scope at phase-9 (verified): `changed_files: Vec<PathBuf>` (def
main.rs:451, live through 1848), `files` (total set, used at 1848), and
`is_incremental = changed_files.len() < files.len()` is already computed at **main.rs:1848** —
but that is *below* phase-9 (phase-9 is ~1744). So compute the scope inline at phase-9.

Replace the `materialize_datalog("")` call (main.rs:1747-1750):

```rust
if rfdb.supports_datalog_v2_materialize() {
    // Work-proportional scope: when this is a partial reanalysis, hand the server the set of
    // re-analyzed files so it maintains DEPENDS_ON against just those files' IMPORTS_FROM/MODULE
    // facts. Full reanalysis (or first run) ⇒ no scope ⇒ server full-evals (correctness floor).
    let scope: Option<Vec<String>> = if changed_files.len() < files.len() {
        Some(
            changed_files
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
        )
    } else {
        None
    };
    let written = rfdb
        .materialize_datalog_scoped("", scope.as_deref())
        .await
        .context("RFDB Datalog v2 @materialize DEPENDS_ON failed")?;
    // ... existing tracing/profile (1751-1756) unchanged ...
}
```

What we pass: **`changed_files` as `Vec<String>`** — NOT `all_imports_from_edges`. Rationale in
§0: `all_imports_from_edges` is semantic-id strings and the full current-run set (not a delta),
so it cannot be turned into a sound `BaseDelta` orchestrator-side; `changed_files` is the cheap,
sound scope key the server can resolve to base-fact files. The legacy P3 fallback
(`else if !all_imports_from_edges.is_empty()`, main.rs:1757-1788) and the full-eval path
(`scope = None`) are untouched.

**Path-form caveat (Risk §8):** `changed_files` are filesystem paths relative to the analysis
root; the `file` attribute stored on nodes is whatever the analyzers wrote. The scope match must
be on the **same path form** the node `file` attribute uses. The server's `diff_base_scoped`
filters on node `file`; the orchestrator must send paths in that exact form. If they differ, the
scope set matches nothing → `base_delta.is_empty()` → §2.2 returns prior result **unchanged**,
which is WRONG for a real change. So this mapping MUST be verified in the proof (§6) before the
orchestrator wire lands. Until verified, prefer **over-broad scope** (see §8) which is always
sound.

---

## 5. Per-rule envelope table

The monotone-maintenance envelope is defined by `maintain_incremental` returning `Ok(None)` on
**negation OR >1 stratum** (exec.rs:1571-1576). Outside it ⇒ per-program recompute (§2.4 step 3).
Classification from `ground:depends-and-packs-rules`:

| Rule / pack | Maintainable? | Reason (tied to envelope) |
|---|---|---|
| `depends/2` (depends.dl:1-6) — **D2 scope** | **MAINTAINABLE** | Single-stratum EDB join, no negation, no recursion, no aggregation; BoolTag set-union dedup; DRed re-derives on IMPORTS_FROM/MODULE deletion. This is the *only* rule phase-9 materializes today (empty source ⇒ `DEPENDS_DL`, rfdb_server.rs:2851-2855). |
| 46 structural/BEAM guarantees (guarantees.yaml:32-597) | **MAINTAINABLE** | Arity-1 `violation/X`, single stratum or EDB+lower-IDB (acyclic), **stratified** negation only, BoolTag, no aggregation → inside envelope. (Not in D2's materialized program yet — `guarantees/imports` pack is undefined, §8.) |
| `call-with-args-has-passes-argument` (guarantees.yaml:371-384) | **RECOMPUTE** | Uses `gt(A,0)` numeric comparison; numeric literals deferred past Gate C (Value-enum extension undecided). Cannot enter incremental eval. |
| `beam-unreachable-handler-precise` (guarantees.yaml:464-477) | **RECOMPUTE** | Uses `incoming()` reverse-index builtin; delta tracking of `incoming()` in `diff_base`/`delta_view` is **unconfirmed**. If unsupported → recompute. |
| `beam-state-guard-never-written`, `...truthy-guard-always-falsy/truthy` (guarantees.yaml:548/571/583/596) | **RECOMPUTE (unless dedup live)** | Semijoin/projection requiring dedup on the join var before fold; `maintain_incremental` Δ-loop seeding of semijoin is **undocumented**. Until proven, recompute. |
| `guarantees/imports` pack (RESUME.md:74) | **UNCLASSIFIED** | No `.dl` / rule inventory exists. Out of D2 implementation scope; D2 planning artifact only. |

**Server behavior:** for any program whose `maintain_incremental` returns `Ok(None)`, the scoped
dispatcher falls back to the **full incremental write-back** (engine_v2.rs:586-662) — correct,
just not work-proportional. Since D2's actual materialized program is `depends/2` alone, the
common path is fully maintainable.

---

## 6. Proof obligation

### 6.1 Unit proof (real ephemeral storage_v2) — the EXIT-of-the-seam

Adapt `maintain_datalog_v2_equals_scratch_on_real_store_over_cycles` (engine_v2.rs:3215-3298) and
`incremental_materialize_commits_only_the_edge_delta` (engine_v2.rs:3349-3416). Test name:
`scoped_incremental_materialize_equals_full_scratch_on_real_store`.

Helpers (all confirmed in `ground:incremental-writeback-and-proof`): `create_ephemeral`
(engine_v2.rs:229-246), `make_v2_node` (engine_v2.rs:1687-1699), `commit_batch_ext`
(engine_v2.rs:1447-1457), `get_edges_by_type_at` (multi_shard.rs:1321-1350).

Steps:
1. `create_ephemeral()`.
2. Build N MODULE nodes (`make_v2_node`, distinct `file` attrs) + base IMPORTS_FROM edges across
   files; `commit_batch_ext(nodes, edges, &[], {}, &[])`.
3. **Materialize full** `@materialize(edge_type="DEPENDS_ON") depends(...)` via
   `eval_datalog_v2_materialize(DEPENDS_DL, limits)`. Snapshot the resulting DEPENDS_ON set
   `D0 = get_edges_by_type_at(snap, "DEPENDS_ON")`.
4. **Edit one file's imports:** `commit_batch_ext` that adds/removes IMPORTS_FROM edges whose
   endpoints live in file `f` (use `commit_batch_ext` with `changed_files = [f]` to mirror prod).
5. **Scoped/incremental materialize:** `eval_datalog_v2_materialize_incremental_scoped(DEPENDS_DL,
   &[f], limits)`. Read `D_inc = get_edges_by_type_at(snap', "DEPENDS_ON")`.
6. **Full-scratch oracle:** on a *separate* `create_ephemeral()` rebuilt to the identical post-edit
   base, run full `eval_datalog_v2_materialize` → `D_full`.
7. **Assert byte-equal:** `assert_eq!(sorted(D_inc), sorted(D_full))` (by `(src,dst,edge_type)`).
   Also assert the returned `(added, removed)` counts are non-trivial and equal the true delta
   (work-proportionality smoke: not a full rewrite).
8. Loop 6 mixed insert/delete edits (mirrors exec.rs:2183-2254) asserting equality each cycle, to
   catch DRed re-derivation bugs (diamond re-derive).

This is the **unit-provable EXIT**: it proves scope-driven maintenance ≡ full scratch on real
storage_v2, including the §4 path-form mapping (step 4 uses real `changed_files`).

### 6.2 Corpus benchmark — the separate D2 EXIT (needs the pipeline)

Per `ground:depends-and-packs-rules` target: **cold ≤ 5 min; 10-line reanalysis ≥ 5× vs the 256s
baseline → ≤ 30s** for the `DEPENDS_ON` phase. This requires the real analyze pipeline (cannot be
a Rust unit test): run `analyze` on the DEPENDS_ON pilot corpus, full cold, record phase-9 ms;
then touch one file, reanalyze, record phase-9 ms with scope wired. Pass iff
`phase9_warm ≤ phase9_cold / 5` and `phase9_warm ≤ 30s`. This is the **corpus-benchmark EXIT**,
explicitly distinct from §6.1 and gated on the orchestrator wire (§4) + a corpus.

---

## 7. Commit sequence (each keeps Gate A byte-identical)

1. **`feat(rfdb): scoped diff_base — diff_base_scoped(prev,cur,scope)`** (increment.rs). Pure
   addition; unit test it against `diff_base` (scope = all files ⇒ identical `BaseDelta`; scope =
   ∅ ⇒ empty). Gate A untouched (no eval path changed).
2. **`feat(rfdb): maintain_datalog_v2_scoped + empty-scope = full diff`** (engine_v2.rs). Refactor
   `maintain_datalog_v2` to delegate with empty scope; add scoped entry. Re-run Gate C proof
   (engine_v2.rs:3215-3298) unchanged (empty scope = old behavior).
3. **`feat(rfdb): factor commit_edge_delta + eval_datalog_v2_materialize_incremental_scoped`**
   (engine_v2.rs). Extract Phase-2 write-back helper from engine_v2.rs:643-662; add scoped
   incremental eval with in-band `Ok(None)` → full-incremental fallback. **← unit-provable
   EXIT-of-the-seam lands its test here** (§6.1).
4. **`feat(rfdb): wire scope through MaterializeDatalog request + dispatcher`** (rfdb_server.rs).
   Add `#[serde(default)] scope: Option<Vec<String>>` (lines 263-265), thread through handler
   (1645-1656) and `dispatch_materialize_datalog` (2828-2859). Back-compat test: old-shape msgpack
   (no `scope`) still deserializes (round-trip). Empty-source test (7194-7246) still passes.
5. **`feat(rfdb-client): materialize_datalog_scoped`** (rfdb.rs). Add scoped method + keep
   `materialize_datalog` as `(.., None)` wrapper (762-766).
6. **`feat(orchestrator): phase-9 passes changed_files scope to v2 @materialize`** (main.rs:1744).
   Compute `scope` from `changed_files` vs `files`; call `materialize_datalog_scoped`. Legacy P3
   (1757-1788) + full-eval (`scope = None`) paths intact.
7. **`test(rfdb): corpus DEPENDS_ON reanalysis ≥5× benchmark harness`** — the
   **corpus-benchmark EXIT** (§6.2). Separate from #3's unit EXIT; needs pipeline + pilot corpus.

Commits 1-3 are server-internal and independently green. Commit 4 is the wire (back-compat
proven). Commits 5-6 are the client/orchestrator wire. Commit 7 is the perf EXIT.

---

## 8. Risks & open questions

- **[BLOCKER-CLASS] scope→ΔIMPORTS_FROM mapping / under-maintain hazard.** The soundness of
  `maintain_incremental` requires the `BaseDelta` to contain **every** base fact that changed. If
  `scope = changed_files` misses a file whose facts changed (e.g. an edge whose *other* endpoint's
  file was re-analyzed but this endpoint's file was not, or a deleted file not present in
  `changed_files`), the maintenance **under-maintains** → stale derived edges, silently wrong.
  Mitigations, cheapest-first:
  1. **Over-broad scope is always sound:** include in scope not just `changed_files` but also any
     file that is an endpoint of an IMPORTS_FROM edge touching a changed file (the server's
     `diff_base_scoped` edge rule already keys on *either* endpoint's file, which covers the
     "other endpoint" case as long as the changed endpoint's file is in scope). Recommend the
     server expand scope = `changed_files ∪ files-of-edges-incident-to-changed-files` internally.
  2. **Deletion of a whole file:** a removed file won't be in `changed_files` (it has no current
     content). Its IMPORTS_FROM edges are tombstoned during the normal incremental commit
     (main.rs:1827 region notes incremental segment handling). The scoped diff must treat
     retracted base edges (present in `prev_view`, absent in `cur_view`) whose endpoint file is in
     scope as retractions — `diff_base_scoped` does this because it diffs prev vs cur. But a file
     deleted *without* any surviving in-scope sibling could be missed → **safest is to force
     `scope = None` (full eval) whenever any file was deleted** this run. Cheap, sound, rare.
  3. **Floor:** when in doubt the orchestrator can always pass `scope = None` → full eval (the
     correctness floor we never remove).

- **[GAP — readers flagged] cross-run `prev` reconstruction.** §2.3/§2.4 reconstructs `prev`
  `Evaluation` from currently-materialized edges rather than persisting it. This is sound for
  `depends/2` (its head columns are exactly the edge endpoints). It is **not** general: a
  `@materialize` predicate with head columns that don't round-trip from the edge (extra payload,
  projection) cannot be reconstructed this way. For D2 (depends/2 only) it is fine; document the
  restriction and gate non-round-trippable specs to full eval. Binding-table load-side
  persistence (RESUME.md:8-14, write-side `76659214` done, load-side unconfirmed) is the proper
  long-term fix and is **out of D2 scope**.

- **[GAP] path-form of `changed_files` vs node `file` attribute.** §4 caveat. Must be verified by
  the §6.1 unit test using real `changed_files` paths end-to-end before the orchestrator wire
  (commit 6) is trusted. If forms differ, normalize on the orchestrator side or in
  `diff_base_scoped`. A mismatch is *silent* (empty delta → "no change") which is the dangerous
  failure mode — the test MUST assert a real change propagates.

- **[GAP] `incoming()` / numeric / semijoin rules** (§5) are not in D2's materialized program
  (only `depends/2` is). They become live only when `guarantees/imports` pack is defined
  (RESUME.md:74 — currently **undefined**, no `.dl`). No D2 action; recorded so the envelope table
  stays honest.

- **[OPEN] capability flag.** §1.3: recommend NOT adding `datalogV2MaterializeScoped` (additive
  optional field already degrades gracefully). Revisit only if we want the orchestrator to skip
  scope construction against old servers — a micro-opt, not correctness.

- **[OPEN] `base_delta.is_empty()` early-return** (§2.2): returning `Some(prev)` on empty delta is
  correct *only if scope genuinely covered all changes*. Combined with the under-maintain hazard
  above, an empty delta from a *mismatched path form* would wrongly short-circuit. The §6.1 test's
  "real change propagates" assertion is the guard; keep it as a hard assert, not a smoke check.

- **No wire-framing blocker.** `ground:rfdb-client-wire-protocol` confirms named-msgpack +
  `#[serde(default)]` makes the optional `scope` field free (no version bump, no framing change).
  The framing (4-byte length prefix, rfdb.rs:398-410) is schema-agnostic. ✅
