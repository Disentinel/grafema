# Edge verb-tense audit (decision #1, 2026-06-09)

Decision #1 (user-approved): edge types are STANDING relations → PRESENT tense / stative.
Scan basis: live edge-type inventory from the fresh graph (`get_stats` on graph.rfdb,
425 737 nodes / 942 563 edges, 51 edge types) + source grep.

## DONE this session: DERIVED_FROM → DERIVES_FROM

- Emitters: `packages/js-analyzer/src/Rules/Expressions.hs` (9 sites),
  `packages/haskell-analyzer/src/Rules/Expressions.hs`.
- Consumers updated: `packages/util/src/queries/traceDataflow.ts` (13 sites),
  `packages/util/src/enrichers/libraryCallbackEnricher.ts` (1 site), `haskell-analyzer/test/Spec.hs`.
- **This was also a live BUG fix**: the canonical registry `packages/types/src/edges.ts:63` and
  `traceValues.ts` already used `DERIVES_FROM`, which the analyzers never emitted — traceValues'
  DERIVES_FROM hops silently returned 0 rows on every real graph.
- Tests: haskell-analyzer 101/101 PASS; js-analyzer 24/25 (the 1 failure — METHOD_SIGNATURE
  HAS_PROPERTY, `test/Spec.hs:430` — is PRE-EXISTING at HEAD, verified by stashing the rename);
  util queries tests 68/68 PASS.
- Checked-in fixture DBs (`test/fixtures/ts-barrel-exports/.grafema/graph.rfdb`) still contain
  DERIVED_FROM edges — historical data; no test asserts on them via the renamed query paths (68/68).

## REMAINING past-tense outliers (full 51-type scan)

| Edge | Live count | Emitters | Consumers | Verdict |
|---|---|---|---|---|
| `ASSIGNED_FROM` | 19 195 | 38 sites in 6 native pkgs (cpp/js/java/python/kotlin analyzers + rust-resolve) | 26 TS files incl. `types/edges.ts:60` (canonical), lang-spec vocabulary `baseline.json` + prompts, MCP `query-tools.ts` docs, rfdb-server datalog tests | **Rename to present needs its own pass**: 5 Haskell rebuilds + types pkg + lang-spec vocabulary regen + MCP docs. Name TBD with user: `ASSIGNS_FROM` reads awkwardly; honest stative candidates: `FLOWS_FROM` or keep direction and use `READS_INIT_FROM`-style. Don't start without the name decision. |
| `GUARDED_WRITE` | 310 | (not audited to source yet) | — | Borderline: participle-as-adjective ("a guarded write"), arguably a noun phrase like `LAYOUT_POSITION`. Suggest: leave. |

Everything else in the live inventory is already present-tense (`CALLS`, `CONTAINS`, `READS_FROM`,
`DEPENDS_ON`, `GOVERNS`, …) or a noun (`LAYOUT_POSITION`, `MISSING_CONSTRUCTOR`).

## Verification of the DERIVES_FROM rename

Reanalysis with rebuilt analyzers (run log `/tmp/reanalyze-derives.log`) must show, via live query:
`DERIVES_FROM` ≈ 53 459 (old DERIVED_FROM count), `DERIVED_FROM` = 0.
Gotcha re-hit and fixed during this pass: stale sibling symlink
`packages/grafema-orchestrator/target/release/grafema-analyzer` → May-22 dist-newstyle build
(resolve_binary prefers siblings) — removed, same as the handoff did for grafema-resolve.
