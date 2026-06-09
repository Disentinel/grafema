# Where Datalog v2 fits in the lang-spec plugin pipeline (grounded)

2026-06-09, autonomous loop. **Premise correction to the overnight report's decision #3**, which
said "there is no plugin loader yet — define the manifest contract." That was under-grounded:
`packages/lang-spec/` **is** the plugin-spec system, and it already has the seam Datalog v2 plugs into.
This note replaces "invent a contract" with "here is the existing system + the precise v2 seam,"
all backed by file:line. No code changed — read-only inventory + a recommended first migration.

## What already exists (evidence)

`@grafema/lang-spec` (`packages/lang-spec/README.md`) is an LLM pipeline that turns a *language
descriptor* into analyzer plugins:

```
00 corpus → 01 review → 02 parse → 03 annotate → 04 triage → 05 vocabulary
  → 06 reannotate → 07 writeback → 08 classify-edges → 09 compile-tests → 10 generate-plugin
```

Three pieces matter for v2:

1. **Vocabulary** (`05-vocabulary`, README:11,169) — the approved node/edge **types**, deduped and
   human-reviewed. This is exactly the apparatus's archetype / value-domain layer (the edge alphabet
   I13 talks about): the set of relations a plugin is allowed to emit.

2. **Edge-phase model** (`08-classify-edges`, README:123-136). Each edge type is classified by *what
   context its derivation needs*:
   | Phase | When | Context |
   |---|---|---|
   | `walk` | during AST traversal | current node, parent, scope stack |
   | `post-file` | after a file is walked | all nodes in that file |
   | `post-project` | after all files | the **entire project graph** |
   Derived deterministically: `crossFile`/`typeInfo` → **post-project**; `siblingNodes` → post-file;
   else walk (README:133-136). This phase is a static **stratification of where a derivation runs.**

3. **Generated plugins** (`10-generate-plugin.ts`). The stage writes `rule-table.json` plus three
   plugin scaffolds: `{lang}-analyzer.ts` (walk), `{lang}-post-file-enricher.ts`,
   `{lang}-post-project-enricher.ts` (`10-generate-plugin.ts:342,352,356-360`). `emitEdges` entries
   carry a `phase` field (`:161-165`). The rule-table is deliberately serializable — README:185:
   *"Rule table format — serializable, future Rust implementation can consume it."*

## The seam: post-project relational edges → `.dl` rule-packs on v2

Cross the two orthogonal axes:

- **lang-spec's phase axis** = WHERE a derivation runs (walk / post-file / **post-project**).
- **the apparatus's data-physics axis** (`semantic-graph-as-abstract-interpretation.md` §3) = WHICH
  substrate a derivation lives in (YAML facts / JS extractor / **Datalog rules**). The decision rule:
  *put in Datalog only what earns its authoring cost via cheap incremental re-derivation — hard to
  write, cheap to maintain (Gate D2).*

These axes meet at one cell. A **post-project** edge whose profile is `crossFile`/`typeInfo` is, by
construction, a derivation over the whole project graph that is re-run on every reanalysis and is
large — which is *precisely* the apparatus's Datalog atom. The current generator emits these as a
**TypeScript** `post-project-enricher` walking the graph imperatively. That is the migration target:

> For a post-project edge type whose derivation is a relational join / reachability, emit (or
> hand-author) a **`.dl` rule-pack** consumed by the datalog2 v2 engine with `@materialize`, instead
> of a bespoke TS graph-walk. The walk/post-file phases stay imperative (they are local parse/sibling
> work — the JS atom the apparatus keeps imperative).

This is not speculative — **the proof instance already ships**: `datalog2/stdlib/depends.dl` is a
post-project, crossFile `MODULE→MODULE DEPENDS_ON` edge, authored as v2 Datalog, that *replaces* the
orchestrator's in-memory TypeScript derivation (`grafema-orchestrator/src/main.rs:1733-1793`), proven
≡ the TS oracle on the real corpus (`datalog2/differential.rs`) and 14.2× cheaper to re-derive
incrementally (Gate D2). depends.dl is the first plugin already migrated onto v2; it just wasn't
framed as "the first lang-spec post-project enricher in Datalog."

## What this makes concrete for the waiting decision

The report's decision #3 becomes a sharp, low-ambiguity choice instead of "design a contract":

- **The seam is the rule-table + the post-project phase**, both of which exist. The rule-table is the
  IR ("future Rust implementation can consume it"); the datalog2 engine is that Rust runtime for the
  relational subset.
- **First migration target = the post-project relational edges of the JS analyzer** (the ones whose
  requirement profile is `crossFile`). Enumerate them from `05-edge-requirements.json`
  (`phaseDistribution['post-project']`, referenced at `10-generate-plugin.ts:347,357`); the ones that
  are pure joins/reachability are the v2 candidates, the rest stay TS.
- **depends.dl is the template.** A second migration (e.g. a cross-file type-resolution or re-export
  edge that is currently a TS post-project walk) would follow its shape: thin facts already in the
  graph + a `.dl` rule + `@materialize(edge_type=...)`.

## Open question for the human (genuinely needs a decision, not invention)

Does the generated `rule-table.json` already encode *enough* of a post-project edge's derivation to
mechanically lower the relational ones to `.dl`, or is the lowering hand-authored per edge (as
depends.dl was)? Answering needs a read of a real `05-edge-requirements.json` + `rule-table.json` for
the JS corpus (LLM-generated artifacts not in this repo's tree — they live under a `{corpus}/.pipeline/`
produced by a paid run). That is the one fact I could not ground from source alone; it decides whether
"migrate plugins to v2" is a codegen change in stage 10 or a per-edge authoring effort.

## Evidence: the real edge vocabulary refines the migration thesis (2026-06-09)

Enumerated the actual dogfood graph (143164 nodes / 136617 edges, 29 edge types) via
`probe_real_graph_vocabulary` and classified every edge type by migratability to `.dl`:

- **Walk-phase syntactic facts (the EDB) — the overwhelming majority.** `READS_FROM` (30806),
  `CONTAINS` (19332), `DECLARES` (13556), `PASSES_ARGUMENT` (12504), `HAS_PROPERTY` (8372),
  `ASSIGNED_FROM` (5262), `HAS_CONDITION`, `HAS_SCOPE`, `RECEIVES_ARGUMENT`, `HAS_ELEMENT`,
  `RETURNS`, `HAS_METHOD`, `HAS_CONSEQUENT`/`HAS_ALTERNATE`, `THROWS`, `EXPORTS`, `AWAITS`,
  `ITERATES_OVER`, `HAS_SIGNATURE`/`HAS_FIELD`/`HAS_CATCH`/`HAS_UPDATE`/`HAS_FINALLY`. These are
  emitted directly from the AST during the walk — primary facts, not relational derivations.
- **Fuzzy-resolver outputs.** `DERIVED_FROM` (17385, dataflow), `CALLS` (5130), `IMPORTS_FROM`
  (1644). Each needs name/specifier/path matching (the imperative resolver atom), NOT a clean
  relational join — they are the JS extractor's output by data-physics, not Datalog candidates.
- **Clean relational post-project derivation: essentially only `DEPENDS_ON`** (the module→module
  file-attr join `depends.dl` already does; not even materialized in this snapshot).

**Refined thesis (evidence-backed):** "migrate analyzers/plugins to v2" is NOT "rewrite edge
emission in Datalog." The EDB (syntactic facts) STAYS imperative — walk-phase extraction is the
correct substrate for it by the §3 data-physics rule (parse + dirty inference, recompute-from-scratch).
Datalog is the **additive IDB layer** that composes those facts into derived relations
(`depends`, dependency cycles, reachability, coverage-as-negation — all proven this session). The
migration is therefore *additive new `.dl` derivations*, not a fact-emission rewrite; depends.dl is
the prototype, and the clean-relational candidates beyond it are scarce precisely because the analyzer
already emits a rich, first-class EDB. The value is in the derived layer, not in re-expressing the EDB.

## Provenance

lang-spec: `packages/lang-spec/README.md`, `packages/lang-spec/src/types.ts`,
`packages/lang-spec/src/stages/10-generate-plugin.ts:161-165,342-360`. Apparatus §3:
`_ai/research/semantic-graph-as-abstract-interpretation.md`. Proof instance:
`packages/rfdb-server/src/datalog2/stdlib/depends.dl` + `stdlib.rs` + `differential.rs`.
