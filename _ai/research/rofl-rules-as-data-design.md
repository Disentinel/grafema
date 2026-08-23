# ROFL rules-as-data on RFDB — design of record

Status: design of record for the rules-as-data lane. Synthesis round, read-only on `packages/`.
Tree: `rofl-v1`, HEAD `aeac10e0` at the time of writing.
Supersedes: the two premise-designs and the three critiques that fed this round (none of which
were committed as files; their surviving claims are restated here with fresh evidence and their
refuted claims are named as refuted).

Every claim below is either (a) a `file:line` read at HEAD `aeac10e0`, (b) a shell command with
its output inlined, (c) a named test/scenario, or (d) marked NOT VERIFIED in §10.

---

## 1. Verdict and chosen spine

**Neither premise won. The design of record is a third shape.**

Premise A ("port the v0 reflection vocabulary wholesale into RFDB as a new fact family, gated
behind the fact-store read path") is right about the *representation* and wrong about the *size*
and the *gate*. Premise B was never written to disk; there is no artifact of it in the tree, so
this document asserts **no comparison against it** and claims no ideas grafted from it. Recording
that plainly is the point — the previous rounds of this migration retracted claims made from
remembered rather than read artifacts.

What the evidence forced:

**(i) The vocabulary splits cleanly into two projections, and only one of them is hard.**
`packages/rofl-conformance/vendor/rofl-v0/src/reflect.ts:148-181` (`encodeRule`) emits exactly
these relations for a clause: `rule/1`, `has_conclusion/2`, `conclusion_lit/3`, `concludes/2`,
`writes_to/2`, `has_premise/2`, `premise_lit/3`, `premise_pos/2`, `premise_neg/2`,
`uses_builtin/2`, `reads_from/2`, `bridge_decl/3`. Of these, **only `conclusion_lit/3` and
`premise_lit/3` carry a reified term** (`reifyLit` / `reifyBodyElem`). Every other relation's
arguments are atoms and small integers. RFDB's `Term` today is
`packages/rfdb-server/src/datalog/types.rs:7-18` — `Var | Const | Lit(Value) | Wildcard`, no
compound form — so the flat projection is expressible in the existing dialect *unchanged*, and
only the term-carrying projection needs new representation. Premise A treated the vocabulary as
one indivisible block; it is not.

**(ii) The gate Premise A proposed does not exist and is not on the critical path.** The critique
that the derive↔fact-store read path is absent is CONFIRMED: `StorageView`
(`packages/rfdb-server/src/derive/storage_glue.rs:305`, `pub(crate) trait StorageView: Sync`) has
eleven methods and every one of them is node/edge-shaped — `generation`, `sorted_run`,
`scan_nodes_by_type`, `scan_edges_by_type`, `edges_from`, `edges_to`, `get_node`,
`nodes_by_attr`, `edge_metadata`, `node_metadata`, `scan_edge_metadata_by_type`. There is no
generic arity-n relation read. `SegmentType` is a closed two-variant enum
(`packages/rfdb-server/src/storage_v2/types.rs:84-87`, `Nodes = 0, Edges = 1`). And `derive/`
imports `crate::facts` in exactly four places, all of them `SortOrder`:

```
$ grep -rn "crate::facts" packages/rfdb-server/src/derive/
src/derive/catalog.rs:28:use crate::facts::SortOrder;
src/derive/plan.rs:2006:        use crate::facts::SortOrder;
src/derive/exec.rs:82:    use crate::facts::SortOrder;
src/derive/exec.rs:6573:        use crate::facts::SortOrder;
```

But the rules-as-data lane does **not** need that read path. Reflection facts are *ground facts
of the program under evaluation*, and ground facts in program text are already first-class EDB in
the derive dialect. The lane can be built entirely inside `derive/` with zero `facts/` coupling,
and *should* be, so that the fact-store read path stays an independent, separately-sequenced
piece of work.

**(iii) The closure arithmetic Premise A rested on is wrong, and provably so.** The translator's
phase order is fixed and documented at `packages/rofl-conformance/src/translate.ts:148-200`:
phase 1 reflection vocabulary → phase 2 perspectives → phase 3 temporal → phase 4 compound terms
→ phase 5 bignum → phase 6 builtins → phase 7 int/string constants. **First blocker wins.** So a
`missing:rules-as-data` verdict means only "phase 1 fired first", never "phase 1 is the only
blocker". Profiling the actual fixture programs with the vendored parser (script
`/tmp/synth/profile.ts`, output inlined in §6) shows `counter.rofl`, `tm.rofl` and
`tm_diverge.rofl` contain **no reflection vocabulary at all** — their `missing:rules-as-data`
verdicts come from the scenario preloading `boot.rofl`, and their real blockers are temporal ticks
and compound terms. Closing rules-as-data flips **two** of the eighteen, not eighteen. §6 gives
the per-case derivation.

**(iv) Rule identity is a two-site invariant, and both sites are live.** `parse_ext_program` has
six production call sites (all others are `#[cfg(test)]`; `plan_golden` is gated at
`packages/rfdb-server/src/derive/mod.rs:60-61`):

| # | site | function |
|---|------|----------|
| 1 | `derive/mod.rs:235` | `evaluate_with_materialize_shared` — THE eval entry (I8) |
| 2 | `graph/engine_v2.rs:785` | `maintain_derive` |
| 3 | `graph/engine_v2.rs:830` | `explain_datalog_fact` |
| 4 | `graph/engine_v2.rs:861` | `explain_datalog_gap` |
| 5 | `graph/engine_v2.rs:936` | `eval_derive_maintain_writeback` |
| 6 | `graph/engine_v2.rs:967` | `eval_derive_materialize_cached` |

Any seam that lets the *store* contribute rules must be installed at all six, or
`explain_datalog_fact` / `explain_datalog_gap` (#3, #4) will explain under a rule set the
evaluator at #1 never used — a silently wrong `why`. And the program key is mirrored: it is
computed at `graph/engine_v2.rs:960-963` (`DefaultHasher` over `source`) and again in
`w8_program_key` at `graph/engine_v2.rs:6064-6069`, whose own doc comment says "must mirror
`eval_derive_materialize_cached` exactly". The W9 unchanged-graph short-circuit at
`graph/engine_v2.rs:1161-1167` (`prev_snapshot.version == cur_snapshot.version &&
Arc::ptr_eq(&prev_snapshot.tombstones, &cur_snapshot.tombstones)`) keys off the same cache entry.
Rule-set identity must enter all three or a store-side rule change will be laundered by the cache.

### Grafted from Premise A (kept, with its reasoning intact)

- The reflection vocabulary is **carried as ordinary ground facts of the program**, not as a
  side-channel Rust structure. This is what makes `concludes(R, path)` queryable at all, and it is
  the only shape that satisfies p3-runtime-rule.
- **Decode is a second producer, not a fork of the evaluator.** Rules reach the fixpoint through
  one path (a program), whether they were written as text or asserted as facts. A. was right that
  forking `Executor::evaluate` into a "rules from store" variant is how you get `why` to disagree
  with the answers.
- Rule identity is content-addressed over a canonical clause rendering, mirroring v0's
  `ruleIdOf` = `'r' + fnv1a(canonClause(c))` (`reflect.ts:134-136`). RFDB already has a
  variable-rename-invariant rule hash it stamps on materialized edges
  (`derive/exec.rs:280-282`, `rule_ast_hash`), so the identity notion exists and does not need
  inventing — only a stable 8-hex surface rendering (see §5).

### Refuted, and removed

- ~~"18 of 25 REDs are behind this lane"~~ — refuted by the phase order at `translate.ts:148-200`
  plus the fixture profile in §6. The correct number for this lane alone is **2**.
- ~~"the lane is gated on the derive↔fact-store read path"~~ — refuted by (ii). It is not, and
  coupling them would serialize two independent pieces of work.
- ~~"`is` arithmetic is a separate, later concern"~~ — refuted: `boot.rofl:20` is
  `stratum(Rel, N) :- dep_neg(Rel, Q), stratum(Q, M), N is M + 1.` The boot program *itself*
  needs `is`. Every scenario that loads boot needs it. It is a co-requisite, not a follow-on.
- ~~"`parse_ext_program` has one seam"~~ — refuted by the six-site table in (iv).

---

## 2. The encoding: rules as facts, in two projections

### 2.1 Projection F (flat) — expressible in today's dialect

Ten relations, all arguments atoms or small integers, all derivable from a parsed `ExtProgram`
with no new `Term` variant:

```
rule(R)                    has_conclusion(R, 1)       concludes(R, Rel)
writes_to(R, P)            has_premise(R, K)          premise_pos(R, Rel)
premise_neg(R, Rel)        uses_builtin(R, Op)        reads_from(R, P)
bridge_decl(R, P, Q)
```

`R` is the content-addressed rule id (§5). `K` is the 1-based premise ordinal. `P`/`Q` are
perspective atoms — in a perspective-less RFDB they are all the constant `main`, which is exactly
what `perspAudit` degenerates to when a literal carries no explicit perspective
(`reflect.ts:143-145`: non-atom perspective → `$any`; the atom case passes through).

Projection F is what `boot.rofl`'s stratum-0 block actually consumes:
`rule_known/1`, `dep/2`, `dep_neg/2`, `reach/2`, `unstratified/1`, `stratum/2` are all defined
purely over `has_conclusion`, `concludes`, `premise_pos`, `premise_neg`, `edb`
(`run-migration/boot.rofl:4-21`). No reified term appears above the negation line.

### 2.2 Projection T (term-carrying) — needs a representation decision

Two relations: `conclusion_lit(R, 1, Term)` and `premise_lit(R, K, Term)`, where `Term` is the
v0 reification: `$lit(rel, persp, $cons(...))`, `$not(...)`, `$builtin(op, $cons(...))`
(`reflect.ts:81-114`).

**This is already supported at the value level, and both premise-designs missed it.** RFDB
distinguishes two different things that the conformance report's single code
`missing:compound-terms` collapses:

- **Syntactic** compound terms — writing `app(cons(H,T), Ys, cons(H,Zs))` in a rule and unifying
  *into* it. `Term` at `packages/rfdb-server/src/datalog/types.rs:7-18` is
  `Var | Const | Lit(Value) | Wildcard`; there is no functor form and no text parser for one
  (`derive/canon.rs:348-358` constructs `Value::Term` but that is the property-test generator
  `random_canonical`, not a parser). **Genuinely missing.**
- **Value-level** compound terms — a *ground* structured value carried as data. This exists:
  `packages/rfdb-server/src/datalog/eval.rs:59-61` is
  `Term(Arc<TermBlob>)`, whose own doc comment reads "ROFL term (§2.7): functor + args,
  recursive. **Rules-as-data and reified structures live here as values**; canonical when every
  nested arg is canonical (V4)." It is constructed through the validating
  `TermBlob::new` (`derive/canon.rs:242-260`), has injective canonical bytes
  (`derive/canon.rs:69-72`), and renders on the wire as its canonical text `functor(a1,…,an)`
  (`packages/rfdb-server/src/bin/rfdb_server.rs:3212-3219`).

**Decision: Projection T is carried as `Value::Term`, not as an opaque string.** Grounds:
(a) it is the representation the codebase already declares for exactly this purpose, in those
words, so choosing anything else creates a second identity for the same concept — the drift class
this migration keeps finding; (b) it is canonical and hashable, so it participates in
`canonical_state_sha` (§9.1 of the fact model) without a special case; (c) the wire rendering
`$fact(path,main,…)` is what p2-derived-by's `bindings['F'].includes('path')` and p4-forged's
`/\$fact\(reading,s1/` actually assert against.

**The cost, stated:** the *parser* still cannot produce a `Value::Term`, so the encoder must build
these blobs programmatically from the parsed `ExtProgram` (which it can — it has the clause in
hand). And a query cannot pattern-match inside a `Value::Term`, because that needs the syntactic
form. So `premise_lit(R, K, X)` binds `X` to a whole reified literal and you can compare it or
render it, but you cannot join through its arguments. Nothing in `boot.rofl` or in any tier-1
assertion does join through them — the only corpus reads of `premise_lit`/`conclusion_lit` are the
round-trip decode `unreifyLit` (`reflect.ts:81-98`) — so this discharges every measured demand and
leaves the syntactic-term lane (p1-functor-append, p4-tm, p4-tm-diverge) honestly separate.

### 2.3 What is NOT encoded here

`derived_by/3`, `in_perspective/2`, `asserted_by/2`, `hole/2`, `authority/2`, `reserved/1`,
`mode/2`, `edb/1` are **provenance and policy**, not rule structure. `derived_by`'s subject is a
whole ground fact reified as `$fact(rel, persp, $cons(...))` (`reflect.ts:112-114`), so it lands
in Projection T's representation class and inherits its limitation. `hole/2` is R-2 territory
(budget semantics) and is out of scope for this lane by construction. `authority`/`reserved`/
`mode`/`edb` are *asserted* by the boot layer, not produced by `encodeRule`, so they need only
the ordinary EDB path.

---

## 3. The read path: one seam, six sites, by construction

### 3.1 The seam is inside `parse_ext_program`, not at its call sites

§1(iv) established that a rule-source seam installed at call sites must be installed at all six or
`explain_datalog_fact` and `explain_datalog_gap` explain under rules the evaluator never used.
The design of record avoids that class of bug entirely by putting the seam **one level down**:
the reflection encoder runs inside `parse_ext_program`
(`packages/rfdb-server/src/derive/parser_ext.rs:863`), so every one of the six production
consumers inherits it with no change at any of them. The invariant is then structural, not a
convention six sites have to keep.

Shape: `parse_ext_program` produces the `ExtProgram` as it does today, then — if and only if the
program opted in (§3.2) — appends the Projection-F and Projection-T ground facts for each of its
own clauses to the program's fact set. From that point on nothing downstream can tell them from
facts the author typed. Stratification (`stratify`), planning (`plan_program_with_catalog`) and
the fixpoint (`Executor::evaluate`) are untouched.

### 3.2 Opt-in, because the blast radius of always-on is unacceptable

Always-on encoding would add ~10 facts per clause to **every** bundled rule-pack evaluation. Two
consequences, both measurable and both bad:

- `derive/plan_golden.rs` fingerprints one plan per (program, stats-profile, rule) over every
  bundled stdlib pack and compares against a golden generated at pre-P3 HEAD
  (`plan_golden.rs:1-26`; the golden is `src/derive/golden/p3_plan_fingerprints.txt`, recorded at
  40,816 lines in `run-migration/rounds/round-012.rofl`). New EDB relations change `FactStats`,
  which changes estimates, which moves plans. The gate would go red across the board and the only
  "fix" would be regenerating it — i.e. destroying the instrument.
- The pack-phase perf ceiling (round-012 records depends 4.912s / method_calls 8.765s /
  axum_routes 5.448s against a 1.10x ceiling) has no room for a per-clause fact multiplier.

So: **a program-level directive, `@reflect`, parsed by `parser_ext` into a flag on `ExtProgram`.**
Absent the directive the encoder does not run and not one byte of bundled-pack behaviour moves —
`plan_golden` stays bit-identical, which is the gate that proves it. The ROFL adapter emits
`@reflect` at the head of every program it loads; nothing else in the tree does.

This also solves cache identity for the text path for free: the directive is part of `source`, and
the program key at `graph/engine_v2.rs:960-963` is `DefaultHasher` over `source`, mirrored in
`w8_program_key` (`graph/engine_v2.rs:6064-6069`). A reflective and a non-reflective spelling of
the same rules are already different keys. No cache change is required *for programs whose rules
come only from text*. The runtime-assertion path is where identity genuinely moves — §5.

### 3.3 Stratification as data, and the `strataPlan()` contract

v0's engine does not contain a stratification checker: it READS `stratum/2` and `unstratified/1`
facts that `boot.rofl:17-21` derives (`vendor/rofl-v0/src/engine.ts:2-4`, and the reads at
`engine.ts:203` and `engine.ts:213`). RFDB stratifies internally in `derive/stratify.rs` and
exposes nothing.

The contract that matters is p2-noboot-null-plan (`src/scenarios.ts`, sourceRef
`test/phase2.test.ts:150`): with **no** boot loaded, `strataPlan()` must report
`level === null` for `isolated`. An adapter that surfaced RFDB's internal stratum would answer
`1` and fail. Therefore:

> `strataPlan()` reads levels from `stratum/2` FACTS in the evaluated fact set, and reports
> `level: null` for any relation with no such fact. It must NOT consult `stratify.rs`.

That is the whole of p2-noboot-null-plan, and it is why that case is genuinely in this lane
(§6): it is a statement about stratification being *data*, and it is falsifiable precisely
because the no-boot case has to come back null.

The converse — RFDB's internal stratification and `boot.rofl`'s derived `stratum/2` agreeing when
boot IS loaded — is p2-stratum-order, which additionally asserts
`iso.level === Math.max(...levels)`. That one needs boot to load at all, so it is blocked (§6).

### 3.4 The rejected alternative: adapter-side injection

The encoder is a pure function of a parsed program, so it could equally well run in the
TypeScript adapter, which would emit `concludes(r1a2b3c4d, path).` and friends as ordinary ground
facts into the program text it sends to `rfdb-server`. That variant needs **zero**
`packages/rfdb-server/` change, cannot perturb `plan_golden`, and closes the same cases. It was
seriously considered and is rejected as the design of record, for three stated reasons:

1. **It re-hashes the whole program on every assertion.** The program key is `DefaultHasher` over
   `source` (`graph/engine_v2.rs:960-963`). Injected reflection facts make `source` grow with the
   rule count, and every `assert` changes it, so the W8 durable pin and the W9 short-circuit never
   hit. In-engine encoding keeps `source` at the size the author wrote.
2. **It two-sources the vocabulary.** Write protection (§4.3) has to reject reserved heads
   somewhere; if the vocabulary also lives in the adapter, the same twenty names exist in two
   languages. That is precisely what the v0 kernel-grep contract exists to forbid
   (`vendor/rofl-v0/scripts/kernel_grep.ts:1-16`: "no relation name outside the documented kernel
   vocabulary may appear … The whitelist mirrors the vocabulary table in README.md").
3. **It puts rule truth outside the store.** The stop condition of this migration is ROFL
   invariants holding *on RFDB as the store*. p3-snapshot-roundtrip already requires
   `canonicalState()` to be bit-identical across two processes; state that lives in an adapter
   buffer is not state the store determines.

Recorded here rather than dropped, because if the in-engine seam turns out to cost a round, this
is the fallback and its three costs are already priced.

---

## 4. The write path: runtime rules, load atomicity, write protection

### 4.1 Runtime rule assertion lives in the adapter, not the engine

p3-runtime-rule (`test/phase3.test.ts:19`) asserts a *clause* at runtime —
`await r.assert('path(X, Y) :- edge(X, Y).')` — and then requires `path(a, c)` to hold and
`concludes(R, path)` to name two rule ids.

The design of record keeps the engine's "a program is a source string" invariant intact: **the
adapter owns the accumulated program text.** `assert` of a clause appends it to the adapter's
source buffer; the next evaluation re-parses the whole buffer. With `@reflect` on, the reflection
facts for the new clause appear automatically, so `concludes/2`, `rule/1` and `has_premise/2`
answer correctly without any engine-side notion of "a rule that arrived later".

This is deliberately not the more elegant "rules read from the store" architecture. Grounds:
(a) it needs no change at any of the six `parse_ext_program` sites and cannot desynchronise
`explain_*` from `evaluate`; (b) it needs no derive↔fact-store read path (§1(ii)); (c) the cache
key is `hash(source)` and the source changed, so W8/W9 invalidation is correct by construction
rather than by a new rule-set-identity component. The honest cost — a full re-derive per asserted
clause — is stated in §6 and is not on any measured tier-1 assertion's critical path.

### 4.2 Load atomicity

p2-unstrat-reject (`test/phase2.test.ts:161`) requires that after a rejected load,
`await r.holds('e(1)')` is `false` — the rejected program's ground facts must not leak. With the
adapter-owned buffer this is a two-line property: parse-and-validate the *candidate* buffer
(existing text + new text) first, and only replace the buffer on success. RFDB's own
abort-no-commit discipline at the eval entry (`graph/engine_v2.rs:681-684` documents
"A mid-run failure … returns the error BEFORE step 3, so nothing is committed") is the same
discipline one level down, so nothing conflicts.

### 4.3 Write protection

p3-write-protected (`test/phase3.test.ts:38`) requires `derived_by(X, r0, 0) :- anything(X).` to
be rejected with a diagnostic matching `/write-protected/`.

Engine-side and small: under `@reflect`, a clause whose head relation is in the reserved
vocabulary (the twenty names of `reflect.ts:11-33`, i.e. `V`, minus the two `IFACE` names
`stratum`/`unstratified`, which boot legitimately concludes into — `reflect.ts:37-39` says so
explicitly) is a parse-stage rejection with a stable code. Stable-code discipline is already the
house rule (I5, "every variant carrying a stable code", `derive/mod.rs:172-190` doc block), so
this is `E-REFL-001` alongside the existing `E-CAT-*` / `E-PLAN-*` / `E-BIND-*` families.

Note the ordering requirement: the check must fire at parse stage, *before* the binding gate
`BindingTable::from_program` (`derive/mod.rs:241-242`) and before stratification, because
p2-unstrat-reject's sibling assertion requires the load to fail with nothing committed.

---

## 5. Identity: rule ids, `why` surfaces, and the three cache sites

### 5.1 Rule id

v0: `ruleIdOf(c) = 'r' + fnv1a(canonClause(c))` — `reflect.ts:134-136`, over the canonical
rendering at `reflect.ts:120-133` which includes head relation, perspective, args, temporal, and
each body element with `not` / builtin spelled out. The observable surface is pinned by
p2-why-tree, which requires the first `why` line to match
`/^path\[main\]\(a,c\)\s+<= r[0-9a-f]{8} @tick 0$/` — so the id must render as `r` + **exactly 8
lowercase hex digits**.

RFDB already has a rule identity: `DerivationWitness.rule_ast_hash`
(`packages/rfdb-server/src/derive/exec.rs:279-287`), documented there as "the stable
whitespace/variable-rename-invariant hash (the same `_source` stamp a materialized edge carries)".

**Decision: keep RFDB's hash as the identity and define the ROFL surface id as its first 8 hex
digits, prefixed `r`.** Do NOT port FNV-1a. Grounds: the identity already exists and is already
load-bearing for materialized-edge provenance; introducing a second identity would create exactly
the drift class this migration keeps finding. The 8-hex truncation is a *rendering*, applied at
the adapter boundary, so nothing stored changes.

Collision honesty: 8 hex digits = 32 bits. Across a boot program of 21 clauses
(`/tmp/synth/profile.ts` output, §6) the birthday probability is negligible, but the truncation is
a rendering with a real collision domain and that is a fact about the surface, not about the
engine. It is recorded, not hidden. p3-malformed-sibling depends on two distinct rule ids for the
two `malformed` clauses and would be the first case to notice a collision.

### 5.2 `@tick 0`

RFDB has no temporal dimension (the translator's phase 3 rejects `@init`/`@next` as
`missing:temporal`, `translate.ts:129-131`). The `why` surface must still print `@tick 0`. That
is consistent — a timeless store is a store where every fact is at tick 0 — and it is what the
converter already asserts: every `Timeless` predicate in the converted store
(`/tmp/rofl-out-f1/rofl_manifest.json`, `"temporal": "Timeless"`). Printing `@tick 0` is honest
here and becomes a real value only when the temporal lane lands.

### 5.3 The three cache sites

Text-only rule sources need no cache change (§3.2). For completeness, the three sites that a
future store-sourced-rules design would have to touch together, so the next round does not have to
rediscover them:

1. `graph/engine_v2.rs:960-963` — the program key, `DefaultHasher` over `source`.
2. `graph/engine_v2.rs:6064-6069` — `w8_program_key`, whose doc comment states it "must mirror
   `eval_derive_materialize_cached` exactly"; it feeds the durable pin sidecar.
3. `graph/engine_v2.rs:1161-1167` — the W9 unchanged-graph short-circuit,
   `prev_snapshot.version == cur_snapshot.version && Arc::ptr_eq(&prev_snapshot.tombstones,
   &cur_snapshot.tombstones)`, which returns the previous evaluation *without* re-deriving.

Site 3 is the dangerous one: it keys on graph state only. If rules ever become store-resident,
a rule change with no node/edge change would take that short-circuit and return a stale
evaluation. The W8 lesson recorded in ruling R-2 (`run-migration/OWNER-RULINGS.md:55-63`,
cancel-as-convergence, 1726 lost edges) is exactly this failure shape. The adapter-owned-buffer
decision in §4.1 is chosen partly to keep that door shut.

---

## 6. What this plan closes

### 6.1 The baseline, measured

Read from the committed report, not re-run (the harness regenerates three tracked files):

```
$ python3 -c "import json,collections; d=json.load(open('packages/rofl-conformance/conformance-report.json')); \
  t1=d['tier1']; c=collections.Counter(r['verdict'] for r in t1); print(len(t1), c); \
  print(collections.Counter(r.get('reason_code') for r in t1 if r['verdict']=='RED'))"
30 Counter({'RED': 25, 'GREEN': 5})
Counter({'missing:rules-as-data': 18, 'dialect:untranslatable': 2, 'missing:compound-terms': 1,
         'missing:whynot-shape': 1, 'missing:perspectives': 1, 'missing:excise': 1, 'missing:holes': 1})
```

Run id `rofl-conformance-1787361952086`, timestamp `2026-08-22T01:25:52.086Z`
(`packages/rofl-conformance/conformance-run-meta.json`).

### 6.2 Why the "18" is not 18 — the phase order, and the fixture profile

`packages/rofl-conformance/src/translate.ts:148-200` runs its checks program-wide in a **fixed
phase order** and returns on the first hit: (1) reflection vocabulary → (2) perspectives →
(3) temporal → (4) compound terms → (5) bignum → (6) builtins → (7) int/string constants. Its own
header says so at `translate.ts:4-7`: "the reported code is deterministic … e.g. boot.rofl fails
at phase 1 with missing:rules-as-data even though it also contains [audit] perspectives."

So `missing:rules-as-data` means *"phase 1 fired first"*, never *"phase 1 is the only blocker"*.
Profiling the five fixture programs with the vendored parser (`/tmp/synth/profile.ts`, which
imports `parseProgram` from `src/neutral.ts` and `RESERVED`/`IFACE` from
`vendor/rofl-v0/src/reflect.ts`, and reports **all** phases rather than the first):

```
$ node --experimental-strip-types /tmp/synth/profile.ts
=== boot.rofl (21 clauses) ===
  P1 reflection-vocab : asserted_by, authority, bridge_decl, concludes, edb, has_conclusion,
                        has_premise, in_perspective, mode, premise_neg, premise_pos, reads_from,
                        reserved, stratum, unstratified, uses_builtin, writes_to
  P2 perspectives     : [audit]
  P3 temporal         : —
  P4 compound terms   : —
  P6 builtins         : is
  P7 int consts       : 0
=== examples/sensors.rofl (10 clauses) ===
  P1 reflection-vocab : authority
  P2 perspectives     : VAR, [s1], [s2], [s3], [trust], [verified]
  P3 temporal         : init
  P6 builtins         : !=, <=, >=, is
  P7 int consts       : 20, 21, 95
=== examples/counter.rofl (3 clauses) ===
  P1 reflection-vocab : —
  P2 perspectives     : —
  P3 temporal         : init, next
  P6 builtins         : <, is
  P7 int consts       : 1
=== examples/tm.rofl (15 clauses) ===
  P1 reflection-vocab : —
  P2 perspectives     : —
  P3 temporal         : init, next
  P4 compound terms   : cons/2, tape/3
  P6 builtins         : =
  P7 int consts       : 0, 1
=== examples/tm_diverge.rofl (10 clauses) ===
  (identical profile to tm.rofl)
```

Three consequences, none of which either premise-design accounted for:

- **`counter.rofl`, `tm.rofl` and `tm_diverge.rofl` contain no reflection vocabulary whatsoever.**
  Their `missing:rules-as-data` verdicts come entirely from the scenario preloading `BOOT`
  (`src/scenarios.ts`, e.g. p4-counter: `await r.load(BOOT)` then `await r.load(COUNTER)`).
  Their own blockers are temporal ticks and syntactic compound terms.
- **`boot.rofl` itself needs `[audit]` perspectives and `is` arithmetic.**
  `run-migration/boot.rofl:20` is `stratum(Rel, N) :- dep_neg(Rel, Q), stratum(Q, M), N is M + 1.`
  and lines 25-36 conclude into `malformed[audit]`, `breach[audit]`, `leak[audit]`,
  `forged[audit]`, `unmoded[audit]`. Fourteen of the eighteen cases load boot, so for those
  fourteen this lane is **necessary and not sufficient**.
- **The `is`/arith gap is bigger than the report's `dialect:untranslatable` label suggests.** The
  registered derive builtins (`packages/rfdb-server/src/derive/builtin.rs:1361-1561`) are
  `node, type, edge, incoming, attr, neq, gt, lt, gte, lte, starts_with, not_starts_with,
  string_contains, method_suffix, ends_with, concat, str_lower, basename, strip_quotes,
  strip_prefix, strip_suffix, last_segment, first_segment, replace_all, path_resolve, split,
  relative_import_resolve, edge_attr, node_attr`. There is no `is` and no `+ - * / mod`. v0's
  `evalArith` (`vendor/rofl-v0/src/unify.ts:96-113`) evaluates over **functor terms**
  (`t.k === 'f'`), so `is` is not independent of the syntactic-compound-term lane — it needs an
  arithmetic *expression* form in `Term`. The comparison half (`>=`, `<=`, `!=`) maps onto
  existing `gte`/`lte`/`neq` and is cheap; the `is` half is not.

Note on integer constants: `translate.ts` phase 7 rejects them as `dialect:untranslatable`, but
that is a **wire** limitation, not an engine one. The derive parser produces typed numeric
literals — `parser_ext.rs:1041-1054` asserts `Term::Lit(Value::Int(0))` for a bare `0` and
`Term::Lit(Value::Float(0.5))` for `0.5`, with the comment "NOT a string round-trip, NOT a node
id". The ambiguity is at `packages/rfdb-server/src/bin/rfdb_server.rs:3205-3210`
(`wire_string_to_value`: any string parsing as `u128` becomes `Value::Id`). So the fix is a wire
type tag, not an engine feature — and it is a prerequisite for anything that queries
`has_premise(R, 1)` (p3-runtime-rule) or compares `V = 20` (p4-sensors).

### 6.3 Closed by this lane

**One case, on the evidence.**

| id | why this lane closes it |
|----|------------------------|
| `p2-noboot-null-plan` | `test/phase2.test.ts:150`. Loads a plain program with **no boot**; asserts `strataPlan().find(p => p.rel === 'isolated').level === null`. Contains no reflection vocabulary, no perspective, no temporal, no compound term, no builtin, no int/string constant (all args are atoms). It is RED purely because RFDB's stratification is internal. §3.3's contract — `strataPlan()` reads `stratum/2` **facts** and returns `null` when there is none — closes it exactly, and the no-boot case is what makes the contract falsifiable. |

### 6.4 Ride-alongs: three more, adapter-only, zero `packages/rfdb-server/` change

These are not in the rules-as-data lane; they are independent and cheap, and they are listed here
so the round that builds the lane can take them without a second setup. Each touches only
`packages/rofl-conformance/src/adapter.ts` and its scenario is unchanged.

| id | current code | what closes it |
|----|--------------|----------------|
| `p1-tc-naive` | `dialect:untranslatable` | The program is the same `TC` transitive closure that `p1-tc-seminaive` already passes GREEN. The only blocker is the `mk({naive: true})` option. v0's two evaluation modes agree on fact sets (`vendor/rofl-v0/LIMITS.md:46-48`), and the identical re-point was already sanctioned for `p2-diff-positive` / `p2-diff-negation`, which are GREEN with the note "re-pointed per design: naive≡seminaive → v0≡RFDB". Same precedent, same justification, recorded in the scenario's `sourceRef`. |
| `p2-why-tree` | `missing:whynot-shape` | RFDB's witness **exists** — `DerivationWitness { rule_ast_hash: String, body: Vec<(String, Box<[Value]>)> }`, `derive/exec.rs:279-287`, reachable via `explain_datalog_fact` (`graph/engine_v2.rs:820`). The assertion wants `/^path\[main\]\(a,c\)\s+<= r[0-9a-f]{8} @tick 0$/` and `[axiom]` leaves. That is a **recursive client-side expansion** of the flat witness: render the head, `r` + first 8 hex of `rule_ast_hash` (§5.1), `@tick 0` (§5.2); for each body fact recurse; a body fact with no witness is an EDB axiom and prints `[axiom]`. No engine change. |
| `p4-excise-multi` | `missing:excise` | `sim_derive` (`graph/engine_v2.rs:592-645`) is overlay-**ADD** only: it builds a `FixtureStorageView` of hypothetical nodes/edges, wraps it in `OverlayStorageView::new(&base, delta)`, and answers `sim ∖ base`. There is no minus-one-fact counterpart. But the adapter owns the program text and its asserted EDB (§4.1), so `excise(f)` = evaluate the buffer, evaluate the buffer with `f` deleted, and diff the canonicalised fact sets — which is v0's own definition ("clean re-evaluation on EDB \\ {fact}; the diff IS the blast radius", `vendor/rofl-v0/src/api.ts:347-348`). The scenario's program is plain (`e1(a). e2(a). p:-e1. p:-e2. q:-p.`) and expects `removed: ['e1[main](a)']`, `added: []`. Adapter-side, sound, O(2) evaluations. |

**Projected tier-1 after this plan: GREEN 9 / 30** (5 today + `p2-noboot-null-plan` + the three
ride-alongs). Not 18. Stating the smaller number is the point of this section.

---

## NOT CLOSED BY THIS PLAN

Every remaining tier-1 RED, with the specific reason. None is dropped.

### From the eighteen `missing:rules-as-data`

| id | still needs (beyond this lane) |
|----|--------------------------------|
| `boot-load` | `[audit]` perspectives; `is` arithmetic (`boot.rofl:20`); typed integer on the wire (`0`). |
| `p2-stratum-order` | Everything `boot-load` needs (it loads `BOOT` first), then `stratum(isolated, N)` and `iso.level === Math.max(...levels)`. |
| `p2-unstrat-reject` | `boot-load`'s set, plus a diagnostic naming `unstratified[main](p)` and `dep_neg`, plus the §4.2 load-atomicity property. |
| `p2-derived-by` | **Per-derivation provenance emission.** `derived_by/3` is not rule structure (§2.3) — it is one fact per (derived fact × supporting rule), which v0 writes during evaluation (`vendor/rofl-v0/src/engine.ts:304`, `:429`). RFDB's `Evaluation` (`derive/exec.rs:246-249`) is `predicate → ground tuples` with no provenance, and `DerivationWitness` is computed on demand for one fact. The scenario also asserts `supportCount('path[main](a,b)') === 2`, i.e. **all** supporting rules, not the first witness. That is a separate engine lane. |
| `p3-kernel-grep` | **A scope ruling** (§8, R-req-1). The v0 contract forbids any appendix-program relation name from appearing as a code identifier in kernel source (`scripts/kernel_grep.ts:52-57` forbids `dep, reach, flow, step, move, temp, close, …`). Ported literally to `packages/rfdb-server/src/`, those eight names alone hit 828 times: `$ for n in delta reach flow step move dep temp close; do grep -rw "$n" src/ --include=*.rs \| wc -l; done` → `461 81 19 63 67 52 56 31`. The contract needs a defensible scope before it can be met. |
| `p3-runtime-rule` | `boot-load`'s set, plus the typed-integer wire fix (`has_premise(${id}, 1)` is queried with a literal `1`). §4.1 supplies the runtime-assertion mechanics but not these. |
| `p3-write-protected` | `boot-load`'s set. §4.3 supplies the rejection itself. |
| `p3-breach` | `boot-load`'s set, plus querying a non-`main` perspective (`breach[audit](R)`). |
| `p3-malformed-sibling` | `boot-load`'s set, plus **retract** of a specific fact, plus `[audit]` queries, plus the `why`-tree shape (the `p2-why-tree` ride-along renderer is a prerequisite, not a substitute — this one asserts the *sibling* rule id on the first line). |
| `p3-snapshot-roundtrip` | `boot-load`'s set **and all of `sensors.rofl`**: five named perspectives, a perspective **variable**, `@init` temporal, `is`/`<=`/`>=`/`!=`, integer constants — plus `save()`/`canonicalState()` and cross-process bit identity. |
| `p4-counter` | `boot-load`'s set, plus **temporal ticks** (`@init`/`@next`), `<` and `is`, and the `run({maxTicks, onBoundary})` tick loop with quiescence/partial reporting. |
| `p4-replay` | `boot-load`'s set + `sensors.rofl`'s set, plus `assertClauses` order-independence and `canonicalState()` stability over 100 shuffles. |
| `p4-tm` | `boot-load`'s set, plus **temporal ticks** and **syntactic compound terms** (`cons/2`, `tape/3` — unified into, not merely carried), plus `=`, plus the tick loop. |
| `p4-tm-diverge` | Everything `p4-tm` needs, plus **holes** (ruling R-2: partial commit + `hole/2` on budget exhaustion, against today's abort-no-commit at `graph/engine_v2.rs:681-684`), plus a queryable `derived_by` trace of `$fact(cfg…)`. |
| `p4-boot-audits` | `boot-load`'s set, plus `[audit]` queries and a **`whynot` tree** demonstration through `dep_neg`/`reach` under 20 lines. |
| `p4-sensors` | `boot-load`'s set + `sensors.rofl`'s set, plus **excise with a non-trivial blast radius** (`added` is non-empty here, unlike the `p4-excise-multi` ride-along), plus `why`/`whynot` trees with finite-failure text. |
| `p4-forged` | `boot-load`'s set + `sensors.rofl`'s set, plus **author-attributed assertion** (`assert(..., { who: 'mallory' })` → `asserted_by/2`) and the `$fact(reading,s1…)` rendering. |

### From the seven other REDs

| id | code | reason it stays open |
|----|------|----------------------|
| `p1-arith` | `dialect:untranslatable` | No `is` and no `+ - * / mod` in the builtin registry (`derive/builtin.rs:1361-1561`); v0's `evalArith` works over functor terms (`unify.ts:96-113`), so this needs an arithmetic expression form in `Term`, not just a builtin. Also needs `X >= 10` / `Y <= -7` with typed integers on the wire. |
| `p1-functor-append` | `missing:compound-terms` | Needs the **syntactic** term form and unification into it (§2.2). `Value::Term` does not help: the assertion unifies `app(cons(H,T), Ys, cons(H,Zs))`. |
| `p2-persp-isolation` | `missing:perspectives` | RFDB has no perspective dimension. Independent lane; the fact model's perspective column exists in the converted store (`/tmp/rofl-out-f1/rofl_manifest.json` `perspectives`), the *evaluator* has none. |
| `p4-budget-hole` | `missing:holes` | Ruling R-2 says holes win; today's engine aborts without committing (`graph/engine_v2.rs:681-684`). Also needs `is` (`M is K + 1`) and `<`. |
| `p1-tc-naive` | `dialect:untranslatable` | **Closed by ride-along §6.4.** |
| `p2-why-tree` | `missing:whynot-shape` | **Closed by ride-along §6.4.** |
| `p4-excise-multi` | `missing:excise` | **Closed by ride-along §6.4.** |

### The dependency graph this exposes

Ordered by how many of the 25 REDs sit behind each, from the tables above:

1. **`[audit]`/named perspectives in the evaluator** — behind 14 (every boot-loading case) + `p2-persp-isolation`.
2. **`is` arithmetic (with an expression term form)** — behind 14 (boot) + `p1-arith` + `p4-budget-hole`.
3. **Typed numerics on the wire** — behind boot and every `sensors`/`counter`/`tm` case.
4. **Temporal ticks** — behind 5 (`p4-counter`, `p4-tm`, `p4-tm-diverge`, `p3-snapshot-roundtrip`, `p4-replay`) + `p4-sensors`.
5. **Syntactic compound terms** — behind 3 (`p1-functor-append`, `p4-tm`, `p4-tm-diverge`).
6. **Rules-as-data (this lane)** — behind 18 as a *necessary* condition, sufficient for 1.

Rules-as-data is the widest necessary condition and the narrowest sufficient one. That is a
reason to build it early, not a reason to expect it to move the verdict count.

---

## 7. Staging and order of work

Each stage is one workflow, each has its own mechanical gate, and each is verifiable without the
next. No stage is "diminishing returns" — they are bounded and pattern-mirroring, which is the
standard this project applies.

**S1 — the encoder (pure function, no wiring).**
`encode_reflection(&ExtProgram) -> Vec<GroundFact>` producing Projection F (§2.1) and Projection T
as `Value::Term` (§2.2). Rule id from `rule_ast_hash` (`derive/materialize.rs:578`; BLAKE3
rendered as hex, variable-rename-invariant per its doc at `:571-577`).
Gate: unit tests asserting the exact fact set for `boot.rofl`'s 21 clauses against v0's
`encodeRule` output, name by name.

**S2 — the `@reflect` directive and the `parse_ext_program` seam** (§3.1, §3.2).
Gate, non-negotiable: `src/derive/golden/p3_plan_fingerprints.txt` must stay **bit-identical**
(`git status --short` on `src/derive/golden/` EMPTY, the same check round-012 ran), proving the
bundled packs did not move. Plus the six-call-site invariant is structural, so the test is that
`explain_datalog_fact` on a `@reflect` program explains under the same rule set `evaluate` used.

**S3 — write protection and load atomicity** (§4.2, §4.3): `E-REFL-001` at parse stage, before
`BindingTable::from_program` (`derive/mod.rs:241-242`).
Gate: `p3-write-protected`'s diagnostic shape, and a unit test that a rejected program leaves no
facts visible.

**S4 — the adapter: `strataPlan()` from `stratum/2` facts** (§3.3).
Gate: `p2-noboot-null-plan` flips GREEN. This is the one verdict this lane moves, so it is the
lane's honest acceptance criterion.

**S5 — the three ride-alongs** (§6.4), independent of S1-S4 and parallelisable with them.
Gate: `p1-tc-naive`, `p2-why-tree`, `p4-excise-multi` flip GREEN; tier-1 reaches 9/30.

**Not in this plan, ordered by leverage** (from §6's dependency graph): perspectives (14) → `is`
arithmetic with an expression term form (14) → typed numerics on the wire (14) → temporal ticks
(6) → syntactic compound terms (3) → derivation provenance (1) → holes (2) → retract (1) →
author-attributed assert (1).

---

## 8. Rulings requested

Three. Each is stated with a recommended answer so it can be ratified rather than re-derived, in
the style of `run-migration/OWNER-RULINGS.md`. The delegation of 2026-08-22 ("shortest sound path
to a working ROFL environment on RFDB") covers ordinary judgment calls; these three are requested
because each changes a *contract*, not an implementation.

**R-req-1 — the kernel-grep contract's scope for RFDB.**
The v0 contract (`vendor/rofl-v0/scripts/kernel_grep.ts:1-16, 52-57`) forbids any appendix-program
relation name from appearing as a code identifier anywhere in kernel source. Ported literally to
`packages/rfdb-server/src/` it reports 828 hits for eight names alone (§6, NOT CLOSED table).
*Recommended:* scope "the kernel" to the ROFL reflection vocabulary's **single defining module**
plus the encoder, and restate the contract as "no ROFL relation name appears as a string literal
outside that module" — dropping the identifier half, which was meaningful for a 2,000-line
TypeScript kernel and is meaningless for a 100k-line polyglot engine. Record the weakening
explicitly; do not quietly pass a weaker test under the old name.

**R-req-2 — typed numerics on the wire.**
`wire_string_to_value` (`packages/rfdb-server/src/bin/rfdb_server.rs:3205-3210`) types any string
that parses as `u128` as `Value::Id`, so an integer constant cannot survive a round trip. The
engine already has typed numeric literals (`parser_ext.rs:1041-1054`). This blocks `boot.rofl`,
`counter.rofl`, `sensors.rofl`, `tm.rofl` and `p3-runtime-rule`, and it is the item MEMORY.md has
carried as "numeric-literals ⚠ Value-representation decision" since the Datalog-v2 rounds.
*Recommended:* add an explicit type tag to the wire representation rather than widen the
heuristic. It is a protocol change with existing clients (MCP, orchestrator, JS analyzers), which
is exactly why it wants a ruling and not a judgment call.

**R-req-3 — where perspectives live.**
Fourteen of the eighteen cases need `[audit]`. Two shapes: (a) a real perspective dimension in the
evaluator, matching the converted store which already carries a perspective column
(`/tmp/rofl-out-f1/rofl_manifest.json`, `perspectives` + `perspective_ruling`); or (b) adapter-side
emulation by name-mangling `rel[p]` into `rel__p`. (b) is days and (a) is weeks, but (b) breaks
`p2-persp-isolation`'s actual semantics — the point of that case is that `secret[vault]` must be
*invisible* to a rule reading `secret[open]`, which mangling gives only by accident and loses the
moment a perspective **variable** appears (`sensors.rofl` has one: profile line `P2: VAR`).
*Recommended:* (a). Record (b) as rejected with this reason, so it is not rediscovered as a
shortcut later.

---

## 9. NM6 / divergence X1 — the id↔sid skew of 32 is NOT a converter defect

Ruling R-11 (`run-migration/OWNER-RULINGS.md:202-210`) binds this round to produce the explicit
subjects and a stated cause, and says plainly: "If the cause turns out to be a converter lossiness
class rather than a property of the base, that is a stage-1 defect and comes back as a repair
round."

**It is not a converter defect. It is a property of the base, produced by an upstream
id-minting / sid-synthesis mismatch that predates the converter by many months.**

### 9.1 What the number actually is

It is not a symmetric difference between two subject sets, despite being written as one in
`round-012-pre.rofl:284` ("distinct sids 503,372 < distinct ids 503,404 proves id≠BLAKE3(sid)
somewhere") and carried forward in R-11 as "503,372 id-metadata subjects vs 503,404 sid subjects".
The subject symmetric difference is **0**. The 32 is a **value-multiplicity surplus on the sid
side**: 503,404 distinct node ids carry sid values that collapse onto 503,372 distinct strings,
because 21 sid strings are each shared by 2-4 entities — 53 ids in total, and Σ(k−1) over those
21 groups is exactly 32.

Live, from the converted store's own catalog:

```
$ python3 -c "import json; m=json.load(open('/tmp/rofl-out-f1/rofl_manifest.json')); \
  [print(p['name'], p['columns'], p['cardinality'], 'live_facts', p['live_facts'], \
   'live_asserts', p['live_asserts'], 'reverse', p['reverse']) \
   for p in m['catalog'] if p['name'] in ('sid','type')]"
sid  ['entity', 'sid']  Functional  live_facts 503404  live_asserts 503443  reverse [1, 0]
type ['entity', 'type'] Functional  live_facts 503443  live_asserts 503443  reverse None
```

`sid` is `Functional` with `reverse: [1, 0]` — i.e. the store already materialises a
sid → entity reverse run. That reverse run is where the collapse becomes observable, and it is
why R-11 correctly refused to let `node_view` land before this was answered.

(The 503,443 − 503,404 = 39 gap on `live_asserts` is a different, already-explained thing: the 39
functional conflicts of ruling R-1a. It is not the 32.)

### 9.2 The cause, from code at HEAD

Two sites, neither in `facts/convert/`:

1. `packages/rfdb-server/src/graph/engine_v2.rs:102-104` — `node_v1_to_v2`:
   ```rust
   let semantic_id = v1.semantic_id.clone()
       .unwrap_or_else(|| format!("{}:{}@{}", node_type, name, file));
   ```
   When a client does not supply a `semanticId`, the server synthesises one from
   `(node_type, name, file)` **only**. Node metadata is not part of it.

2. `plugins/type-inference.mjs:569-582` — the builtin-method minting path:
   ```js
   methodId = `builtin::${className}::${methodName}`;
   await client.addNodes([{ id: methodId, type: 'METHOD', name: methodName,
     file: '<builtin>', exported: true,
     metadata: JSON.stringify({ _source: 'type-inference', builtin: true,
                                kind: 'method', parentClass: className }) }]);
   ```
   The **id** carries `className`; the payload carries `parentClass` in metadata; and it sends no
   `semanticId`.

Compose the two and the collapse is forced: two builtin methods of the same name on different
classes get **different ids** (the class is in the id string) and the **same synthesised sid**
`METHOD:<name>@<builtin>` (the class is only in metadata, which the synthesis drops). Every
same-named builtin method across two or more classes contributes one to the surplus.

The premise-phase enumeration of this round matched that prediction exactly: all 53 ids in the 21
collapsed groups are `type = METHOD`, `file = <builtin>`, `metadata._source = type-inference`,
differing only in `metadata.parentClass`; `id == BLAKE3("builtin::<parentClass>::<name>")[0..16]`
LE held for 53/53 and `id == BLAKE3(semantic_id)` for 0/53. That measurement is flagged in §10 as
not re-run after this session's compaction, with its reproduction command.

The converter reads `semantic_id` as it finds it. It neither creates nor merges these. Round-012's
own X1 note already reached the boundary of this conclusion — "they agree on sid, so the skew
lives elsewhere in the base. NOT MEASURED: where" (`run-migration/rounds/round-012.rofl:206-210`)
— and this section supplies the "where". **No stage-1 repair round is owed.**

### 9.3 What this binds for stage 2

- **`node_view` keyed on the entity id `E` is safe and loses nothing.** The skew is entirely on
  the sid side; every entity keeps its own id-keyed row.
- **The sid reverse direction must be typed `sid -> Set<Id>`, never `Option<Id>`.** A
  first-match-wins reverse probe would silently drop 32 entities and every edge incident on them.
  This must be enforced by a mechanical uniformity gate at the point the reverse run is exposed —
  in the same style as the existing `E-BIND-001/002` per-predicate uniformity gate
  (`derive/mod.rs:236-242`), not by a comment.
- **Any sid registry or sid-keyed probe promised for stage 2 inherits this.** `sid` being declared
  `Functional` in the catalog is a statement about the *forward* direction (one sid per entity);
  it says nothing about the reverse, and the manifest's own `reverse: [1, 0]` is not a uniqueness
  claim.
- The upstream fix — having `type-inference.mjs` send an explicit `semanticId` that includes
  `parentClass` — is a real fix but it is a **base-data change** with a re-analysis cost, and it
  is out of scope for this lane. Recorded so it is not lost.

---

## 10. What I could not verify

Non-negotiable section. Every earlier round of this migration that skipped it later had to retract
something.

1. **The 53 ids / 21 sid strings / Σ(k−1)=32 enumeration was measured in this round's premise
   phase and NOT re-run after this session's context compaction.** §9.2's *mechanism* is verified
   from code at HEAD (`graph/engine_v2.rs:102-104`, `plugins/type-inference.mjs:569-582`) and
   §9.1's *totals* are verified live from `/tmp/rofl-out-f1/rofl_manifest.json`, but the
   group-by-sid enumeration is carried forward from the premise phase. To reproduce: enumerate the
   `sid` predicate's forward run over the converted store, group by sid value, keep groups with
   |group| > 1, and assert Σ(|g|−1) == 32 and that every member has `type = METHOD`,
   `file = <builtin>`.
2. **I did not run the conformance harness.** Running it regenerates three tracked files
   (`conformance-report.json`, `conformance-run-meta.json`,
   `_ai/research/rofl-conformance-report.md`), and this round is read-only on the tree. Every
   tier-1 number in §6 is read from the committed report, run id
   `rofl-conformance-1787361952086`, `2026-08-22T01:25:52.086Z` — which is one day older than HEAD
   `aeac10e0`. If any commit since then changed the harness or the adapter, §6's baseline is
   stale. NOT CHECKED.
3. **No Rust was built or run.** Every `packages/rfdb-server/` claim is a read of source at HEAD
   `aeac10e0`. No claim here rests on a test I executed.
4. **The `plan_golden` blast-radius argument in §3.2 is reasoned, not measured.** The chain
   (new EDB relations → different `FactStats` → different estimates → different plans → moved
   fingerprints) follows from `plan_golden.rs:16-23`, but I did not implement always-on encoding
   and observe the golden move. It is stated as the reason for the opt-in design and as S2's gate;
   if it turns out fingerprints do NOT move, the opt-in is still right for the perf reason but the
   argument should be corrected.
5. **`Value::Term` does not survive a wire round-trip, and I did not test what that breaks.**
   The render side handles it (`bin/rfdb_server.rs:3212-3219`, "a `Term` as its canonical text
   `functor(a1,…,an)`") but the parse side has exactly two arms —
   `wire_string_to_value` at `:3205-3210` is `u128 → Id`, else `Str`. So a `Value::Term` sent to a
   client and echoed back returns as `Value::Str`. The tier-1 assertions that touch reified facts
   are string-containment checks (`bindings['F'].includes('path')`, `/\$fact\(reading,s1/`) so they
   would pass, but the asymmetry is real and unmeasured.
6. **I did not read `packages/rofl-conformance/src/adapter.ts` in full.** I established by grep
   that `kernelVocabularyCheck` is absent from it; I did not enumerate which of `strataPlan`,
   `supportCount`, `excise`, `canonicalState`, `save`, `retract`, `whynot` the adapter already
   implements. §6.4's "adapter-only" claims are about where the *change* belongs, not a claim that
   the surrounding method already exists.
7. **No Grafema graph query was used.** The `.grafema` snapshot's freshness against HEAD
   `aeac10e0` was not checked, so every structural claim here is grep/read-derived by design.
8. **Premise B does not exist on disk.** `find` over the tree for markdown newer than
   2026-08-22 12:00 returns only `run-migration/ROADMAP-RU.md`, `run-migration/OWNER-RULINGS.md`
   and `_ai/research/rofl-conformance-report.md`. §1 therefore asserts nothing about it, and
   `grafted_from_loser` for it is empty rather than guessed.
