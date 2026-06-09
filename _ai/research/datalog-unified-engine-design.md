# Unified Semiring-Datalog Engine — Synthesis Design Doc

**Status:** strategic synthesis of six design memos (archetypes-in-engine, semiring-action-stdlib, enox-generality, federation-feasibility, js-analysis-as-datalog, tldr-dsl-to-datalog).
**Date:** 2026-06-09. **Branch:** feat/datalog. **Engine baseline:** datalog2 v2, Gate C closed, Gate D in progress.
**Author stance:** rigorous, not promotional. Where a memo over-claimed, this doc says so.

---

## 1. The Unified Thesis

**Claim under test:** ONE semiring-Datalog engine unifies a layered stack —
`AST-EDB → analysis rules → archetype claim-map → semiring actions → DSL surface` —
spanning code (Grafema), knowledge (Enox), and federation.

**Verdict: the stack coheres as a layered architecture, but it is NOT one flat unified
system. It is one engine binary + one tag algebra + one annotation set, with TWO honest
seams where generality genuinely breaks.** The thesis holds with two named exceptions, not
as an unqualified "one engine does everything."

The layers, bottom to top, and how solid each is:

| Layer | What it is | Cohesion | Evidence |
|---|---|---|---|
| **L0 — EDB** | nodes/edges as `node(Id,Type)`, `edge(Src,Dst,Type)`, `attr(Id,K,V)`. AST is just more nodes/edges (`AST:VariableDeclarator`, field in edge_type). Enox assertions are `edge(From,Type,To)` of the same shape. | **SOLID.** One fact model serves AST, resolved code graph, and knowledge graph. | EDB Differ keys on `(src,type,dst)` (spec §9.1) — identical for code edge and Enox assertion. |
| **L1 — analysis rules** | `.dl` rule packs that derive semantic edges from EDB (structural: one-hop joins; resolved: recursive seeded rules + stratified negation for shadowing). | **SOLID for structural, RISKY for resolved.** Structural family is a mechanical port. Resolved family (READS_FROM/CALLS/cross-file/shadowing) is the real engineering. | depends.dl materialize precedent; Resolve.hs:55-64 scope-chain walk is recursive Datalog. |
| **L2 — archetype claim-map** | `archetype(S,D,Role) :- edge(S,D,"CONCRETE_TYPE")` as seeded stdlib rules; unclaimed concrete type ⇒ W-EDGE-001 (governance, non-fatal). | **SOLID mechanically, BLOCKED on data hygiene.** Rides existing Gate-A evaluation; reuses the W-STRAT-001 seam verbatim. But the TS source map is drifted. | StratWarning enum + edge_type_arg() already exist (stratify.rs); no @materialize needed (pure view). |
| **L3 — semiring actions** | 4 sealed TAGS {bool, count, conf, count·conf} ⊎ 3 ACTIONS {@materialize, witness, @lattice}. | **SOLID, sealed.** This is the genuinely closed, reusable core. | tag.rs: exactly 4 Tag impls; parser_ext.rs: exactly {Tag, TagFrom, Materialize, Lattice}. Verified this session. |
| **L4 — DSL surface** | English-readable archetype notation compiled BACKWARDS (archetype+verb → edge() literals) to v2 Datalog. | **COHERENT for ~80% of rules, fights precision on the other 20%.** | 9-archetype map is invertible; builtin vocabulary covers every construct. |
| **Federation (orthogonal)** | scatter-gather + frontier stitching at the TS router; Datalog stays local. | **WORKS at router layer; CHOKES (silently) as cross-base Datalog.** Not a layer — a deployment topology around L0–L3. | StorageView is structurally single-store (storage_glue.rs). |

**The crisp statement:** *One engine, one fact model, one sealed tag algebra. Code and
knowledge share L0–L3 verbatim. The DSL (L4) is a compile target over the archetype map
(L2). Federation is NOT in the engine — it is a router pattern that runs the same local
engine N times and stitches.* The two places the unified story breaks:
1. **Knowledge needs non-monotonic, temporally-ordered belief revision** that code never
   exercises (cyclic contradiction, supersede-over-time). The engine cannot express it today.
2. **Federation cannot be transparent cross-base Datalog** — a join whose target lives in
   another base silently returns zero rows. The honest model is router-level stitch only.

Everything else is one coherent stack.

---

## 2. Per-Dimension Synthesis

### 2.1 Semiring actions (L3) — the load-bearing core, present as TWO axes

The strongest and most reusable result. The user's framing "decorators that modify the
semiring" collapses two orthogonal axes — fix the framing and the stdlib is clean and closed:

- **Axis 1 — TAGS (the only thing that *is* a semiring):** `bool`, `count`, `conf`,
  `count·conf` (Product). Sealed by I6, verified: tag.rs exposes exactly these four impls.
- **Axis 2 — ACTIONS (orthogonal side-channels, NOT semirings):** `@materialize` (write
  derived edges back, stamped `_source=rule_ast_hash`), `witness` (law-exempt provenance
  sidecar, no read path into evaluation — I6), `@lattice` (join a payload up a lattice).

**Integration ruling:** the doc and DSL MUST present this as `{tags} ⊎ {actions}`, never as
"semiring actions." Mislabeling witness/materialize as semirings invites someone to make
witness a Tag and break the law gates. This is a real hazard, not pedantry.

Generality of each member: bool/conf/materialize/witness are **fully general** (code +
knowledge, byte-identical). count is **general but code-secondary** (depends_on is ~2% of
code edge mass; Enox uses count heavily for source-support) — and it is **banned from
recursive strata** (non-idempotent, I4), which the stdlib doc must state next to it.
`@lattice` is the **one domain-specific seam**: the *mechanism* is general, the *instances*
are not (TypeUnion/ConstSet are code-only; Enox needs its own sealed lattice = an I16
design-review event, not a config flag).

### 2.2 Archetypes in engine (L2) — build now, scoped, blocked on reconciliation

Build the queryable `archetype(S,D,Role)` predicate + the W-EDGE-001 unclaimed-type warning
**now**. Both are cheap (one StratWarning struct variant + a CLAIMED-set pre-pass in the
loader + a generated stdlib `.dl`) and they directly satisfy Gate E's exit ("an externally
written annotation-free rule against archetypes runs, explains, survives a vocabulary
addition").

**Do NOT** `@materialize` archetype facts to disk — it is ~136k facts of pure view over
edge type, zero unique information (the "materialize only what queries need" lesson). Keep it
queried-on-demand.

**Single-source-of-truth ruling (resolving the implicit conflict between memos):** TS
`EDGE_ARCHETYPE_MAP` stays SoT *for this release*; `archetypes.dl` is **generated** from it
with a CI no-op drift check. Rationale: the TS map has live UI consumers
(describe/legend/trace_dataflow); flipping the .dl to canonical now would invert a working
dependency before Gate E proves the .dl path. Defer that flip to post-E.

### 2.3 Knowledge generality (Enox) — clean on 3 of 4 axes (see §4 for the hard verdict)

Map Enox onto four predicate families: monotone structure (BoolTag — depends/requires/extends
transitive closure, clean today), confidence propagation (`conf * witness` — clean, ConfTag
is byte-exact), defeasible/current-belief (stratified negation, **acyclic only**), temporal
belief (**does not map** in v1 — as_of is NOW-only, a declared non-goal).

### 2.4 Federation — router-level only (see §3 for the hard verdict)

Identity is globally sound (BLAKE3(semantic_id) u128, path-embedded, no namespacing). The
engine is single-store by design; the federation protocol already routes *around* the engine.

### 2.5 JS-analysis-as-Datalog (L1) — split it, ship structural only first

Structural family (ASSIGNED_FROM/DERIVED_FROM/RETURNS) = pure AST-tree projections = one-hop
joins = near-mechanical port that **will work**. Resolved family (READS_FROM/CALLS/cross-file)
= recursive Datalog + scope facts + shadowing-as-stratified-negation = **the choke point**.
The first cut MUST NOT claim the resolved family.

### 2.6 DSL surface (L4) — ship with two mandatory guards

Compile archetype-operator → edge() literal via a **reverse index** built from the SAME
`EDGE_ARCHETYPE_MAP` (no second SoT). Two non-negotiable guards because English fights Datalog
precision exactly where the data is:
1. **A verb is mandatory on flow operators.** A bare `<` (flow_in) is a *set* of edge types
   (READS_FROM ∪ DERIVED_FROM ∪ ASSIGNED_FROM ∪ …) = a disjunction = N rules. flow_in is ~41%
   of edge mass, so this ambiguity bites hardest where it matters most.
2. **Transitive closure needs an explicit `*` marker.** English hides recursion; Datalog must
   seed it. Without the marker, multi-hop rules silently match one hop.
Plus a raw-Datalog escape hatch for the ~20% needing one exact edge type / custom stratum.

### 2.7 Cross-cutting conflict resolution

- **EDGE_ARCHETYPE_MAP drift is the shared blocker for L2, L3-materialize-content, and L4.**
  Three memos independently hit it: DERIVES_FROM (present tense, in map) is a phantom;
  DERIVED_FROM (17,385 real edges, ~3rd largest class) is unclaimed; AWAITS, HAS_EFFECT
  unclaimed. A compiler/claim-map that trusts this map mis-claims 17k+ edges and fires false
  W-codes. **Reconcile-against-live-vocabulary is the single prerequisite for L2+L4.**
- **Stale .rfdb.** The reference graph predates the datalog work. Every "live edge census"
  claim and every parity test needs a fresh reanalyze first.

---

## 3. Killer Risks (ranked by likelihood-to-sink × cost)

1. **Federation "goes insane" — HARD VERDICT: it does NOT go insane; it fails silently, which
   is worse for trust.** A cross-base Datalog join (`edge(X,Dst,"IMPORTS_FROM"), node(Dst,T)`
   where Dst lives in base B) returns **zero rows**, not an error — base A's StorageView probes
   only base A, `get_node(Dst)` returns None. Provenance truncates at the boundary; cross-node
   incremental is incoherent (no shared snapshot/clock — diff_base over two bases reports all of
   A retracted, all of B asserted). The user's "go insane" fear is **misdirected**: the danger is
   not chaos, it is a confident empty answer that violates the core thesis ("graph must be the
   superior way to understand code"). **Mitigation is architectural, not a bug-fix:** keep Datalog
   local, stitch at the router, and surface the frontier LOUDLY. The OverlayStorageView (k-way
   merge of N legs via the existing KMerge) is mechanically feasible in <50 lines on fixtures but
   is **local-only** (cannot wrap remote shards), perf-costly (get_node becomes O(#bases)), and
   STILL cannot do incremental or cross-base why(). Treat overlay as a niche convenience for
   multiple .rfdb files mounted in one process, never as the federation answer.

2. **Knowledge belief-revision wall — HARD VERDICT below in §4.** Cyclic contradiction
   (A refutes B, B refutes A — routine in live research) is a **hard load error** (E-STRAT-001),
   not a degraded result. Temporal belief ("what was live as of date D") **does not map** (as_of
   NOW-only). These are exactly the two features the code pipeline never forced the engine to
   build, and they are the *decision-support core* of Enox.

3. **EDGE_ARCHETYPE_MAP drift poisons three layers at once.** It is the shared dependency of
   L2 (claim map), L4 (compile target), and the @materialize content of L3. Shipping the drift
   into the engine fires false W-codes on the 3rd-largest edge class and makes the DSL compile
   "derives from" to a zero-match edge type. **Cheap to fix, catastrophic to ignore.**

4. **Resolved-analysis family (L1) is harder than the memo's one-line THESIS admits.** The
   js-analysis memo's THESIS field is literally empty ("short summary") and its VERDICT honestly
   scopes it out — but a reader skimming the PROPOSAL could mistake the whole thing for
   "mechanical." Scope/binding, cross-file (the MODULE#-sid orchestrator bug), shadowing-as-
   negation, and absent string-ops (concat/substring) are real. **Only the structural family is
   first-cut-ready.**

5. **ConfTag non-invertibility kills the incremental win for knowledge churn.** The 14.2x
   reanalysis speedup is a BoolTag (invertible) result. A confidence *change* on one Enox
   assertion forces full stratum recompute, not a cheap ± delta. Fine at Enox's current scale
   (~3.9k edges); a scaling hazard, not a launch blocker.

6. **DSL disjunction explosion in flow_in.** A bare archetype operator with no native Datalog
   disjunction either emits N head-sharing rules (rule-count blowup) or waits for a `member()`
   builtin that does not exist. Mitigated by the mandatory-verb guard, but the guard leaks Datalog
   precision back into the "English" surface — the readability promise is partial.

7. **OverlayStorageView could regress the common single-store hot path** if not gated behind an
   explicit flag (get_node O(1) → O(#bases), sorted_run merges N legs). Low likelihood (it's
   opt-in), high blast radius (the measured 14.2x lives on that path).

---

## 4. Generality Verdict — does the SAME machinery serve code and knowledge equally?

**No — "equally" is FALSE on the strict reading, but the shared substrate covers ~90% of
real knowledge traffic.** Precise breakdown:

| Capability | Code (Grafema) | Knowledge (Enox) | Same machinery? |
|---|---|---|---|
| Fact model (node/edge/attr EDB) | ✓ | ✓ (assertion = edge) | **YES, identical** |
| BoolTag monotone reachability | ✓ depends/calls closure | ✓ depends_on/requires/enables closure | **YES, verbatim** |
| ConfTag confidence | resolver/type-inference certainty | claim confidence + evidence chaining | **YES, byte-identical** (I15 "never probability" was practically designed for Enox) |
| Witness provenance | "why is this edge here" | "which sources back this claim" (Enox `trail`) | **YES** |
| @materialize write-back | IMPORTS_FROM ⇒ DEPENDS_ON | transitive enables/supersedes edges | **YES, identical mechanics** |
| CountTag | secondary (depends ~2%) | primary (source support count) | YES, but role differs |
| Lattice instance | TypeUnion, ConstSet | role/confidence-band union (DIFFERENT lattice) | **MECHANISM yes, INSTANCE no** |
| Non-monotonic belief (contradicts/refutes) | code graphs rarely cyclic; CALLS never "negative" | mutual refutation is ROUTINE | **NO** — cyclic case = hard E-STRAT-001 |
| Temporal belief ("as of date D") | reanalysis = fresh NOW each run; never needs history | core value: obsolescence, audit trail | **NO** — as_of NOW-only, declared non-goal |

**Where it is equal:** the query/confidence/provenance/monotone-traversal layer — ~90% of
Enox's actual traffic (recall, traverse, semantic_search over depends/supports/references).
That layer ships **today**, lawfully, no engine change.

**Where it is NOT equal (the converse is clean — code needs nothing knowledge doesn't;
knowledge is a strict superset of demands):**
- **Non-monotonicity.** The engine handles it ONLY via acyclic stratified negation. Enox's
  contradiction graph grows cycles organically; each cycle fails the whole base to load.
- **Time.** Belief revision over time is the Dedalus time-as-first-class problem; v1 says
  time-travel is a non-goal.
- **Lattice instance.** Code's TypeUnion does not transfer; Enox needs its own sealed lattice.

**Honest bottom line:** ship knowledge on this engine **today** with **eager-supersede-at-
write** (resolve supersede in the ingest adapter so the read-time graph stays acyclic and
NOW-only). This loses the belief timeline (you cannot ask "what did we believe in March") —
a real loss for an audit/memory product, not cosmetic. Treat cyclic-contradiction +
temporal belief as a named **future extension** (promote as_of to a real temporal column;
add a defeasible/argumentation stratum), NOT as something the current sealed tag set covers.
One adapter caveat to enforce: provenance-as-filter ("trust only peer-reviewed sources")
must be a real EDB predicate `credible(Src)`, NEVER the witness (witness has no read path
into the planner — conflating them fails silently).

---

## 5. Sequenced First Steps — smallest provable verticals, ordered by risk-reduction-per-effort

The user leans toward: (a) write archetypes to rfdb, (b) the semiring-action stdlib, (c) a
JS-analysis-as-Datalog slice. Re-ordered by how much risk each kills per unit effort, with
the prerequisite the user did not name made explicit:

**STEP 0 (PREREQUISITE — do before 1, 2, or 4 mean anything): reconcile the map.**
Reanalyze the repo to a fresh `.rfdb`; run `SELECT DISTINCT edge_type` (or `query_graph`);
diff against the keys of `EDGE_ARCHETYPE_MAP`. The diff IS the I13 claim-coverage gap
(expect DERIVED_FROM, AWAITS, HAS_EFFECT). This single artifact unblocks L2, L4, and the
materialize content of L3, and fixes the stale-graph hazard that contaminates every parity
test. Cost: hours. Risk killed: poisons three layers if skipped.

**STEP 1 (cheapest real code, highest reuse): write the semiring-action stdlib doc.**
NOT engineering — a validation. One short doc, two tables (TAGS / ACTIONS), each row tagged
GENERAL vs DOMAIN-SPECIFIC, asserting *nothing new compiles*: confirm tag.rs has exactly the
4 Tag impls and parser_ext.rs has exactly {Tag, TagFrom, Materialize, Lattice} (✓ verified
this session). If the doc names a 5th semiring or 4th action, it has drifted from the sealed
engine. This pins the vocabulary every other layer references. Cost: low. Risk killed: framing
trap (the "semiring actions" mislabel) that would otherwise propagate into the DSL and break
law-gate reasoning.

**STEP 2 (the archetype write — user's (a), now unblocked by Step 0): ship
`archetype(S,D,Role)` + W-EDGE-001.** Generate `archetypes.dl` from the reconciled TS map
(CI no-op drift check). Add the StratWarning struct variant + CLAIMED-set pre-pass in the
loader. Do NOT @materialize. This is literally on the Gate E checklist. Cost: low-medium.
Risk killed: closes Gate E's "survives a vocabulary addition" exit.

**STEP 3 (user's (c), scoped to structural only): the JS-analysis structural slice.** Hand-
write AST-EDB for `const x = a + 1`; run `assigned_from ⇒ @materialize(ASSIGNED_FROM)`; assert
it equals the single edge the analyzer emits today. Explicitly DEFER the resolved family
(READS_FROM/CALLS/cross-file/shadowing) to a separate, larger effort. Cost: medium. Risk
killed: proves the AST-as-EDB premise end-to-end without committing to the choke point.

### THE ONE EXPERIMENT TO RUN FIRST

**The federation boundary test** — because it de-risks the user's loudest worry ("federation
might go insane") for the least effort, on fixtures, without touching the live engine, and
gives a *binary* answer:

> Build two FixtureStorageViews. Base A: an edge `A.x -IMPORTS_FROM-> B.y` (dst =
> BLAKE3 of B's semantic_id) and NO node B.y. Base B: node B.y. Run
> `r(X,Y) :- edge(X,Y,"IMPORTS_FROM"), node(Y,_)` against base A alone — confirm **0 rows**
> (the join dies at the missing node, proving the silent-under-approximation failure). Then
> implement a throwaway 2-leg OverlayStorageView (KMerge the sorted runs, union the get_node
> probes), run the same rule, confirm it now yields the cross-base row.

This single <50-line fixture test converts "might go insane" into "fails precisely, here is
the exact line, here is the exact minimal fix and its exact cost." It is the highest
risk-reduction-per-effort move in the whole program because federation is the user's stated
top fear and the test settles it empirically rather than by argument.

**Runner-up experiment (do second, settles the §4 verdict empirically): the Enox
stratification probe.** Take the live `enox-knowledge.rfdb`, pick a real `supersedes` chain
and a real `contradicts` pair, hand-write the `superseded/live` rules with `\+`, feed the
assertion EDB through the datalog2 in-memory harness. Observe whether the contradiction
subgraph stratifies. This turns "knowledge strains on belief revision" from theory into a
**frequency number** — how often does real Enox data trip E-STRAT-001 today.

---

## 6. Open Questions for the User (genuine forks needing a human decision)

1. **Single source of truth for the archetype map — and WHEN to flip it.** This doc rules
   "TS stays SoT this release, .dl generated, flip after Gate E." Do you accept the deferred
   flip, or do you want the .dl canonical sooner (accepting that describe/legend/trace_dataflow
   must then read engine output, inverting a working dependency)?

2. **Knowledge belief-revision: eager-supersede-at-write vs. build the temporal extension.**
   Option (a): NOW-only, resolve supersede in the ingest adapter, **lose the belief timeline**
   — adequate if Enox's only question is "what to use NOW." Option (b): promote as_of to a
   first-class temporal column (Dedalus-style) — a Gate-F-scope extension, not free. For a
   memory/audit product the timeline loss is real. Which do you accept for v1?

3. **Cyclic contradiction is a hard load error today.** Do you (a) forbid cycles at ingest
   (newer tombstones older), (b) accept the base fails to load on a mutual-refutation cycle,
   or (c) commit to a defeasible/argumentation stratum (real R&D)? Real research disputes hit
   this routinely.

4. **OverlayStorageView — build the niche local-multi-rfdb convenience at all?** It is
   mechanically cheap and answers "one transparent Datalog program over several mounted .rfdb
   files," but it is a dead-end for remote shards and the router path is the only thing that
   scales. Build it as a documented convenience, or skip it and force everything through the
   router?

5. **DSL readability vs. precision tradeoff.** The mandatory-verb + explicit-`*`-marker guards
   keep correctness but partially break the "English-readable" promise (the author must name
   the flow verb and mark recursion). Is a "structured-English-with-required-annotations"
   surface acceptable, or do you want fuller natural language (accepting the generated
   disjunction and one-hop-vs-transitive ambiguity)?

6. **Resolved-analysis family scope and timing.** Do you want to commit to porting the resolved
   family (scope-chain walk, shadowing-as-negation, cross-file) to Datalog rules at all, or keep
   resolution in the analyzer/orchestrator and use Datalog only for the structural + governance
   layers? This is the largest single unscoped effort in the stack.
