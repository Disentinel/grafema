# R13 — Adversarial soundness critique of `_ai/research/rofl-rules-as-data-design.md`

**Target:** `/home/dev/grafema-rofl/_ai/research/rofl-rules-as-data-design.md` (796 lines, commit `fad06052`)
**Reviewer mandate:** default to finding it flawed; a flaw without a `file:line` or a command output is an opinion, not a finding.
**Verdict: UNSOUND.** Three of its load-bearing claims are refuted by re-running its own tooling against its own sources, and one acceptance-critical axis (does reflection enter the canonical hash / rule identity) is never answered.

Everything below carries either a `file:line` read at the current working tree or a shell command with its output inlined.

---

## 0. Summary table

| # | Finding | Class |
|---|---------|-------|
| F1 | §1 says this lane closes **2** REDs; §6/§7 say **1**; the commit message says "corrected 18 → 1". §1 was never updated. | FATAL — internal contradiction on the headline number |
| F2 | My independent re-derivation gives **0**, not 1 or 2. `p2-noboot-null-plan`'s RED is an **adapter throw**, and the adapter already has everything needed to satisfy it with zero `packages/rfdb-server/` change. §7 S4's "honest acceptance criterion" does not gate the lane it claims to gate. | FATAL — the plan has no gate |
| F3 | The doc's §6.2 profiler covers phases 1,2,3,4,6,7. `translate.ts` has **10** phases. Phase 9 emits `missing:demand-mode` and fires on 4 of `boot.rofl`'s 21 clauses. The doc commits the exact error it convicts the previous round of. | FATAL — understates the work on all 14 boot-loading cases |
| F4 | §2.1's "`P`/`Q` … are all the constant `main`" is refuted by v0's real `encodeRule`: boot emits 6 `bridge_decl` facts and `writes_to(R, audit)`. Collapsing to `main` emits **zero** `bridge_decl` and voids boot's own audit layer — and makes §7 S1's own gate unsatisfiable. | FATAL — encoding contradicts its own acceptance gate |
| F5 | §2.2 mis-specifies the reified term (3 args, no temporal; real shape is 4 args) and cites the un-reification functions. | SEVERE — the S1 spec is wrong as written |
| F6 | `Value::Term` cannot represent v0's atom/string distinction without an unstated convention; §2.2's "discharges every measured demand" (incl. round-trip decode) is unsupported. | SEVERE |
| F7 | §2.2 ground (b) is wrong about `canonical_state_sha`; the doc never answers whether reflection facts enter the canonical hash or rule identity. | UNDERSPECIFIED on acceptance axis A3 |
| F8 | §9.1 inlines a shell output that does not reproduce (`reverse None` vs actual `reverse [1, 0]`). | Evidence defect (conclusion survives) |
| F9 | §6's "828 hits for eight names" — the per-name counts reproduce exactly but sum to **830**. | Evidence defect |
| F10 | §3.1 describes appending to "the program's fact set"; `ExtProgram` has no fact set. | Spec defect |
| F11 | "~10 facts per clause" — actual is **11.9**. | Evidence defect |
| F12 | Rule-identity divergence (`rule_ast_hash` is rename-invariant, v0's `ruleIdOf` is not) is never named. | UNDERSPECIFIED |
| F13 | §3.2's `plan_golden` blast-radius mechanism is misattributed (`FactStats` is per-predicate). Conclusion still holds. | Reasoning defect |
| F14 | All three §6.4 "ride-alongs" violate `adapter.ts:1-7`'s stated contract; the doc does not name the tension, and the precedent it cites is weaker than claimed. | Contract tension |

---

## 1. Re-verification of load-bearing evidence (attack axis 1)

### 1.1 Confirmed EXACT (the doc's genuine strengths)

Re-read at the current working tree, all match the doc verbatim:

- The six production `parse_ext_program` call sites and the `#[cfg(test)]` gating of `plan_golden` (`derive/mod.rs:60-61`, `derive/mod.rs:235`, `engine_v2.rs:785 / :830 / :861 / :936 / :967`).
- Every `engine_v2.rs` citation: `node_v1_to_v2` semantic-id synthesis `:102-104`; `sim_derive` `:592-645` (overlay-ADD only, `OverlayStorageView::new(&base, delta)`, `sim ∖ base`); abort-no-commit `:681-684`; program key `DefaultHasher` over `source` `:960-963`; W9 unchanged-graph short-circuit `:1161-1167`; `w8_program_key` `:6064-6069` with its "must mirror `eval_derive_materialize_cached` exactly" doc comment.
- `rule_ast_hash` at `derive/materialize.rs:578`, BLAKE3, `.to_hex().to_string()` (lowercase hex), rename-invariant per its own doc.
- `DerivationWitness { rule_ast_hash: String, …, body: Vec<(String, Box<[Value]>)> }` at `derive/exec.rs:279-287`.
- `Value::Term(Arc<TermBlob>)` at `datalog/eval.rs:59-61` with the doc comment the design quotes; `TermBlob::new` validating V1–V4 at `derive/canon.rs:241-259`; `random_canonical` at `:340-358` being the property-test generator, not a parser.
- `wire_string_to_value` `bin/rfdb_server.rs:3205-3210` (u128 → `Id`, else `Str`) and `datalog_value_to_wire_string` `:3212-3219`.
- `parser_ext.rs:1038-1055` — `bare_numeric_term_parses_to_a_typed_literal`, quoted exactly.
- The builtin registry list. Re-read at `derive/builtin.rs` — 29 builtins, matching the doc's enumeration **exactly**, with no `is` and no arithmetic. (Minor: the doc cites `builtin.rs:1361-1561`; `pub fn registry()` is at `:1358`.)
- v0 vendor citations: `engine.ts:2-4`, `:203`, `:213`, `derived_by` emission at `:304` and `:429`; `api.ts:347-348`; `LIMITS.md:46-48`; `kernel_grep.ts:1-16` and the `FORBIDDEN` list `:51-56`; `reflect.ts:148-181` (`encodeRule`) — all EXACT.
- `plugins/type-inference.mjs:569-582` — EXACT.
- The tier-1 baseline (30 scenarios / 25 RED / 5 GREEN / 18 `missing:rules-as-data`) and the §6.2 fixture profile output, which reproduces byte-for-byte from `/tmp/synth/profile.ts`.
- `packages/rfdb-server/src/derive/golden/p3_plan_fingerprints.txt` at 40,816 lines.

That is a large, honestly-gathered evidence base. The failures below are not sloppiness across the board; they are concentrated in exactly the three places where the document is making its own new argument.

### 1.2 F8 — an inlined shell output that does not reproduce (§9.1)

The doc prints:

```
sid  ['entity', 'sid']  Functional  live_facts 503404  live_asserts 503443  reverse [1, 0]
type ['entity', 'type'] Functional  live_facts 503443  live_asserts 503443  reverse None
```

Running the doc's command verbatim, unmodified, against the same unmodified file:

```
$ python3 -c "import json; m=json.load(open('/tmp/rofl-out-f1/rofl_manifest.json')); [print(p['name'], p['columns'], p['cardinality'], 'live_facts', p['live_facts'], 'live_asserts', p['live_asserts'], 'reverse', p['reverse']) for p in m['catalog'] if p['name'] in ('sid','type')]"
sid ['entity', 'sid'] Functional live_facts 503404 live_asserts 503443 reverse [1, 0]
type ['entity', 'type'] Functional live_facts 503443 live_asserts 503443 reverse [1, 0]
```

`type` has `reverse [1, 0]`, not `None`. This is a **transcription error, not staleness**: the manifest's mtime (`2026-08-23 10:12:32`) predates commit `fad06052` (`2026-08-23 12:40:49`), so the file has not changed since the doc was written. The `sid` line is exact and §9's conclusion (the 32 is a sid-side multiplicity surplus, not a converter defect) is unaffected — but this is precisely the kind of hand-copied "live output" the Evidence Rule exists to prevent, in a section whose whole purpose is to discharge ruling R-11.

### 1.3 F9 — arithmetic error in an evidence block (§6, `p3-kernel-grep`)

The doc: *"those eight names alone hit 828 times … → `461 81 19 63 67 52 56 31`"*.

```
$ cd packages/rfdb-server && for n in delta reach flow step move dep temp close; do printf "%s " "$(grep -rw "$n" src/ --include=*.rs | wc -l)"; done
461 81 19 63 67 52 56 31
$ python3 -c "print(sum([461,81,19,63,67,52,56,31]))"
830
```

Per-name counts reproduce exactly; the total is 830. Immaterial to the ruling request R-req-1, but it is a stated number that is wrong.

### 1.4 §10 item 2 — resolved, in the doc's favour on substance

The doc flags its tier-1 baseline as read from run `rofl-conformance-1787361952086` / `2026-08-22T01:25:52.086Z`, "NOT CHECKED" against HEAD. The working tree now has a regenerated run:

```
$ cat packages/rofl-conformance/conformance-run-meta.json
{ "run_id": "rofl-conformance-1787489578948", "timestamp": "2026-08-23T12:52:58.948Z" }
$ git diff --stat packages/rofl-conformance/conformance-report.json _ai/research/rofl-conformance-report.md
 _ai/research/rofl-conformance-report.md           | 4 ++--
 packages/rofl-conformance/conformance-report.json | 2 +-
```

The only field that moved in the JSON is `rfdb.gitSha` (`f08e5d53…` → `bc3db6c1…`). **No verdict, no reason code, no count changed.** §6's baseline is confirmed current. Item 2 closes.

---

## 2. F1 — the document contradicts itself on its own headline number

§1(iii), line 72:

> Closing rules-as-data flips **two** of the eighteen, not eighteen.

§1 "Refuted, and removed", line 116:

> The correct number for this lane alone is **2**.

But:

- line 500: **"One case, on the evidence."** (§6.3 heading, followed by a one-row table)
- line 518: "**Projected tier-1 after this plan: GREEN 9 / 30** (5 today + `p2-noboot-null-plan` + the three ride-alongs)" — 5 + 1 + 3 = 9, i.e. the lane contributes **one**
- line 570: "Rules-as-data (this lane) — behind 18 as a *necessary* condition, **sufficient for 1**."
- line 602: "Gate: `p2-noboot-null-plan` flips GREEN. This is **the one verdict this lane moves**."

And the commit message for `fad06052` itself reads *"lane's closed-RED count corrected 18 → 1"*.

So the correction from 18 was applied to §6 and §7 and **not** to §1. §1 is the section the reviewer/owner reads to ratify the plan, and it states a number the rest of the document refutes four times over. Given that the whole point of §1(iii) is to convict the previous round of getting a closure number wrong, this is not a typo — it is the same failure mode, uncaught, in the section that diagnoses it.

---

## 3. F2 — my independent re-derivation is **0**, and §7's acceptance criterion does not gate the lane

The task asked me to re-derive the number myself. I did, and I get a third answer.

`p2-noboot-null-plan` (`packages/rofl-conformance/src/scenarios.ts:262-274`) runs:

```
node(a). edge(a, a).
linked(X) :- edge(X, Y).
isolated(X) :- node(X), not linked(X).
```

and asserts `plan.find(p => p.rel === 'isolated')!.level === null`.

First: does this program even reach the engine? Yes — I called the real translator on it:

```
$ npx tsx /tmp/r13/direct.ts
CONTROL p2-noboot-null-plan prog        OK (translates)
```

So the RED does **not** come from `translate.ts`. It comes from the adapter:

```
packages/rofl-conformance/src/adapter.ts:293-296
  strataPlan(): { rule: string; rel: string; level: number | null }[] {
    throw new UnsupportedFeature('missing:rules-as-data',
      'v0 strata come from boot-derived stratum/2 + unstratified/1 FACTS (engine.ts:2-4, boot.rofl:17-21); RFDB stratification is internal, not queryable');
  }
```

Now: **this scenario loads no boot.** With no boot program, there are no `stratum/2` facts to read, so §3.3's contract ("`strataPlan()` reads `stratum/2` facts and returns `null` when there is none") degenerates to *"enumerate the program's relations and return `level: null` for each."* The adapter already has that enumeration in hand — `t.programRels` is computed by the translator and used at `adapter.ts:157`, `:274`, `:287`. v0's own return shape is `{ rule, rel, level: number | null }` (`vendor/rofl-v0/src/api.ts:447-449`), and the assertion only reads `.rel` and `.level`.

Therefore `p2-noboot-null-plan` is closable with an **adapter-only** change, zero `packages/rfdb-server/` diff, exercising **none** of S1 (the encoder), S2 (the `@reflect` seam), or S3 (write protection). By the doc's own §6.4 taxonomy — "adapter-only, zero `packages/rfdb-server/` change" — it belongs in the ride-along table, not in §6.3.

**Why this is fatal, not pedantic.** §7 S4 says:

> Gate: `p2-noboot-null-plan` flips GREEN. This is the one verdict this lane moves, so it is the lane's **honest acceptance criterion**.

An acceptance criterion that can be satisfied without touching a single line of the thing being accepted is not an acceptance criterion. The plan as written can be declared "done, gate green" with S1/S2/S3 unbuilt or built wrong. The lane's real closed-RED count against the tier-1 suite is **0**, and the document needs to say so and then justify the lane on its *necessary-condition* grounds (which it does have, at line 570-573) rather than on a gate that does not gate.

---

## 4. F3 — the doc omits an entire blocker class, committing the error it convicts the previous round of

§1(iii) is built on this characterisation:

> The translator's phase order is fixed and documented at `packages/rofl-conformance/src/translate.ts:148-200`: phase 1 reflection vocabulary → phase 2 perspectives → phase 3 temporal → phase 4 compound terms → phase 5 bignum → phase 6 builtins → phase 7 int/string constants. **First blocker wins.**

`translate.ts` does not stop at phase 7. Read at the current tree:

- `export function translate` — `:148`
- Phase 1 `:149`, Phase 2 `:157`, Phase 3 `:165`, Phase 4 `:171`, Phase 5 `:179`, Phase 6 `:189`
- **Phase 8 `:203`** (arity consistency)
- **Phase 9 `:214`** — head shape / range restriction / unsafe negation → reason code **`missing:demand-mode`**
- **Phase 10 `:252`** (body structure)

The doc's own §6.2 profiler (`/tmp/synth/profile.ts`, read in full) computes P1, P2, P3, P4, P6, P7 and nothing else. It literally cannot see phases 8, 9, 10 — and phase 9 is not a corner case.

I extended the profiler with `translate.ts`'s exact phase-9 predicates (including the real `isWildcard` at `:104-106`, `t.k === 'v' && t.name.startsWith('_')`, matching `parser.ts:100`'s `_` → `_${freshCounter++}` renaming):

```
$ npx tsx /tmp/r13/profile-full.ts
=== boot.rofl (21 clauses) ===
  P9 demand-mode      :
      - clause 3 (sees): repeated head var P
      - clause 12 (stratum): head arg not a named var -> {"k":"i","v":0}
      - clause 13 (stratum): head var N NOT range-restricted
      - clause 19 (leak): unsafe negation var R in not bridge_decl
=== examples/sensors.rofl (10 clauses) ===
  P9 demand-mode      : 5 blockers (close/2 ×2, corroborated, outlier ×2)
  P10 body-structure  : clause 10 (temp): disconnected body
=== examples/counter.rofl (3 clauses) ===
  P9 demand-mode      : clause 2 (counter): head var M NOT range-restricted
=== examples/tm.rofl (15 clauses) ===
  P9 demand-mode      : 22 blockers
```

And confirmed against the real `translate()` on minimal reproductions of each boot shape:

```
$ npx tsx /tmp/r13/direct.ts
boot.rofl:7  sees(P,P)       missing:demand-mode :: repeated head variable 'P' in clause 2:
                             demand/moded head shapes have no RFDB counterpart
boot.rofl:31 not bridge(R,A,B)  missing:demand-mode :: negated premise variable 'R' in clause 4
                             is not bound by a positive premise (unsafe negation): v0 evaluates it
                             by finite failure
```

These map to real boot lines: `run-migration/boot.rofl:7` (`sees(P, P) :- perspective(P).`), `:19` (`stratum(Rel, 0) :- edb(Rel).`), `:20` (`stratum(Rel, N) :- dep_neg(Rel, Q), stratum(Q, M), N is M + 1.`), `:31` (`leak[audit](A, B) :- flow(A, B), not sees(B, A), not bridge_decl(R, A, B).`).

**Consequence.** The doc's `boot-load` NOT-CLOSED row reads:

> `[audit]` perspectives; `is` arithmetic (`boot.rofl:20`); typed integer on the wire (`0`).

Three items. There is a fourth, and it is bigger than any of them: **demand/moded evaluation**. v0's own `LIMITS.md:42-43` documents demand-mode non-enumeration; RFDB has no counterpart at all. §6's "dependency graph this exposes" — the section that orders the entire remaining roadmap by leverage — never names it, so it is missing from the leverage ranking even though it sits behind all 14 boot-loading cases plus `p4-sensors`, `p4-counter`, `p4-tm`, `p4-tm-diverge`.

This is the same error §1(iii) convicts Premise A of: reading a first-blocker-wins reason code as if it enumerated the blockers. The doc caught it one level down and then stopped one level too early.

---

## 5. F4 — §2.1's perspective collapse contradicts §7 S1's own gate and voids boot's audit layer

§2.1:

> `P`/`Q` are perspective atoms — in a perspective-less RFDB they are all the constant `main`, which is exactly what `perspAudit` degenerates to when a literal carries no explicit perspective (`reflect.ts:143-145`).

I ran v0's real `encodeRule` over `run-migration/boot.rofl` (byte-identical to `vendor/rofl-v0/boot.rofl`):

```
$ npx tsx /tmp/r13/enc.ts
clauses: 21   distinct rule ids: 21   total reflection facts: 249   facts/clause avg: 11.9
per-relation: {"rule":21,"has_conclusion":21,"conclusion_lit":21,"concludes":21,"writes_to":21,
"has_premise":39,"premise_lit":39,"premise_pos":32,"reads_from":21,"uses_builtin":1,
"premise_neg":6,"bridge_decl":6}

--- clause 21 (unmoded) ---
   conclusion_lit(rb2bbe8a8, 1, $lit(unmoded,audit,$cons($var("R"),$nil),$now))
   writes_to(rb2bbe8a8, audit)
   reads_from(rb2bbe8a8, main)
   bridge_decl(rb2bbe8a8, main, audit)
```

`P` and `Q` are **not** all `main`. Six of boot's 21 clauses emit `bridge_decl(R, main, audit)`, and `writes_to` carries `audit` for every `[audit]`-headed clause.

Two independent consequences, both bad:

1. **It voids boot's own audit layer.** `run-migration/boot.rofl:31` is
   `leak[audit](A, B) :- flow(A, B), not sees(B, A), not bridge_decl(R, A, B).`
   If the encoder collapses every perspective to `main`, `perspAudit` equality holds everywhere and **zero** `bridge_decl` facts are emitted. `not bridge_decl(R, A, B)` then succeeds unconditionally and `leak[audit]` fires on every `flow` pair that fails `sees` — i.e. the leak audit reports whatever it likes. Boot's audit block is one of the invariants this migration exists to preserve (`p4-boot-audits`, `p3-breach`).
2. **It makes §7 S1's gate unsatisfiable.** S1's gate is: *"unit tests asserting the exact fact set for `boot.rofl`'s 21 clauses against v0's `encodeRule` output, name by name."* v0's output contains `bridge_decl` ×6 and `writes_to(…, audit)`; a §2.1-conforming encoder emits neither. §2.1 and §7 S1 cannot both be satisfied. The document proposes an encoding and then proposes a gate that rejects it.

The honest statement is: Projection F **requires** the perspective dimension for the `writes_to` / `reads_from` / `bridge_decl` triple to mean anything, so the lane is not as independent of the perspectives lane as §1(ii) and §6's dependency graph assert. That is a real ordering constraint the plan does not carry.

### F4b — "all arguments atoms or small integers" is false

§1(i)/§2.1: *"Ten relations, all arguments atoms or small integers."* From the same run:

```
   uses_builtin(r21bdb8e9, "is")
```

`encodeRule` emits `{ rel: V.uses_builtin, args: [rid, mks(b.op)] }` — `mks` is **string**, not `mka` (atom). v0's `canonTerm` (`vendor/rofl-v0/src/unify.ts:79-87`) renders `case 's': return JSON.stringify(t.v)` (quoted) versus `case 'a': return t.name` (bare). So Projection F already contains a string-vs-atom distinction, which matters for F6 below.

### F4c — fact volume understated (F11)

§2 says "~10 facts per clause". Measured: **249 / 21 = 11.9**. Small, but this number feeds the §3.2 blast-radius argument.

---

## 6. F5 — §2.2 mis-specifies the reified term and cites the wrong lines

§2.2:

> `Term` is the v0 reification: `$lit(rel, persp, $cons(...))`, `$not(...)`, `$builtin(op, $cons(...))` (`reflect.ts:81-114`).

The real definition, read at `vendor/rofl-v0/src/reflect.ts:77-79`:

```ts
export function reifyLit(l: Lit): Term {
  return mkf('$lit', [mka(l.rel), reifyTerm(l.persp), list(l.args.map(reifyTerm)), mka('$' + l.temporal)]);
}
```

**Four** arguments. The temporal tag is an argument of `$lit`, not an omission. Confirmed in the live output above: `$lit(unmoded,audit,$cons($var("R"),$nil),$now)`.

And the citation is wrong: `reflect.ts:81-114` is `unreifyLit` / `unreifyBodyElem` / `factTerm` — the **decode** side. `reifyLit` is at `:77-79`, `reifyBodyElem` at `:94-98`, `reifyTerm` at `:63-67`.

S1's deliverable is an encoder written to this spec. Written as specified, it produces 3-arity `$lit` terms that `unreifyLit` rejects outright:

```ts
// reflect.ts:81
if (t.k !== 'f' || t.name !== '$lit' || t.args.length !== 4) throw new Error('bad reified literal: ' + canonTerm(t));
```

so S1's own conformance gate would fail on its own spec.

---

## 7. F6 — `Value::Term` is not sufficient as the doc claims (attack axis 3)

§2.2's decision paragraph ends:

> Nothing in `boot.rofl` or in any tier-1 assertion does join through them — the only corpus reads of `premise_lit`/`conclusion_lit` are the round-trip decode `unreifyLit` (`reflect.ts:81-98`) — **so this discharges every measured demand**.

It does not discharge the round-trip decode, which is the one demand it names.

v0 has **five** term kinds (`vendor/rofl-v0/src/unify.ts:4-9`): `v` (var), `i` (int), `s` (string), `a` (atom), `f` (functor). RFDB's `Value` (`datalog/eval.rs:44-62`) is `Id(u128) | Str(String) | Int(i64) | Float(f64) | BigInt(Arc<[u8]>) | Term(Arc<TermBlob>)`. **There is no atom variant.**

The decode path requires the distinction:

```ts
// reflect.ts:81-88 (unreifyLit)
if (rel.k !== 'a' || tmp.k !== 'a') throw new Error('bad reified literal: ' + canonTerm(t));
// reflect.ts:70 (unreifyTerm)
if (t.k === 'f' && t.name === '$var' && t.args.length === 1 && t.args[0].k === 's') return mkv(t.args[0].v);
```

So inside a single `$lit` term, argument 0 (`rel`) must decode as an **atom** and the payload of `$var` must decode as a **string**. Under the obvious encoding — v0 atom and v0 string both → `Value::Str` — those are indistinguishable, and `push_term_text` (`datalog/eval.rs:340-360`) renders a `Value::Str` inside a Term **quoted** (`out.push('"')`), so `$lit("unmoded", …)` ≠ v0's `$lit(unmoded, …)` on the wire too.

A workaround exists — encode v0 atoms as **0-arity `TermBlob`s**, which `push_term_text` renders bare (`if t.args.is_empty() { return; }` after the functor name) — but the doc never states it, and it is not free: `TermBlob::new` validates canonicity V1–V4 recursively (`derive/canon.rs:241-259`), so every atom becomes an allocated blob and the encoder's cost model changes.

Projection T must also carry **arithmetic expression terms**, which §2.2 never mentions. From the live encode:

```
premise_lit(r21bdb8e9, 3, $builtin("is",$cons($var("N"),$cons(+($var("M"),1),$nil))))
```

`+($var("M"),1)` is a functor term whose functor is an operator. §2.2's claim that Projection T is "already supported at the value level" is true for the *container*; it is unproven for the *contents*.

**Answering the axis directly:** can a v0 program observe a difference between Projection F and T? Yes — `boot.rofl:36` (`unmoded[audit](R) :- uses_builtin(R, B), not mode(B, _).`) reads a Projection-F relation only, but `p3-runtime-rule` queries `has_premise(${id}, 1)` and `p3-malformed-sibling` asserts on a rendered rule id, and the decode round-trip is the mechanism by which an asserted rule becomes executable. The F/T split is a legitimate *staging* device; it is not a semantic firewall, and the doc presents it as though the F half were complete on its own (§2.1: "Projection F is what `boot.rofl`'s stratum-0 block actually consumes"). That is true only *below the negation line* — which the doc does say — but `boot.rofl` above the line, and every §4 write path, needs T.

---

## 8. F7 — rule identity, determinism, and the canonical hash (attack axis 4): UNANSWERED

The task asked whether this design silently changes rule identity, determinism, or the canonical sha256 that acceptance criterion A3 depends on. **The document does not answer it**, and its one gesture in that direction is wrong.

§2.2 ground (b):

> it is canonical and hashable, so it participates in `canonical_state_sha` (§9.1 of the fact model) without a special case

`canonical_state_sha` is at `packages/rfdb-server/src/facts/convert/reader.rs:236`:

```rust
pub fn canonical_state_sha(man: &RoflManifest, facts: &FactMap) -> [u8; 32]
```

It hashes a `FactMap` from the **converted ROFL fact store**. But §1(ii) and §3.1 place this entire lane inside `derive/`, explicitly "with zero `facts/` coupling", with the encoder running inside `parse_ext_program` (`derive/parser_ext.rs:863`) and its output entering the derive `Evaluation`. Facts synthesised there **never reach a `FactMap`** and therefore never reach `canonical_state_sha`. Ground (b) asserts the opposite of the architecture the same document specifies two sections earlier.

The unanswered questions this leaves, each acceptance-critical:

1. **Do reflection facts enter the canonical state hash?** `p3-snapshot-roundtrip` asserts cross-process bit identity of `canonicalState()`. If two processes disagree about whether `@reflect` was on, they produce different states. The doc's answer is "it participates … without a special case" — which is false as written, and if the true answer is "they do not participate", then a program's rules are invisible to the state hash, which contradicts v0, where rules **are** facts in the store and are hashed with everything else.
2. **Do reflection facts enter the ledger?** Never mentioned.
3. **Does `@reflect` change the derive cache key?** The program key is `DefaultHasher` over `source` (`engine_v2.rs:960-963`, mirrored `:6064-6069`). A `@reflect` directive is in the source text, so toggling it changes the key — that part is safe by accident. But §4's *runtime rule assertion* (asserting a rule as facts) does **not** change `source`. Under W8/W9 the unchanged-graph short-circuit (`engine_v2.rs:1161-1167`) keys on snapshot version + tombstone `Arc::ptr_eq`. §1(iv) itself states the hazard — "Rule-set identity must enter all three or a store-side rule change will be laundered by the cache" — and then the design never discharges it. §7 has no stage for it.
4. **Rule identity divergence (F12).** `rule_ast_hash` (`derive/materialize.rs:578`) is variable-rename-invariant by its own doc. v0's `ruleIdOf = 'r' + fnv1a(canonClause(c))` (`reflect.ts:134-136`) is **not** — `canonTerm` renders `?X` with the real variable name (`unify.ts:79-87`). So two α-equivalent clauses get one id in RFDB and two in v0. Additionally RFDB's hash runs over the **translated** rule (`u_`-prefixed relations), making ids translator-dependent. `boot.rofl` happens to contain no α-equivalent clause pair, so nothing breaks today — but §5.1 records only the 8-hex truncation collision domain and never names this semantic divergence, and `p3-malformed-sibling` asserts a *specific sibling rule id* in its output.

Any one of these is enough to call the design underspecified on an acceptance-critical axis. Together they are the biggest gap in the document.

---

## 9. F10 / F13 — two structural claims that do not match the code

**F10.** §3.1: *"then — if and only if the [directive is present] — appends [the reflection facts] to the program's fact set."* There is no fact set:

```rust
// packages/rfdb-server/src/derive/parser_ext.rs:238-243
pub struct ExtProgram {
    requires: Vec<Requires>,
    items: Vec<Item>,
}
```

Ground facts in RFDB are empty-body `Rule`s among `items` (which is why `FactStats::from_rules` mines them — see below). The encoder must push `Item::Rule` values with empty bodies, not "append to a fact set". Minor, but S1's signature in §7 is `encode_reflection(&ExtProgram) -> Vec<GroundFact>` and no `GroundFact` type exists.

**F13.** §3.2's blast-radius chain is "new EDB relations → different `FactStats` → different estimates → different plans → moved fingerprints" (the doc flags it NOT VERIFIED at §10.4). Read at `derive/plan.rs:65` / `:74-108`, `FactStats::from_rules` builds **per-predicate** statistics, and only from empty-body all-constant rules. New predicates therefore do not perturb the estimates of *existing* predicates. The direct mechanism is rule count: `plan_golden.rs:204-238`'s `compute_fingerprints()` emits **"One output line per rule"**, and reflection facts *are* rules under F10. So the golden moves — the conclusion (opt-in ⇒ golden bit-identical) survives — but the stated mechanism is wrong, and §7 S2's gate rests on it.

---

## 10. F14 — the ride-alongs violate the adapter's own stated contract

`packages/rofl-conformance/src/adapter.ts:1-7` states the adapter **"never simulates missing engine features."** The constructor enforces one instance of this at `:32-36` by throwing on `opts.naive`.

All three §6.4 ride-alongs are simulations by that definition:

- `p1-tc-naive` — accept `{naive:true}` and ignore it (the engine has no naive mode).
- `p2-why-tree` — assemble a recursive why-**tree** client-side from flat `DerivationWitness` records (the engine has no tree).
- `p4-excise-multi` — implement `excise` as two evaluations plus a client-side diff (the engine has no minus-one-fact path; `sim_derive` at `engine_v2.rs:592-645` is overlay-ADD only, as the doc correctly says).

The doc does not name this tension anywhere. It may well be the right call — v0's `LIMITS.md:46-48` genuinely licenses naive≡seminaive, and `api.ts:347-348` genuinely defines excise as a clean re-evaluation diff — but it is a **contract amendment** to `adapter.ts:1-7`, and §8 requests three rulings without requesting this one.

One sub-claim is also weaker than stated. §6.4 cites `p2-diff-positive` as precedent ("re-pointed per design: naive≡seminaive → v0≡RFDB"). Reading `scenarios.ts:155-177`, that scenario's naive branch runs through `ctx.mkOracle` — the **v0 engine** — not the RFDB adapter. So the precedent is "v0-naive ≡ v0-seminaive", not "adapter may fake a mode it lacks". Different claim.

---

## 11. §10 "WHAT I COULD NOT VERIFY" — status after this review (attack axis 5)

| # | Item | Status |
|---|------|--------|
| 1 | 53 ids / 21 sid strings / Σ(k−1)=32 enumeration | **STILL OPEN.** I did not read the shard blobs. §9.1's *totals* re-verify live (with the F8 transcription defect); the group-by is still carried forward. |
| 2 | Conformance harness not run | **CLOSED, in the doc's favour.** Run regenerated (`…578948`, `2026-08-23T12:52:58.948Z`); `git diff` shows only `rfdb.gitSha` moved. Every §6 count confirmed current. |
| 3 | No Rust built or run | **STILL OPEN.** I did not build Rust either. All `packages/rfdb-server/` claims here are source reads, same as the doc's. |
| 4 | `plan_golden` blast radius reasoned, not measured | **STILL OPEN as a measurement**, but the *mechanism* is now corrected — see F13. The doc's stated causal chain (`FactStats`) is wrong; the real one is rule count. Conclusion unchanged. |
| 5 | `Value::Term` wire round-trip untested | **STILL OPEN as a test**, and now **worse than the doc thinks** — see F6: the problem is not only Term→Str on the return leg, it is that the atom/string distinction `unreifyLit` requires has no representation on the way out either. |
| 6 | `adapter.ts` not read in full | **CLOSED.** Read all 319 lines. None of `strataPlan` (`:293`), `supportCount` (`:298`), `kernelVocabularyCheck` (`:303`), `excise` (`:254`), `save` (`:45`), `canonicalState` (`:49`), `retract` (`:111`), `why` (`:236`), `whynot` (`:245`) is implemented — every one throws `UnsupportedFeature`. §6.4's "adapter-only" claims are therefore about *new* method bodies, not edits to existing ones. This is also what produced F2. |
| 7 | No Grafema query used | **STILL OPEN.** I used none either. |
| 8 | Premise B does not exist on disk | **CONFIRMED unchanged.** |

Three of eight closed; five remain, and one of them (#5) is now known to be a larger problem than the doc recorded.

---

## 12. What I could not break

Stated so the verdict is not read as a blanket rejection:

- **§1(iv)'s six-site invariant is correct and is the document's best contribution.** All six sites verified, all others `#[cfg(test)]`, and the three-way cache mirror (`:960-963`, `:6064-6069`, `:1161-1167`) is real. §3.1's decision to put the seam *inside* `parse_ext_program` rather than at the call sites follows soundly from it and eliminates a real bug class.
- **§1(ii)'s "not gated on the fact-store read path"** — I could not refute it. `grep -rn "crate::facts" packages/rfdb-server/src/derive/` returns 4 hits, all `SortOrder`. The `derive/` ↔ `facts/` decoupling is real.
- **§9's substantive conclusion** (the 32 is a sid-side multiplicity surplus from `engine_v2.rs:102-104` × `plugins/type-inference.mjs:569-582`, not a converter defect) survives the F8 transcription defect. Both code sites verified exact; the mechanism is forced.
- **§6.2's fixture profile** reproduces byte-for-byte for the phases it covers. The finding in F3 is that it covers the wrong set of phases, not that it computes them wrongly.
- **The builtin-registry analysis** (no `is`, no arithmetic; `evalArith` over functor terms ⇒ `is` needs an expression term form, not just a builtin) is correct and well-argued.
- **§7's insistence on `git status --short` on `src/derive/golden/` being EMPTY** as S2's non-negotiable gate is the right gate, for a partly-wrong reason (F13).

---

## 13. Required fixes before this can be the design of record

1. **Reconcile the closed-RED count to one number, and make it 0** (F1, F2). Move `p2-noboot-null-plan` into §6.4's ride-along table. Then either supply a real acceptance gate for S1/S2/S3 (a unit test on `encode_reflection` against v0's `encodeRule`, plus an `explain_datalog_fact`-agrees-with-`evaluate` test on a `@reflect` program), or state plainly that this lane moves zero tier-1 verdicts and is justified solely as a necessary condition for 18.
2. **Add `missing:demand-mode` to §6's blocker taxonomy and dependency graph** (F3), with `boot.rofl:7 / :19 / :20 / :31` named, and re-rank the leverage ordering with it included.
3. **Fix §2.1's perspective claim** (F4): `writes_to`/`reads_from`/`bridge_decl` carry real perspectives; boot emits 6 `bridge_decl` facts; the perspectives lane is a co-requisite of Projection F, not independent of it. Reconcile with §7 S1's gate.
4. **Fix §2.2's term shape and citation** (F5): 4-arity `$lit(rel, persp, args, temporal)`, `reifyLit` at `reflect.ts:77-79`, `reifyBodyElem` at `:94-98`.
5. **State the atom-encoding convention** (F6) — 0-arity `TermBlob` or an explicit new `Value` variant — and add the arithmetic-expression case to Projection T's demand list.
6. **Answer the identity axis** (F7): reflection facts vs `canonical_state_sha`, vs the ledger, vs the W8/W9 program key under *runtime* rule assertion; and record the `rule_ast_hash` (rename-invariant) vs `ruleIdOf` (not) divergence in §5.
7. **Correct the mechanical details**: §3.1's "fact set" (F10), §3.2's `FactStats` chain (F13), "~10 facts per clause" → 11.9 (F11), 828 → 830 (F9), §9.1's inlined `type` row (F8), `builtin.rs:1361` → `:1358`.
8. **Request a fourth ruling** (F14): does §6.4 amend `adapter.ts:1-7`'s "never simulates missing engine features"?

---

## Appendix — reproduction

Scripts used, all under `/tmp/r13/` (none written into the repo):

- `/tmp/r13/profile-full.ts` — extends the doc's `/tmp/synth/profile.ts` with `translate.ts` phases 8/9/10 over the five fixture programs.
- `/tmp/r13/direct.ts` — calls the real `translate()` on minimal reproductions of each `boot.rofl` blocker shape plus three controls.
- `/tmp/r13/enc.ts` — runs v0's real `encodeRule` over `run-migration/boot.rofl`, printing per-relation counts and full fact renderings.

Run with `cd packages/rofl-conformance && npx tsx /tmp/r13/<script>.ts`.
