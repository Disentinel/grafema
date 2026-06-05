# RFDB Datalog Engine v2 — Specification (rev 3.0, normalized)

Design 2026-06-05. Enox anchor: `session:2026-06-05-datalog-engine-semiring-design`
(rationale, review history, and alternatives live there and in the conversation log — not here).
Single source of truth for the implementing agent; done = every gate manifest green (§13).

## 0. Telos (the goal — unfalsifiable by design)

**Beyond answering "what is there", the engine materializes new facts from existing facts by
declared rules — with no external code, purely from the query language. It does so explainably,
cheaply, and idempotently, so that covering the codebase with a new rule causes minimal
operational friction.**

Status and role: deliberately not checkable — the goal from which the §2 invariants
crystallize as falsifiable proxy facets: *no external code, purely from the query* →
I12,I13,I14,I16; *explainably* → I5,I7,I8,I9; *cheaply* (per evaluation AND per change) →
I2, work/plan-quality assertions, the Differ; *idempotently* → I1,I3,I4,I6,I10,I11.
The telos is an arbiter, not a legislator: when operational checks underdetermine or conflict,
decisions resolve toward it; no proxy may be optimized in a way that defeats it. Subordinate
to the product telos — *Grafema helps humans understand code*.

## 1. Goal, boundary, non-goals

Bottom-up, semi-naive, semiring-parameterized Datalog evaluator inside `rfdb-server`, deeply
integrated with the LSM storage; materializes derived facts (resolver rules, enrichers,
guarantees, archetypes) and maintains them incrementally across runs. Sits BESIDE the existing
top-down evaluator (kept for goal-directed point queries); shared: types, parser, builtin
bodies, GraphStore access, EvalLimits.

Deliverable = engine + EDB Differ (§9.1) + run isolation (§8.5) + format migration (§8.6).
Size: core fixpoint ~800 LOC; whole deliverable 10–12k LOC Rust excl. tests.

Non-goals (v1): distributed evaluation; probability semiring; time-travel execution (layout
reserved); user-defined semirings; replacing the top-down engine.

## 2. Invariants and checks (normative core)

Check classes: (a) type guarantee — verified by compilation incl. compile-fail tests;
(b) enumerated deterministic test, seed-pinned where randomized; (c) tripwire — deterministic
CI signal forcing explicit human attention. Suite `tests/invariants/inv_*` runs in every gate
manifest.

| # | Invariant | Check |
|---|---|---|
| I1 | Committed facts+tags independent of worker count, partitioning, iteration order, plan choice | (b) corpus + seed-pinned sampling: K=1 vs K=N vs rule-order permutations → byte-equal state; manifest also asserts K=8 ≥ 3x speedup over K=1 (median-of-5) so determinism is not bought by serialization |
| I2 | Maintained ≡ recomputed, exact ε=0, after any delta sequence | (b) audit harness ≥100 seed-pinned edit cycles; plus work-proportionality: 10-line edit ⇒ |Δ_EDB| ≤ facts of edited file AND derived-work ≤ 1% of full run (counters per I9) |
| I3 | Within a stratum facts/tags only grow; negation/aggregation read frozen lower strata | (a) stratifier; (b) debug checker asserts Total ⊆-growth per iteration in all tests |
| I4 | Termination by construction | (a) trybuild: CountTag in recursive stratum must not compile; (b) chain tests per idempotent tag/lattice (strict monotone, ≤ carrier bound); iteration-cap firing test |
| I5 | No silent failures: every rejection/deviation carries a taxonomy code | (a) error module's only Err constructor takes ErrorCode; (b) every builtin × unsupported mode asserts a code; every guard class has a code test |
| I6 | Only lawful semirings drive semantics; annotations have no read path into evaluation | (b) seed-pinned proptest law suites per semiring/product; (a) annotation store exposes no read API to executor + compile-fail test |
| I7 | Readers never see uncommitted state; crash leaves last committed generation intact | (b) failpoints at: after each stratum, mid-manifest-flip, mid-plugin, mid-compaction; assert committed intact + staged GC on restart |
| I8 | One engine: explain/profiling are recordings of the single execution path | (c) public-api snapshot pins one eval entry; (b) explain tests assert the entry's execution counter |
| I9 | Event log is source of truth and self-describing | (b) every event validates vs versioned JSON Schema; replay tool reconstructs run report from log alone AND report's fact counts are independently recomputed from committed segments — all three must agree; golden-log fixtures pin required content |
| I10 | Storage speaks the algebra: compaction = ⊕/⊔; no point lookups in fixpoint path; access via StorageView only | (b) point-lookup plan asserts E-PLAN; compaction output equals explicit fold on fixtures; (a) storage access module-private |
| I11 | Format outlives code: versioned segments, unknown id = error, old formats readable forever, migration explicit | (b) fixtures: v1 read-only ok / unknown semiring_id → E-FMT-001 / future version → explicit error; coexistence matrix in Gate B manifest |
| I12 | Bare author surface: typical rule has zero annotations; defaults live in stdlib | (b) lint: stdlib/*.dl + doc examples annotation-free outside allowlisted advanced files; Gate D pilot rules annotation-free |
| I13 | Edge vocabulary grows only through archetypes | (b) loading a .dl with an unclaimed concrete edge type asserts the W-code; stdlib claim map total in CI |
| I14 | Less code, never no code: manifested plugins are permanent first-class strata | (b) plugin-between-strata integration test; (c) plugin contract in public-api snapshot |
| I15 | Confidence is never probability | (b) wordlist lint (probability, probabilistic, likelihood, вероятность, …) over source, docs, API-output snapshots |
| I16 | Six extension slots (tag, lattice, builtin, external predicate, storage contract, rule pragmas); a seventh = design review. Allowed exception kind: relaxation of an existing slot (precedent: Tag/Annotation) | (c) public-api snapshot pins the set of extension traits; changing it fails CI until snapshot updated with a design-reference commit |
| P1 | Green = manifest: CI is the only judge; agent never self-judges | (b) CI executes manifests; meta-check: every gate has a schema-valid manifest |
| P2 | Judge files (manifests, snapshots, allowlists, baselines, this spec) deserve first attention | (c) CI labels any diff touching them; reviewer reads those hunks first — a green achieved alongside judge edits is reviewed as one unit |
| P3 | Legacy fallback lives through Gate E + one release | (b) `RFDB_DATALOG_V2=off` test asserts the legacy-path execution counter (not result equality); (c) deleting legacy paths fails CI unless `legacy-retirement.lock` updated |

Manifest quality assertions (anti-Goodhart, all deterministic): type-inference ⊤-fraction ≤
imperative plugin's unknown-fraction + 2pp AND exact match on labeled fixture subset; pilot
rules = key-set equality modulo documented diff list (supersets fail); on dogfood: sort-order
usage events present for every stdlib rule plan, zero full-scan warnings, planner median
q-error ≤ 4; audit seed = f(commit hash), weekly full pass over all strata.
Wall-clock gate targets are criteria, not invariants: median-of-5 on the reference machine
(`bench/reference-hw.md`, recorded baselines: cold analyze 6m51s, 10-line reanalysis 256s).

## 3. Rule language (.dl) — grammar: Appendix A (normative)

```
#requires(engine >= 2)

@tag(count * witness)                          // predicate property, first definition wins;
@materialize(edge_type = "DEPENDS_ON")         // cross-file conflict = E-TAG-002
depends(X, Y) :- edge(X, Y, "IMPORTS_FROM").

@tag(conf * witness)
@tag_from(attr = "confidence", default = $deploy.default_confidence)
trusted_dep(X, Y) :- depends(X, Y).

reach(Seed, Y) :- depends(Seed, Y).            // stdlib recursion is seeded-only
reach(Seed, Z) :- reach(Seed, Y), depends(Y, Z).

orphan(X) :- node(X, "FUNCTION"), \+ edge(_, X, "CALLS").

fanin(X, N) :- node(X, "FUNCTION"), N = count { C : edge(C, X, "CALLS") }.
// grouping = head vars minus aggregate var; empty group ⇒ fact ABSENT
// unless `default N = 0`; lint L-AGG-001 nudges guarantee authors

@lattice(value = type_union)
var_type(X => T) :- ...                        // => introduces the lattice payload column
```

- Recursion only for predicates whose tag implements IdempotentTag (compile-gated).
- Negation/aggregation only over strictly lower strata.
- Unsatisfiable `#requires` ⇒ explicit rejection.
- `@materialize` also writes real edges stamped `_source = rule_ast_hash`,
  `_generation = run_id`.
- Guards: per-rule estimated output > `max_materialized_facts` (10M) ⇒ E-PLAN-003 with
  estimate; cross-join body ⇒ E-PLAN-003; global materialization budget 200M ⇒ E-PLAN-004
  with top offenders; unseeded recursive materialization falls to E-PLAN-003 by estimate.
- stdlib: `archetypes.dl` (claim map; unclaimed concrete edge type ⇒ W-code),
  `valuetrace.dl` (seeded), `reach.dl` (seeded; full closure stays top-down `path()`).
  Appendix B classifies all 36 existing guarantee rules; producing it is a Gate A manifest item.

## 4. Semantics

**Stratification (load).** Dependency graph over predicates from rules + plugin manifests +
storage-level @materialize map: `edge(_,_,"T")` depends on the rule materializing T;
`edge(_,_,Var)` conservatively depends on all materialized predicates (W-STRAT-001, top
stratum). Same for `incoming` and negative literals. SCC condensation; negative/aggregating
edge inside an SCC ⇒ E-STRAT-001 naming the cycle.

**Semi-naive fixpoint (per stratum).**
```
seed: non-recursive rules once → candidates
loop while any Δ nonempty:
  per rule, per recursive position i:
    Bi ← Δ[Bi]; Bj(j<i) ← Total; Bj(j>i) ← Total ∪ Δ
    Δ-side joins are hash-joins (build on Δ); Total/EDB legs merge-join over sort orders
  re-shuffle derived facts across workers by hash(output fact_id)
  GROUP BY fact key, FOLD tags with ⊕        // two derivations in one round count twice
  new key → Δnext; existing → tag' = tag ⊕ folded; re-enters Δnext iff tag_changed
  Total += Δnext; Δ = Δnext
```
tag_changed / termination: Bool never; Count banned from recursion (I4); Conf — exact integer
inequality, monotone finite chain ≤ carrier; Witness annotation — at most one improvement per
better witness under its total order; Product — componentwise.

**Tags.** tag(H) = ⊗ over body tags. EDB contributes one() unless @tag_from lifts a clamped
metadata value (declared-type mismatch = load error; dynamic mismatch = tuple skip + counted
event). Negative literals contribute one().

**Negation.** Stratified vs frozen lower strata; incremental deltas INVERT through negative
literals (a deletion can create derived facts, an insertion can retract them).

**Aggregation.** count/sum/min/max over frozen strata; result tag = one(); incremental unit =
the affected group (retract old fact, insert new, propagate).

## 5. Values, tuples

`Value`: Id(u128) | Str(SmolStr) | Int(i64) | Float(f64) | Bool(bool). No string round-trips
for IDs; variable→slot resolution once per plan. Attr JSON coercion at literal level: failure =
tuple non-match + `coercion_miss` event (never crash, never silent-empty query).
Fact = `Box<[Value]>`; batches `Vec<Row>` (column-major later behind same interfaces).
`fact_id = u64 hash(predicate_id, key tuple)`.

## 6. Tags (sealed), annotations, lattices

```rust
pub(crate) trait Sealed {}
pub trait Tag: Sealed + Clone + Send + Sync {
    fn one() -> Self; fn zero() -> Self;
    fn times(&self, o: &Self) -> Self;        // ⊗
    fn plus(&self, o: &Self) -> Self;         // ⊕ — commutative + associative, EXACT
}
pub trait InvertibleTag: Tag { fn minus(&self, o: &Self) -> Self; }
pub trait IdempotentTag: Tag {}               // in-crate marker; gates recursion
```

| Tag | Carrier | ⊗ | ⊕ | Idem | Invert | Notes |
|---|---|---|---|---|---|---|
| BoolTag | () | — | — | yes | set-diff | default / check |
| CountTag | i64 | × | + | no | yes | incremental maintenance |
| ConfTag | u32 neg-log units | saturating + | min | yes | no | tropical (min,+) ≅ (max,×) on [0,1] via −log; rendered as confidence at API edges |
| Product<A,B> | A×B | compwise | compwise | A∧B | A∧B | lawful by theorem; stdlib: count, count·conf |

`@tag(count * witness)` desugars to Tag=CountTag + Annotation=Witness.

**Annotations** (law-exempt sidecar; witness is provably not a semiring): per-fact
`(rule_ast_hash, body fact_ids)`; update = CAS keep-min by (derivation_height, rule_ast_hash,
fact_ids) — deterministic within a run; contract = stores SOME valid derivation, verified by
replay against committed state; no read path into evaluation (I6).

**Lattices** (payload slot): `bottom / join / leq / widen`; payload merges via ⊔ on
re-derivation; fact re-enters Δ iff payload strictly grew; widening forced after 16
iterations/fact. Sealed v1: TypeUnion, ConstSet (capped → ⊤). Lattice needs never route
through tags.

Default-deny: a missing capability ⇒ slow correct path. Segment tag encoding
`(semiring_id: u16, len: u16, bytes)`; annotation block separate; unknown id ⇒ E-FMT-001.

## 7. Builtins, planner, execution

**Builtin registry** (one registration point; migrating all v1 builtins is Gate A scope; plus
`sim(X,Y,Thr)` over HNSW — floor 0.6, k-cap 64):
```rust
pub struct BuiltinDef { name, arity, modes: &[Mode], cost: fn(&Stats,&Mode)->Cost,
                        kind: Generator|Filter|Function,
                        eval: fn(&dyn StorageView,&mut Batch,&ArgSpec)->Result<()> }
```
Unsupported mode at plan time ⇒ E-PLAN-001 naming required bindings.

**Planner.** Literal order: feasibility (bound-first) + greedy cost from Stats (snapshot taken
at run start; drift > 2x ⇒ re-plan). Runtime adaptivity: actual/estimate > 10x ⇒ re-plan the
rule's remaining suffix, event PLAN_ADAPTED with both numbers. Sort orders: min chain cover
over (predicate, key cols) patterns weighted by predicate size; serve Total/EDB merge legs only
(Δ side is hash); ≤ 3 orders per predicate, overflow ⇒ hash-join + W-PLAN-002. Guards: §3.

**Execution.** Workers only add; re-shuffle by output fact_id before fold; fold spills above a
memory threshold. Hot-key (top-1% frequency) splitting in the join phase only. Per-tuple point
lookups forbidden in the fixpoint path. EvalLimits per stratum; iteration cap 10,000 ⇒
E-EXEC-002. Total residency: this-run Total in RAM up to `stratum_ram_budget` (2 GiB), prior
materialization on disk, merged iterators; over budget ⇒ spill coldest predicate + W-EXEC-003;
plan-time estimate > 4× budget ⇒ E-PLAN-005. Monomorphization: generics in join/fold inner
loops only; orchestration, IO, logging behind dyn.

## 8. Storage

**8.1 Fact layout (segment format v2):** key tuple (typed, per-predicate schema) | fact_id u64
| tag(semiring_id,len,bytes) | payload?(lattice_id,len,bytes) | tx_created u64 |
tx_invalidated u64 (open = u64::MAX) | provenance { rule_ast_hash | plugin_id, generation }.
rule_ast_hash = hash of the normalized rule AST (whitespace/comment/var-renaming invariant).
format_version u16 in segment header.

**8.2 LSM mapping.** IDB predicate = column family with its sort orders. Within-run Δ =
in-memory sorted buffers (never flushed per iteration). Compaction merges duplicate keys by ⊕
on tags, ⊔ on payloads; CountTag negatives generalize tombstones; non-invertible tags use
logical invalidation (tx_invalidated) + recompute markers. Zero-copy reads pin segment epochs
via storage_v2's reclamation mechanism — no segment reference across compaction without a pin.

**8.3 StorageView.** Monomorphized, deliberately leaky contract over the real LSM: sorted-run
iterators per (predicate, order), prefix scans, bloom probes, filter pushdown. In-memory impl =
engine test harness only.

**8.4 as_of (reserved).** Optional `as_of: Tx` pinned once; iterators filter
tx_created ≤ T < tx_invalidated. v1 plumbs the parameter, supports NOW, rejects others.

**8.5 Run isolation.** All writes staged under the run's generation; commit = single atomic
manifest flip after all strata + plugin outputs land. Readers pinned to last committed
generation via tx visibility. Crash: staged generation GC'd on restart. Cancellation =
abort-no-commit. Plugin deadline 120 s; timeout ⇒ its output predicates POISONED, downstream
reads ⇒ E-EXEC-004, run aborts without commit.

**8.6 Format migration.** v1 segments readable forever (read-only); IDB writes v2-only;
`rfdb migrate-segments` offline, idempotent, resumable; no silent in-place upgrade.

## 9. Incremental maintenance

**9.1 EDB Differ** (prerequisite for the reanalysis target). State: per-file digest (sorted
fact_id list + rolling hash) beside segments. At ingest: analyzer snapshot vs digest ⇒
fact-level ± deltas. Identity: nodes = semantic ID; edges = (src,type,dst); attrs = (node,key).
File rename = full-file replace (documented worst case; detection is post-Gate-E optimization).
Cross-file dirty propagation uses the PREVIOUS committed generation's `depends`
materialization. Differ deltas carry tag one().

**9.2 Strategy per stratum (chosen by tag capability):**

| Stratum | Count component invertible | Strategy |
|---|---|---|
| non-recursive, no negation/aggregation | yes | pure differential (± deltas through plans; count 0 ⇒ fact dies and propagates) |
| non-recursive with negation/aggregation | yes | differential with sign inversion through negative literals + group recompute for aggregates |
| non-recursive | no | DRed within stratum |
| recursive | any | recompute the stratum semi-naively from its inputs |

Witness refresh: retraction of a fact serving as a survivor's stored witness ⇒ recompute that
witness within the dirty set (DRed-lite, bounded).

**9.3 Predicate binding.** Manifest table: predicate → (semiring_id, annotation_id, lattice_id,
schema, defining rule_ast_hashes). Changed rule hash ⇒ invalidate that provenance and re-derive
the affected portion. Changed binding ⇒ full predicate rebuild (mixed semiring_id segments are
unmergeable by construction).

**9.4 Plugins.** Re-run iff declared read set ∩ dirty ≠ ∅. `attr:*` reads ⇒ always dirty
(warn at registration).

**9.5 Audit.** CI/nightly: recompute one stratum (seed = f(commit hash); weekly full pass)
vs maintained state; exact compare, ε = 0; divergence = hard failure with both snapshots
dumped.

## 10. External predicates (plugins)

```json
{ "name": "shape-verifier",
  "reads":  ["node:CALL", "edge:CALLS", "edge:INSTANCE_OF"],
  "writes": ["node:ISSUE", "edge:HAS_ISSUE"] }
```
Manifests enter stratification; rule↔plugin cycles ⇒ load error naming both. Plugins run at
their topological position; writes become EDB-with-provenance for higher strata; undeclared
writes rejected at commit.

## 11. Observability

Event log `runs/<generation>/events.jsonl`, ALWAYS ON, decisions + aggregates only:
plan chosen (literal order, join kinds, orders, estimates) and rejected alternatives with
reasons; PLAN_ADAPTED; guard rejections; stats snapshot; stratum schedule; per-iteration Δ
sizes per predicate; rule firing counts; fold ⊕ counts; coercion_misses; spills; hot-key
splits; run begin/commit/abort; plugin start/stop/poison; compaction consolidations.
No per-tuple events in the default stream; bounded debug: `--trace-rule <pred> --limit <n>`.
Hot-loop logging is aggregate counters, zero allocation without a sink.

Renderers are offline functions of the log: `grafema rules plan <pred>`; `grafema run report`
(estimate vs actual per plan node — the optimizer feedback loop); `--explain-live`; replay of
any past run. No built-in narrative renderer: the log + schema doc suffice for an external AI
to translate a run into any register on demand.

`events-schema.md` (versioned; version field in every line): every event type, fields, units,
the tabletop metaphor mapping (стол/мел/коробки/бирки) as canonical translation vocabulary,
ten worked event→plain-language examples.

`why(fact_id)`: stored witness resolved to facts; bounded lazy tree; without an active witness
annotation — explicit message, never empty.

## 12. Errors

Stable codes: E-STRAT-*, E-PLAN-*, E-EXEC-*, E-TAG-*, E-FMT-*; W-* warnings; L-* lints. Every
error: code, file:line for .dl, one-line fix suggestion. Silent-empty-result is a forbidden
failure mode engine-wide (I5). Kill switch: `RFDB_DATALOG_V2=off` ⇒ legacy paths (P3).

## 13. Testing and gates

Tests: invariant suite (§2); law suites incl. products and lattices; engine unit tests on the
in-memory harness (fixpoint, negation incl. delta inversion, aggregation incl. empty group +
group recompute, lattice join/widening, every §9.2 strategy, deletion cascades, witness replay
validity, re-shuffle/fold under adversarial partitioning, spill paths); differential old-vs-new
on key sets over the dogfood corpus; audit cycles (seeded, logged); pilot regression vs
imperative originals on dogfood + pure-JS fixture; CodeQL-derived structural corpus later.

Each gate ships a machine-checkable conformance manifest (YAML: tests, commands, thresholds);
green = manifest passes in CI. Reference hardware + recorded baselines pinned in
`bench/reference-hw.md`.

- **A — Core.** Parser (Appendix A), stratifier incl. storage-level deps, semi-naive executor
  with BoolTag, re-shuffle+fold, in-memory harness; crate `src/datalog2/` {parser_ext,
  stratify, plan, exec, tag, lattice, builtin, storage_glue, differ, events}; port from v1:
  hash-join/anti-join kernels, reorder feasibility, EvalLimits, builtin eval bodies;
  Appendix B produced.
- **B — Storage.** Segment v2, binding table, sort orders, compaction-⊕, @materialize
  write-back with index-visibility barrier, run isolation, migration tool. Exit: `depends/2`
  on dogfood; DEPENDS_ON edges identical to the orchestrator derivation, which is then
  disabled behind the kill switch (deleted only after Gate E + one release).
- **C — Tags & increments.** Count/Conf/Products, annotations + why(), law gates, EDB Differ,
  §9.2 strategies incl. negation inversion, audit harness. Exit: single-line edit ⇒ fact-level
  deltas ⇒ maintained ≡ scratch over 100 seeded cycles; work-proportionality holds.
- **D — Pilots.** method-call-resolver candidate joins; DEPENDS_ON family; guarantee pack
  `guarantees/imports`; type-inference lattice rules behind a flag (quality criteria: §2
  manifest assertions). Exit: cold analyze ≤ 5 min; 10-line reanalysis ≥ 5x vs 256s baseline,
  target ≤ 30 s; pure-JS fixture green.
- **E — Productization.** stdlib, MCP `explain_fact`, docs, events-schema.md, sim(),
  Appendix B migrations executed. Exit: an externally written annotation-free rule against
  archetypes runs, explains, survives a vocabulary addition; all §2 checks green.

Open: hot-key thresholds (tune at B); column-major batches (measure at C); recursive
aggregates (deferred); magic-sets bridge (deferred); rename detection (post-E).

## Appendix A — Grammar (normative EBNF)
```
file        := pragma* item* ;
pragma      := "#requires" "(" ident cmp value ")" ;
item        := annotation* rule ;
annotation  := "@tag" "(" tagexpr ")" | "@tag_from" "(" kvpairs ")"
             | "@materialize" "(" kvpairs ")" | "@lattice" "(" kvpairs ")" ;
tagexpr     := tagatom ( "*" tagatom )* ;   tagatom := "bool"|"count"|"conf"|"witness" ;
rule        := head ":-" body "." | head "." ;
head        := pred "(" terms ( "=>" var )? ")" ;
body        := literal ( "," literal )* ;
literal     := pred "(" terms ")" | "\+" pred "(" terms ")" | var "=" agg | builtin ;
agg         := ("count"|"sum"|"min"|"max") "{" var ":" body "}" ( "default" var "=" const )? ;
terms       := term ( "," term )* ;   term := var | const | "_" ;
```
`*` only inside @tag; `=>` only in heads; aggregates only as `Var = agg`.

## Appendix B — Guarantee rule migration map
Generated at Gate A from the live rule list: each of the 36 rules classified
{rule-portable | seeded-rewrite | stays-top-down(path-based)} with a rewrite sketch.
