# REG-1097: beam-resolver — cross-module remote calls in Elixir

**Linear:** https://linear.app/grafemadev/issue/REG-1097
**Branch:** `reg-1097-beam-resolver-resolve-cross-module-remote-calls-in-elixir`
**Priority:** High
**Test project:** `~/kami/ichi` (32 modules, 6750 LOC)

## Root cause

`BeamLocalRefs.buildQualifiedIndex` (packages/beam-resolve/src/BeamLocalRefs.hs:79) calls
`extractModuleFromId (gnId n)` to read `[in:ModuleName]` out of a FUNCTION node.

In tests `gnId` is the legacy arrow form (`"lib/accounts.ex->FUNCTION->list_users/0[in:Accounts]"`),
so the pattern matches. In production, the orchestrator (`analyzer.rs:3382-3394`) sends:

```rust
"id":         node.id,          // u128 hash (numeric string, no [in:])
"semanticId": semantic,         // URI form: grafema://...#FUNCTION-%3Eemit/3%5Bin:Ichi.EventBus%5D
```

So `gnId` contains no `[in:`, `extractModuleFromId` returns `Nothing` for every FUNCTION,
`qualIdx` is empty, every `Mod.func()` call falls through to `tryBuiltin` and emits 0 `CALLS` edges.

Unit tests in `packages/beam-resolve/test/Spec.hs` pass (9/9) because they never exercise
the hash-id + `semanticId`-in-metadata shape. `grafema-common/Grafema/Types.hs:43` already
exposes `gnSemanticId` helper for exactly this (reads `semanticId` from metadata, falls back
to `gnId`) — it's just not used in BeamLocalRefs.

### Production evidence (kami/ichi)

- FUNCTION `emit/3` in `Ichi.EventBus` exists (URI ID contains `%5Bin:Ichi.EventBus%5D`)
- 3990 CALL nodes with `name="Ichi.EventBus.emit"` exist
- `grafema who "emit/3"` → 0 callers
- Only 441 CALLS edges total; should be 3000+
- `cabal test` → 9/9 green (false safety)

## Plan

### Main fix (Steps 1–6) — closes the ticket's acceptance criteria

**Step 1 — reproduce with a failing test.**
`packages/beam-resolve/test/Spec.hs`, new `describe "production node shape"`:
- helper `mkProdNode` — hash-like `gnId`, semantic ID string stored as `MetaText` in `gnMetadata` under key `"semanticId"`.
- test: FUNCTION `emit/3` in `Ichi.EventBus` + MODULE node + CALL `Ichi.EventBus.emit` arity=3 from another file → expect CALLS edge to FUNCTION hash id. Should fail on current code.
- test (arity collision): `foo/1` and `foo/2` in same module, two CALL nodes with different arities → two distinct edges.
- test (arity fallback): CALL without `metadata.arity` → resolves via name-only fallback (backward compat with analyzers that don't populate arity).
- `cabal test` → red.

**Step 2 — fix `BeamLocalRefs`.**
- `buildQualifiedIndex`: `extractModuleFromId (gnSemanticId n)` instead of `gnId n`.
- `QualifiedIndex` → `Map (Text, Text, Int) Text` keyed on `(module, baseName, arity)`.
- Add `extractArity :: Text -> Maybe Int` parsing `"/N"` suffix from FUNCTION name.
- Secondary arity-agnostic index `Map (Text, Text) Text` for fallback.
- `lookupQualified`: try `(mod, fn, arity)` first, then `(mod, fn)` fallback.
- `resolveCall`: read arity from `gnMetadata callNode` (`"arity"` → `MetaInt`). If absent, arity-agnostic path.
- Module suffix index unchanged (already uses `gnName` of MODULE nodes — ID-agnostic).
- `cabal test` → green.

**Step 3 — rebuild.**
Use `scripts/build-native.sh` (memory says manual `cabal build` + `cp ~/.grafema/bin/` bypasses
`.build-hash` and the orchestrator's `target/release` symlinks). Verify binary mtime updated
and orchestrator picks up the new version.

**Step 4 — verify end-to-end on `~/kami/ichi`.**
```bash
cd ~/kami/ichi
grafema resolve                 # re-run resolution only, no full re-analyze
grafema who "emit/3"            # expect 30+ callers
grafema impact "emit/3"         # expect HIGH
grafema types                   # CALLS edge count should jump from 441 to ~3000+
```
If short of expected — diagnose remaining cases (aliases, pipe syntax, `&Mod.fun/1` captures).

**Step 5 — sibling spot check (narrow).**
Grep `packages/beam-resolve/src/*.hs` for `gnId n` used with `extractSomething` style parsing.
Note findings but fix only BeamLocalRefs in this step — full audit is Step 9.

**Step 6 — KB + Linear.**
- Update Linear REG-1097 → In Review after PR.
- Partial `/extract-knowledge` focused on hash-id vs semanticId finding (full extraction in Step 12).

## Scope rule (set during execution)

**BEAM-only.** Within REG-1097 we fix everything reachable in the BEAM stack
(beam-analyzer + beam-resolve + orchestrator wiring for BEAM). Cross-language
resolver audits (originally Step 9) are **out of scope** for this ticket.
A separate ticket can pick them up later if the same class is found elsewhere.

## Data point from Step 4 (kami unresolved triage)

After the main fix, `~/kami/ichi` still has 3446 unresolved BEAM CALLs. Tallying
the `symbol_name` of every unresolved-diagnostic ISSUE produced a 312-symbol
distribution. Two distinct streams emerged:

**Stream A — real builtins (~1000 calls):** Path/Map/Logger/String/File/DateTime/
Enum/Keyword/Application/GenServer/Task/Process/Jason/Regex/MapSet/System/Date/Float.
Resolvable via `effects-db/runtimes/elixir.yaml` + `Grafema.RuntimeGlobals` engine.

**Stream B — analyzer false positives (~1280 calls / 37%):** Three sub-classes:

1. **Operators / special forms classified as CALLs (~700):**
   `::` (467), `<<>>` (277), `%{}` (137), `@` (121), `|` (51), `{}` (49), `->` (45),
   `||` (34), `+` (27), `==` (26), `try` (41), `sigil_r` (19), `!=`, `>`, `>=`,
   `<`, `/`, `++`, `&&`, `and`, `in`, `<>`, …
   Root cause: `BeamAnalyzer.Rules.Calls.process/2` skip-list at `calls.ex:8`
   only excludes `[:__block__, :__aliases__, :fn, :&, :quote, :unquote]`.
   Every other atom-named AST node becomes a CALL.

2. **`<obj>.method` placeholder (~500):** `<obj>.to_string` (467), `<obj>.get` (28).
   In `calls.ex:30` when the receiver is not a simple identifier (chained access,
   pipe result), the analyzer writes the literal string `"<obj>"` as receiver.
   These CALL nodes carry no information and cannot be resolved by definition.

3. **Struct field access classified as CALL (~80):** `state.name`, `state.token`,
   `state.queue_dir`, etc. In Elixir AST `state.name` is `{{:., _, [{:state, _, _}, :name]}, _, []}` —
   `process_dot_call` does not distinguish a 0-arg dot from a function call, so
   field access becomes a CALL with arity 0.

### Follow-up stages (Steps 7–12) — batched in the same ticket

**Order rationale:** B → A → 7 → 8 → 10 → 11 → 12. Stream B first because cleaning
analyzer noise changes the picture for Stream A (some "missing builtins" may turn
out to be false positives). Step 9 dropped (out of scope per BEAM-only rule).

### Step 7.5b — beam-analyzer noise removal (Stream B)

`packages/beam-analyzer/lib/beam_analyzer/rules/calls.ex` + tests in
`packages/beam-analyzer/test/`.

1. **Skip-list expansion in `process/2`.** Add Elixir operators and special forms:
   - Arithmetic: `+ - * / div rem`
   - Comparison: `== != === !== < > <= >= =~`
   - Logical: `and or not && || !`
   - Membership: `in not in`
   - Bitstring: `<<>>`
   - Concat: `<> ++ --`
   - List/cons: `|`
   - Match: `= ^`
   - Pin/capture/access: `@ & ::`
   - Tuple/map literals: `{} %{}`
   - Special forms: `try case cond if unless with for receive when else after rescue catch`
   - Block / arrow: `__block__ __aliases__ -> fn quote unquote`
   - Sigils: every `sigil_*` atom (regex match `sigil_[a-zA-Z]`)

   Test (red-then-green): fixture file with `1 + 2`, `<<1, 2>>`, `%{a: 1}`,
   `try do … end`, `~r/foo/` → expect 0 CALL nodes for these constructs.

2. **Suppress `<obj>` placeholder calls.** In `process_dot_call/5` second clause
   (the fallback for non-identifier receivers): instead of emitting a CALL with
   receiver `"<obj>"`, emit nothing. These calls are unresolvable by construction
   and add only noise. The pipe-walker (`walk_pipe_arg`) has a similar fallback —
   audit and apply the same fix.

   Test: `state.foo.bar()` → 0 CALL nodes (we don't have type info to know what
   `state.foo` returns); `Mod.fun()` → 1 CALL (existing path unchanged).

3. **Field access vs zero-arg call.** In `process_dot_call/5`, when `args == []`
   AND the receiver is a known variable in scope (looked up via `Context.current_vars`
   or similar), emit a `PROPERTY_ACCESS` / `READS_FROM` node instead of a CALL.

   This is subtler — Elixir doesn't syntactically distinguish `state.name` (field)
   from `state.name()` (zero-arg function call on the value of `state`). The only
   reliable cue is "did the user write `()`?" — Elixir AST's `meta` carries a
   `:no_parens` marker for the field-access form. Verify and use that.

   Test: `state.name` (no parens) → PROPERTY_ACCESS, no CALL; `state.name()` →
   CALL with arity 0 (rare but valid).

4. **Re-analyze kami, measure delta.** Expected: ~1280 fewer unresolved CALLs.
   Update the unresolved tally — Stream A target list will shift.

### Step 7.5a — beam-runtime-globals via effects-db (Stream A)

Wire BEAM into the existing `Grafema.RuntimeGlobals` engine. Add a new
`beam-runtime-globals` plugin command alongside `beam-imports` / `beam-local-refs`.

1. **Taxonomy additions** (`effects-db/taxonomy.yaml`):
   - `SPAWN` — process creation. Optional metadata: `linked: bool`, `monitored: bool`.
   - `MESSAGE_PASSING` — async send / sync call between processes. Optional
     metadata: `direction: send|call|cast`, `target: pid|name|registered`.

   No `LINK` / `MONITOR` as separate effects — they're flags on `SPAWN`.

2. **`effects-db/runtimes/elixir.yaml`** — data-driven from the (post-Stream-B)
   unresolved tally. Start with the top-N modules covering ≥80% of remaining
   unresolved BEAM CALLs:
   - Kernel auto-imports (`+` etc. should already be filtered by Stream B,
     but `to_string`, `inspect`, `is_*`, `get_in`, etc. stay)
   - `Path`, `File`, `Logger` (IO + THROW for `!` variants)
   - `Map`, `Keyword`, `MapSet`, `Enum`, `String` (PURE)
   - `DateTime`, `Date`, `System` (NONDETERMINISTIC + IO)
   - `Application` (IO)
   - `GenServer` (MESSAGE_PASSING + ASYNC + SPAWN for start_link)
   - `Supervisor`, `Task`, `Agent`, `Process` (SPAWN + MESSAGE_PASSING)
   - `Jason`, `Regex` (PURE + THROW for `!`)
   - `Float`, `Integer` (PURE)

3. **`effects-db/runtimes/erlang.yaml`** — Erlang-style BIFs with `:` prefix
   for Elixir callers (`:erlang.*`, `:lists.*`, `:maps.*`, `:ets.*`, `:gen_server.*`,
   `:supervisor.*`, `:application.*`). Naming strategy uses `:` separator.

4. **`packages/beam-resolve/src/BeamRuntimeGlobals.hs`** — thin wrapper around
   `Grafema.RuntimeGlobals.resolveAll` with two NameStrategies:
   - Elixir: `nsSeparator = "."`, `nsPrefix = "BEAM_GLOBAL::"`,
     `nsCategory = "elixir-stdlib"`, `nsFilter = FilterCalls`,
     `nsEdgeType = "CALLS"`, `nsVirtualFile = "<runtime/elixir>"`.
   - Erlang: `nsSeparator = ":"`, `nsPrefix = "ERLANG_BIF::"`,
     `nsCategory = "erlang-bif"`, `nsVirtualFile = "<runtime/erlang>"`.

   Run both in sequence on the same node set, dedup virtual nodes via the engine's
   built-in seen-set.

5. **Wire into `Main.hs`** — new dispatch case `"beam-runtime-globals"`.

6. **Wire into orchestrator** — `packages/grafema-orchestrator/src/main.rs:1408`:
   ```rust
   &[("beam-imports", &[]), ("beam-local-refs", &[]), ("beam-runtime-globals", &[])]
   ```

7. **Remove hardcoded `beamBuiltins` from `BeamLocalRefs`** — now redundant.
   Leave it only for tests (until removed), or migrate the tests to assert via
   the new path.

8. **Tests:** unit tests against `RuntimeGlobals.resolveAll` with sample yaml +
   sample CALL nodes. End-to-end on kami: re-analyze, expect <500 unresolved
   (post-B + post-A combined).



**Step 7 — `BeamBehaviourResolution.findFileModule` hash-ID bug.**
Same symptom class: `extractFileFromId` parses `->` out of `gnId`, fails in production → all
`@behaviour` declarations miss their `IMPLEMENTS` edges. Preferred fix: change `ModuleIndex` to
`Map Text (Text, Text)` where second field is `gnFile` — avoids parsing IDs entirely.
- Red test (production-shape nodes) → IMPORT `kind=behaviour` → expect `IMPLEMENTS` edge.
- Fix.
- Verify on kami: GenServer/Supervisor → behaviour edges appear.

**Step 8 — `BeamProtocolResolution` audit.**
Currently believed to treat `gnId`/`gnName` as opaque keys. Verify by reading the full file and
checking kami's `defimpl` chains. If it parses semantic IDs anywhere, apply the same fix pattern.

**Step 9 — DROPPED (out of scope per BEAM-only rule).**
Cross-language resolver audit moved to a future ticket. Within REG-1097 we limit
the same-class search to `packages/beam-resolve/src/*.hs` only (covered by Step 5
spot check + the explicit fixes in Steps 7 and 8).

**Step 10 — Elixir alias tracking (`alias Foo.Bar, as: Baz`).**
Originally excluded. Now included as a stage with reproduction-first gate:
- Measure: `grep -rn "alias.*as:" ~/kami/ichi/lib/` + check CALL nodes whose module part is an
  alias rather than a full module name.
- If significant → design: either (a) beam-analyzer rewrites CALL names to full form at analysis
  time using scope-aware alias tracking (symmetric with BeamImportResolution), or (b) emit
  `ALIAS` nodes that the resolver consults before `lookupQualified`. Prefer (a).
- Tests: CALL through alias resolves to full function. Collision test: two different aliases in
  two functions each go to their own module.
- Verify on kami.

**Step 11 — guarantee rule.**
After all fixes, lock the invariant as a Datalog guarantee so regressions fail `grafema check`:
```datalog
violation(Call) :- node(Call, "CALL"),
                   attr(Call, "name", Name),
                   contains_dot(Name),
                   \+ edge(Call, _, "CALLS").
```
Strict variant scoped to BEAM files with an allowlist for builtins (Kernel, Enum, IO, ...).
Save in `.grafema/guarantees.yaml`. Catches: regressions from Steps 1–10, unsupported new alias
patterns, new qualified-call forms (pipe, `&Mod.fun/1` capture).

**Step 12 — closeout.**
- Update `AI-AGENT-STORIES.md`: cross-module Elixir navigation → WORKING (with kami example).
- `/extract-knowledge`: full KB pass.
  - FACT: resolver protocol — `gnId` is hash in prod, semantic ID lives in metadata.
  - FACT: Datalog guarantees are the right tool to lock resolver invariants.
  - DECISION: arity-aware qualified lookup (rejected alternative: name-only).
  - Reference: skill `grafema-uri-semantic-id-parsing` as related prior art.
- PR (requires explicit user approval per CLAUDE.md).

## Execution order

```
main fix:    Step 1 → 2 → 3 → 4 → 5 → 6                     [DONE]
analyzer:    Step 7.5b (Stream B — beam-analyzer noise removal)  [DONE]
runtime:     Step 7.5a (Stream A — elixir.yaml + erlang.yaml + RuntimeGlobals)  [DONE]
siblings:    Step 7 (behaviour hash-id + virtual external)   [DONE]
             Step 8 (protocol audit — no fix needed, sanity test added)  [DONE]
alias:       Step 10 — DEFERRED (kami has 0 `alias .. as:`, no production motivation)
hardening:   Step 11 — REPLACED by 17 unit tests + e2e (datalog engine lacks string ops needed for formal guarantee)
closeout:    Step 12 — done in this session: AI-AGENT-STORIES updated (US-21), plan file updated
```

Step 9 dropped (BEAM-only scope rule).

## Final results (2026-04-13)

**Acceptance criterion met.** `grafema who "emit/3"` on `~/kami/ichi`:
0 callers → **37 resolved callers** (target was 30+).

| Metric | Original | Final |
|--------|----------|-------|
| `grafema who "emit/3"` | 0 | **37** |
| Total CALL nodes | 3990 | 1822 (−54%, noise removed) |
| Unresolved CALLs | 3446 | **10** |
| Resolution rate | 14% | **99.5%** |
| GLOBAL_DEFINITION nodes (stdlib) | 0 | 149 |
| Virtual external MODULE nodes | 0 | 6 |
| IMPLEMENTS edges (`use →`) | 0 | 25 |
| beam-resolve unit tests | 9 | 17 |

The 10 remaining unresolved are all genuine external libraries (Req, Phoenix.PubSub,
Plug, ExUnit) — `effects-db/packages/` territory, not stdlib.

## Files changed

**beam-resolve (Haskell):**
- `packages/beam-resolve/src/BeamLocalRefs.hs` — `gnSemanticId`, arity-aware index, URI-encoded `[in:]` recognition
- `packages/beam-resolve/src/BeamBehaviourResolution.hs` — file-keyed index, `kind=use` recognition, virtual external MODULE nodes
- `packages/beam-resolve/src/BeamRuntimeGlobals.hs` — NEW, thin wrapper over `Grafema.RuntimeGlobals` for Elixir + Erlang strategies
- `packages/beam-resolve/src/Main.hs` — `beam-runtime-globals` dispatch, `IORef SymbolDB` cache
- `packages/beam-resolve/beam-resolve.cabal` — new module
- `packages/beam-resolve/test/Spec.hs` — 8 new test cases (12 → 17 total)

**beam-analyzer (Elixir):**
- `packages/beam-analyzer/lib/beam_analyzer/rules/calls.ex` — `callable?/1` predicate, drop `<obj>` placeholder, detect `:no_parens` for field access
- `packages/beam-analyzer/lib/beam_analyzer/rules/functions.ex` — gate `Calls.process` + `Infrastructure.process_call` behind `callable?/1`
- `packages/beam-analyzer/test/beam_analyzer_test.exs` — 4 new test cases (14 → 18 total)

**effects-db:**
- `effects-db/runtimes/elixir.yaml` — NEW, ~500 functions across 28 modules
- `effects-db/runtimes/erlang.yaml` — NEW, Erlang BIFs (`:erlang`, `:lists`, `:maps`, `:ets`, `:gen_server`, `:supervisor`, `:application`)
- `effects-db/taxonomy.yaml` — added `SPAWN` and `MESSAGE_PASSING` effects

**orchestrator (Rust):**
- `packages/grafema-orchestrator/src/main.rs` — registered `beam-runtime-globals`, `beam-behaviours`, `beam-protocols` plugins (were dead code before)

**Documentation:**
- `AI-AGENT-STORIES.md` — added US-21 (cross-module Elixir navigation: WORKING)

## Follow-ups (out of scope for REG-1097)

1. **`grafema who` should search GLOBAL_DEFINITION** — `who Logger.info` returns 0 callers despite 51 actual call sites
2. **`grafema impact` parity with `who`** — `impact emit/3` shows 0 direct callers while `who emit/3` shows 37
3. **`effects-db/packages/`** — Req, Phoenix, Plug, ExUnit — closes the last 10 unresolved BEAM CALLs in kami
4. **Symmetric virtual MODULE in `BeamImportResolution`** for non-`use` imports to external modules (alias, import, require)
5. **`alias Foo, as: Bar` tracking** — gated on a project that actually uses this pattern
6. **Datalog string predicates** (`contains`, `endswith`) — enables formal `qualified-call-resolved` guarantee
7. **Pre-existing flaky beam-analyzer worker timeouts** — random file failures during pool runs, not regression
8. **effects-db registry** — already in Linear backlog, current local-first lookup is by-design

Commits: Step 1+2+3 as one atomic change (red test + fix + new arity test).
Steps 7, 8, 9, 10, 11 — each its own commit, each through the 3-review pipeline.

## Risks / open questions

- **CALL arity metadata shape.** `packages/beam-analyzer/lib/beam_analyzer/rules/calls.ex:86`
  writes `metadata: %{arity: arity}` as integer. On the Haskell side that's `MetaInt`. Covered
  by a dedicated test. Pipe syntax / `&fun/1` captures may not set arity — arity-agnostic
  fallback catches these.
- **`splitQualifiedCall "Foo.Bar.Baz.func"`.** `last`/`init` on `splitOn "."` — module
  `"Foo.Bar.Baz"`, function `"func"`. Works.
- **Alias tracking depth.** Unknown until Step 10 measurement. If pervasive, Step 10 grows
  beyond the resolver into beam-analyzer.
- **Stale binary trap.** Memory warns: manual `cp` to `~/.grafema/bin/` bypasses `.build-hash`
  and `target/release` symlinks. Use `scripts/build-native.sh` only.
- **MCP grafema server is bound to `/Users/vadimr/grafema`, not `~/kami/ichi`.** Verification
  must go through the CLI (`grafema who`, `grafema types`, `grafema query`), not MCP.

## Decisions confirmed with user

1. All stages batched into REG-1097 (not split into follow-up tickets).
2. Step 10 may touch beam-analyzer (Elixir) in addition to beam-resolve (Haskell) — approved.
3. Step 9 may grow to fix resolvers for other languages in this same ticket — approved.

## What requires explicit user command (per CLAUDE.md)

- `git commit` / `git push`
- Creating the PR
- Any release / publish
