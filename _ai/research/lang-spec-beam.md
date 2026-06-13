# Migration spec: `beam-resolve` (BEAM / Elixir+Erlang resolvers) → derive (datalog2) packs

Round: resolve-datalog2, lang = **beam**. Base: `origin/main` @ `6e609746` (verified `git merge-base HEAD origin/main`).
Precedent followed: `_ai/research/resolve-datalog2-migration-specs.json` + `…-synthesis.md` §3 (differential harness) / §4 (missing-cap ranking) / §5.
Builtin set verified live against `packages/rfdb-server/src/derive/builtin.rs` registry (HEAD): see §0.

---

## §0. Available builtin vocabulary (verified `builtin.rs:1188-1372` registry())

Generators: `node/2` (=`type/2`), `edge/3`, `incoming/3`.
Function/probe: `attr/3` ([B,B,F]/[B,B,B]/**[F,B,B]** generator), `edge_attr/5`, `node_attr/3` (top-level JSON scalar only; **NO** generator mode).
Filters: `neq/2`, `gt/lt/gte/lte /2`, `starts_with/2`, `not_starts_with/2`, `string_contains/2`, `ends_with/2`.
String fns: `concat/3`, `str_lower/2`, `basename/2`, `strip_quotes/2`, `strip_prefix/3`, `strip_suffix/3`, `last_segment/3`, `replace_all/4`, `path_resolve/3`, `method_suffix/2`.

`node_attr/3` (`builtin.rs:1093-1115`) reads ONLY a **top-level** JSON String/Number/Bool field; a non-scalar value (list/object/null) or absent key ⇒ NO row. This is load-bearing for beam (see §5).

---

## §1. Resolver inventory (read `packages/beam-resolve/src/` FULLY)

`Main.hs` dispatches **9** commands (lines 88-98). Source-of-truth file:line per step below.

| # | command | module | edge(s) emitted | node(s) minted | legacy `resolvedVia`/`source` |
|---|---|---|---|---|---|
| 1 | `beam-imports` | `BeamImportResolution.hs` | `IMPORTS_FROM` | — | (none stamped) |
| 2 | `beam-local-refs` | `BeamLocalRefs.hs` | `CALLS` (3 arms) | `EXTERNAL_FUNCTION` `BEAM_GLOBAL::<fn>` | `beam-local-refs` |
| 3 | `beam-protocols` | `BeamProtocolResolution.hs` | `IMPLEMENTS` | — | `beam-protocols` |
| 4 | `beam-behaviours` | `BeamBehaviourResolution.hs` | `IMPLEMENTS` | `MODULE` `BEAM_GLOBAL::Module::<n>` | `beam-behaviours` |
| 5 | `beam-runtime-globals` | `BeamRuntimeGlobals.hs` | `CALLS` | `GLOBAL_DEFINITION` | (effects-db driven) |
| 6 | `beam-wrapper-resolve` | `BeamWrapperResolution.hs` | `SENDS_TO`/`SUBSCRIBES_TO`/`BROADCASTS_TO` | synthetic `PUBSUB_TOPIC` | (via meta only) |
| 7 | `beam-message-types` | `BeamMessageTypeResolution.hs` | `SENDS_MESSAGE`/`SELF_SCHEDULE` | — | `beam-message-type-resolution` |
| 8 | `beam-pubsub-delivery` | `BeamPubsubDelivery.hs` | `PUBLISHES` | — | `beam-pubsub-delivery` |
| 9 | `beam-message-findings` | `BeamMessageFindings.hs` | `CONTAINS` | `ISSUE` (6 finding kinds) | (finding_kind meta) |

Shared helper `BeamShape.hs` — structural `parseShape`/`unify` over a nested-list shape tree; used by #7, #8, #9.

### Per-step detail

**#1 imports** (`BeamImportResolution.hs:39-88`): index MODULE by `gnName`; for each `IMPORT` node, candidates = `[name, dropWhile (==':') name]` (Erlang `:lists` → `lists`); first match → `IMPORTS_FROM` IMPORT→MODULE. External (unmatched) skipped.

**#2 local-refs** (`BeamLocalRefs.hs:209-362`): for each `CALL`, resolution order:
  1. exact same-file `(file, name)` against FUNCTION decl index (BEAM `name` includes arity `foo/2`).
  2. same-file `(file, baseName)` (baseName = `foo/2`→`foo`).
  3. if `baseName` is qualified (has `.`): split on **last** dot → `(modAlias, funcName)`; `lookupQualified` tries `(fullMod,func,arity)` then `(fullMod,func)`, then **module-suffix** index (alias `Accounts` → `MyApp.Accounts`); arity from `metadata.arity`.
  4. else if `baseName ∈ beamBuiltins` (hardcoded ~50-set, lines 191-207) → mint `EXTERNAL_FUNCTION` `BEAM_GLOBAL::<base>` + `CALLS`.

**#3 protocols** (`BeamProtocolResolution.hs:37-67`): MODULE with `metadata.protocol` (a defimpl) → look up the protocol MODULE by that name → `IMPLEMENTS` impl→protocol.

**#4 behaviours** (`BeamBehaviourResolution.hs:54-141`): `IMPORT` with `metadata.kind ∈ {behaviour, use}`. Owner MODULE found by **file** (`byFile` index, the IMPORT's file). Target = MODULE named `gnName import` if present, else mint virtual `MODULE` `BEAM_GLOBAL::Module::<name>` (dedup via seen-set). Edge `IMPLEMENTS` owner→target.

**#5 runtime-globals** (`BeamRuntimeGlobals.hs` + shared `Grafema.RuntimeGlobals`): TWO strategies (Elixir prefix `BEAM_GLOBAL::`, Erlang `ERLANG_BIF::`), both separator `.`, filter = CALLs not already locally resolved; all dot-suffixes of the call name tried against effects-db YAML symbol DB; on match mint `GLOBAL_DEFINITION` + `CALLS` carrying effect metadata. **Reads external YAML (effects-db).**

**#6 wrapper-resolve** (`BeamWrapperResolution.hs:356-521`): re-runs #2's CALL→FUNCTION resolution; keeps callers of FUNCTIONs carrying a `wraps` **MetaMap** sub-object `{kind,target,target_hint,message_shape,topic}`. Per `kind`: call/cast/send/send_after → `SENDS_TO` to a PROCESS (resolved by file for `module_self`, by module-name index for `literal` hint); sub → `SUBSCRIBES_TO` caller-MODULE→PUBSUB_TOPIC; broadcast → `BROADCASTS_TO` CALL→PUBSUB_TOPIC. Topic resolved from `wraps.topic`, falling back to file-local topic or a **synthetic** `PUBSUB_TOPIC` node. `target=var` → skip.

**#7 message-types** (`BeamMessageTypeResolution.hs:171-227`): direct send-sites = CALL nodes carrying `sender_via`/`sender_base`/`message_shape`/`target_is_self`/`target_hint`; plus wrapper-sites from #6. Candidate MESSAGE_TYPEs = same file (self) or PROCESS's file (by `target_hint` name). Keep those with `handler_type == sender_via` AND **`unify(sentShape, pattern_shape)`**. Edge = `SELF_SCHEDULE` (send_after+self) else `SENDS_MESSAGE`. May emit MANY edges per CALL (non-determinism).

**#8 pubsub-delivery** (`BeamPubsubDelivery.hs:149-253`): broadcast CALLs (`pubsub_op=broadcast`, `pubsub_topic`, `pubsub_server`, `message_shape`) + wrapper-broadcasts. Subscribers indexed by `(server,topic)` (from `pubsub_op=subscribe` CALLs + sub-wrappers under sentinel `<wrapper>` server). For each broadcast, candidate `handle_info` MESSAGE_TYPEs in each subscriber file with `unify(shape, pattern_shape)` → `PUBLISHES` CALL→MESSAGE_TYPE.

**#9 message-findings** (`BeamMessageFindings.hs`): a **diagnostics** pass — emits `ISSUE` nodes (+`CONTAINS`) for six finding kinds (silent handler, unreachable handler, heterogeneous key type, etc.) using `unify` and `topLevelMapKV` shape recursion. NOT a resolution step; out of Datalog scope entirely (parallels the JS message-findings exclusion).

---

## §2. Draft `.dl` rules (TODAY's builtins). Migratable steps only.

Conventions: `M#<file>` = orchestrator's MODULE# kernel facts if available; here drafted directly on stored graph shapes verified in §4. Each pack is provenance-scoped (`@materialize`).

### Pack `beam_imports` (#1) — FULLY EXPRESSIBLE

```prolog
% Exact-name match: IMPORT.name == MODULE.name → IMPORTS_FROM.
beam_import(I, Mod) :-
    node(I, "IMPORT"),
    attr(I, "name", N),
    node(Mod, "MODULE"),
    attr(Mod, "name", N).

% Erlang colon-stripped form: IMPORT name ":lists" → MODULE "lists".
beam_import(I, Mod) :-
    node(I, "IMPORT"),
    attr(I, "name", N),
    strip_prefix(N, ":", Bare),          % no row if no leading ':'
    node(Mod, "MODULE"),
    attr(Mod, "name", Bare).

@materialize edge IMPORTS_FROM(I, Mod) :- beam_import(I, Mod).
```
Delta vs legacy: legacy `firstMatch` prefers exact over colon-stripped (Map last-wins → ONE edge); set-union here emits BOTH if a `:lists` IMPORT AND a literal `lists` MODULE both exist — extremely rare. → **SUPERSET (bounded: imports whose `:`-stripped form ALSO equals a distinct MODULE name; expect 0 in practice).**

### Pack `beam_local_refs` (#2) — arms 1, 2 EXPRESSIBLE; arms 3, 4 PARTIAL

```prolog
% Arm 1: exact same-file (file, name-with-arity).
beam_call(C, F) :-
    node(C, "CALL"), attr(C, "file", File), attr(C, "name", Nm),
    node(F, "FUNCTION"), attr(F, "file", File), attr(F, "name", Nm).

% Arm 2: same-file base-name (CALL "foo" vs FUNCTION "foo/2").
beam_call(C, F) :-
    node(C, "CALL"), attr(C, "file", File), attr(C, "name", Base),
    node(F, "FUNCTION"), attr(F, "file", File),
    strip_suffix_anyarity(F, Base).      % see note — needs arity-strip on FUNCTION name

@materialize edge CALLS(C, F) :- beam_call(C, F).
```
Arm 2 needs FUNCTION `"foo/2"` → base `"foo"`: `attr(F,"name",FN), last_segment` won't help (separator is `/` but we want PREFIX before `/`). There is **no `prefix_before_sep` / `first_segment` builtin** — `last_segment` returns the tail, `basename` is hardwired `/` and returns the TAIL `2`. To get `foo` from `foo/2` need `strip_suffix(FN, "/<arity>", base)` but arity is unbound. **Workaround:** join CALL.name (no arity) directly and require FUNCTION name `concat(Base,"/",AritySfx)` — but AritySfx (`/2`) is a free unbound tail, and `concat` needs all inputs bound. **Missing builtin: `first_segment(S, Sep, Head)` (the prefix-before-first-sep twin of `last_segment`).** Until then arm 2 is NOT expressible. Arm 1 is exact and fine.

Arm 3 (qualified cross-file, module-suffix alias): split last `.`, suffix-fanout over all module names. `last_segment(CallName, ".", Func)` gives the func part; the module-alias part needs `strip_suffix(CallName, concat(".",Func), ModAlias)` (the prefix) — same first-segment gap. And the **suffix-index** ("Accounts" matches "MyApp.Accounts") is a per-module dot-suffix enumeration with no fact form (parallels JS star-re-export: "no fact-enumeration workaround exists"). → **NOT expressible without (a) first-segment builtin AND (b) a MODULE-suffix fact or `ends_with`-join.** `ends_with(ModName, ModAlias)` exists and could approximate the suffix join, but legacy requires alias to be a **dot-aligned** suffix (`Accounts` of `MyApp.Accounts`, not `ccounts`) — `ends_with` would over-match. PARTIAL/deferred.

Arm 4 (beamBuiltins → mint EXTERNAL_FUNCTION): the ~50-name set is hardcoded Haskell. Needs an **external-data-as-facts** beam-builtin fact pack (parallels JS builtins pack `js_builtins_nodes`). Two-pack node-then-edge split (like `axum_routes.dl`). Expressible ONCE the fact pack exists.

### Pack `beam_protocols` (#3) — EXPRESSIBLE (gated on `node_attr` for top-level scalar `protocol`)

```prolog
beam_impl(Impl, Proto) :-
    node(Impl, "MODULE"),
    node_attr(Impl, "protocol", PName),   % top-level scalar string — OK
    node(Proto, "MODULE"),
    attr(Proto, "name", PName).
@materialize edge IMPLEMENTS(Impl, Proto) :- beam_impl(Impl, Proto).
```
`protocol` is a top-level string field (analyzer `modules.ex:87`, fixture `Spec.hs:400`). **FULLY EXPRESSIBLE.** Delta vs legacy: EXACT (legacy is a single Map lookup; set semantics identical since protocol-name→MODULE is unique).

### Pack `beam_behaviours` (#4) — PARTIAL

```prolog
% Owner MODULE of the @behaviour/use IMPORT, by FILE.
beam_behaviour_real(Owner, Target) :-
    node(I, "IMPORT"), node_attr(I, "kind", K),
    behaviour_kind(K),                     % K == "behaviour" OR "use"
    attr(I, "file", File), attr(I, "name", BName),
    node(Owner, "MODULE"), attr(Owner, "file", File),
    node(Target, "MODULE"), attr(Target, "name", BName).
@materialize edge IMPLEMENTS(Owner, Target) :- beam_behaviour_real(Owner, Target).
```
`behaviour_kind` needs a 2-value OR → two rule bodies (one per literal). Real-target arm EXPRESSIBLE. The **virtual `BEAM_GLOBAL::Module::<name>` mint** for stdlib behaviours (GenServer etc.) needs a node-minting pack with a deterministic id; the seen-set dedup maps to `@materialize_node` natural dedup. Expressible as a second pack but: the synthetic id is `"BEAM_GLOBAL::Module::"<>name` — `concat("BEAM_GLOBAL::Module::", BName, Id)` works. → real arm EXACT; virtual arm SUPERSET-shaped node mint, **expressible with concat + @materialize_node**, but ordering (node-before-edge) needs the two-pack split. PARTIAL-now / fully-doable.

### Pack `beam_runtime_globals` (#5) — NOT expressible now

Driven by **external effects-db YAML** + dot-suffix matching + effect-metadata copy. Needs the effects-db-YAML-facts-pack generator (synthesis §4 item 3, unbuilt) and the "filter CALLs already locally resolved" negation (stratified `!beam_call`). Deferred to the globals wave (parallels JS/Rust runtime-globals which stayed NATIVE per the ledger).

### Packs #6, #7, #8 — NOT expressible (shape unification)

All three depend on `BeamShape.unify` — structural recursion over a nested-list shape tree (`tuple`/`list`/`cons`/`map`/`struct`, arbitrary depth, key-intersection compatibility). Datalog2 has no recursion-over-data-structure, and `message_shape`/`pattern_shape`/`wraps` are stored as **non-scalar `MetaList`/`MetaMap`** which `node_attr` cannot even read (it returns NO row on non-scalar; §0, §5). Hard product limitation. Plus #6 re-runs the whole #2 call-resolution (inherits its gaps).

### Pack #9 — out of scope (diagnostics, ISSUE emission via shape recursion).

---

## §3. Predicted deltas (per migratable pack, classes per synthesis §3.4)

| pack | class | bound |
|---|---|---|
| `beam_imports` | **SUPERSET** | extra = #IMPORTs whose `:`-stripped name == a *distinct* MODULE; predicted **0** on real corpora |
| `beam_local_refs` arm1 (exact) | **EXACT** | modulo multi-decl same (file,name/arity) — beam name+arity is unique ⇒ 0 |
| `beam_local_refs` arm2/3/4 | **SUBSET (deferred)** | missing = all base-name + qualified-alias + builtin CALLS until first-segment builtin + suffix-facts + builtin-facts land |
| `beam_protocols` | **EXACT** | 0 (unique protocol→MODULE) |
| `beam_behaviours` real arm | **EXACT** | 0 |
| `beam_behaviours` virtual arm | **SUPERSET** | set-union vs seen-set Map = identical after @materialize_node dedup ⇒ 0; ordering caveat |
| `beam_runtime_globals` | deferred | n/a |
| #6/#7/#8 | NOT MIGRATABLE | product limitation |

No live differential possible this round: dogfood graph has **zero** beam nodes (§4). Deltas are predicted from source, to be measured on a beam fixture corpus in the executing wave.

---

## §4. Analyzer-shape spot-verification (THE ROUND'S LESSON)

Every shape the draft rules assume, checked against analyzer source AND (where possible) live probe.

| assumed shape | evidence | verified? |
|---|---|---|
| `node(M,"MODULE")` exists | live probe `findByType MODULE` non-empty (491535-node dogfood) | ✅ live |
| `node(I,"IMPORT")` exists | live probe non-empty | ✅ live |
| `node(F,"FUNCTION")`, `node(C,"CALL")` exist | live probe non-empty | ✅ live |
| `PROCESS`/`MESSAGE_TYPE`/`PUBSUB_TOPIC` exist | live probe **EMPTY (0)** — beam-only, no Elixir in dogfood | ⚠ **NOT live-verifiable**; grounded on analyzer src + `Spec.hs` fixtures only |
| FUNCTION name = `"foo/2"` (arity in name) | `semantic_id.ex:9` `name/arity`; `BeamLocalRefs.hs:33` comment; fixture | ✅ src |
| CALL name = **no arity**; arity in `metadata.arity` (int) | `calls.ex:171,179` `name: name … metadata: %{arity: arity}`; `BeamLocalRefs.hs:185-188 callArity` | ✅ src |
| FUNCTION sid carries `[in:Module]` | `semantic_id.ex:9`; URI form `%5Bin:%5D` per `BeamLocalRefs.hs:143-167` | ✅ src — **⚠ orchestrator MODULE# bug risk (see note)** |
| MODULE defimpl has top-level scalar `protocol` + `for_type` | `modules.ex:86-88`; fixture `Spec.hs:399-401` | ✅ src+fixture |
| IMPORT `metadata.kind ∈ {alias,import,use,behaviour}` (top-level string) | `imports.ex:7,15,62,85,112,133` | ✅ src |
| `wraps` is a nested `MetaMap`; `message_shape`/`pattern_shape` nested `MetaList` | `BeamWrapperResolution.hs:88 MetaMap`; `BeamShape.hs:55-67`; fixture `Spec.hs:420,454,671` | ✅ src+fixture — **NOT scalar ⇒ `node_attr` returns NO row** |
| send-site meta `sender_via/sender_base/target_is_self/target_hint` top-level scalars | `BeamMessageTypeResolution.hs:95-99`; fixture `Spec.hs:908-910` | ✅ src+fixture |
| `pubsub_op/pubsub_topic/pubsub_server` top-level scalars | `BeamPubsubDelivery.hs:77-98` | ✅ src |

**Unverified-shape flags (live):** PROCESS, MESSAGE_TYPE, PUBSUB_TOPIC node presence and their metadata layout are grounded only on source + test fixtures — there is no Elixir/Erlang code in the dogfood graph to probe. The executing wave MUST run the differential on a beam corpus (e.g. the `kami`/`ichi` Elixir project the comments reference) before trusting #2-arm3/#7/#8 verdicts.

**Note — orchestrator MODULE# parser bug (carried from synthesis):** the resolvers recover the owning module from the `[in:Module]` marker in the FUNCTION **semantic id** (`extractModuleFromId`), reading the sid out of metadata in production (gnId is a u128 hash). Any pack arm needing module-ownership (#2 arm3) must read the sid, not gnId — and the known orchestrator MODULE#-sid parser that "drops Haskell deps" (MEMORY) may similarly mishandle the beam `[in:]`/`%5Bin:%5D` URI form. Flag for the executing wave.

---

## §5. Missing capabilities (ranked, beam-specific, on top of synthesis §4)

1. **`first_segment(S, Sep, Head)`** — the prefix-before-FIRST-separator twin of `last_segment`. Blocks `beam_local_refs` arm 2 (`"foo/2"`→`"foo"`) and arm 3's module-alias extraction (`"Accounts.list"`→`"Accounts"`). Highest leverage: arm 2 is the bulk of beam CALLS. (Same eval discipline as `last_segment`; ~15 LOC.)
2. **Dot-aligned suffix join for module aliases** — legacy "alias `Accounts` resolves to `MyApp.Accounts`" needs a MODULE dot-suffix **fact** (each suffix → full name) OR a builtin `is_dot_suffix(Alias, Full)` (= `ends_with` AND the char before the match is `.` or the alias is the whole name). `ends_with/2` alone over-matches (`ccounts`). Blocks arm 3.
3. **Shape-tree unification as data** — `BeamShape.unify` is structural recursion over nested `MetaList`/`MetaMap`. No Datalog2 construct expresses it; `node_attr` cannot even read non-scalar metadata. **Hard product limitation** — gates #6/#7/#8 (the message-flow precise edges). Either keep these NATIVE (recommended, mirroring JS/Rust runtime-globals staying native) or pre-flatten the shape into a canonical scalar key in the analyzer + emit shape-bucket facts (large design, own effort).
4. **effects-db-YAML facts-pack generator** (synthesis §4 item 3, already ranked) — gates #5 beam-runtime-globals.
5. **stratified negation `!beam_call(C,_)`** — #5 filters CALLs already locally resolved; needs the local-refs pack's output as a stratum input (datalog2 has stratified negation; wiring it cross-pack is the work).
6. **beam-builtin name facts** (the ~50 Kernel/BIF set, `BeamLocalRefs.hs:191-207`) — external-data-as-facts; gates arm 4. Low effort (a generated fact pack).

---

## §6. Honesty section

- **No live differential this round.** Dogfood graph (`/Users/vadimr/grafema/.grafema/graph.rfdb`, loaded 491535 nodes via `/tmp/beam-probe.rfdb` copy + own server on `/tmp/beam-probe.sock`) has **0** PROCESS / MESSAGE_TYPE / PUBSUB_TOPIC nodes — no BEAM source in the monorepo. MODULE/IMPORT/FUNCTION/CALL exist but are TS/Rust/Haskell, NOT beam-shaped (no `[in:]` arity names, no `protocol` metadata). So every beam-specific verdict is **source-grounded, not graph-grounded**. Probe server cleaned up after.
- **Only 3 of 9 steps are cleanly migratable now**: `beam_imports` (full), `beam_protocols` (full, needs `node_attr` which EXISTS), `beam_local_refs` arm 1 (exact same-file+arity). `beam_behaviours` real-arm is doable; its virtual mint needs a 2-pack split. That is the honest "expressible now" set.
- **The shape-unification trio (#6/#7/#8) is a genuine product limitation**, not a builtin gap — the same way JS/Rust runtime-globals were left native. Do NOT pretend a `node_attr` patch unblocks them; it does not (non-scalar metadata).
- **The round's lesson held twice here:** (1) the protocol resolver's `protocol`/`for_type` are top-level scalars on the *impl* MODULE (verified `modules.ex:86`), readable by `node_attr` — but `wraps`/`message_shape` are NOT scalars, a distinction invisible from the resolver's `Map.lookup` alone and only caught by reading the analyzer + `BeamShape`. (2) CALL `name` carries NO arity (arity is metadata), so any arm matching `(file,name)` against FUNCTION `foo/2` must base-name-strip — the missing `first_segment` builtin, surfaced only by reading `calls.ex:179` + `semantic_id.ex:9` together.
- Unverified-against-live-graph shapes are flagged ⚠ in §4 and MUST be re-checked on a beam corpus before the executing wave records pass/fail.

---

## ADVERSARIAL VERDICT (independent review, 2026-06-13)

Reviewer re-read all 9 `beam-resolve/src/` modules, the analyzer emission
(`beam-analyzer/lib/beam_analyzer/rules/{calls,modules,functions,infrastructure,pubsub}.ex`,
`semantic_id.ex`), the live `derive/builtin.rs` registry + mode tables, and the synthesis.
No live beam nodes exist in the dogfood graph (confirmed: PROCESS/MESSAGE_TYPE/PUBSUB_TOPIC = 0),
so beam-specific shapes are SOURCE-grounded; all general builtins were live-checked.

### CONFIRMED by independent evidence
- FUNCTION `name: "#{name}/#{arity}"` (functions.ex:31, semantic_id.ex:9) — arity IS in the name.
  CALL `name: name, metadata: %{arity: arity}` (calls.ex:170,179) — arity NOT in CALL name.
  => the `first_segment` gap for arm 2 (`"foo/2"`→`"foo"`) is REAL: `last_segment(name,"/",X)` would
  bind the ARITY `"2"`, not `"foo"`; no prefix-before-first-sep builtin exists (registry verified).
  This catch is correct and well-grounded.
- `wraps: refined` is a MAP and `message_shape = shape_to_meta(...)` is a nested shape
  (functions.ex:100, infrastructure.ex:253-261). `node_attr` returns NO row on non-scalar
  (builtin.rs:1093-1115, verified). => the #6/#7/#8 "hard product limitation" is correct.
- `protocol`/`for_type` are top-level scalars on the impl MODULE (modules.ex:86-89); the resolver
  filters `Map.member "protocol"` then looks up `metadata.protocol` → MODULE by name
  (BeamProtocolResolution.hs:44-58). The `beam_protocols` pack is faithful.
- Import colon-strip: resolver uses `T.dropWhile (== ':')` (BeamImportResolution.hs:19) +
  `firstMatch` over `[name, stripped]` taking the FIRST — the spec's two-arm set-union SUPERSET
  classification is correct.

### MINOR CORRECTIONS (do not change the verdict, tighten it)
1. `beam_protocols` and `beam_behaviours` real-arm: legacy stamps `meta(resolvedVia, kind)`
   (BeamProtocolResolution.hs:62-64). The draft `@materialize edge IMPLEMENTS(...)` omits the meta.
   For clean per-step differential SLICING (the synthesis §3 partition is by `resolvedVia`), the
   packs MUST carry `meta(resolvedVia="beam-protocols")` / `meta(resolvedVia="beam-behaviours")`,
   else the IMPLEMENTS slice cannot be isolated from any other IMPLEMENTS producer. Add the meta.
2. Import colon-strip nuance: `strip_prefix(N, ":", Bare)` strips exactly ONE colon; the resolver's
   `dropWhile (==':')` strips a run. Equivalent for the normal `:lists` single-colon case; a `::x`
   form (rare) would diverge. Note as an additional (negligible) SUPERSET edge case.
3. `beam_local_refs` arm 1 EXACT claim: the resolver `declIdx = Map.fromList` is last-wins ONE id
   per (file, name-with-arity). Since beam FUNCTION name INCLUDES arity, (file,name/arity) collisions
   are genuinely ~0, so arm-1 EXACT survives — but state the bound as "modulo duplicate (file,
   name/arity)" explicitly, matching the haskell finding's discipline.

### CONFIRMED GAPS (spec's missing-capability ranking is sound)
`first_segment` (#1, highest leverage), dot-aligned suffix join (#2), shape-unification as data
(#3, hard limit), effects-db-YAML facts pack (#4), cross-pack stratified negation (#5), beam-builtin
name facts (#6) — all independently verified against source. The ranking is correct.

### READY FOR PACKS: **PARTIAL — as the spec itself states.** 3 steps migratable now
(`beam_imports` full, `beam_protocols` full, `beam_local_refs` arm 1) + `beam_behaviours` real-arm,
ONCE the provenance `meta()` stamps (correction #1) are added so the differential can slice. The
#6/#7/#8 trio is a genuine product limitation, correctly excluded. This is the most rigorous of the
three specs; only the missing `meta()` stamps are a real (small) blocker for a clean differential.
