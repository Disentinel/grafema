# ROFL perspectives as a real evaluator dimension — design of record

Status: DESIGN (not implemented). Branch `rofl-v1`. Mandate: `run-migration/OWNER-RULINGS.md:286`
(R-15 — "perspective becomes a first-class dimension threaded through evaluation. Encoding
`breach[audit]` into the relation name is explicitly REJECTED").

Every factual claim below carries `file:line` read at current HEAD, or an inlined command output.
Section 9 lists everything I could **not** verify.

**Revision 2 (post-adversarial-review).** Two independent critics returned UNSOUND. I ran every
divergence program they supplied against the vendored v0 reference — **all nine reproduce**
(§0), plus four probes of my own that neither critic thought to run (§3.10). Their findings
changed the design materially; what I did not accept is recorded, with commands and output, in
the final section ("Criticisms rejected, with evidence"). The headline change:

> The *representation* decision (perspective is a sibling field of a literal, never a mangled
> name, never an argument column) **survives** and is confirmed by both critics. The *corollary*
> that a flat `RelKey = (perspective, predicate)` should be threaded through every static layer
> — catalog, stratification, plan, `assign_pred_ids`, `Evaluation` — **is dead.** It was refuted
> three separate ways: it destroys the `plan_golden` gate, it presumes a statically-bounded
> perspective universe that v0 does not have, and it silently changes the stratification
> accept/reject boundary. It is replaced by a **two-layer** model (§2.1) that is the actual
> transcription of v0: the *static* layer (catalog / stratification / plan / predicate ids) stays
> keyed by predicate NAME, exactly as v0's `reflect.ts` keys it; the *dynamic* layer (relation
> contents, fact identity, evaluation output) is keyed by `(perspective, predicate, tuple)`,
> exactly as v0's `store.ts` keys it.

---

## 0. The divergence programs, actually run against v0

Run at `vendor/rofl-v0` rev `052a4c5` (`cat vendor/rofl-v0/REV` → `052a4c5`) via
`node --experimental-strip-types` (node v22.22.3), harness `/tmp/divprobe/run.ts`, importing
`Rofl` from `vendor/rofl-v0/src/api.ts`. Verbatim output:

```
===== A1  copy[P](X) :- secret[P](X). =====
load ok = true diags = []
factKeys(copy) = ["copy[open](s2)","copy[vault](s1)"]
query copy[vault](X) = ["X = s1"]
query copy[Q](X)     = ["Q = open, X = s2","Q = vault, X = s1"]

===== A1b  secret[P](s1).  (bodyless) =====
load ok = false diags = ["fact secret[?P](s1)@now: perspective must be an atom"]

===== A2  implicit-main head vs explicit-main head =====
--- implicit: load ok = true diags = []
   bridge_decl(R,A,B) = [6 kernel rows, none with A = vault]
   leak[audit](A,B)   = ["A = vault, B = main"]
--- explicit: load ok = true diags = []
   bridge_decl(R,A,B) = [... , "A = vault, B = main, R = r05385a60"]
   leak[audit](A,B)   = []

===== A3a  head persp var bound from an argument term =====
p[a](zeta).  q[P](x) :- p[a](P).  r(P, Y) :- q[P](Y).
load ok = true diags = []
factKeys(q) = ["q[zeta](x)"]
query r(P,Y) = ["P = zeta, Y = x"]

===== A3b  clean(X) :- item(X), not q[P](X). =====
load ok = true diags = []
query clean(X) = ["X = b"]

===== A4  q[b](X) :- p[a](X), not q[c](X).   (boot loaded) =====
load ok = false diags = ["program rejected: unstratified[main](q)", <derivation demo>]
query q[b](X) = []

===== A4-control  same program, boot NOT loaded =====
load ok = true diags = []
query q[b](X) = ["X = 1"]

===== ISO-1  plant h[hypothesis](x) — does the [main] projection move? =====
main-projection facts added by the plant = 9
 ["authority[main](hypothesis,$kernel)",
  "derived_by[main]($fact(perspective,main,$cons(hypothesis,$nil)),r65c1731a,0)",
  "derived_by[main]($fact(sees,main,$cons(hypothesis,$cons(hypothesis,$nil))),r4af55a3b,0)",
  "derived_by[main]($fact(stratum,main,$cons(h,$cons(0,$nil))),r9aacf819,0)",
  "edb[main](h)",
  "in_perspective[main]($fact(h,hypothesis,$cons(x,$nil)),hypothesis)",
  "perspective[main](hypothesis)", "sees[main](hypothesis,hypothesis)",
  "stratum[main](h,0)"]

===== p2-persp-isolation (the target case) under v0 =====
load ok = true []
spy(X)    = []
honest(X) = ["X = s1"]
```

What each result forces:

| run | forces |
| --- | --- |
| A1 / A1b | a **rule** head MAY carry a perspective variable and concludes into the resolved perspective; only a **bodyless fact** requires a concrete one. Kills rev-1 §3.3. |
| A2 | `perspExplicit` is load-bearing *under negation* in `boot.rofl:31`. `Persp{Name,Var}` cannot represent it. Kills rev-1 §2.1's 2-variant enum and §5 A6-3's bridge definition. |
| A3a | the perspective universe is **data-dependent** — `zeta` appears in no bracket. Kills rev-1 §3.2's static `𝒫` and every `𝒫`-fan-out in the change list. |
| A3b | v0 **answers** a negated literal with an unbound perspective variable (`relAll` = "in NO perspective"). Rejecting it is a new divergence, not agreement. |
| A4 vs A4-control | the reference's *kernel* has no stratification check at all; the name-granular rejection comes from **boot.rofl**, i.e. userland. Settles §3.9. |
| ISO-1 | v0's own kernel bookkeeping writes into `[main]` on every assertion, so ISO-1 as stated in rev 1 is **false for `p = main`**. Forces the §3.8 carve-out. |
| p2-persp-isolation | the target case's expected behaviour, unchanged. |

A3a raised a question neither critic asked — whether a data-dependent perspective set can grow
without bound and break fixpoint termination. Four further probes (G1–G4) answer it; they live in
**§3.10** because they produce two new semantic rulings rather than refuting rev 1.

---

## 1. Ground: what already exists, and what the critical path actually is

### 1.1 The dimension already exists — one layer below `derive/`

`packages/rfdb-server/src/facts/` implements perspectives first-class, today:

| thing | site |
| --- | --- |
| `pub struct PerspectiveId(u32)` — field **private** | `facts/mod.rs:56` |
| `pub const PERSPECTIVE_MAIN_NAME: &str = "main"` | `facts/mod.rs:60` |
| `pub const PERSPECTIVE_MAIN: PerspectiveId = PerspectiveId(0)` | `facts/mod.rs:63` |
| `PerspectiveTable::new()` interns `main` at 0 | `facts/mod.rs:80` |
| `pub struct FactKey { perspective, predicate, tuple }` | `facts/mod.rs:111` |
| `fact_key_canon_bytes(perspective_name, predicate_name, tuple, out)` | `facts/mod.rs:397` |
| `fid(perspective_name, predicate_name, tuple) -> u128` | `facts/mod.rs:417` |
| perspective is an explicit parameter of every `FactStore` read primitive | `facts/mod.rs:483,494,558` |
| `canonical_state_sha(&self, s: &Snapshot) -> [u8; 32]` | `facts/mod.rs:610` |
| hygiene test `no_perspective_id_literal_outside_facts` | `facts/mod.rs:682` |
| hygiene test `perspective_table_interns_main_at_zero` | `facts/mod.rs:714` |

`fact_key_canon_bytes` hashes **the canonical NAME strings, never the interned u32 ids** — the
doc comment at `facts/mod.rs:397` states the reason (§9.2: interned ids depend on declaration
order and process; hashing them is forbidden). That decision is already made and this design does
not reopen it; it *inherits* it.

### 1.2 `derive/` has zero perspective code

```
$ grep -rn "crate::facts" --include=*.rs packages/rfdb-server/src/derive/
packages/rfdb-server/src/derive/plan.rs:2006:        use crate::facts::SortOrder;
packages/rfdb-server/src/derive/catalog.rs:28:use crate::facts::SortOrder;
packages/rfdb-server/src/derive/exec.rs:82:    use crate::facts::SortOrder;
packages/rfdb-server/src/derive/exec.rs:6573:        use crate::facts::SortOrder;

$ grep -rn "perspective\|Perspective" --include=*.rs packages/rfdb-server/src/derive/
packages/rfdb-server/src/derive/canon.rs:4://! encoder on which `fid = BLAKE3(canon(perspective, predicate, tuple))[0..16]` (§2.1)
packages/rfdb-server/src/derive/catalog.rs:72:    /// At most one live value per subject in one perspective; conflicting live
packages/rfdb-server/src/derive/catalog.rs:319:    /// perspective record of every multi-live Functional resolution:
```

Three doc-comment mentions, no code. The evaluator is perspective-blind. **This is the whole gap.**

The consequence that shapes the design: the fact store's dimension and the evaluator's dimension
must be *the same* dimension — same names, same canonical bytes, one identity. A second,
independently-invented notion of "perspective" inside `derive/` would be exactly the wire↔store
split R-15 rejects (`OWNER-RULINGS.md:295-297`).

### 1.3 The ROFL EDB reaches the engine as PROGRAM TEXT, so no storage change is on the path

`packages/rofl-conformance/src/adapter.ts` sends the whole ROFL state — rules *and* ground facts —
as one Datalog source string to `client.executeDatalog(source)`. That lands at
`bin/rfdb_server.rs:2942 dispatch_execute_datalog` → `route_datalog_engine` (`:2868`) →
`GraphEngineV2::eval_derive(source, target.predicate(), limits)` (`graph/engine_v2.rs:539`).

So for the conformance lane, perspectives are a **parser → plan → exec** change. That is exactly
the ТЗ's P2 **Phase A** ("perspective as namespace layer … no storage format change"); Phase B
(native key dimension in the store) stays deferred, "only if perf demands".

### 1.4 Which cases this unblocks — the honest count

```
$ python3 -c "... Counter(x['reason_code'] for x in json.load(open('packages/rofl-conformance/conformance-report.json'))['tier1'])"
Counter({'missing:rules-as-data': 18, 'None': 5, 'dialect:untranslatable': 2,
         'missing:compound-terms': 1, 'missing:whynot-shape': 1,
         'missing:perspectives': 1, 'missing:excise': 1, 'missing:holes': 1})
```

Exactly **one** tier-1 case is coded `missing:perspectives`:

```json
{"id": "p2-persp-isolation", "sourceRef": "test/phase2.test.ts:118", "tier": "tier1",
 "verdict": "RED", "reason_code": "missing:perspectives",
 "evidence": "perspective [vault] in clause 1: RFDB has no perspective dimension"}
```

The other perspective-carrying cases (every boot-loading case) are **masked**: the translator
runs its phases in a fixed order and `missing:rules-as-data` fires first — `translate.ts`'s own
header says boot.rofl "fails at phase 1 with `missing:rules-as-data` even though it also contains
`[audit]` perspectives".

Rev 1 inherited the figure "~14" without deriving it. Derived now, by joining `scenarios.ts`
against the live report:

```
$ python3 - # scenarios whose body mentions BOOT, joined to conformance-report.json tier1
scenarios mentioning BOOT: 16
Counter({('RED', 'missing:rules-as-data'): 15, ('GREEN', None): 1})
  p2-diff-negation GREEN | p2-stratum-order, p2-unstrat-reject, p3-runtime-rule,
  p3-write-protected, p3-breach, p3-malformed-sibling, p3-snapshot-roundtrip, p4-counter,
  p4-replay, p4-tm, p4-tm-diverge, p4-boot-audits, p4-sensors, p4-forged, boot-load  RED
```

So the truthful statement is: perspectives are a **prerequisite** for **15** boot-loading RED
cases (not 14) and the **sole** blocker for 1. This design must therefore land the general
mechanism (perspective variables, cross-perspective heads) that boot.rofl needs, while its first
increment flips the one case that is unblocked today. What perspectives do **not** do is unblock
those 15 on their own — `missing:rules-as-data` remains their first blocker (§9.8).

---

## 2. REPRESENTATION

### 2.1 The decision

> **Perspective is a first-class field of a relational literal, sibling to the predicate name and
> to the argument tuple — never an argument, never part of the name. The evaluator's relation key
> becomes the pair `(perspective, predicate)`.**

Concretely, in `packages/rfdb-server/src/datalog/types.rs`:

```rust
/// A literal's perspective. Three states, mirroring ROFL v0's `Lit` EXACTLY:
/// v0 carries BOTH `persp: Term` and `perspExplicit: boolean` (`parser.ts:9-11`,
/// comment "// was [p] written in the source?"), and `reflect.ts:171-176` gates
/// `bridge_decl` emission on the explicitness bit. A two-variant enum destroys it.
///
///   Implicit  — no `[...]` was written. RESOLVES to `main`; not the same literal
///               as `Name("main")` for reflection or for rendering (§4.7).
///   Name(n)   — `[n]` written, a concrete perspective.
///   Var(v)    — `[V]` written, a perspective variable (§3.2).
pub enum Persp { Implicit, Name(String), Var(String) }

impl Default for Persp { fn default() -> Self { Persp::Implicit } }

impl Persp {
    /// The concrete perspective this resolves to WITHOUT a substitution, or `None`
    /// for a `Var`. `Implicit` and `Name("main")` both resolve to `main` — resolution
    /// is where the explicitness bit is (deliberately) dropped.
    pub fn resolved(&self) -> Option<&str> {
        match self {
            Persp::Implicit => Some(crate::facts::PERSPECTIVE_MAIN_NAME),
            Persp::Name(n) => Some(n),
            Persp::Var(_) => None,
        }
    }
    pub fn is_explicit(&self) -> bool { !matches!(self, Persp::Implicit) }
}
```

and `Atom` gains one private field `persp: Persp` next to its existing private
`predicate: String` / `args: Vec<Term>` (`datalog/types.rs:68-72`, `Atom` fields are already
private with `predicate()/args()/arity()/variables()/is_ground()` accessors).

Reusing `crate::facts::PERSPECTIVE_MAIN_NAME` (not a fresh `"main"` literal) is deliberate: it is
the single point that ties the evaluator's default to the fact store's id-0 interning
(`facts/mod.rs:60,63,80`).

**Where the perspective lives in the evaluator: TWO layers, not one.**

Rev 1 proposed one flat `RelKey = (perspective, predicate)` threaded through catalog,
stratification, plan, `assign_pred_ids` and `Evaluation`. That is **withdrawn**. v0 does not have
one flat key; it has two, and it keys the two layers *differently*:

| v0 layer | key | evidence |
| --- | --- | --- |
| **static** — dependency graph, stratification, rule indexing, demand | predicate **NAME**, perspective **dropped** | `reflect.ts:155` `concludes(rid, mka(c.head.rel))`; `:163-164` `premise_pos/premise_neg(rid, mka(b.lit.rel))` — `b.lit.rel` only; `engine.ts:182` `levelOf = strat.get(r.clause.head.rel)`; `:211-220 readStrata` `out.set(rel.name, n.v)`; `:271` `fireRuleFront` on `cur.rels.has(b.lit.rel)`; `:384` `demandRels.get(lit.rel)` |
| **dynamic** — fact identity, relation contents, visibility | `(rel, persp, args)` | `store.ts` `factKey(rel, persp, args)`, index `rel -> persp -> keys`, `relPersp(rel, persp)` / `relAll(rel)`; `engine.ts:370-372` |

So the RFDB counterpart is:

```rust
// STATIC layer — UNCHANGED. Stratum.predicates stays Vec<String> (stratify.rs:167);
// RulePlan.head stays String (plan.rs:280); LegSource::Derived{name: String}
// (plan.rs:243); assign_pred_ids stays name-keyed (exec.rs:3884).

// DYNAMIC layer — the perspective becomes an INNER map level, a direct transcription
// of v0's `rel -> persp -> keys`:
//   exec.rs:894   relations: HashMap<String, Relation<T>>
//              => relations: HashMap<String, BTreeMap<String, Relation<T>>>
//   exec.rs:248   Evaluation.relations: BTreeMap<String, Vec<Box<[Value]>>>
//              => BTreeMap<String, BTreeMap<String, Vec<Box<[Value]>>>>
// The inner key is the RESOLVED perspective name (Implicit ⇒ "main").
```

A body leg's perspective rides on the leg's literal — `PlanLeg.literal: Literal` (`plan.rs:262`)
already carries the whole `Atom`, hence `persp`, so **no `LegSource` or `RulePlan` field changes
at all.** A concrete perspective probes one inner entry; a `Persp::Var` iterates the inner map
(= `relAll`) and binds. A head writes into `inner[resolved]`, creating the entry on demand — which
is what makes §3.2's data-dependent universe (A3a) representable without a static `𝒫`.

`Evaluation::facts(&self, predicate: &str)` (`exec.rs:254`) **keeps its signature** and returns the
`main` projection; a new `facts_in(perspective, predicate)` serves the rest. That is what bounds
the blast radius:
```
$ grep -rn "\.facts(" packages/rfdb-server/src/ | wc -l
135
```
all 135 keep compiling and keep meaning what they mean today.

### 2.2 Why this one wins

1. **It is the shape v0 actually has — both halves of it.** The table above is the transcription.
   Rev 1 quoted the `rel -> persp -> keys` index correctly and then flattened it into one pair
   key, which is the *inner* half applied to the *outer* layer as well. v0 never does that.
2. **It is the shape the fact store already has** (`FactKey { perspective, predicate, tuple }`,
   `facts/mod.rs:111`) and the shape the converted manifest already has
   (`facts/convert/manifest.rs:203 pub perspectives: Vec<String>`) — at the *identity* layer,
   which is precisely the dynamic layer.
3. **It respects the binding constraints** of `_ai/research/rofl-rules-as-data-design.md` §2-§4:
   `Term` has no compound form and does not need one — the perspective is *not* a term argument;
   `StorageView` stays node/edge-shaped (§3.6 below keeps base legs `main`-only); `SegmentType`
   is untouched because nothing about the storage format changes in Phase A.
4. **It costs zero call-site churn.** `Atom::new(predicate, args)` defaults `persp` to `Implicit`:
   ```
   $ grep -rn "Atom::new" --include=*.rs packages/rfdb-server/src/ | wc -l
   168
   ```
   (144 of those are `datalog/tests.rs`, 20 `derive/plan.rs`, 2 `datalog/parser.rs`, 1 each in
   `datalog/eval.rs` and `datalog/eval_explain.rs`.) All 168 keep compiling and keep meaning
   exactly what they mean today. `PartialEq`/`Eq`, which `Atom` already derives, start
   distinguishing perspectives for free — which is what makes the dimension *real*.
5. **It keeps `fact_id`, `assign_pred_ids` and `plan_golden` genuinely untouched** (§4), instead
   of *arguing* that they are untouched. Rev 1's flat `RelKey` provably moved all 40,816
   fingerprints; this one moves none, because the plan's types do not change.

### 2.3 What was rejected, and on what grounds

**(a) Name mangling — `secret$vault(X)`.** REJECTED by `OWNER-RULINGS.md:291-297`. Independent of
the ruling, it fails on its own terms: isolation, cross-perspective queries and `canonicalState()`
would each have to re-parse a name to recover a value the representation threw away, and the
manifest's `perspectives: Vec<String>` column would permanently disagree with the wire — the exact
class of split A4's cross-backend differential exists to catch.

**(b) An extra leading tuple column — `secret("vault", X)`.** REJECTED on three concrete
mechanisms: it changes arity, which collides with `PredicateCatalog`'s strict head-arity
registration (`E-CAT-002`, `derive/plan.rs`) and shifts every `plan_golden` fingerprint
(`derive/golden/p3_plan_fingerprints.txt`, 3.3 MB); it changes `FactStats::from_rules`'s exact
ground-fact cardinalities; and — decisively — it makes isolation a **program** obligation instead
of an **engine** property. Any rule that forgets to constrain column 0 leaks silently, so A6 stops
being mechanically checkable. That single consequence disqualifies it.

**(c) A plan-time single-perspective parameter (evaluate the program once per perspective).**
REJECTED because it cannot express two things ROFL actually requires: a perspective *variable*
binding across perspectives (`engine.ts` `matchPremise`'s `store.relAll` branch), and a rule whose
head is in one perspective while its premises are in another — which is literally what boot.rofl
is made of (`vendor/rofl-v0/boot.rofl`: `leak[audit](A, B) :- flow(A, B), not sees(B, A), not
bridge_decl(R, A, B).`, plus `forged[audit]`, `malformed[audit]`, `breach[audit]`,
`unmoded[audit]`). Those are the 14 masked cases.

**(d) A segment-level / storage partition.** REJECTED for this phase: the ТЗ makes the native key
dimension Phase B, "only if perf demands"; `StorageView` (`derive/storage_glue.rs`, `pub(crate)
trait StorageView: Sync`) is node/edge-shaped with no perspective in any of its eleven methods;
and per §1.3 the ROFL EDB is not in storage at all — it arrives as program text. Building a
storage partition would be work that the failing case does not exercise.

### 2.4 Surface syntax

`pred[persp](args…)`, identical to v0 (`vendor/rofl-v0/src/parser.ts`: on `[`, an `ident` becomes
`mka(p.v)`, a `var` becomes `mkv(p.v)`, anything else is `bad perspective`; the comment there
states "A relational literal starts ident + `'['` (perspective form is unambiguous)").

It is unambiguous in the RFDB dialect too — `[` is currently unused by the parser:
```
$ grep -n "'\['\|\"\[\"" packages/rfdb-server/src/datalog/parser.rs
(no output)
$ grep -c "'\['" packages/rfdb-server/src/derive/parser_ext.rs
0
```
and `parse_identifier` (`datalog/parser.rs:89-100`) stops at any char that is not alphanumeric,
`_` or `:` — so `[` is already a clean terminator. An absent `[…]` means `main`, so **every
existing program parses to exactly what it parses to today.**

---

## 3. SEMANTICS

Stated as rules, each traced to the v0 reference that defines it.

### 3.1 Visibility: EXACT MATCH, no fallback

For a body literal `p[r](t̄)` where `r` is a concrete name, the candidate facts are exactly the
facts of predicate `p` in perspective `r`. Source: `engine.ts` `matchPremise` —
`cands = perspT.k === 'a' ? this.store.relPersp(lit.rel, perspT.name) : this.store.relAll(lit.rel)`.
`relPersp` (`store.ts`) reads one bucket of the `rel -> persp -> keys` index.

There is **no inheritance, no layering, and no fallback to `main`.** `store.ts` has no such path.
A perspective with no facts for `p` yields the **empty relation** — a legal answer, not an error.
That matches `facts/mod.rs:15-17`, which already states it for the fact store: "Reading a
perspective with no facts returns an EMPTY run — exact-match semantics, a valid empty answer, not
an error."

This is what makes `p2-persp-isolation` pass: `spy(X) :- secret[open](X).` finds no
`secret` facts in `open`, so `spy` is empty, while `honest(X) :- secret[vault](X).` sees `s1`.

### 3.2 Perspective variables — the universe is DATA-DEPENDENT, not static

Rev 1 said the universe `𝒫` = { names appearing in the program text } ∪ { main } is a static
superset of v0's `relAll`. **That is refuted.** Divergence program A3a (§0), run against v0:

```
p[a](zeta).   q[P](x) :- p[a](P).   r(P, Y) :- q[P](Y).
→ factKeys(q) = ["q[zeta](x)"]      r(P,Y) = ["P = zeta, Y = x"]
```

`zeta` appears in no bracket anywhere. A head perspective variable binds from an **argument term**
and *creates* a perspective. So `𝒫` is not statically computable, is not a superset, and the whole
`𝒫`-fan-out machinery (rev-1 change list steps 4 and 6, `LegSource::DerivedAny`) is deleted.

The corrected rule, which needs no universe at all:

* **Body leg, `Persp::Var(P)`** — iterate the relation's inner perspective map (§2.1), i.e.
  exactly v0's `relAll` (`engine.ts:370-372`), unifying `P` with each matched fact's perspective
  (`engine.ts:377` `unify(perspT, mka(f.persp), s)`). The candidate set is "perspectives that have
  facts", by construction, because that IS the inner map's key set. No superset, no argument
  needed.
* **Head, `Persp::Var(P)`** — resolved per row at conclusion time (§3.3), the entry created on
  demand.

`Atom::variables()` must count the perspective variable (change list step 1) so `P` participates
in binding and in safety.

**Negation with an unbound perspective variable is ANSWERED, not rejected.** Divergence program
A3b (§0):
```
item(a). item(b). q[vault](a).   clean(X) :- item(X), not q[P](X).
v0 → clean(X) = ["X = b"]        (semantics: "q(X) holds in NO perspective")
```
Rev 1 claimed `Rule::is_safe()` plus `E-PLAN-002` "cover it with no new machinery". Both halves
were wrong:
* `Rule::is_safe()` (`datalog/types.rs:209-219`) is `head_vars ⊆ positive_body_variables` — it
  never inspects a negated literal's variables at all, so it cannot see `P`.
* `E-PLAN-002` (`derive/plan.rs:184` `PlanCode::Infeasible => "E-PLAN-002"`) *would* reject if the
  negated-leg check (`plan.rs:940-941`, "Negative literals require ALL Var args to be in bound")
  were extended to the perspective field — and rejecting is exactly what must NOT happen, because
  v0 answers.

**Ruling:** a negated leg whose perspective is a `Persp::Var` unbound elsewhere is an
**existential over the inner perspective map** — "no fact of `p` with this tuple in any
perspective" — matching v0's `relAll`. Implementation: the negated leg's anti-join probes every
inner entry and passes only if all miss. The perspective variable is explicitly **excluded** from
`plan.rs:940`'s all-args-bound requirement, and this exclusion is a named test (T3b, §8.1), not an
oversight. This is the same shape as the already-pinned existential wildcard rule
(`exec.rs::negated_derived_leg_with_wildcard_is_existential`, cited by
`rofl-conformance/src/translate.ts:314-319`'s comment).

### 3.3 Conclusion (write) rule: FACTS are concrete, RULE HEADS need not be

Rev 1 said a head whose `Persp` is `Var` is rejected with `E-PERSP-002`, citing `api.ts`
`addClause`. **The citation was misread and the rule is withdrawn.** `api.ts:104-107` puts that
check inside the *bodyless-clause* branch only:

```ts
private addClause(c: Clause, who?: string): string | null {
  if (c.body.length === 0) {
    const h = c.head;
    if (h.persp.k !== 'a') return `fact ${canonClause(c)}: perspective must be an atom`;
```
For a rule (`body.length > 0`) v0 registers the head perspective only when it is an atom
(`api.ts:131` `if (c.head.persp.k === 'a') registerPersp(...)` — conditional), treats a positive
body literal's perspective as a **binder** (`engine.ts:141` `bindAll(b.lit.persp)`), marks the rule
SAFE when the body binds it (`engine.ts:158` `if (!h.args.every(groundIn) || !groundIn(h.persp))
safe = false;`) and concludes into the *resolved* perspective (`engine.ts:278-290`).

Divergence programs A1 / A1b (§0) confirm the split empirically:
```
copy[P](X) :- secret[P](X).   → load ok = true,  copy[open](s2) AND copy[vault](s1)
secret[P](s1).                → load ok = false, "fact secret[?P](s1)@now: perspective must be an atom"
```

**Corrected ruling:**
* A **bodyless fact** with a non-concrete perspective → **`E-PERSP-002`** at the rule-acceptance
  point in `derive/parser_ext.rs::parse_ext_program` (`:863`), message transcribing v0's.
* A **rule head** may carry `Persp::Var(P)`. `P` must be bound by a positive body literal — either
  by that literal's own perspective or by one of its argument terms (A3a binds it from an
  argument). This is `Rule::is_safe()`'s existing `head_vars ⊆ positive_body_variables`
  discipline, which now applies to `P` for free *because* step 1 puts the perspective variable
  into `Atom::variables()`. An unbound head perspective variable is therefore already
  `is_safe() == false` — no new error code.
* At conclusion, the resolved perspective names the inner map entry. If a row leaves `P` unbound
  (possible only through a demand-backed head), the row is **skipped with a diagnostic**, matching
  `engine.ts:280-288`, not silently dropped.

`copy[P](X) :- secret[P](X)` — the canonical perspective-relabel/bridge idiom, and the mechanism
§2.3(c) says boot.rofl is made of — therefore **loads and evaluates**, instead of being rejected.

### 3.4 Default perspective

`main`, spelled once as `crate::facts::PERSPECTIVE_MAIN_NAME` (`facts/mod.rs:60`), matching v0's
`parser.ts` (`let persp: Term = mka('main')`) and `reflect.ts` (`export const MAIN = 'main'`).

### 3.5 Conflict: the concept does not arise

Two facts that differ only in perspective are two distinct facts, because the perspective is part
of identity (`factKey(rel, persp, args)` in `store.ts`; `FactKey{perspective,…}` at
`facts/mod.rs:111`). There is no merge, no precedence, no shadowing — hence no conflict rule to
get wrong.

### 3.6 Base (storage-served) legs are `main`-only, and a non-`main` one is REJECTED

`node`/`edge`/attr legs are served by `StorageView` (`derive/storage_glue.rs`), which has no
perspective in any method. `AssertBatch`'s doc at `facts/mod.rs:261` already fixes the same rule
for the fact-store write path: "P2: must be `PERSPECTIVE_MAIN` (§10.1: perspective is
unrepresentable in today's record format) — else `E-CAP-001`".

Ruling: a **base** leg with a non-`main` perspective is a **plan-time rejection**,
**`E-PERSP-001`**, carrying (clause index, literal, perspective name, the reason "base relations
exist only in `main`"). It is *not* an empty run, because silently answering `node[audit](X)` with
`[]` would return a wrong-but-plausible answer for a category error. This is the narrow, genuinely
kernel-owned case of the ТЗ's "planner rejects reads outside visibility … rejection carries
provenance".

**Where it must be enforced — rev 1 put it in a place that is unreachable.** Rev 1's change list
said "step 5: `base_dispatch` resolves only for `perspective == main`" + "step 6: `LegSource::Base`
→ `E-PERSP-001` when non-`main`". Those two defeat each other. `classify` (`derive/plan.rs:1162`)
resolves in a fixed order:

```rust
fn classify(pred: &str, strat, head_stratum, catalog, head) -> PlanResult<LegSource> {
    if let Some(s) = strat.stratum_of(pred) { return Ok(LegSource::Derived{...}) }   // 1
    if let Some(dispatch) = catalog.base_dispatch(pred) { return Ok(LegSource::Base{...}) } // 2
    if is_known_builtin(pred) { return Ok(LegSource::Builtin(...)) }                 // 3
    if catalog.get(pred).is_some() { return Ok(LegSource::Derived{recursive:false}) }// 4  OPEN-SPACE
    Err(PlanError{ code: PlanCode::CatalogRejected, ... })                           // 5
}
```
`node` **is** catalog-registered — `PredicateCatalog::with_base_relations()` does
`cat.declare(attribute("node", 2))` at `derive/catalog.rs:251`. So if step 5 made
`base_dispatch("node")` return `None` for `[audit]`, arm 2 falls through, arm 3 misses, and arm 4
fires: `node[audit](X)` becomes an OPEN-SPACE derived leg served as the LEGAL EMPTY relation
(documented at `plan.rs:1154-1159`). The leg never becomes `LegSource::Base`, so step 6's
`E-PERSP-001` is **unreachable**, and the design would implement precisely the silent-empty
behaviour this section forbids. Note also that `classify`'s signature carries no perspective at
all (`pred: &str`), so neither step could have expressed the rule.

**Corrected mechanism.** Thread the perspective into `classify` and check it FIRST, before any
arm:

```rust
fn classify(pred: &str, persp: &Persp, strat, head_stratum, catalog, head) -> PlanResult<LegSource> {
    // §3.6 — base names exist only in `main`, checked BEFORE the arm order so it cannot
    // be swallowed by the open-space arm. `catalog.is_base_name(pred)` is the set
    // pre-registered by `with_base_relations()` (catalog.rs:220-258), not `base_dispatch`.
    if catalog.is_base_name(pred) && persp.resolved() != Some(PERSPECTIVE_MAIN_NAME) {
        return Err(PlanError { code: PlanCode::PerspectiveOnBase, head, detail: ... });
    }
    ... arms 1-5 unchanged ...
}
```
`base_dispatch` is left alone. `is_base_name` reads `base_names`, which the catalog already
maintains — `catalog.rs:190` documents it as "Populated by [`Self::with_base_relations`] only".
A `Persp::Var` on a base name also rejects here (`resolved()` returns `None`), which closes the
underspecification a critic flagged: `node[P](X)` is `E-PERSP-001`, not "bind P=main", not a fan-out.

There is exactly one caller (`plan.rs:615 let source = classify(pred, strat, …)`), inside the loop
that already holds the literal, so this is a one-call-site signature change.
```
$ grep -n "classify(" packages/rfdb-server/src/derive/plan.rs
615:        let source = classify(pred, strat, head_stratum, catalog, &head)?;
1162:fn classify(
```

Derived / ROFL-EDB legs in an unpopulated perspective stay an **empty relation** (§3.1), which is
the behaviour `derive/plan.rs`'s OPEN-SPACE default already gives body-only predicates, pinned by
`derive/exec.rs::unknown_predicate_leg_terminates_with_empty_result`.

### 3.7 The kernel does NOT enforce the ⊑ visibility preorder — and that is deliberate

The ТЗ's P2A wording ("planner rejects reads outside visibility unless a declared bridge exists")
reads as though the engine owns `⊑`. In v0 it does not. `sees/2` and `imports/2` are defined in
**boot.rofl**, i.e. userland:

```
perspective(P) :- authority(P, _).
sees(P, P) :- perspective(P).      sees(P, Q) :- imports(P, Q).
sees(P, Q) :- imports(P, X), sees(X, Q).
leak[audit](A, B) :- flow(A, B), not sees(B, A), not bridge_decl(R, A, B).
```

A leak is **derived as an audit finding**, not blocked by the engine. Therefore:

* the **engine** guarantee is the stronger and simpler one — *exact-match isolation* (§3.1): a
  fact crosses perspectives only through a rule that names both perspectives explicitly, and every
  such rule is statically enumerable from the program;
* the **`⊑` policy** guarantee is a userland Datalog program (boot.rofl), which needs the
  reflection facts (`bridge_decl`, `reads_from`, `writes_to`, `in_perspective`, `asserted_by` —
  `vendor/rofl-v0/src/reflect.ts`) that the *rules-as-data* lane produces. Perspectives are the
  prerequisite; they are not the whole of A6's userland half.

Divergence from a literal reading of the ТЗ is recorded here on purpose rather than silently
implemented either way.

### 3.8 Isolation stated as a property a test can check — with the `main` carve-out

Rev 1 stated ISO-1 universally over all perspectives `p`. **It is false in the reference for
`p = main`.** Divergence run ISO-1 (§0): planting `h[hypothesis](x)` into a boot-loaded v0 adds
**9 facts to the `[main]` projection** — `authority[main](hypothesis,$kernel)`,
`perspective[main](hypothesis)`, `sees[main](hypothesis,hypothesis)`, `edb[main](h)`,
`stratum[main](h,0)`, `in_perspective[main](…)` and three `derived_by[main](…)`. The cause is v0's
own kernel bookkeeping: `api.ts:115` `registerPersp(this.store, persp)`, `:119`
`store.add(V.edb, MAIN, …)`, `:121-123` `factMetaFacts(...)` all write into `MAIN` regardless of
the asserted fact's perspective.

Corrected statement:

> **ISO-1 (exact-match isolation).** Let `Π` be a program, `p` a perspective, and `f = q[r](t̄)` a
> ground fact with `r ≠ p`, where `q` is **not** a kernel reflection relation. If no rule of `Π`
> has head perspective resolving to `p` and a body literal whose perspective is `r` or a
> perspective variable, then
> `eval(Π) ↾ p ∖ ℛ  ==  eval(Π ∪ {f}) ↾ p ∖ ℛ`, where `↾ p` is the projection of
> `Evaluation.relations` to inner key `p`, and `ℛ` is the kernel-emitted reflection vocabulary
> (`vendor/rofl-v0/src/reflect.ts:11-35`'s `RESERVED` set: `edb`, `perspective`, `authority`,
> `sees`, `stratum`, `in_perspective`, `asserted_by`, `derived_by`, …).

The carve-out is not a weakening for *this* lane: RFDB emits none of `ℛ` today (that is the
rules-as-data lane, §9.8), so `ℛ = ∅` and the property is the strong one. It is written down now
because the moment rules-as-data lands, an uncarved ISO-1 would fail on its first run and the
failure would look like a perspective bug rather than the reflection bookkeeping it is.

Mechanically checkable: two evaluations, one projection, one `assert_eq!`. §8.3 turns it into a
named test. §5 turns it into A6.

### 3.9 Stratification granularity: NAME-granular, deliberately

Rev 1's change list made `Stratum.predicates: Vec<RelKey>` and put dependency edges on `RelKey`,
with no semantics section behind it. That silently changes the accept/reject boundary of every
negation that crosses a perspective. Divergence program A4 (§0), against v0 **with boot loaded**:

```
p[a](1).  q[c](2).  q[b](X) :- p[a](X), not q[c](X).
v0 + boot → load ok = false, "program rejected: unstratified[main](q)"
```
because `reflect.ts:155,163-164` drop the perspective when emitting `concludes`/`premise_neg`, so
`boot.rofl:13,17` sees `dep_neg(q,q)` and `reach(q,q)`. A `RelKey`-granular kernel would call
`q[b]` and `q[c]` distinct, find `q[c]` EDB-only, stratify, and derive `q[b](1)`.

**Ruling: RFDB's `derive/stratify.rs` stays NAME-granular** (`Stratum.predicates: Vec<String>`,
`stratify.rs:167`, unchanged). Three reasons, in order of weight:

1. It is the granularity of the **only** stratification mechanism the reference has. The v0
   *kernel* has none at all — divergence run **A4-control** (§0), the same program with boot NOT
   loaded, gives `load ok = true, q[b](X) = ["X = 1"]`, because `engine.ts:201-209
   checkUnstratified` reads `store.relAll(IFACE.unstratified)`, which is empty without boot's
   rules. So the name-granular boundary is the *only* boundary the reference ever draws.
2. It is **conservative**: name-granularity rejects a superset of what RelKey-granularity rejects.
   A program RFDB accepts under it is a program v0+boot also accepts. The failure mode is a
   refused program, never a wrong answer.
3. It keeps `assign_pred_ids` (`exec.rs:3884`), `RulePlan.head: String` (`plan.rs:280`) and hence
   `plan_golden` untouched (§4.7).

Recorded divergence, deliberately: a program that is per-perspective stratifiable but not
per-name stratifiable is REJECTED by RFDB and ACCEPTED by the bare v0 kernel (A4-control). This
is the price of matching v0+boot, which is what the 15 boot-loading tier-1 cases will compare
against. §8.6 T17 pins both sides of it.

A second, pre-existing divergence surfaces here and is worth writing down: v0's engine reads its
strata **from the store**, i.e. from userland boot.rofl (`engine.ts:181-182` `readStrata()` /
`levelOf`), whereas RFDB computes them internally (`translate.ts:137` codes this as
"RFDB stratification is internal, not queryable data"). This design does not change that, and a
`RelKey`-keyed kernel would have made it worse — a RelKey-keyed kernel cannot consume a name-keyed
userland `stratum/2` table at all, which would have blocked the §3.7 layering the rules-as-data
lane depends on.

### 3.10 A head perspective resolving to a NON-ATOM is SKIPPED, not rejected — and that is what bounds `𝒫`

Neither critic raised the question A3a opens: once a perspective can be minted from data
(`q[P](x) :- p[a](P).` concluded `q[zeta](x)`), can the perspective set **grow without bound**
during the fixpoint? If it can, the two-layer map of §2.1 has an unbounded outer key set and
termination is a new proof obligation. Four probes, `/tmp/divprobe/growth.ts` +
`/tmp/divprobe/growth2.ts`, same harness and reference rev as §0. Verbatim:

```
--- G1  p[a](1).   q[P](x) :- p[a](P).          (perspective resolves to an INTEGER)
   load ok = true []            evaluate = {"partial":false}
   r.diagnostics = ["rule r66d43af2: non-ground or open conclusion skipped (q)"]
   factKeys(q) = []
--- G1b p[a](zed). q[P](x) :- p[a](P).          (control: resolves to an ATOM)
   load ok = true []            r.diagnostics = []
   factKeys(q) = ["q[zed](x)"]

G2  n(0). n(N) :- n(M), M < 4, N is M + 1.  q[P](x) :- n(P).
    query n(X) = ["X = 0","X = 1","X = 2","X = 3","X = 4"]      factKeys(q) = []

G3  n(0). n(N) :- n(M), N is M + 1.  q[P](x) :- n(P).     (unbounded mint, no guard)
    elapsed ms = 2989   load ok = true   diags = []   count factKeys(q) = 0

G4  seed[a](b).  seed[P](Q) :- seed[Q](P).     (perspective/argument swap cycle)
    load ok = true   factKeys(seed) = ["seed[a](b)","seed[b](a)"]
```

Mechanism, `engine.ts:277-290 conclude()` (read at rev `052a4c5`):

```ts
const perspT = walk(h.persp, sol.s);
const args = perspT.k === 'a' ? h.args.map((a) => resolve(a, sol.s)) : [];
if (perspT.k !== 'a' || !args.every(isGround)) {
  if (!this.demandRels.has(h.rel)) {
    const msg = `rule ${r.id}: non-ground or open conclusion skipped (${h.rel})`;
    if (!this.diags.includes(msg)) this.diags.push(msg);
  }
  return;
}
```

Two rulings follow.

**Ruling 1 — a non-atom head perspective is a per-solution SKIP with a warning, never a
rejection.** G1 loads `ok = true` and evaluates `partial = false`; the rule stays live, other
solutions of the same rule still conclude, and the only trace is one deduplicated diagnostic
string. RFDB must mirror this exactly. Getting it wrong in either direction is a divergence:
*reject* → RFDB refuses a program v0 loads (G1); *conclude* → RFDB invents `q[1](x)`, a fact v0
does not have. This is emphatically **not** `E-PERSP-002` (§3.3): that one is load-time and fires
only on a **bodyless fact** (A1b, `api.ts:104-107`). A rule head is never rejected for its
perspective — at load time it is checked only for *safety* (`engine.ts:158`
`!groundIn(h.persp) → safe = false`, i.e. the variable must be bound by the positive body), which
RFDB already gets free from `Rule::is_safe()` (`datalog/types.rs:209-219`, T4c).

**Ruling 2 — `𝒫` is data-dependent but FINITE, and that is what makes the fixpoint terminate.**
A perspective can only ever be an atom (`perspT.k === 'a'`). Atoms are never *minted*: v0's
builtins produce integers and strings (`N is M + 1`), and Ruling 1's guard drops every one of
them — G3 mints integers for 2989 ms without a guard and still concludes **zero** `q` facts. So
the reachable perspective set is a subset of {atoms occurring in the program text} ∪ {atoms
already in the store}: finite, and *not enlarged by evaluation*. G4 is the positive control —
a cycle that circulates perspectives through argument positions reaches a fixpoint at `{a, b}`,
exactly the two atoms in the source.

Consequence for RFDB: the outer key set of the two-layer dynamic map (§2.1) is finite and grows
monotonically, which is precisely the condition the existing semi-naive fixpoint and the DRed
maintenance loop already assume for the tuple set. **No new termination argument is required.**
But the property rests on the premise "atoms are never minted", so it must be *tested*, not
assumed — §8.1 T4d and §8.6 T18/T19. Any future builtin that returns a fresh atom breaks Ruling 2
silently, and T19 is the tripwire.

---

## 4. DETERMINISM (A3 canonical sha256, A10 tag_fold invariance)

### 4.1 The requirement, restated adversarially

"If perspective identity leaks into the hash in a way that depends on insertion order, the design
is dead." Three places could leak it: the in-memory `fact_id`, the per-run predicate-id
assignment, and the cross-process canonical encoder. Each is addressed below.

### 4.2 The in-memory `fact_id` encoder is NOT touched

`derive/value.rs:102` — `pub fn fact_id(predicate_id: PredicateId, key: &[Value]) -> u64`, blake3
over `predicate_id.to_le_bytes()` followed by the variant-tagged, length-prefixed values. Its
existing arms are pinned byte-for-byte by the named test
`fact_id_pre_p1_goldens_are_byte_stable` (`derive/value.rs:187-204`, e.g.
`fact_id(7, &[Value::Id(42), s("queue:publish")]) == 0x9c66_1586_b0dd_e512`).

**The perspective enters through the id ASSIGNMENT, not through the encoder.** `fact_id`'s
signature, body and bytes are unchanged; the golden test passes by construction because it calls
`fact_id` with literal `u64`s. This is the single most important mechanical choice in §4: it makes
"did the hash move?" answerable by a test that already exists and that this change does not edit.

### 4.3 The id assignment is ALSO not touched — separation is physical, not by id

Rev 1 turned `assign_pred_ids` into `assign_rel_ids(strat) -> HashMap<RelKey, u64>` so that two
facts with the same tuple in different perspectives could not collide inside one
`Relation.total`. Under the two-layer model (§2.1) that reason evaporates: **a `Relation<T>` only
ever holds one perspective's facts**, because the perspective is the *outer* map's inner key
(`relations: HashMap<String, BTreeMap<String, Relation<T>>>`). Two same-tuple facts in different
perspectives live in two different `Relation`s and cannot collide, whatever their `fact_id`.

So `assign_pred_ids` (`derive/exec.rs:3884-3897`) is left **exactly as it is**:

```rust
fn assign_pred_ids(strat: &Stratification) -> HashMap<String, u64> {
    let mut names: Vec<&String> = strat.strata.iter().flat_map(|s| s.predicates.iter()).collect();
    names.sort();
    names.dedup();
    names.into_iter().enumerate().map(|(i, n)| (n.clone(), i as u64)).collect()
}
```

Its order-independence property (`sort(); dedup(); enumerate()` over a *set* of names) is
inherited unchanged, and `main`-only programs keep byte-identical `predicate_id`s and therefore
byte-identical `fact_id`s — not by an argument about lexicographic order, but because no line of
the function changed.

`derive/increment.rs`'s reserved base ids `NODE_PRED_ID = u64::MAX` / `EDGE_PRED_ID = u64::MAX - 1`
(`increment.rs:176-178`) need no perspective, because base facts are `main`-only by §3.6.

**The obligation this creates instead:** every place that pairs a `fact_id` with a relation must
carry the perspective alongside it, since the id no longer discriminates. Those places are the
inner-map key by construction (`WeightedRelation` and `RelationDelta` are per-`Relation`), plus
`Evaluation::key_set(predicate, pred_id)` (`exec.rs:263`), which gains a perspective argument in
its `_in` twin. §8.5 T14 is the test that would catch a miss.

### 4.4 Cross-process canonical artifacts hash NAMES

A3's sha256 is produced by `facts::fact_key_canon_bytes` / `fid` (`facts/mod.rs:397,417`), whose
layout is `varint(|persp|) ‖ persp ‖ varint(|pred|) ‖ pred ‖ varint(arity) ‖ canon(tuple…)` over
**names**. `facts/convert/reader.rs:236 canonical_state_sha` sorts by (perspective NAME, predicate
NAME, tuple canon bytes) and is already covered by two named order-independence tests:
`canonical_state_sha_is_order_and_id_assignment_independent` (`reader.rs:1291`) and
`canonical_state_sha_author_component_is_the_rank_not_the_name` (`reader.rs:1391`).

**Rule for this lane: the `u64` from §4.3 is an in-process dedup key and must never reach a
persisted or hashed artifact.** Where the derive engine emits canonical output it renders
`RelKey.perspective` as a name through `fact_key_canon_bytes`. `derive/canon.rs:4` already
documents `fid = BLAKE3(canon(perspective, predicate, tuple))[0..16]` as the normative encoder, so
this uses an existing seam rather than inventing one.

### 4.5 A10 tag_fold invariance is preserved by construction

`tag_fold` folds the multiset of tags **at one fact key**; compaction merges records **by key**.
Perspective enters the KEY and never the TAG. Adding it therefore strictly *refines* the key
partition: for `main`-only data every fold input multiset is bit-identical to today, and for
multi-perspective data the folds are correctly separated instead of wrongly merged. A10 needs a
new *fixture* (two perspectives), not a new *argument* — §8.5 T9.

### 4.6 The determinism properties as tests

* **D-1** `rel_ids_are_independent_of_perspective_mention_order` — build the same program with the
  ground EDB shuffled so perspectives are first mentioned in different orders; assert the
  `assign_rel_ids` map is equal.
* **D-2** `fact_id_pre_p1_goldens_are_byte_stable` — **unchanged, must still pass.** This is the
  proof that §4.2 held.
* **D-3** canonical-sha equality across a permutation of the EDB *and* across two processes (A3's
  rebuild-vs-restore), with ≥2 perspectives interned in opposite orders in the two processes.
* **D-4** `plan_golden` bit-identity for all `main`-only programs
  (`derive/golden/p3_plan_fingerprints.txt`, 3,305,368 bytes / 40,816 lines at HEAD) — the
  regression guard that the 35 stdlib packs did not move. §4.7 is what makes it achievable; rev 1
  asserted it and would have broken it.

### 4.7 The rendering contract — what actually makes D-4 hold

Rev 1 listed `plan_golden` as "the single highest-risk unknown ... must be checked before any code
is written". Checked. Under rev 1's design it **breaks**, three independent ways:

```rust
// derive/plan_golden.rs:168-181
fn render_plan(p: &RulePlan) -> String {
    let legs: Vec<String> = p.legs.iter().map(|l| format!(
        "{:?}|{:?}|{}|{:?}|{}", l.literal, l.pattern, render_source(&l.source), l.join, l.estimate
    )).collect();
    format!("head={} estimate={} domains={:?} legs=[{}]", p.head, p.estimate, p.head_domains, legs.join(" ;; "))
}
// derive/plan_golden.rs:160-166
fn render_source(s: &LegSource) -> String { match s {
    LegSource::Derived { name, recursive } => format!("derived:{name}:{recursive}"), ... } }
// derive/plan_golden.rs:214-221 — p.head is interpolated with {} in BOTH the plaintext
// key column and the hashed body.
```
1. `l.literal` is rendered with `{:?}`, and `Literal`/`Atom` have **derived** `Debug`
   (`datalog/types.rs:68-72`, `:113-117`; `grep -rn "impl .*Debug for Atom"` → no output). A new
   field changes the derived output, hence every fingerprint of every rule with ≥1 leg.
2. `render_source` destructures `LegSource::Derived { name, recursive }`; rev-1 step 6 renamed it
   to `{ key: RelKey, recursive }` — a compile error **inside the gate file**.
3. `p.head` (`plan.rs:280 pub head: String`) becomes a `RelKey`, moving the plaintext key column.

Breaks 2 and 3 are gone in this revision: §2.1 leaves `LegSource` and `RulePlan.head` alone. Break
1 is real and is closed by a **normative rendering contract**, not by regenerating the golden
(`plan_golden.rs:277-281`: "running it to silence the gate defeats the gate"):

> **R-1.** `Atom` gets a **hand-written** `Debug` that emits bytes identical to today's derived
> form when `persp == Persp::Implicit`, and appends `, persp: …` only otherwise. `Persp`'s `Debug`
> emits **nothing** for `Implicit`.

Proven with rustc rather than asserted — `/tmp/dbgproof/m2.rs`, compiled and run:

```
today           = Atom { predicate: "edge", args: [Var("X"), Const("t")] }
proposed manual = Atom { predicate: "edge", args: [Var("X"), Const("t")] }
proposed non-main = Atom { predicate: "edge", args: [Var("X"), Const("t")], persp: "audit" }
naive derived   = AtomNaive { predicate: "edge", args: [Var("X"), Const("t")], persp: Name("main") }
manual byte-identical to today : true
naive  byte-identical to today : false
```

This is exactly why §2.1's `Persp` has a distinct `Implicit` variant rather than defaulting to
`Name("main")`: `Name("main")` would have to render *something* to stay honest, and eliding it
would make `p` and `p[main]` indistinguishable in diagnostics — the very distinction A6-3 turns on
(§5). With `Implicit` the elision is faithful: an implicit perspective genuinely has no bracket to
print. Every bundled program is `Implicit`-only at HEAD, since `[` is unparseable today
(§2.4), so R-1 makes D-4 hold for all 40,816 lines by construction.

> **R-2.** `Display for Persp` renders `""` / `[name]` / `[?Var]`; there is no `Display for
> RelKey` because there is no `RelKey`. `PlanError`'s `Display` (`plan.rs:210-212`) keeps printing
> a bare `head: String`.

> **R-3.** `PredicateCount { predicate: String }` (`derive/exec.rs:970-976`) is an emitted-event
> payload on the wire. It gains a sibling `perspective: String` field (always `"main"` for today's
> programs) rather than mangling the name — an additive field, so a name-reading consumer is
> unaffected. The TS/MCP consumer side is still unaudited (§9.3).

---

## 5. NONINTERFERENCE (A6) as a checkable property

A6 restated as three obligations, each an executable test:

**A6-1 (plant).** A fact planted in `[hypothesis]` must not affect `[verified]` absent a bridge.
This is ISO-1 (§3.8) instantiated with `p = verified`, `r = hypothesis`. Test: evaluate `Π` and
`Π ∪ { h[hypothesis](x) }`; assert `eval ↾ verified` is equal. **This test fails the moment any
part of the pipeline reverts to keying on the predicate name alone** — which is exactly the
property §8.3 demands.

**A6-2 (breach carries provenance).** Two distinct breach classes, deliberately separated:
* *engine-owned*: a non-`main` perspective on a base relation → `E-PERSP-001` at plan time, with
  clause index + literal + perspective name (§3.6). A rejection, never a silent empty.
* *policy-owned*: a cross-perspective read that userland's `⊑` disallows → derived as
  `leak[audit](A,B)` / `breach[audit](R)` by boot.rofl (§3.7), whose provenance is the rule id
  carried in `reads_from`/`writes_to`. This half needs the rules-as-data lane and is **not** closed
  by this design; recorded here so the gap is explicit rather than assumed-away.

**A6-3 (bridge).** With a declared bridge, *exactly* the bridged consequences appear.

Rev 1 defined a bridge as "a rule whose head perspective differs from some body literal's
perspective", quoted `reflect.ts:173` as deriving `bridge_decl` "from precisely that condition",
and then **dropped the `c.head.perspExplicit &&` conjunct from its own quotation**. The real
condition is a conjunction:

```ts
// vendor/rofl-v0/src/reflect.ts:171-176
for (const [pk, pa] of [...readPersps.entries()].sort()) {
  facts.push({ rel: V.reads_from, args: [rid, pa] });
  if (c.head.perspExplicit && pk !== canonTerm(headP)) {
    facts.push({ rel: V.bridge_decl, args: [rid, pa, headP] });
  }
}
```

Divergence run A2 (§0) shows the bit is load-bearing, and in the dangerous direction —
`bridge_decl` appears **under negation** at `boot.rofl:31`
(`leak[audit](A,B) :- flow(A,B), not sees(B,A), not bridge_decl(R,A,B).`), so over-generating it
**suppresses** a leak finding:

| program (boot loaded) | `bridge_decl(vault,main)` | `leak[audit](A,B)` |
| --- | --- | --- |
| `honest(X) :- secret[vault](X).` (implicit head) | absent | `["A = vault, B = main"]` |
| `honest[main](X) :- secret[vault](X).` (explicit head) | present (`R = r05385a60`) | `[]` |

**Corrected definition, normative:**

> A rule is a **declared bridge** iff its head perspective was written explicitly
> (`Persp::is_explicit()`) **and** some body literal's perspective differs from it. A rule with an
> implicit head whose body reads a foreign perspective is **not** a bridge — it is a `leak`, and
> that is exactly what `p2-persp-isolation` is (`scenarios.ts:225`: `spy(X) :- secret[open](X).`
> and `honest(X) :- secret[vault](X).` both have implicit-main heads reading a bracketed
> perspective).

This is the reason §2.1's `Persp` needs three variants. A two-variant `Persp{Name,Var}` destroys
the bit at parse time, downstream of which *at most one* of the two rows in the table above is
reproducible, and `p2-persp-isolation` — the single case this design exists to flip — is on the
side the two-variant enum gets wrong.

The engine still enumerates bridges statically (the head's `Persp` and each leg literal's `Persp`
are both in the plan, `PlanLeg.literal`, `plan.rs:262`) — that part of rev 1 survives; only the
predicate changed. Emitting `bridge_decl` as a *fact* remains the rules-as-data lane's job (§9.8).

Test: `Π` with no bridge → `eval ↾ verified` unchanged by the planted fact;
`Π + { v[verified](X) :- h[hypothesis](X). }` → `eval ↾ verified` gains exactly the image of the
bridged relation and nothing else (set equality, not containment). Plus **T8c**: the two rules of
the A2 table classify differently under `is_explicit()`.

---

## 6. ENGINE INTEGRATION

### 6.1 The first landable increment — flips `p2-persp-isolation` RED → GREEN

**Named case:** `p2-persp-isolation` — `packages/rofl-conformance/src/scenarios.ts:225`,
`sourceRef` `test/phase2.test.ts:118`, currently RED with
`"perspective [vault] in clause 1: RFDB has no perspective dimension"`.

```ts
await r.load(`
  secret[vault](s1).
  spy(X)    :- secret[open](X).
  honest(X) :- secret[vault](X).
`);
assert.deepEqual((await r.query('spy(X)')).rows, []);
assert.deepEqual((await r.query('honest(X)')).rows.map(x => x.text), ['X = s1']);
```

It uses **atom perspectives only** — no perspective variables, no cross-perspective heads, no
base legs. So the first increment is scoped to exactly that: parse `[name]`, add the inner
perspective level to `relations`/`Evaluation`, reject non-`main` base legs in `classify`, thread
the target perspective to the wire, and **make the conformance round trip perspective-carrying**.
Perspective **variables** (§3.2) and the reflection facts boot.rofl needs are increment 2 and 3 —
the mechanism is designed for them here, but they are not in the first slice.

Expected effect on the report: `missing:perspectives` count 1 → 0; GREEN 5 → 6 — **conditional on
step 12 below**, which rev 1 got wrong (see §6.3). Until step 12 lands in full, deleting the
Phase-2 gate turns this case from an honest `UnsupportedFeature` RED into a **silent wrong
answer**, which is worse than the RED. Step 12 is therefore not optional polish; it is the
increment.

### 6.2 Ordered change list

| # | file | change |
| --- | --- | --- |
| 1 | `datalog/types.rs` | add `Persp{Implicit,Name,Var}` + `resolved()`/`is_explicit()`; add private `persp: Persp` to `Atom` (`Atom::new` defaults to `Implicit`, new `Atom::new_in`); add `Atom::persp()`; **hand-written `Debug for Atom`/`Persp` per §4.7 R-1** (this is D-4's whole guard); **include the perspective var in `Atom::variables()`** (this is what makes §3.3's head-var safety check work for free) |
| 2 | `datalog/parser.rs` | in `parse_atom` (`:225`), after `parse_identifier` (`:89`): on `[`, parse ident → `Persp::Name` / uppercase → `Persp::Var`, `expect("]")`; absent ⇒ `Persp::Implicit` |
| 3 | `derive/parser_ext.rs` | reject a **bodyless fact** whose perspective is not concrete, `E-PERSP-002`, inside `parse_ext_program` (`:863`) — per the rules-as-data design's "the read seam belongs INSIDE `parse_ext_program`". A **rule head** with `Persp::Var` is NOT rejected (§3.3) |
| 4 | `derive/stratify.rs` | **NO CHANGE.** `Stratum.predicates: Vec<String>` stays (`:167`); dependency edges stay name-granular, deliberately (§3.9) |
| 5 | `derive/catalog.rs` | **no key change** — `PredicateDecl`/`declare_strict`/`get` stay name-keyed, so arity conflicts stay per-name (`E-CAT-002` unchanged, and more conservative than per-perspective). Add `is_base_name(&str) -> bool` reading the existing `base_names` (`:190`) for §3.6 |
| 6 | `derive/plan.rs` | `classify` (`:1162`) takes `&Persp` and rejects a base name in a non-`main` perspective **first**, before its five arms — `E-PERSP-001` (§3.6). One call site (`:615`). `RulePlan.head` stays `String`, `LegSource` unchanged, `PlanLeg.literal` already carries the perspective (`:262`). `FactStats::from_rules` counts per (perspective, predicate). **Increment 2**: exclude a negated leg's perspective var from the all-args-bound check (`:940-941`), per §3.2 |
| 7 | `derive/exec.rs` | `relations` (`:894`) → `HashMap<String, BTreeMap<String, Relation<T>>>`; `Evaluation.relations` (`:248`) → `BTreeMap<String, BTreeMap<String, Vec<Box<[Value]>>>>`; `facts(&str)` (`:254`) keeps its signature = the `main` projection, new `facts_in(persp, pred)`; `key_set` (`:263`) gains a `_in` twin; `rules_by_head` (`:884`), `seeded` (`:1358`), `delta_next` (`:1448`), `Clause.head_pred` (`:3397`) stay name-keyed at the top level and gain the inner perspective; `assign_pred_ids` (`:3884`) **unchanged** (§4.3); `PredicateCount` (`:970-976`) gains an additive `perspective` field (§4.7 R-3); `DerivationWitness.body: Vec<(String, String, Box<[Value]>)>` = (perspective, predicate, tuple) |
| 8 | `derive/increment.rs`, `derive/binding.rs` | the per-relation delta maps gain the same inner perspective level; `fact_id` stays opaque (`increment.rs:49-50`); reserved base ids unchanged (§4.3) |
| 9 | `derive/pin_sidecar.rs` | encode the inner perspective level in `encode_evaluation` (`:240-249`, currently `for (name, rows) in &eval.relations`); **bump `MAGIC` `b"RFD2PIN1"` → `b"RFD2PIN2"`** (`:74`) — its doc already says "Bump on any layout change: an unknown magic loads as `None` (⇒ scratch), never as a misparse", so a rolled-back binary cold-starts instead of misreading |
| 10 | `graph/engine_v2.rs` | `eval_derive(source, target_predicate: &str, …)` (`:539`) gains a perspective argument (defaulted at the 86 `eval_derive` mention sites via a `_in` twin, so existing callers are untouched); the D2 pinned-cache tuple (`:256-267`) carries the new `Evaluation` |
| 11 | `bin/rfdb_server.rs` | `route_datalog_engine` (`:2868`) passes `target.persp()` alongside `target.predicate()`; the three dispatchers (`dispatch_execute_datalog:2942`, `dispatch_datalog_query`, `dispatch_check_guarantee`) pass it through |
| 12 | `rofl-conformance/src/translate.ts` + `adapter.ts` | **the full round trip, not just the gate** — see §6.3. Rev 1's "render `[persp]` in `renderSource`" is structurally unreachable |
| 13 | `derive/materialize.rs` | `E-PERSP-003` when a `@materialize` / `@materialize_node` head is not implicit-`main` (§6.4). Rev 1 listed this file neither as changed nor as untouched |
| 14 | `datalog/eval.rs` (v1 explain path) | `E-PERSP-004` refusal instead of a silent perspective-blind answer (§6.5) |

Steps 1-3, 5-14 are the first increment. The increment-2 items are: `classify`'s negated-leg
perspective-var exclusion (step 6) and the `Persp::Var` body-leg inner-map iteration in step 7
(perspective variables, needed by boot.rofl).

### 6.3 The conformance round trip — rev 1's step 12 was unreachable

Rev 1 said step 12 was "delete the Phase-2 gate (`translate.ts:157`) and the two `checkLitMeta`
perspective branches (`:137`, `:140`); render `[persp]` in `renderSource`". `renderSource`
(`translate.ts:346-359`) only concatenates already-built `r.text` and the ground-fact table — it
cannot reach where the perspective is dropped. The perspective is dropped in four places, all
inside `translate()`:

```ts
// translate.ts:283,292 — the ground-fact table is REL-KEYED and the dedup key is persp-blind
const groundFacts = new Map<string, string[][]>();
const key = `${rel}(${args.join(',')})`;
// translate.ts:314,319 — the RULE TEXT is built here, with no perspective
bodyParts.push(`${PFX}${b.lit.rel}(${b.lit.args.map(rn).join(', ')})`);
bodyParts.push(`\\+ ${PFX}${b.lit.rel}(${b.lit.args.map(rn).join(', ')})`);
// translate.ts:332 — programRels is a list of NAMES
const programRels = [...new Set(clauses.flatMap((c) => litsOf(c).map((l) => l.rel)))];
// translate.ts:374 — the dump rule carries no perspective
const dumpRule = `xdump(${vars.join(', ')}) :- ${PFX}${rel}(${vars.join(', ')}).`;
```
and two more on the adapter side (read with python — see the research hazard below):
```ts
adapter.ts:134  async dumpRel(rel: string)          // rel-keyed
adapter.ts:147  for (const tuple of t.groundFacts.get(rel) ?? [])  // unconditional union
adapter.ts:277  out.push(`${r}[main](${tuple.join(',')})`)         // hardcoded [main]
adapter.ts:284-289 domainFactSet — documented "persp-stripped"
```

With rev-1 step 12 exactly as written, `secret[vault](s1).` renders as `u_secret("s1").` in
`main`, `spy(X) :- secret[open](X).` renders as `u_spy(X) :- u_secret(X).`, and
`(await r.query('spy(X)')).rows` returns `s1` where `scenarios.ts:225-236` asserts `[]`. The case
does not flip — it degrades from an honest RED into a **silent wrong answer inside the
conformance harness**, which is the exact failure mode this migration round exists to prevent.

**Corrected step 12, normative:**
1. `TransFact`/`groundFacts` become keyed by `(rel, persp)`; the dedup key becomes
   `${rel}[${persp}](${args})`.
2. `bodyParts` (`:314`, `:319`) and the head (`:322-325`) render `${PFX}${rel}[${persp}](...)`,
   with `[...]` emitted only when the source wrote it (`perspExplicit`) so main-only programs go
   to the wire byte-identically to today.
3. `programRels` becomes a list of `(rel, persp)` pairs; `renderDumpSource`/`dumpRel`/`factKeys`/
   `domainFactSet`/`groundFactsOf` take the pair.
4. `factKeys` (`adapter.ts:277`) renders the real perspective instead of the literal `[main]`;
   `domainFactSet` keeps stripping it (it is the persp-blind comparison surface **by design**) but
   a new `perspFactSet` is what T15's perspective axis compares, otherwise T15 passes vacuously.
5. `explainDatalogFact`/`explainDatalogGap` (`adapter.ts:215`, `:227`) send
   `USER_PREFIX + rel + [persp]`; the witness rendering must match `p2-why-tree`'s expected
   `path[main](a,c)` shape (`scenarios.ts:214-219`).

**Research hazard, recorded because it invalidates tool output:** `adapter.ts` contains NUL bytes
(`tuple.join('\x00')` at lines 143 and 148), so plain `grep` silently reports nothing:
```
$ grep -n "dumpRel" packages/rofl-conformance/src/adapter.ts ; echo "exit=$?"
exit=1
$ grep -a -n "dumpRel" packages/rofl-conformance/src/adapter.ts | head -3
134:  async dumpRel(rel: string): Promise<string[][]> {
157:    for (const rel of t.programRels) out.set(rel, await this.dumpRel(rel));
182:    const tuples = await this.dumpRel(lit.rel);
```
Use `grep -a` or python for every claim about that file. Rev 1's adapter claims were made with the
tool that returns nothing.

### 6.4 `@materialize` write-back — rev 1 audited the writes and missed the reads

Rev 1 §9.3 confirmed the 16 `eval.relations.insert` sites in `materialize.rs` are behind
`#[cfg(test)]` (`materialize.rs:656` — verified, correct) and concluded the blast radius was
bounded. That audited **write** sites. Two **production read** sites key `Evaluation` by predicate
name:

```
derive/materialize.rs:340   for fact in evaluation.facts(&spec.predicate)   // plan_node_writeback
derive/materialize.rs:437   for fact in evaluation.facts(&spec.predicate)   // plan_writeback (pub, :422)
```
with `MaterializeSpec { predicate: String, edge_type: String, rule_ast_hash: String }`
(`materialize.rs:126-130`). The write-back target is a **perspective-free graph edge** (module doc
`materialize.rs:3-5`: "a binary derived fact `p(A, B)` becomes a graph edge `A —T→ B`"), and the
provenance stamp is perspective-blind: `rule_ast_hash` (`:578-603`) digests `encode_atom(head)` +
body, and `encode_atom` (`:620-625`) encodes **only** `atom.predicate()` and `atom.args()`. So
`@materialize(edge_type="T")` on `p[hypothesis](A,B)` and on `p[verified](A,B)` would produce the
same `_source` stamp on the same edge type, and `materialize.rs:26-30` documents that a matching
`_source` means a re-run "OVER-WRITES its own prior generation's edges" — one perspective silently
destroying another's committed edges. That is a persistent breach of A6-1 on the storage path.

Two rulings close it:
* `facts(&str)` keeping its `main`-only meaning (§2.1) means the write-back can never *silently*
  pick up a non-`main` fact. That is the containment half.
* The non-silence half: **`E-PERSP-003`** at spec-collection time
  (`collect_materialize_specs` / `collect_materialize_node_specs`) when the annotated rule's head
  perspective is not `Persp::Implicit` or `Persp::Name("main")`. Projecting a perspectival fact
  into a perspective-free edge is a category error of the same shape as §3.6's base-leg read, and
  gets the same treatment: a coded rejection, never a silent no-op and never an overwrite.

`derive/materialize.rs` accordingly moves from "unmentioned" to change-list step 13.

### 6.5 The v1 explain path must refuse, not answer

Rev 1 §9.4 named this and left it undesigned. It is on the **live** path:
`dispatch_execute_datalog` routes `explain: true` away from the derive engine
(`bin/rfdb_server.rs:2946 if derive_engine_enabled() && !explain`), and the ROFL adapter's
`why`/`whynot` both go through explain (`adapter.ts:215`, `:227`). Since `datalog/eval.rs` shares
`parse_atom`, it would parse `[persp]` and ignore it.

Ruling: **`E-PERSP-004`** — `datalog/eval.rs` refuses any program containing an atom with
`Persp::is_explicit() == true`, with the message naming the literal and pointing at the derive
engine. A perspective-blind wrong answer on the explain path would be indistinguishable from a
correct one to the harness. Change-list step 14.

### 6.6 Deliberately NOT touched

* `derive/value.rs` — §4.2.
* `derive/storage_glue.rs` / `StorageView` / `SegmentType` / any on-disk graph format — §2.3(d).
* `facts/` — it already has the dimension (§1.1); this lane *consumes* its constants and canonical
  encoder, it does not modify them.
* `derive/stratify.rs` — name-granular by ruling, §3.9.
* `derive/exec.rs::assign_pred_ids` — §4.3.
* `derive/plan.rs`'s `RulePlan.head` / `LegSource` types — §2.1, §4.7.

(`datalog/eval.rs` has MOVED out of this list: rev 1 put it here, but leaving it perspective-blind
on the live `explain` path is a silent wrong answer. It is change-list step 14, §6.5.)

### 6.7 Gating

The ТЗ asks for a `rofl_mode` feature gate. It does not exist at HEAD:
```
$ grep -rn "rofl_mode\|ROFL_MODE" --include=*.rs --include=*.toml packages/rfdb-server/
(no output)
$ grep -n "^\[features\]" -A 6 packages/rfdb-server/Cargo.toml
89:[features]
90-default = ["ui"]
94-ui = ["dep:rust-embed", "tower-http/fs"]
95-embedding = [
```
Since a `main`-only program is bit-identical under this design (§2.4 parsing, §4.2 hashing, §4.3
ids, §4.5 folds, §4.7 rendering), the protection that actually matters for the prod asset is the
**`plan_golden` bit-identity gate** (D-4) plus the existing 51/51 Gate A, not a cargo feature.

A critic attacked this reasoning as circular — "the design's sole chosen safety mechanism is the
one the change provably destroys" — and under **rev 1** that was correct (§4.7 lists the three
breaks). It no longer is: rev 2 does not change `RulePlan`, `LegSource` or `assign_pred_ids` at
all, and the one remaining exposure (`Atom`'s derived `Debug` inside `render_plan`'s `{:?}`) is
closed by the R-1 rendering contract, proven byte-identical with rustc in §4.7. D-4 is therefore
a live gate again rather than a prediction.

Recommendation unchanged: land without a new cargo feature and let D-4 be the gate; if the owner
wants the feature anyway, it is additive and independent of this design. Flagged as an open
question rather than decided unilaterally. **Order of work is now load-bearing:** step 1's `Debug`
impl and a `cargo test -p rfdb-server plan_golden` run must land in the SAME change as the `Atom`
field, or the gate goes red on the first commit.

---

## 7. INCREMENTALITY

### 7.1 A perspective change cannot reuse stale maintained state — structurally

The D2 pinned cache and the durable sidecar are keyed by `program_key`, a `DefaultHasher` over the
**source text** (`graph/engine_v2.rs:960-963`, mirrored at `:6064-6069`). Changing any literal's
perspective changes the source text, hence the program key, hence there is no prior entry to
reuse. This is not a new mechanism; it is the existing one being sufficient. No perspective-aware
invalidation logic is needed at the program level.

### 7.2 Within one program

* `WeightedRelation<T> = BTreeMap<u64, (Box<[Value]>, T)>` is keyed by `fact_id`, treated
  opaquely (`increment.rs:12,46-50`). Under §4.3 `fact_id` is **not** perspective-scoped — the
  separation is physical: one `WeightedRelation` belongs to one `(predicate, perspective)` inner
  entry, so two same-tuple facts in different perspectives are in different maps and cannot
  collide. The delta algebra, `apply_counted`/`apply_set` and the DRed over-delete/re-derive need
  **no** perspective logic *inside* a relation; they need the inner map level *around* it.
* `RelationDelta`s are held per relation; that map gains the same inner perspective level (step 8).
* `BaseDelta` (`increment.rs:186-192`) stays perspective-free: base facts are `main`-only (§3.6),
  so a base delta can only seed `main` legs. Derived facts in other perspectives change only
  through rules, which the existing Δ-loop already propagates.
* **Sidecar reload.** Rev 1 said the prior `Evaluation` is "re-keyed at load using the current
  run's `assign_rel_ids` map … so a program that adds a perspective simply gets a different id
  assignment". A critic correctly pointed out that this contradicts §7.1: the sidecar is reached
  through the same source-text `program_key`, so "a program that adds a perspective" can never
  find a prior entry. Both halves of the confusion are dropped. The accurate statement is
  narrower and still true: the sidecar persists **names + rows, not ids**
  (`pin_sidecar.rs:240-249` `for (name, rows) in &eval.relations`), so ids are re-derived from
  `assign_pred_ids` on load and nothing id-shaped crosses the process boundary. §4.4's rule ("the
  `u64` is an in-process dedup key and must never reach a persisted artifact") is what makes the
  MAGIC bump (step 9) the *only* compatibility concern.
* The monotone envelope for `maintain_datalog_v2` is unchanged: it is a property of negation and
  stratum shape, not of perspectives.

### 7.3 The obligation this creates

`maintained ≡ scratch` must be re-proved with a two-perspective program — §8.5 T14 — because that
is the only place where a keying mistake (e.g. one map that forgot the inner perspective level and
merged two perspectives' rows) would show up as a *wrong answer* rather than a compile error.
Under rev 1's flat `RelKey` a miss was mostly a compile error; under rev 2's two-level map a
missing inner level compiles fine and silently merges, so **T14 carries more weight than it did**
and is not optional.

---

## 8. TEST PLAN

### 8.1 Parser / types (unit, `datalog/`)

* **T1** `parse_atom_reads_perspective_bracket` — `secret[vault](s1)` → `persp == Persp::Name("vault")`,
  predicate `secret`, arity 1.
* **T2** `atom_without_bracket_is_implicit_and_resolves_to_main` — `secret(s1)` →
  `Persp::Implicit`, `resolved() == Some("main")`, `is_explicit() == false`; and
  `Atom::new("p", vec![])` likewise (the 168-call-site compatibility claim, §2.2.4).
* **T2b** `implicit_and_explicit_main_are_distinct_literals` — `p(X)` ≠ `p[main](X)` under
  `PartialEq`, but `resolved()` is equal for both. This is the bit A6-3 turns on (§5); it is the
  test that would fail if someone "simplifies" `Persp` back to two variants.
* **T2c (D-4's real guard)** `atom_debug_is_byte_identical_when_implicit` —
  `format!("{:?}", Atom::new("edge", vec![Var("X")]))` equals the string pinned in the test body,
  which is the pre-change derived form (§4.7 R-1).
* **T3** `perspective_variable_counts_as_a_variable` — `p[P](X)` → `variables()` contains `P`.
* **T3b** `negated_leg_with_unbound_perspective_var_is_existential_not_rejected` — the A3b
  program; asserts `clean(X) == {b}`, i.e. `E-PLAN-002` does **not** fire (§3.2). This is the test
  that pins the deliberate exclusion from `plan.rs:940-941`.
* **T4** `bodyless_fact_with_non_concrete_perspective_is_rejected` — `secret[P](s1).` →
  `E-PERSP-002` with clause index. And **T4b**
  `rule_head_perspective_variable_is_accepted_and_concludes_per_row` — the A1 program; asserts
  both `copy[vault](s1)` and `copy[open](s2)` derive (§3.3).
* **T4c** `unbound_head_perspective_variable_is_unsafe` — `copy[P](X) :- secret[vault](X).` →
  `is_safe() == false` via the existing `head_vars ⊆ positive_body_variables` path, no new code.
* **T4d (§3.10 Ruling 1)** `non_atom_head_perspective_skips_the_solution_with_a_warning` — the G1
  program `p[a](1). q[P](x) :- p[a](P).` → program **accepted**, `q` empty, exactly one warning
  diagnostic naming the rule and `q`; and the G1b control `p[a](zed).` derives `q[zed](x)` with no
  diagnostic. Asserts a skip, not `E-PERSP-002` and not an invented `q[1](x)`.
* **T4e (§3.10 Ruling 2)** `perspective_set_is_closed_under_evaluation` — the G4 program
  `seed[a](b). seed[P](Q) :- seed[Q](P).` reaches a fixpoint whose perspective set is exactly
  `{a, b}`, the atoms in the source; assert on the *set of outer keys* of the dynamic map, so the
  test fails if evaluation ever mints an outer key.

### 8.2 Planner (unit, `derive/plan.rs`)

* **T5** `base_leg_in_non_main_perspective_is_rejected_with_provenance` — `node[audit](X)` →
  `E-PERSP-001` whose message names the clause, the literal and `audit`. Asserts a *rejection*, not
  an empty result (§3.6). **T5b** `base_leg_with_perspective_variable_is_rejected` — `node[P](X)`,
  same code (closes the `Persp::Var`-on-base underspecification).
* **T5c (the regression this design nearly shipped)**
  `base_leg_in_non_main_is_not_swallowed_by_the_open_space_arm` — asserts that the rejection is
  raised BEFORE `classify`'s arm 4, by building a `PredicateCatalog::with_base_relations()` (where
  `catalog.get("node").is_some()`, `catalog.rs:251`) and asserting `E-PERSP-001`, not an empty
  `LegSource::Derived`.
* **T6** `derived_leg_in_unpopulated_perspective_is_an_empty_relation` — the `spy` half of
  `p2-persp-isolation`, at the plan/exec level.
* **T6b** `materialize_on_a_non_main_head_is_rejected` — `E-PERSP-003` (§6.4), asserting a coded
  error rather than zero edges written.

### 8.3 The isolation tests (these FAIL if isolation is broken)

* **T7** `facts_in_one_perspective_are_invisible_to_another` — the `p2-persp-isolation` program in
  Rust: `secret[vault](s1).` ⊢ `spy` = ∅ and `honest` = {s1}. Fails if any map loses the inner
  perspective level and merges.
* **T8 (A6-1, the strong one)** `planting_a_fact_in_hypothesis_does_not_change_verified` — build
  `Π`, evaluate, project `↾ verified`; add `h[hypothesis](x)`, evaluate, project again; `assert_eq!`.
  Then **T8b (A6-3)**: add the bridge rule `v[verified](X) :- h[hypothesis](X).` and assert the
  projection grows by *exactly* the bridged image (set equality both ways).
  T8 is the test that would fail if any map in §6.2 steps 7-9 lost its inner perspective level.
* **T8c (A6-3's real predicate)** `implicit_head_reading_a_foreign_perspective_is_not_a_bridge` —
  the two rules of the §5 A2 table classify differently under `is_explicit()`. Guards against
  re-collapsing `Persp` to two variants, which would make `p2-persp-isolation` classify as a
  bridge and suppress a leak.

### 8.4 Determinism

* **T9** = D-1 `pred_ids_are_independent_of_perspective_mention_order` — with `assign_pred_ids`
  unchanged (§4.3) this is now a *characterisation* test: adding perspectives must not perturb the
  name-keyed id map at all.
* **T10** = D-2 — the existing `fact_id_pre_p1_goldens_are_byte_stable` re-run unmodified.
* **T11** = D-3 — canonical sha equality across EDB permutation and across two OS processes with
  ≥2 perspectives interned in opposite orders (A3).
* **T12** = D-4 — `plan_golden` diff empty for `main`-only programs, i.e. all 40,816 lines of
  `derive/golden/p3_plan_fingerprints.txt` unchanged. **Must be run in the same change as step 1**
  (§6.7).

### 8.5 Compaction / incrementality

* **T13 (A10)** `tag_fold_invariant_across_compaction_with_two_perspectives` — the existing A10
  fixture duplicated into a second perspective; pre/post-compaction folds equal per
  (perspective, predicate).
* **T14** `maintained_equals_scratch_with_two_perspectives` — mirrors the existing
  maintained≡scratch cycle proof (`graph/engine_v2.rs:4956` `scratch_at`, `:4980`
  `assert_eq!(maintained.relations, scratch.relations)`) with a two-perspective program, insert
  and delete cycles.

### 8.6 Differential against the vendored v0 reference

* **T15** — extend the tier-0 differential generator (120 seeds, 0 divergences at the report's
  `rfdb.gitSha bc3db6c16ce3be254a2faaf11983dcc88ebb9100`) with a **perspective axis**: each seed
  draws relation perspectives from a small pool (`main`, `p1`, `p2`), atom form in increment 1 and
  atom+variable form (including a **head** perspective variable, A1, and one drawn from the
  argument pool, A3a) in increment 2. Run `vendor/rofl-v0` (rev `052a4c5`) and rfdb on the same
  seed; compare answer sets.
  **T15 is only meaningful after step 12's item 4**: `adapter.ts:284-289 domainFactSet` is
  documented "persp-stripped", so comparing through it cannot distinguish `p[a]` from `p[b]` and
  the perspective axis would pass **vacuously**. T15 compares through the new `perspFactSet`.
* **T15b (the nine §0 programs as fixtures)** — A1, A1b, A2-implicit, A2-explicit, A3a, A3b, A4,
  A4-control and ISO-1 become named tier-1 differential fixtures with the v0 answers recorded in
  §0 as the expectations. Every one of them refuted something in rev 1; they are the cheapest
  possible guard against re-introducing it.
* **T16** — conformance ratchet: `p2-persp-isolation` GREEN, and the report's reason-code histogram
  contains **no** `missing:perspectives` entry.
* **T17 (the recorded stratification divergence, §3.9)** — the A4 program is asserted **rejected**
  by RFDB (name-granular), and the report records that the bare v0 kernel accepts it (A4-control).
  A test that *documents* a divergence rather than hiding it; if someone later makes stratify.rs
  RelKey-granular, T17 goes red and the ruling gets re-opened deliberately.
* **T18 (§3.10 Ruling 1, differential)** — G1, G1b and G2 as tier-1 fixtures with the v0 answers
  recorded in §3.10 as expectations (`q` empty for the integer perspective, `q[zed](x)` for the
  atom control). This is the fixture that catches "RFDB rejected a program v0 loads" and
  "RFDB invented `q[1](x)`" as *different* failures.
* **T19 (§3.10 Ruling 2, the tripwire)** — G3, the unguarded integer mint, asserted to conclude
  **zero** facts in the perspective-carrying head under a bounded step budget. If a future builtin
  ever returns a fresh atom, the finiteness premise behind Ruling 2 dies and T19 is the only place
  that notices before the fixpoint stops terminating.

---

## 9. WHAT I COULD NOT VERIFY

Revision 2's list. It **supersedes** rev 1's; where a later section says "Rev 1 §9.3" or
"Rev 1 §9.4" it is citing the *previous* revision's list, which is exactly why those two items
now have designs (§6.4, §6.5) instead of entries here.

### 9.1 Nothing in this design has been compiled

This revision changed exactly one file — this document. No Rust source was touched for it:

```
$ git diff packages/rfdb-server | grep -ci "persp"
0
```

(The working tree *does* carry concurrent, unrelated `rfdb-server` edits from another lane —
`bin/rfdb_server.rs`, `datalog/mod.rs`, `graph/engine_v2.rs`, new `datalog/wire.rs`, mtimes
13:24–13:39 today, **0** perspective mentions between them. They are not this design's and were
not touched.)

The only compiled artifact in the entire revision is the standalone rustc model
`/tmp/dbgproof/m2.rs` (§4.7). Every source-compatibility claim is therefore *read-and-reason*,
not compiler-checked:

| claim | measured at HEAD | but not compiled |
| --- | --- | --- |
| `Evaluation::facts(&str)` stays source-compatible | `grep -rn "\.facts(" --include=*.rs packages/rfdb-server/src \| wc -l` → **135** | yes |
| `Atom::new` keeps its arity | `grep -rn "Atom::new" --include=*.rs packages/rfdb-server/src \| wc -l` → **168** | yes |
| `PlanLeg` gains a `Persp` without moving `render_plan` | `plan.rs:250-272`, `plan_golden.rs:160-189` read | yes |

Any one of these may fall on first build. §6.1's first increment exists to convert them into
compiler facts; it is the falsification step for this whole document.

### 9.2 D-4 is proved on a model, not on the real `Atom`

`/tmp/dbgproof/m2.rs` proves the *rendering contract* — a hand-written `Debug` that elides
`Persp::Implicit` is byte-identical to today's derived output, a naive derived one is not — on a
two-field stand-in, not on `datalog/types.rs:68-72`. The real check (add the field + the
hand-written impl, run `cargo test --lib derive::plan_golden`) was **not run**.

What I *did* verify about the gate:

```
$ wc -l  packages/rfdb-server/src/derive/golden/p3_plan_fingerprints.txt
40816
$ grep -c "|ERR|" packages/rfdb-server/src/derive/golden/p3_plan_fingerprints.txt
4
$ head -1 packages/rfdb-server/src/derive/golden/p3_plan_fingerprints.txt
pack:js_local_refs|prod|0|rt_global|e39667ac5e132cb50fd9d35174b3cff2
$ grep -m1 "|ERR|" packages/rfdb-server/src/derive/golden/p3_plan_fingerprints.txt
fixture:fx_cross_join_reject|prod|ERR|E-PLAN-003|h
$ grep -c "legs=\[\]" packages/rfdb-server/src/derive/golden/p3_plan_fingerprints.txt
0
```

So 40,812 lines carry a 32-hex digest of `render_plan`'s output — which embeds `{:?}` of the
literal (`plan_golden.rs:160-189`) — and none of them is a legs-empty plan whose render would
omit it. The structural claim "those 40,812 move if `Debug` moves, and only those" is sound on
these counts. It has still never been *executed*.

### 9.3 No performance number, anywhere

The two-layer dynamic map (§2.1) adds one map lookup per relation access on the join hot path,
and replaces a flat `HashMap<String, Relation<T>>` with `HashMap<String, BTreeMap<String,
Relation<T>>>`. I did not benchmark it, did not measure a baseline, and did not re-run the derive
phase. §2.1's argument that the inner map is single-entry for every program in today's corpus is
a *structural* claim about programs that carry no `[p]` — it is not a measurement, and it says
nothing about a boot-loading program where `|𝒫| > 1`.

### 9.4 `E-PERSP-003` and `E-PERSP-004` have no oracle at all

v0 has no `@materialize` and no explain surface shaped like RFDB's:

```
$ grep -rn "materialize" packages/rofl-conformance/vendor/rofl-v0/
src/engine.ts:390:            // already-materialized demand result outside the front window
src/engine.ts:406:   *  results are materialized into the store with full provenance. */
```

Both hits are prose about demand results; neither is a directive. So §6.4's rejection of
`@materialize` on a non-`main` head and §6.5's explain refusal are **policy choices that cannot
be validated differentially**. They are falsifiable only against an owner ruling, not against the
reference. I flag them as the two weakest load-bearing decisions in the document.

### 9.5 The tier-0 perspective axis (T15) is designed, not attempted

The generator was not modified. The baseline it must not disturb, read live from
`packages/rofl-conformance/conformance-report.json` at run
`rofl-conformance-1787489578948` / `2026-08-23T12:52:58.948Z`:

```
engines {"v0":{"rev":"052a4c5"},"rfdb":{"gitSha":"bc3db6c16ce3be254a2faaf11983dcc88ebb9100", …}}
tier0   {"seeds":120,"divergences":[],
         "witnessChecks":{"passed":325,"failed":0},"whynotChecks":{"passed":554,"failed":0}}
```

`bc3db6c1` is one commit behind HEAD `95844d6e` (`git merge-base --is-ancestor …` → ancestor;
`git rev-list --count bc3db6c1..HEAD` → `1`), and that commit is docs-only, so the baseline is
current for code purposes. Whether the seed grammar can carry a perspective axis **without**
invalidating those 120 recorded seeds is unverified — the honest risk is that adding the axis
changes seed→program derivation and silently re-bases the whole tier-0 baseline.

### 9.6 Today's suite exercises exactly one perspective scenario, so most of §3 is untested by construction

Live tier-1 verdict histogram from the same report:

```
GREEN / -                        5
RED / dialect:untranslatable     2
RED / missing:compound-terms     1
RED / missing:whynot-shape       1
RED / missing:perspectives       1
RED / missing:rules-as-data     18
RED / missing:excise             1
RED / missing:holes              1
```

and the single perspective case:

```
{"id":"p2-persp-isolation","sourceRef":"test/phase2.test.ts:118","tier":"tier1",
 "verdict":"RED","reason_code":"missing:perspectives",
 "evidence":"perspective [vault] in clause 1: RFDB has no perspective dimension"}
```

One scenario. Everything §3 rules on beyond exact-match visibility — A3b's existential negation
(§3.2), the A1 head variable (§3.3), the §3.10 non-atom skip — has **no** scenario behind it
today. §8's T-numbers are the plan to fix that; none of them exists yet.

### 9.7 Incrementality with perspectives has never been executed

maintained ≡ scratch has never been run on a perspective-carrying program, because such a program
cannot be loaded. §7.1's argument — a perspective change alters the program text, hence the rule
hash, hence the cache misses — is structural, not demonstrated. T14 is the demonstration and it
does not exist.

### 9.8 The RocksDB store path is argued from a read, not exercised end-to-end

§1.3's claim that no storage change is on the critical path rests on reading `translate.ts` and
`adapter.ts` and finding that the ROFL EDB reaches the engine as *program text*. I read those; I
did not run a perspective-carrying ROFL program end-to-end through a RocksDB-backed
`rfdb-server`, because the feature does not exist. The one storage-side fact I did verify runs
the *other* way: `AssertBatch.perspective` must be `PERSPECTIVE_MAIN` or `E-CAP-001`
(`facts/mod.rs:261-263`), which is precisely why §3.6 rejects non-`main` base legs rather than
plumbing them.

### 9.9 `perspExplicit`'s consumer set — verified, and recorded because rev 1 assumed it

```
$ grep -rn "perspExplicit" packages/rofl-conformance/vendor/rofl-v0/src/
src/parser.ts:11:  perspExplicit: boolean; // was [p] written in the source?
src/parser.ts:167:    let perspExplicit = false;
src/parser.ts:175:      perspExplicit = true;
src/parser.ts:181:    return { rel, persp, perspExplicit, args, temporal };
src/reflect.ts:88:    perspExplicit: true,
src/reflect.ts:173:    if (c.head.perspExplicit && pk !== canonTerm(headP)) {
```

Four declaration/assignment sites, one synthesized literal, and exactly **one** semantic
consumer — `reflect.ts:173`, which gates `bridge_decl` emission. That single line is the entire
A2 divergence and the entire justification for `Persp::Implicit`. This is listed here not because
the grep is weak but because its *inverse* is: "no other consumer exists" is only as strong as a
grep over a vendored snapshot, and a consumer added by a future v0 rev would not announce itself.

### 9.10 The `classify` reorder is designed against a read, and the read is narrow

```
$ grep -rn "classify(" --include=*.rs packages/rfdb-server/src
packages/rfdb-server/src/derive/plan.rs:615:        let source = classify(pred, strat, head_stratum, catalog, &head)?;
packages/rfdb-server/src/derive/plan.rs:1162:fn classify(
```

One definition, one call site. §3.6/§6.2 lean on that: moving the `E-PERSP-001` check to the
front of `classify` reaches every leg. I verified the five arms (`:1162-1196`), the call site
(`:615`), and that `catalog.get("node").is_some()` under `with_base_relations()`
(`catalog.rs:251`) — the fact that makes rev 1's placement unreachable. What I did **not** verify
is that no path constructs a `PlanLeg` without going through `:615`; I have one grep, and the
design leans on it.

### 9.11 The scope discipline is itself the largest unverified thing

I ran no `cargo build`, no `cargo test`, no `cargo clippy`, and no conformance run in this
revision. That is deliberate — the deliverable is a document — but it means every "unchanged",
"untouched", "source-compatible" and "byte-identical" in §§2, 4 and 6 is a **prediction with a
citation**, not a result. The correct reading of this document is: the semantics (§0, §3, §3.10)
are verified against the reference and should be trusted; the integration claims (§2.1's map
shape, §4.7's rendering contract, §6.2's change list) are argued and should be treated as the
hypotheses that §6.1 is designed to test first.

---

## Criticisms rejected, with evidence

Both critics returned UNSOUND, and the overwhelming majority of what they said was right —
all nine divergence programs reproduced (§0), four findings changed the design materially, and
one killed the spine's corollary outright. This section records only what I did **not** accept,
plus the details I had to correct while accepting the finding around them. Nothing here changes a
verdict; the design is revised as if every accepted finding stood, because it does.

### R1 — Critic A, flaw 4: the *framing* "strictly finer than the reference's" is rejected; the finding is accepted

**The finding is accepted and fixed.** Rev 1 made `Stratum.predicates: Vec<RelKey>` with no
semantics behind it, silently moving the accept/reject boundary of cross-perspective negation.
§3.9 now rules NAME-granular, with T17 pinning it.

**What I reject is the characterization of the reference.** "Finer than the reference's
granularity" presupposes the v0 *kernel* has a dependency granularity. It has none. Evidence,
divergence run A4 vs A4-control (§0, verbatim):

```
A4          q[b](X) :- p[a](X), not q[c](X).   WITH boot
            → load ok = false, "program rejected: unstratified[main](q)"
A4-control  same program, boot NOT loaded
            → load ok = true, q[b](X) = ["X = 1"]
```

and the mechanism, `engine.ts:201-208`:

```ts
private checkUnstratified(programHasNegation: boolean): void {
  if (!programHasNegation) return;
  const un = this.store.relAll(IFACE.unstratified);
  if (un.length === 0) return;
```

`unstratified` is not a kernel concept — it is defined in **userland**, `boot.rofl:17`
`unstratified(Rel) :- dep_neg(Rel, Q), reach(Q, Rel).`, over `boot.rofl:13`
`dep_neg(A, B) :- concludes(R, A), premise_neg(R, B).`, and those two relations are emitted
perspective-free at `reflect.ts:155/163/164`:

```ts
facts.push({ rel: V.concludes,    args: [rid, mka(c.head.rel)] });
if (b.t === 'pos') facts.push({ rel: V.premise_pos, args: [rid, mka(b.lit.rel)] });
if (b.t === 'neg') facts.push({ rel: V.premise_neg, args: [rid, mka(b.lit.rel)] });
```

So the reference's only stratification boundary is a *userland policy* that happens to be
name-granular. RFDB's name-granular rule is therefore **the same** granularity as boot's, not a
finer one — the real divergence is one of *layer* (RFDB enforces in the kernel what v0 expresses
in userland), and that is what §3.9's closing paragraph and T17 now record. Getting this right
matters downstream: it is why §3.7 can leave the ⊑ preorder to userland at all.

### R2 — Critic B: "every one of the 40,816 fingerprints moves" is overstated; the conclusion is accepted

```
$ grep -c "|ERR|" packages/rfdb-server/src/derive/golden/p3_plan_fingerprints.txt
4
```

Those four are of shape `{name}|{profile}|ERR|{code}|{head}` (e.g.
`fixture:fx_cross_join_reject|prod|ERR|E-PLAN-003|h`) — they embed no literal render and so do
not move when `Debug` moves. The correct number is **40,812 of 40,816**.

This is a correction, not a refutation: the gate breaks either way, the ledger-gated regeneration
(`plan_golden.rs:283 #[ignore = "writes the golden file from the current planner; ledger-gated"]`,
`:281` "running it to silence the gate defeats the gate") is self-defeating either way, and §4.7's
hand-written-`Debug` answer is unchanged. I record it because a 4-line discrepancy in a claim of
that size is exactly the kind of thing that gets a correct finding dismissed.

### R3 — Critic A's ISO-1 fact breakdown is wrong in detail; the count and the conclusion are right

The critic's "9 facts, of which 4 `derived_by`" is a miscount. The actual added set (§0,
verbatim from the run) is 9 facts comprising **3** `derived_by[main]`, **1**
`in_perspective[main]`, and 5 others (`authority`, `edb`, `perspective`, `sees`, `stratum`).
The conclusion — v0's own kernel bookkeeping writes into `[main]` on every assertion, so ISO-1 as
rev 1 stated it is false for `p = main` — is exactly right and forced the §3.8 carve-out.

### R4 — Critic B's "86 sites" for `eval_derive` is a mention count, not a site count

```
$ grep -rn "eval_derive" --include=*.rs packages/rfdb-server/src | wc -l
87
$ grep -rn "eval_derived" --include=*.rs packages/rfdb-server/src | wc -l
12
$ grep -rn "eval_derive" --include=*.rs packages/rfdb-server/src | grep -v "eval_derived" | wc -l
75
$ grep -rn "eval_derive" --include=*.rs packages/rfdb-server/src | grep -v "eval_derived" \
    | grep -c "^[^:]*:[0-9]*: *///"
8
```

87 substring hits at HEAD, of which **12** are `eval_derived*` — a different function family
(`datalog/eval.rs:2624`, `datalog/eval_explain.rs:1996/2004/2012`, the explain evaluator's
derived-atom recursion) that a prefix grep sweeps up. Of the 75 real ones, 8 are doc-comment
lines and 5 are `fn` definitions (`graph/engine_v2.rs:539/687/889/925/955`).

More importantly the number is **moot** under the revised spine: the two-layer model keeps
`Evaluation::facts(&str)` source-compatible, so the count that matters is how many sites must
*change*, and the design's answer is the write path only. Rejected as presented; the underlying
worry (rev 1 under-counted its blast radius) was correct and is what the two-layer model exists
to remove.

### R5 — Critic B's `RelKey` `Hash + Eq` objection is MOOT, not rejected

The critic was right that rev 1 threaded a `RelKey` through hash-keyed structures without
specifying its `Hash`/`Eq`/ordering. That is no longer a defect to fix because **`RelKey` no
longer exists in the design** — §2.1 replaced it with the two-layer model, whose outer key is
`String` (the predicate name, exactly as today) and whose inner key is `String` (the perspective
name, in a `BTreeMap` so iteration order is deterministic by construction, §4.3). Recorded here
so the objection is not mistaken for an unaddressed one.

### Confirmed correct, not rejected

For the record, two citations I attempted to break and could not:

* Critic A's `translate.ts:246` citation is exact — that line does code unsafe negation as
  `missing:demand-mode` with the message "v0 evaluates it by finite failure; RFDB rejects
  (E-PLAN-002)". §3.2's ruling is built on it.
* Critic B's reading of `materialize.rs` production read sites is exact — `evaluation.facts(&spec.predicate)`
  at `:126-130` and `:422-437` are perspective-blind and are not behind `#[cfg(test)]`
  (`:656`). §6.4 exists because of it.
