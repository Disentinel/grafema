# Datalog v2 — overnight autonomous loop report (2026-06-09)

Branch `feat/datalog`. All work committed + pushed, each a green revertable unit. This is
the decision-ready handoff: what landed, what's proven, and the supervised decisions waiting
for you. Running ledger stays in `rfdb-datalog-RESUME.md`; this is the morning-scannable digest.

## What landed this loop (newest first)

| Commit | Unit | Evidence |
|---|---|---|
| `e00268c1` | roadmap: sim() primitive logged | doc |
| `0c2e9c3b` | **sim() engine primitive** — hypothetical-edit query = read-only `maintain_incremental` over a hypothetical `BaseDelta` | `sim_hypothetical_edit_predicts_derived_facts_without_mutating_base`; datalog2::exec 21/21 |
| `e039371a` | apparatus iter6 — deployment-binding resolution closes frontend→backend chain | datalog2 smoke green |
| `427fbe63` | apparatus §8 — 5 prior-art citations web-verified | doc |
| `b0368872` | apparatus iter5 — express library-semantics as a Datalog rule | smoke green |
| `7fd8e080` | apparatus iter4 — value-domain via derived congruence (points-to) | smoke green |
| `c2071947` | coverage-as-negation on the REAL corpus — CALL resolution probe | 13634 CALL sites, 16.2% direct-resolved (honest Layout-A lower bound) |
| `6e316f49` | gaps: DERIVED_FROM vs DERIVES_FROM edge-vocab fork | 17385 dark edges |

## What is now PROVEN (no decision needed)

- **The abstract-interpretation apparatus** (`semantic-graph-as-abstract-interpretation.md`) is
  empirically validated end-to-end on the engine: value-domains (iter1/2/4), library-semantics
  (iter5), deployment-binding resolution (iter6), coverage-as-negation (iter3 + real data §6).
  Prior art (§8) cross-checked against DOOP, egg, chase/Datalog±, provenance-semirings, why-not/PUG.
- **sim()** (what-if) is the read-only dual of **why()** (already wired to MCP). Both soundness
  obligations pinned: `sim(base,Δ) ≡ scratch(base ∪ Δ)` and non-destructive (base untouched).
- **v2 `depends/2` ⊋ orchestrator DEPENDS_ON** on the real corpus is already characterized by
  `differential.rs` (the only-v2 delta = endpoints the orchestrator's MODULE#-sid parser drops but
  the file-attr join maps; diagnostic prints samples). This is evidence the legacy path is
  retireable after Gate E + one release (task #8 lock in place).

## Decisions WAITING on you (I did NOT do these autonomously — out of safe-revertable scope)

1. **`DERIVED_FROM` vs `DERIVES_FROM` vocabulary fork** (`_ai/gaps.md`, `6e316f49`).
   Analyzers emit `DERIVED_FROM` (Expressions.hs); types/edges.ts + queries + archetypes.ts use
   `DERIVES_FROM`. ~17k edges are dark to every consumer. *Cross-layer rename — needs your call on
   the canonical spelling before I touch analyzer + TS in lockstep.* Recommendation: canonicalize on
   `DERIVES_FROM` (the consumer side; fewer call-sites than re-pointing all queries) and emit a
   one-shot migration. Low risk once the name is chosen.

2. **sim() production vertical.** Engine primitive proven; the wire (`GraphEngineV2::sim_datalog_v2`
   + server `SimDatalog{source, hypothetical:[edits]}` + TS/MCP `sim_fact`, mirroring `explain_fact`)
   is a multi-file feature. Needs an **OverlayStorageView** (base view + in-memory hypothetical Δ) to
   run sim over the real `LsmStorageView`. *I held off because it's a supervised vertical with no
   consumer until you greenlight the MCP surface.* Recommendation: green-light — it's the natural
   companion to `explain_fact` and directly powers "what fact closes this gap?" for agents.

3. **Plugin system shape.** The menu item "rewrite analyzers/plugins onto the new system" presumes a
   concrete plugin loader/format. Today the only bundled mechanism is `datalog2/stdlib.rs`
   (`include_str!` a `.dl` + dispatch on empty source). The apparatus doc §3 sketches the
   polyglot-molecule {YAML ⊎ JS ⊎ Datalog} but there is no loader yet. *I did not author speculative
   stdlib rules — my own `materialize-only-what-queries-need` rule says list the consumer first.*
   Recommendation: before any analyzer rewrite, define the plugin manifest + loader contract (one
   design session); then the first migration target is the orchestrator's in-memory DEPENDS_ON
   derivation, which `depends.dl` already replaces — that's the proof-of-migration with a real consumer.

## Why I stopped grinding tests

The engine and its real-corpus validation are mature; further *autonomous* safe units were trending
toward marginal coverage-probe variants (declining insight). The remaining high-leverage work is the
three decisions above, all of which need your input or change a product surface. Synthesizing rather
than manufacturing more green commits is the honest call. The loop continues; if a safe, consumer-backed
unit surfaces (e.g. a real-code dragons-probe you'd act on), I'll take it.
