# R13 — Adversarial implementability critique: `rofl-rules-as-data-design.md`

**Target:** `_ai/research/rofl-rules-as-data-design.md` (796 lines, commit `fad06052`), never reviewed.
**Lens:** NOT "is this true" — **"could a competent engineer implement exactly this, from this text, at
this HEAD, without inventing anything?"** Soundness is a separate reviewer's lane.
**Verdict: UNSOUND (implementability).** Five of the doc's load-bearing mechanisms do not exist in the
shape the doc assumes, and the lane's single claimed verdict payoff (§7 S4, "the lane's honest
acceptance criterion") is reachable by a ~6-line adapter change that needs none of S1–S3.

Every claim below carries `file:line` read at current HEAD or an inlined command output.

---

## Axis 1 — The code it proposes to change is not shaped the way it assumes

### 1.1 FATAL — `ExtProgram` has no "fact set" to append to; §3.1's seam does not exist

§3.1 (doc:216-219):

> "appends the Projection-F and Projection-T ground facts for each of its own clauses **to the
> program's fact set**. From that point on nothing downstream can tell them from facts the author
> typed. Stratification (`stratify`), planning (`plan_program_with_catalog`) and the fixpoint
> (`Executor::evaluate`) are **untouched**."

At HEAD, `ExtProgram` is (`packages/rfdb-server/src/derive/parser_ext.rs:238-243`):

```rust
pub struct ExtProgram {
    /// `#requires` pragmas (all satisfiable — unsatisfiable ones are rejected at parse).
    pub requires: Vec<Requires>,
    /// Annotated rule items in source order.
    pub items: Vec<Item>,
}
```

There is **no fact-set field**. Ground facts in this dialect are `Rule`s with an empty body
(`datalog/types.rs:155-158` `Rule { head, body }`, `Rule::fact` at `:167`, `is_fact()` at `:185-187`).
So "appending to the program's fact set" can only mean **pushing more `Item`s**, and `Item`s are
exactly what flows into every downstream stage. From `derive/mod.rs:235` onward:

```rust
let program = parse_ext_program(source)?;
// → BindingTable::from_program(&program, BOOLTAG_SEMIRING_ID)?
// → stratify(...)
// → PredicateCatalog::with_base_relations() / declare_strict
// → plan_program_with_catalog(...)
// → Executor::<BoolTag>
```

Therefore the sentence "Stratification, planning and the fixpoint are untouched" is **false by
construction of the only available mechanism**. Concretely, appended facts:

- add ~10 new predicates to `BindingTable::from_program` (uniformity gate E-BIND-001/002),
- add ~10 new nodes to `stratify`,
- must pass `PredicateCatalog::declare_strict` — which raises `E-CAT-002` on any arity conflict,
  including shadowing a base relation (`derive/catalog.rs`, proven by its own test at `:630-636`:
  `cat.declare_strict("edge", 1).unwrap_err().code == "E-CAT-002"`),
- change `FactStats::from_rules` (`derive/plan.rs:47-105`): a predicate is classified all-ground
  only if **every** rule for it has an empty body and all head args are ground. Ten new all-ground
  predicates per program change `FactShape`, which is exactly the input the doc itself says moves
  plans (§3.2, doc:227-232).

An implementer following §3.1 literally writes code whose first test run contradicts the paragraph
that told them to write it. **The seam as described has no landing site.** What the doc needed to
specify — and does not — is: which of `BindingTable` / `stratify` / catalog / planner the injected
facts bypass, and how a bypassed predicate is still resolvable by the executor.

### 1.2 FATAL — `@reflect` is unparseable three separate ways

§3.2 (doc:235): "**a program-level directive, `@reflect`, parsed by `parser_ext` into a flag on
`ExtProgram`.**"

Three independent blockers at HEAD, none acknowledged:

**(a) The annotation grammar requires `(`.** `read_annotation` (`parser_ext.rs:342-421`) reads the
name then requires a parenthesised payload. A bare `@reflect` does not parse.

**(b) The annotation name dispatch is a closed match with a hard error default**
(`parser_ext.rs:405-421`):

```rust
"lattice" => Ok(Annotation::Lattice(parse_kvpairs(inner, inner_start)?)),
other => Err(ExtParseError::new(
    ErrorCode::AnnotationSyntax,
    format!("unknown annotation '@{other}'"),
    at,
)),
```

So `@reflect(...)` is an `AnnotationSyntax` error, not an ignored unknown. Adding an arm is trivial
— but the doc presents `@reflect` as "parsed by `parser_ext`" as though it were a config knob, and
never says which `Annotation` variant it becomes.

**(c) Annotations are not program-level.** Annotations accumulate in `pending_annotations` and
attach to the **following** rule, becoming part of an `Item`; a program ending with unattached
annotations is a parse error (`parser_ext.rs:905-910`). There is exactly one program-level
mechanism in this dialect — `read_pragma` (`parser_ext.rs:311-339`), which accepts **only**
`#requires`, and `Requires` understands **only** the key `engine`. So "a program-level directive"
requires either a new pragma keyword or a new `Requires` key — a different, unspecified change to a
different function than the one the doc names.

An implementer cannot write `@reflect` from this text. They must first decide (a) syntax, (b) which
enum, (c) which of two grammars. That is three inventions on the doc's own critical path.

### 1.3 FATAL — §2.2's stated ground (c) is falsified by the renderer

§2.2 (doc:180-182) justifies choosing `Value::Term` partly because:

> "(c) the wire rendering `$fact(path,main,…)` is what p2-derived-by's
> `bindings['F'].includes('path')` and p4-forged's `/\$fact\(reading,s1/` actually assert against."

The renderer is `push_term_text` (`packages/rfdb-server/src/datalog/eval.rs:340-369`), verbatim:

```rust
Value::Str(s) => {
    out.push('"');
    for c in s.chars() { if c == '"' || c == '\\' { out.push('\\'); } out.push(c); }
    out.push('"');
}
```

A nested `Value::Str` renders **quoted**. So an encoder that puts the relation name in as a `Str`
produces `$fact("reading","s1",…)`, which does **not** match `/\$fact\(reading,s1/`. Ground (c) as
written is wrong.

There *is* a way to get bare atoms — an arity-0 `TermBlob`, since `push_term_text` returns
immediately after the functor when `args.is_empty()` (`eval.rs:341-344`), and `TermBlob::new`
validates **args only, not the functor** (`derive/canon.rs:242-259`), so `$fact` / `$lit` / `$cons`
functors are legal. But that is a *different encoder* from the one the doc specifies: every atom
becomes a nested arity-0 blob, which changes the canonical bytes, `canonical_state_sha` (ground (b)),
and the S1 golden fact set. The doc's own justification therefore does not survive its first
implementation decision, and the decision is unspecified.

### 1.4 FATAL — S1's acceptance gate is impossible as stated (rule identity mismatch)

§7 S1 gate (doc:587-588): "unit tests asserting the exact fact set for `boot.rofl`'s 21 clauses
against v0's `encodeRule` output, **name by name**", with rule id from `rule_ast_hash`
(`derive/materialize.rs:578`).

Arg 1 of *every* Projection-F and Projection-T relation is the rule id `R`. The two notions of rule
identity are **structurally incompatible**:

- RFDB `rule_ast_hash` (`materialize.rs:570-585`) — "The normalization **renumbers variables to
  positional `V{n}`** in first-appearance order … then … BLAKE3". **Variable-rename-INVARIANT.**
- v0 `ruleIdOf = 'r' + fnv1a(canonClause(c))` (`vendor/rofl-v0/src/reflect.ts:134-136`), and
  `canonTerm` (`vendor/rofl-v0/src/unify.ts:79-87`) is:
  ```ts
  case 'v': return '?' + t.name;
  ```
  **Variable-NAME-SENSITIVE.**

`p(X) :- q(X).` and `p(Y) :- q(Y).` are the same RFDB rule and two different v0 rules. A "name by
name" equality test against `encodeRule` output can therefore never pass on the `R` column. The doc
never mentions this, never proposes a mapping, and never says which identity wins. S1's gate — the
first stage's only mechanical criterion — is unrunnable.

### 1.5 FATAL — S1's fixture cannot be parsed by the code S1 lives in

S1 asserts the fact set "**for `boot.rofl`'s 21 clauses**" — i.e. `encode_reflection(&ExtProgram)`
must be fed a parsed `boot.rofl`. `parse_ext_program` cannot parse `run-migration/boot.rofl` at HEAD,
for at least three unrelated reasons:

| `boot.rofl` feature | HEAD status |
| --- | --- |
| `--` line comments (throughout) | `skip_trivia` (`parser_ext.rs:279-299`) handles **only** `%` |
| `[audit]` perspective annotations | no perspective syntax; behind Б1 (see Axis 3) |
| `N is M + 1` (`boot.rofl:20`) | `is` arithmetic — the doc's own §6 lists it as a separate blocker behind 14 cases |

So S1 — declared "one workflow … verifiable without the next" (doc:583-584) — is transitively
blocked on two of the doc's own top-3 dependency-graph items. Either the gate uses a *different*
fixture (unspecified), or S1 is not independently landable. The doc claims the latter.

### 1.6 The six-call-site table is incomplete: there is a 7th caller

§3.1's structural argument is "six production consumers inherit it with no change". `grep` at HEAD
finds a 7th non-test caller inside the parser module itself: `parse_ext_rule`
(`parser_ext.rs:920`), which calls `parse_ext_program` on a single-rule source. Under an in-parser
seam, every `parse_ext_rule` caller silently gains reflection facts too. The doc's structural
invariant ("all six or the explains diverge") is stated over an enumeration that is wrong, and the
7th site is the one that parses *individual runtime-asserted rules* — precisely §4/§5's path.

(The six sites the doc does name are all correct at HEAD: `graph/engine_v2.rs:785`
`maintain_derive`, `:830` `explain_datalog_fact`, `:861` `explain_datalog_gap`, `:936`
`eval_derive_maintain_writeback`, `:967` `eval_derive_materialize_cached`, plus `derive/mod.rs:235`.)

### 1.7 Two encoder inputs that do not exist and are not specified

**(a) Builtin classification.** v0's `encodeRule` emits `uses_builtin(rid, mks(op))` and *excludes*
builtins from `premise_pos` (`vendor/rofl-v0/src/reflect.ts:148-181`). RFDB's `Literal` carries only
`Positive`/`Negative` — a builtin is an ordinary positive literal at the type level. So the encoder
needs an oracle "is this predicate name a builtin?", i.e. a lookup into `derive/builtin.rs`. Never
mentioned; without it, Projection F is wrong for every clause containing a builtin.

**(b) Wildcards have no name.** `Term::Wildcard` (`datalog/types.rs:7-18`) carries nothing. v0
reifies each wildcard as a distinct `$var("_$N")`. The encoder must therefore *invent* stable names,
and the numbering scheme is part of the fact set the S1 gate compares. `boot.rofl` uses `_` in at
least 4 clauses (lines 4, 25, 26, 36), so this is on the S1 fixture's critical path. Unspecified.

### 1.8 Confirmed-correct shape claims (credit where due)

- `Term` enum `Var|Const|Lit(Value)|Wildcard` at `datalog/types.rs:7-18` — **correct**.
- `Value::Term(Arc<TermBlob>)` and its "Rules-as-data and reified structures live here as values"
  doc comment (`datalog/eval.rs:45-62`) — **correct, quoted accurately**.
- `rule_ast_hash` at `materialize.rs:578` with doc comment at `:571-577` — **correct**.
- Program key `DefaultHasher` over `source` at `engine_v2.rs:960-963`, mirrored in `w8_program_key`
  at `:6062-6068` (which carries a "must mirror … exactly" comment) — **correct**, and §3.2's
  observation that `@reflect` in the source text separates the cache keys for free is **valid**.
- W9 short-circuit at `engine_v2.rs:1161-1167` — **correct**.
- `sim_derive` overlay-ADD-only at `engine_v2.rs:592-645` — **correct**, so §6.4's excise argument
  stands on a real limitation.
- `plan_golden` golden = 40,816 lines — **correct** (`wc -l src/derive/golden/p3_plan_fingerprints.txt`
  → `40816`).
- The v0 side is quoted accurately: `V` 20 names `reflect.ts:11-33`, `IFACE` `:37-39`, `encodeRule`
  `:148-181`, `canonClause` `:129-132`.

---

## Axis 2 — "ZERO coupling to `facts/`, lives entirely inside `derive/`": **CONFIRMED**

This is the doc's strongest claim and it holds. Traced step by step, the encoder consumes only:

| Encoder need | Where it lives | Crate-internal path |
| --- | --- | --- |
| parsed clauses | `ExtProgram`/`Item`/`Rule`/`Atom`/`Term` | `derive/parser_ext.rs`, `datalog/types.rs` |
| rule identity | `rule_ast_hash` | `derive/materialize.rs:578` |
| term construction | `TermBlob::new` | `derive/canon.rs:242-259` |
| values | `Value` | `datalog/eval.rs:45-62` |
| builtin oracle (§1.7a) | `derive/builtin.rs` | inside `derive/` |

`grep -rn "crate::facts" packages/rfdb-server/src/derive/` returns exactly the four `SortOrder`
import lines the doc itself inlines — nothing else. The storage seam the derive path uses is the
`pub(crate) trait StorageView: Sync` at `derive/storage_glue.rs:305` (node/edge-shaped), and
`SegmentType { Nodes = 0, Edges = 1 }` at `storage_v2/types.rs:84-87` — i.e. reflection facts are
program-scoped and never reach a segment. **No falsification found.** The one caveat: §1.1's real
mechanism (facts as `Item`s) *increases* the coupling to `derive/`'s own pipeline (binding table,
stratifier, catalog, planner) even while keeping `facts/` untouched — the claim is true but narrower
than the reader will take it.

---

## Axis 3 — Sequencing: this lane collides with three in-flight lanes and is partly superseded

### 3.1 Perspectives (Б1) will rewrite the encoder — and the roadmap already re-prioritised

§2.1 hard-codes the perspective argument of `writes_to` / `reads_from` / `bridge_decl` to the
constant `main`, justified as correct "in a perspective-less RFDB". Owner ruling **R-15**
(`run-migration/OWNER-RULINGS.md`, binding, **dated after** this doc) makes perspectives a real
evaluator dimension with its own design round **first**. `ROADMAP-RU.md` states the re-prioritisation
directly: **Б1 perspectives (behind 14+) above Б2 rules-as-data (~~18~~ → 1–2)**.

Consequence for implementability: an encoder written to §2.1 is **guaranteed** to be rewritten by
Б1, and its S1 golden fact set regenerated. The doc's §7 ordering ("a reason to build it early",
doc:571-572) is stale against the ruling board.

### 3.2 R-14 (wire numerics) is in flight **now** and rewrites code this doc cites

§8 R-req-2 asks for a ruling on `wire_string_to_value` (`bin/rfdb_server.rs:3205-3210`). R-14 has
already answered it and the fix is **item 4 of the currently-running batch** per `ROADMAP-RU.md`. It
rewrites `rfdb_server.rs:3205-3219` — the exact lines §2.2 relies on for its wire-rendering ground —
and mandates a `parse(render(v)) == v` property test **including `Value::Term`**. That directly
contradicts §10.5's "did not test what that breaks". Any encoder built on today's rendering will be
landing into a moving floor; the doc gives no ordering constraint against R-14.

### 3.3 §8 and §9 are superseded

- §8 R-req-1 (kernel-grep scope) → answered by **R-13**.
- §8 R-req-2 (wire numerics) → answered by **R-14**.
- §8 R-req-3 → answered by **R-15**.
- §9's id↔sid skew of 32 → closed by **R-12** (symmetric difference 0; surplus described on the
  **id** side).

An implementer reading §8/§9 as open questions would re-derive four settled rulings. These sections
must be struck or annotated before the doc is handed to anyone.

### 3.4 What this lane blocks: almost nothing

§6 itself concedes rules-as-data is "behind 18 as a *necessary* condition, **sufficient for 1**"
(doc:568). Combined with Axis 5 below — where that 1 is reachable without the engine lane — the
sequencing answer is: **this lane blocks zero verdicts and is blocked by two lanes above it.**

---

## Axis 4 — Blast radius, and whether the gates actually prove what they claim

### 4.1 FATAL — S2's "non-negotiable" gate is **vacuous**

§7 S2 (doc:591-593):

> "Gate, non-negotiable: `src/derive/golden/p3_plan_fingerprints.txt` must stay **bit-identical**
> (`git status --short` on `src/derive/golden/` EMPTY, the same check round-012 ran)"

The golden file is consumed via `const GOLDEN: &str = include_str!("golden/p3_plan_fingerprints.txt");`
(`derive/plan_golden.rs:33`) and the **only** writer is the regenerator at `plan_golden.rs:282-287`:

```rust
#[test]
#[ignore = "writes the golden file from the current planner; ledger-gated"]
fn regen() { ... std::fs::write(&path, compute_fingerprints()) ... }
```

`#[ignore]` means a normal `cargo test` never writes it. Therefore `git status --short` on that
directory is **EMPTY whether the change is bit-identical or catastrophically plan-moving.** The gate
cannot fail. It is a check on the developer's own hygiene, not on the code.

The real mechanical gate exists and the doc should have named it: the test
`p3_plan_fingerprints_match_pre_p3_golden` at `plan_golden.rs:250`, which compares `compute_fingerprints()`
to `GOLDEN` line by line and panics naming every differing `(program, profile, rule head)`. This is a
one-word fix to the doc, but as written S2 would ship behind a gate that proves nothing — the single
most dangerous instruction in the document, because it is labelled "non-negotiable".

### 4.2 FATAL — the harness contaminates the reflection fact set it is supposed to query

Under the in-engine seam, **every rule in the submitted source** gets reflected — including rules the
harness synthesises. `renderDumpSource` (`translate.ts:370-376`) prepends a synthetic rule to the
source of **every** query:

```ts
const dumpRule = `xdump(${vars.join(', ')}) :- ${PFX}${rel}(${vars.join(', ')}).`;
return { source: dumpRule + '\n' + renderSource(t), headVars: vars };
```

So any reflection query issued through `dumpRel` sees `rule(r_xdump)`, `concludes(r_xdump, xdump)`,
`has_premise(r_xdump, …)` mixed into the answer. p3-runtime-rule's `concludes(R, path)` two-id
assertion, and any "count the rules" assertion, become harness-dependent. Worse, `renderSource`
(used by the witness path) and `renderDumpSource` produce **different rule sets for the same logical
program** — hence two different reflection fact sets *and* two different `DefaultHasher` program keys
(`engine_v2.rs:960-963`). Nothing in §3 or §4 addresses harness-synthesised rules. An in-engine
encoder must exclude them, and the doc gives no mechanism (and the adapter-side alternative rejected
in §3.4 does not have this problem — a fourth cost, on the other side of the ledger, that §3.4 omits).

### 4.3 §6.4 contradicts itself on scenario immutability

§6.4's preamble frames the three ride-alongs as adapter-only with "its scenario is unchanged", but
its own `p1-tc-naive` cell (doc:514) says the re-point is "recorded in the scenario's `sourceRef`" —
i.e. the scenario file **is** edited. Two further consequences the cell does not price:

- re-pointing `p1-tc-naive` makes it a **duplicate** of the already-GREEN `p1-tc-seminaive` (same TC
  program, same assertions), so tier-1 gains a verdict without gaining coverage;
- it deletes the oracle's **only** naive-mode exercise. `mk({naive:true})` appears once
  (`scenarios.ts:94`) and the adapter throws on it at `adapter.ts:32-36`. In PASS 1 (oracle mode)
  that scenario is the only thing exercising v0's naive evaluator.

### 4.4 §4.1/§4.2 specify behaviour that already exists

§4.1 ("runtime rule assertion lives in the adapter") and §4.2 (load atomicity via a candidate buffer
committed only on success) describe what `adapter.ts:72-109` already implements today
(`load` / `assert` / `assertClauses` build a candidate clause list, translate, and only then commit).
Zero implementation content; an implementer will spend a cycle discovering there is nothing to do.

### 4.5 Test blast radius, counted

- Rust: S1 adds new unit tests only. S2 touches `parse_ext_program` — every `derive/` test that
  parses a program is exposed, but under a correct opt-in gate none should change. The provable
  claim is `p3_plan_fingerprints_match_pre_p3_golden` staying green **plus** the `derive` suite
  unchanged; the doc's stated gate proves neither (§4.1 above).
- TS: `strataPlan` has exactly two call sites (`scenarios.ts:255`, `:271`) plus the oracle
  passthrough (`oracle.ts:71-72`). Verified:
  ```
  $ grep -arn "strataPlan" packages/rofl-conformance/src/
  packages/rofl-conformance/src/scenarios.ts:255:      const plan = await r.strataPlan();
  packages/rofl-conformance/src/scenarios.ts:271:      const plan = await r.strataPlan();
  packages/rofl-conformance/src/oracle.ts:71:  strataPlan(): { rule: string; rel: string; level: number | null }[] {
  packages/rofl-conformance/src/oracle.ts:72:    return this.r.strataPlan();
  packages/rofl-conformance/src/adapter.ts:293:  strataPlan(): { rule: string; rel: string; level: number | null }[] {
  ```
  So the TS blast radius of the whole lane's *verdict-moving* part is **one method, two call sites**.

### 4.6 Evidence hazard found while reviewing: `adapter.ts` is invisible to plain `grep`

The `-a` above is **load-bearing**. `packages/rofl-conformance/src/adapter.ts` contains two raw NUL
bytes — the tuple-key separator is written as a literal `\x00` character in the source, not as an
escape:

```
$ python3 -c "d=open('.../src/adapter.ts','rb').read(); [print('line',i,repr(l[:60])) for i,l in enumerate(d.split(b'\n'),1) if b'\x00' in l]"
line 143 b"        const key = tuple.join('\x00');"
line 148 b"      const key = tuple.join('\x00');"
```

GNU grep therefore classifies the file as **binary** and silently omits it from every `grep -rn`
sweep of this package (the message goes to stderr, so a piped sweep looks clean). It is the only such
file in `packages/rofl-conformance/`. Consequence for this migration: any evidence gathered about the
adapter with a plain recursive grep is **silently incomplete** — including, potentially, the
`kernel_grep` contract discussed in §8 R-req-1, whose whole mechanism is grepping source for
vocabulary names. Fix is one character (`' '`), and it should land before anyone runs a
grep-based contract check over this package.

---

## Axis 5 — The strictly smaller first increment (the most useful output here)

**Yes. It is adapter-only, ~6 lines, zero Rust, and it flips the exact case S7/S4 calls "the lane's
honest acceptance criterion".**

**File:** `packages/rofl-conformance/src/adapter.ts`
**Class:** `RfdbRofl` (`adapter.ts:26`)
**Method:** `strataPlan()` — currently `adapter.ts:293-296`:

```ts
strataPlan(): { rule: string; rel: string; level: number | null }[] {
  throw new UnsupportedFeature('missing:rules-as-data',
    'v0 strata come from boot-derived stratum/2 + unstratified/1 FACTS (engine.ts:2-4, boot.rofl:17-21); RFDB stratification is internal, not queryable');
}
```

**Change:** make it `async` and return one entry per **translated** rule, with the level looked up
from `stratum/2` **facts** (never from `stratify.rs`) — which is verbatim the contract §3.3 states
(doc:258-260):

```ts
async strataPlan(): Promise<{ rule: string; rel: string; level: number | null }[]> {
  const levels = new Map<string, number>();
  for (const [rel, lvl] of await this.dumpRel('stratum')) levels.set(rel, Number(lvl));
  return this.t().rules.map((r) => ({
    rule: r.text, rel: r.rel,
    level: levels.has(r.rel) ? levels.get(r.rel)! : null,
  }));
}
```

**Why every piece already exists at HEAD:**

- `this.t(): Translation` — `adapter.ts:125-128` (memoised translation).
- `Translation.rules: TransRule[]` where `TransRule = { rel; text; headVars }`
  (`translate.ts:72-81`) — a **positional match** for `{rule, rel, level}`.
- `this.dumpRel(rel)` — `adapter.ts:134-152`; it calls `renderDumpSource(t, rel)`, which returns
  `null` when `!t.relArity.has(rel)` (`translate.ts:371`), then unions `t.groundFacts.get(rel) ?? []`.
  **With no boot loaded there is no `stratum` relation anywhere in the program, so `dumpRel('stratum')`
  honestly returns `[]`** — no special case, no simulation, no fallback engine.
- `async` is explicitly sanctioned by the harness contract (`scenarios.ts:19-23`):
  > "Duck-typed engine surface: OracleEngine (sync) or RfdbRofl (async). Scenario code awaits every
  > call, which is a no-op for sync values."
  and both call sites already `await` (`scenarios.ts:255`, `:271`).

**The case it flips:** `p2-noboot-null-plan` (`scenarios.ts:261-274`, sourceRef
`test/phase2.test.ts:150`), whose entire assertion is:

```ts
const plan = await r.strataPlan();
assert.equal(plan.find((p) => p.rel === 'isolated')!.level, null);
```

`u_isolated` is a translated rule ⇒ present in `t().rules` with `rel === 'isolated'`; no `stratum`
fact exists ⇒ `level: null`. **GREEN.** (The program `node(a). edge(a,a). linked/1. isolated/1` loads
fine despite RFDB's base `node/2`/`edge/3`: `translate.ts` namespaces every user predicate with
`PFX = 'u_'`, documented at `translate.ts:12-14` precisely because "phase1 TC uses `edge`!".)

**Blast radius: exactly 1 scenario.** The other caller, `p2-stratum-order` (`scenarios.ts:255`),
still fails **earlier** at `await r.load(BOOT)` — `boot.rofl` uses `[audit]` perspectives (rejected by
`checkLitMeta`, `translate.ts:129`) and `is` arithmetic — so it stays RED with an unchanged reason
code. `oracle.ts:71-72` is the v0 passthrough and is untouched.

**What this proves about the doc:** S1 (encoder) + S2 (`@reflect` seam) + S3 (write protection) —
the entire Rust lane, the one carrying all five fatal flaws above — is **not on the path** to the
lane's only claimed verdict. That does not make the engine lane worthless (p3-write-protected,
p3-runtime-rule and the "rules live in the store" stop-condition argument in §3.4(3) are real), but
it does mean the doc's staging is inverted: **S4 should be S1, land alone, and be measured before any
`parser_ext.rs` line is touched.**

---

## Underspecified (implementer must invent; each is a stop-and-ask)

1. Which downstream stage(s) injected facts bypass, given they can only be `Item`s (§1.1).
2. `@reflect` concrete syntax + which `Annotation`/pragma it becomes (§1.2).
3. Atom encoding: quoted `Value::Str` vs arity-0 `TermBlob` (§1.3) — changes canonical bytes.
4. Which rule identity wins, RFDB's rename-invariant hash or v0's name-sensitive id (§1.4).
5. The S1 fixture, given `boot.rofl` does not parse (§1.5).
6. Builtin classification source for `uses_builtin` / `premise_pos` (§1.7a).
7. Wildcard naming scheme (§1.7b) — part of the compared fact set.
8. Whether `parse_ext_rule` (`parser_ext.rs:920`) participates in the seam (§1.6).
9. How harness-synthesised `xdump` rules are excluded from reflection (§4.2).
10. Ordering against R-14's in-flight wire-numerics rewrite and R-15's perspectives round (§3.2, §3.1).
11. `E-REFL-001`'s exact diagnostic string vs what `p3-write-protected` asserts (§7 S3 names the code
    but not the shape the test matches).

## Strengths confirmed

- **Axis 2 holds:** the encoder genuinely needs nothing from `facts/`; every input lives in
  `derive/` + `datalog/`. This is a real architectural finding, not a hope.
- **§3.1's diagnosis is right even though its cure is wrong:** a call-site seam *would* desynchronise
  `evaluate` from `explain_datalog_fact`/`explain_datalog_gap`; all six sites verified at HEAD.
- **§3.2's cache-identity observation is correct and free:** the directive is part of `source`, and
  both program keys hash `source` (`engine_v2.rs:960-963`, `:6062-6068`).
- **§3.4 is exemplary practice** — the rejected alternative is recorded with its three costs priced,
  which is why this review could weigh it. (It is also, on this analysis, the better option; §4.2 adds
  a fourth cost *to the chosen* design.)
- **§6's honesty:** the doc states plainly that the lane is "sufficient for 1" rather than the
  headline 18. That honesty is what made the axis-5 finding findable.
- **Value-level vs syntactic compound-term distinction (§2.2)** is a genuine correction to the
  conformance report's single `missing:compound-terms` code, and the `Value::Term` doc comment quoted
  at `eval.rs:59-61` supports it exactly as claimed.
