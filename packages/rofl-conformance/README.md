# rofl-conformance — TWO-TIER ROFL v0 ↔ RFDB conformance harness (ТЗ P0)

This harness is the **definition of done** for every later phase of the
RFDB → ROFL fact-model migration. It runs the TS v0 reference suite and a
seeded differential against the RFDB derive engine, and emits a machine-
readable conformance report joined against pre-registered ledger expectations.

Zero npm dependencies, fully offline; Node ≥ 22.6 (`--experimental-strip-types`).

## Run

```bash
# self-tests (incl. LIVE wire smoke against a spawned rfdb-server)
cd packages/rofl-conformance
node --experimental-strip-types --test test/*.test.ts

# full P0 run: tier-0 differential + tier-1 suite + reports (~15s)
cd <repo root>
node --experimental-strip-types packages/rofl-conformance/src/run.ts --seeds 120
# flags: --seeds N (120) | --rfdb <binary> | --only tier0|tier1
```

Outputs: `conformance-report.json` (machine — **byte-reproducible**: run
identity lives in the `conformance-run-meta.json` sidecar, so identical-seed
runs on the same commit produce byte-identical report files) +
`_ai/research/rofl-conformance-report.md` (human). `run.ts` refuses to run
unless `run-migration/rounds/round-001.rofl` (the pre-registered expectations)
is **committed** — pre-registration integrity.

The migration round loop (restore → audit → act → record → snapshot → commit,
never push): `bash run-migration/run-round.sh <NNN>`.

## The two tiers

**Tier-0** — the common language subset both engines run TODAY: stratified,
range-restricted, connected flat Datalog over atom constants in the single
implicit perspective. 120 seeded programs (90 positive + 30 stratified-negation,
LCG ported from `phase2.test.ts:21-54` with tier-0 constraints), run on BOTH
engines, canonical fact sets compared **byte-for-byte**, plus per-seed witness
spot-checks in BOTH directions:

- **why** (≤5 derived facts): v0 `why().ok` ∧ RFDB `explainDatalogFact`
  witness exists ∧ witness body ⊆ v0 fact set;
- **whynot** (≤5 absent ground tuples over rule-bearing rels — EDB-only rels
  return null gaps, live-probed): v0 `whynot().holds === false` ∧ RFDB
  `explainDatalogGap` witness exists ∧ satisfied premises ⊆ v0 fact set
  (`satisfied[]` lists positive premises only, live-probed) ∧ the failing
  predicate is a program/aux predicate.

Deliberately NOT tree identity: v0 keeps only the first witness per fact
(`store.ts:127`); why/whynot TREE parity stays RED `missing:whynot-shape`.
Any mismatch or unexpected E-code is a **DIVERGENCE**: the run fails with a
full repro dump. It is never recoded as RED.

**Tier-1** — the 29 v0 tests ported 1:1 (verbatim assertion literals, each
with `file:line` provenance) + one boot.rofl-load scenario = 30. Two passes:

1. **Oracle self-check**: all 30 must pass against the vendored v0 engine, and
   the count must equal 30 — kills broken ports, fake greens, silent skips.
2. **Subject verdicts** against the `RfdbRofl` adapter:
   `GREEN` (passed) / `RED {reason_code}` (UnsupportedFeature from the closed
   taxonomy) / `DIVERGENCE` (wrong answer on translatable input → run fails) /
   `HARNESS_GAP` (harness defect → run fails).

**A RED is a SUCCESS of the harness** — the RED list with reason codes IS the
migration roadmap.

## RED reason taxonomy (closed)

| code | meaning |
|---|---|
| `missing:perspectives` | `rel[persp]` dimension absent in RFDB |
| `missing:rules-as-data` | reflection vocabulary (rule/concludes/derived_by/stratum/…) absent |
| `missing:holes` | v0 commits partial + `hole/2` on budget exhaustion; RFDB aborts-no-commit (THE policy contradiction; ТЗ P1 mandates holes) |
| `missing:compound-terms` | functor terms (`cons(H,T)`) unrepresentable (`datalog/types.rs:12-14`) |
| `missing:bignum` | ints beyond i64 / 2^53 unrepresentable on both sides |
| `missing:whynot-shape` | v0 recursive why/whynot text trees vs RFDB flat witnesses (`exec.rs:248`) |
| `missing:temporal` | `@init`/`@next` tick semantics absent |
| `missing:excise` | minus-one-fact blast radius absent (sim is overlay-ADD) |
| `missing:retract` | base-fact retraction absent for program-text EDB |
| `missing:snapshot` | canonicalState/save/restore absent |
| `missing:demand-mode` | unsafe heads / unsafe negation (v0 demand-moded evaluation) |
| `engine:limit-abort` | RFDB EvalLimits abort on inputs v0 handles by budget |
| `dialect:untranslatable` | no verified translation in P0 (builtins/ints/strings, naive-mode toggle, planner-trap shapes) |

## Architecture

- **Oracle** = ROFL v0 vendored at `vendor/rofl-v0/` (REV pins `052a4c5`,
  main — the corpus branch `6dfa003` patches the engine, so only DATA files
  come from it: `vendor/corpus/audit-v0.2.rofl`). Re-vendor: `scripts/vendor.sh`.
- **Subject** = `rfdb-server` over the wire (`[4-byte BE len][MessagePack]`,
  hand-rolled codec `src/msgpack.ts`): `executeDatalog {explain:false}` —
  explain=true silently reroutes to the legacy v1 engine. Hello must advertise
  `datalogDerive`. One server + one empty tmp DB per run (ground facts in
  program text are first-class EDB; stateless reads).
- **Adapter** `src/adapter.ts` (`RfdbRofl`) mirrors the v0 API and DELEGATES
  every answer to RFDB; vendored parser/unify are reused as parsing/matching
  code over RFDB-returned tuples, never as a fallback engine. Unsupported ops
  throw `UnsupportedFeature(code)` — never simulate.
- **Translator** `src/translate.ts`: v0 clauses → RFDB v1 dialect. Atoms →
  quoted strings, `not` → `\+`, user predicates namespaced `u_<rel>` (v0 names
  collide with RFDB base relations `edge`/`node` and builtins like `path`),
  negated wildcards projected through aux predicates, statically-empty
  predicates eliminated to fixpoint. Fixed program-wide check-phase order
  makes the reported reason code deterministic.
- **Per-predicate dump**: `executeDatalog` answers for the FIRST rule head's
  predicate — a fresh `xdump(V…) :- u_rel(V…).` rule is hoisted per dump, so
  the engine itself materializes the full extension (EDB echo pinned by
  wire-smoke test #2).

## Engine findings discovered by this harness (probe evidence)

1. `\+ p(X, _)` — a wildcard inside a NEGATED literal — silently returns wrong
   answers (positive wildcards are fine). Worked around by projection; reported,
   not masked.
2. A body literal over a predicate with no facts and no rules HANGS the server
   past the 30s EvalLimits deadline.
3. A fully-ground body literal in a multi-literal rule trips E-PLAN-003 after
   planner reordering (ground leg placed first, next leg "shares no binding").
4. `executeDatalog`'s "first rule head" includes ground FACTS — the target
   rule must be hoisted above all facts.

## Ledger

`run-migration/` runs on the VENDORED v0 engine: `boot.rofl` → `audit.rofl`
(audit-v0.2, corpus rev `6dfa003` — verified to load clean on the main-rev
engine) → `rounds/round-*.rofl` sorted. Round-001 pre-registers expectations
(committed BEFORE the first harness run); round-002+ add `evidence[world]` +
`found[m]` per claim. `record-round.ts` ARCHIVES the exact report bytes at
`rounds/round-NNN.report.json` and records the sha256 over that archive, so
`evidence[world]` always verifies against persisted bytes; re-recording an
existing round is refused (assert-only — a post-record change must produce a
NEW round). `ledger.ts audit` gates on
groundless/vocab_drift/malformed/breach/unstratified/unmoded; `leak[audit]`
prints non-gated (documented: audit-v0.2 reads perspectives a/b/world without
`imports` declarations — corpus precedent does not gate leak either).
