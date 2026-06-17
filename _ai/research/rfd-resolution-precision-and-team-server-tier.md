# RFD — Resolution precision, the soundness contract, and the team-server tier

**Status:** Draft for discussion · **Date:** 2026-06-16 · **Owner:** engine (laptop)
**Origin:** triage of the 1864 over-resolved CALLs surfaced by the `resolution-is-a-function`
guarantee (PR #431). Discussion with Vadim 2026-06-16.

## 1. Problem

Grafema's resolvers map a use-site (CALL / REFERENCE / PROPERTY_ACCESS) to its definition.
For some sites the resolver cannot pin a single target from local evidence and emits several.
The `resolution-is-a-function` guarantee (PR #431) measured **1864 over-resolved CALL
sources** on the real graph (503k nodes / 1.07M edges), dominated by cross-impl method calls
(`x.len()` / `.iter()` / `.new()`) where the receiver's concrete type isn't locally known, so
the resolver matches by method **name** across every `impl`.

The question this RFD answers: **is that a bug to gate on, an acceptable imprecision, or a
limitation we must surface — and where does precise resolution live?**

## 2. The distinction that drives everything: sound vs precise

- **Sound** = no false negatives. The real target IS in the emitted set.
- **Precise** = exactly one (the real) target, no extras.

The cross-impl fan-out is **sound but imprecise**: a superset that always contains the true
target plus spurious same-name candidates. This is a *strict improvement* over the retired
native `Map.fromList` resolver, which was **unsound** — it picked one arbitrary winner
(last-write-wins) and could silently drop the real target.

**Soundness is the contract; precision is a quality gradient.** A sound-but-imprecise edge
set is correct-but-noisy. An unsound result (missing or wrong-single edge) is a *defect*.

## 3. Decision: local = heuristic sound-superset; precise = team-server tier

Precise cross-method / type-aware resolution requires the language's own type inference.
Reimplementing it (a Rust trait solver, TS checker, …) inside the analyzer is both enormous
and language-specific — against the language-agnostic graph model. The realistic oracle is the
language's indexer (rust-analyzer, scip-typescript, scip-java …) exporting a **SCIP** index
(cross-language IR; each occurrence → its resolved definition symbol — `x.len()` → `Vec::len`).

**Measured cost** (`rust-analyzer scip .` cold, `packages/rfdb-server`, 102k LOC / 76 deps):

| metric | value |
|---|---|
| wall | **~149 s** (single-threaded, CPU-bound) |
| peak RSS | **~2.7 GB** |
| index size | **15 MB** SCIP |
| incremental? | **CLI: no** (cold re-index every run). Incrementality only in rust-analyzer's **LSP server** (salsa demand-recompute). |

Whole-repo Rust (~150–200k LOC) ≈ 3–5 min + ~3 GB cold; a full `analyze` is ~505 s — so cold
SCIP adds ~50–100% to the Rust slice plus a second fat process, **per language**.

→ **Too heavy for the local laptop loop.** Precise resolution is a **team-server / cloud
tier** (warm per-language indexers, or batch SCIP in CI). Local stays the heuristic
sound-superset: fast, sound, imprecise on type-dependent dispatch.

## 4. Principle: imprecision and unsoundness must be EXPLICIT (and double as upsell)

(Vadim, 2026-06-16) A resolver must never *silently* present N equal edges, nor silently drop
the real one. Both must be **flagged in the graph**:

- **Imprecise (sound superset):** mark the edges as ambiguous (`candidateCount: N` /
  `precision: "heuristic-superset"`), so a consumer (AI/human) knows not to trust a single
  target. The marker is the natural place for: *"precise resolution available on the
  team-server (SCIP-backed)."* — limitation marker doubles as product upsell.
- **Unsound (a real target dropped, or one wrong winner picked):** a hard flag — this is a
  defect, not a quality gradient.

## 5. Concrete designs

### 5.1 PR #431 — guarantee as an EXPLICIT one-to-many allowlist (not a blind carve-out)

> A use-site resolves to **at most one** target per `resolvedVia`, **UNLESS** that
> `resolvedVia` is in an explicitly-declared one-to-many allowlist — each entry documented
> with *why it is not a function*.

Allowlist (initial):
- `rust-dyn-dispatch` — **intentional** one-to-many (trait-object dispatch; multiplicity is
  correct semantics).
- `rust-cross-method` — **heuristic sound-superset** (no local receiver type → name-match
  across impls). Precise resolution = team-server SCIP. Tracked, not a CI blocker.

Crucially, an **unflagged** fan-out (any `resolvedVia` not on the allowlist — e.g. the
scope-precise `rust-calls`, or JS resolvers) is a **violation** → catches real bugs. The
resolver cannot silently fan out; it must stamp its `resolvedVia` and earn its allowlist slot.
Ships `severity:error`, green, teeth intact.

**Blocked on:** vm's fresh-graph histogram of the 1864 BY `resolvedVia` — confirm they carry
`rust-cross-method` (allowlist valid) and that **no** `rust-calls` (scope-walk fan-out = real
bug) or non-rust tail (js/method_calls = real bugs) hides in them.

### 5.2 Ambiguity marker on superset edges + a queryable surface (product feature)

Stamp superset edges so `find_*`/MCP can answer "which resolutions are ambiguous, and how
many candidates?" — the visible imprecision + the team-server pointer. Bigger than #431.

### 5.3 Team-server SCIP-precision tier (the upsell)

Warm per-language indexer (rust-analyzer LSP for incremental, or batch SCIP in CI) → ingest
each call-site occurrence → emit the single precise CALLS edge, collapsing the local superset.
SCIP is the common IR, so this generalizes across languages and fits the agnostic graph model.

## 6. Open questions

1. vm's 1864 histogram (§5.1 blocker).
2. Audit for any *actual unsoundness* (a resolver still picking one winner / dropping the
   real target) — current resolvers are superset (sound), but verify before claiming the only
   issue is imprecision.
3. Marker schema (§5.2): edge metadata field name + how `check`/MCP query it.
4. Team-server packaging (§5.3): warm-LSP vs batch-SCIP-in-CI; memory budget; freshness.

## 7. References
- [[project_scip_precision_is_team_server_tier]] (measurements + tier decision)
- [[project_datalog_resolver_parity_ceiling]] (sound-superset vs unsound-winner)
- [[project_invariant_at_merge_boundary_not_producer]] (guarantee enforcement model)
- PR #431 (`resolution-is-a-function`), task #29 (1864 triage)
