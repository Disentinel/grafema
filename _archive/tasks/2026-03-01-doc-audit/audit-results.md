# Documentation Audit — Pre-release 0.2.13-beta

*Date: 2026-03-01*

---

## Project Stats

| Language | Lines |
|----------|------:|
| TypeScript (src) | 122,863 |
| TypeScript + JS (tests) | 181,759 |
| Rust (rfdb-server) | 39,361 |
| Docs (md) | 6,299 |
| **Total** | **~350K** |

### By Package (TS src)

| Package | Lines | Role |
|---------|------:|------|
| core (v1) | 68,262 | Imperative analyzer (plugins, GraphBuilder, orchestrator) |
| cli | 16,215 | CLI interface |
| vscode | 11,723 | VS Code extension |
| core-v2 | 7,246 | Declarative edge-map walker |
| mcp | 6,960 | MCP server (24+ tools) |
| lang-spec | 4,678 | Language spec generator |
| rfdb (client) | 4,088 | Rust DB client |
| types | 2,472 | Shared types |
| api | 1,137 | GraphQL API |

### core v1 vs core-v2

| Metric | v1 | v2 |
|--------|---:|---:|
| Total lines | 68,262 | 7,246 |
| Plugins/analysis | 43,914 | — |
| Core infra | 14,038 | — |
| Visitors | — | 4,667 |
| Walk engine | — | 607 |
| Edge-map (declarative rules) | — | 198 |
| Resolve (deferred edges) | — | 1,022 |
| Registry | — | 409 |

v2 is ~10x less code. Golden construct coverage: 385/591 (65%). Neither v1 nor v2 covers all 591 — golden file is the target spec, not current v1 behavior.

---

## Changes Made

### Updated (10 files)

| File | What Changed |
|------|--------------|
| `CHANGELOG.md` | Added `[0.2.13-beta] - 2026-03-01` section (29 commits: core-v2, lang-spec, Redis/LibraryRegistry, RFDB flock) |
| `README.md` | Packages table 5→9 entries (added core-v2, api, rfdb, lang-spec) |
| `docs/ROADMAP.md` | Current state → v0.2.x, marked completed tasks (REG-293/292/291/252/306/311/259/270/271), version philosophy updated |
| `docs/_internal/AST_COVERAGE.md` | Full rewrite: dual v1/v2 columns, 40+ TS nodes, all v2 edge types, Navi→Grafema |
| `docs/_internal/TESTING.md` | Full rewrite: Navi→Grafema, structure/commands/helpers updated, CI section added |
| `docs/_internal/GUI_ROADMAP.md` | Navi→Grafema (line 3) |
| `docs/_internal/GUI_SPEC.md` | `navi:layout`→`grafema:layout`, "Navi-specific"→"Grafema-specific" |
| `docs/plugin-development.md` | `createTestBackend`→`createTestDatabase`, added v1/v2 note |
| `docs/configuration.md` | Added ReactAnalyzer to Analysis Phase plugin table |
| `docs/glossary.md` | Priority: "number" → "dependencies with topological sort" |

### Created (1 file)

| File | Content |
|------|---------|
| `packages/core-v2/README.md` | Architecture, edge-map, visitors, deferred references, scope tracking, 65% coverage note |

### Deleted (3 files)

| File | Reason |
|------|--------|
| `docs/_internal/REGINAFLOW_DB.md` | Dead NAPI architecture (rust-engine/, nodes.bin, ReginaFlowBackend). Real docs: rfdb-server/README.md |
| `docs/_internal/TODO-strapi-onboarding.md` | All 7 bugs (BUG-001..007) fixed. References `mcp__navi__*` tools and dead `rust-engine/` |
| `docs/_internal/semantic-coverage.md` | Uses `npx navi` CLI. Coverage methodology already in project-onboarding docs |

**Net: -563 lines** (1,132 deleted, 569 added)

---

## Audit Categories

### Critical (blocks release) — FIXED

1. **CHANGELOG.md missing 0.2.13-beta** — 29 commits since 0.2.12-beta had no changelog entry
2. **README.md packages table outdated** — missing core-v2, api, rfdb, lang-spec (4 of 9 packages)
3. **ROADMAP.md stuck on v0.1.0** — current state section described v0.1, not v0.2.x
4. **packages/core-v2 had no README** — new package with zero documentation

### Serious (need fix) — FIXED

5. **REGINAFLOW_DB.md describes dead architecture** — NAPI/embedded model, `rust-engine/` paths
6. **TESTING.md references "Navi"** — wrong project name, outdated test structure/commands
7. **AST_COVERAGE.md missing core-v2** — no v2 column, dozens of now-handled nodes shown as "Not Handled"
8. **plugin-development.md uses deprecated API** — `createTestBackend()` throws error since RFDB v2
9. **3 obsolete docs lingering** — strapi onboarding, semantic coverage, REGINAFLOW_DB

### Moderate — FIXED

10. **GUI_ROADMAP.md / GUI_SPEC.md say "Navi"** — old project name in 3 places
11. **glossary.md wrong Priority definition** — "number" vs actual topological sort
12. **configuration.md missing ReactAnalyzer** — used in examples but not in plugin table

### OK (left as-is)

- `docs/getting-started.md` — accurate
- `docs/cross-service-tracing.md` — accurate
- `docs/datalog-cheat-sheet.md` — accurate
- `docs/project-onboarding.md` — accurate
- `docs/_internal/ABSTRACT.md` — research doc, still relevant
- `docs/_internal/guarantee-workflow.md` — accurate
- `docs/_internal/PAID_READY_QUALITY_BAR.md` — accurate
- `docs/AUTO_RND.md` — research doc, still relevant
- All package READMEs (cli, mcp, types, rfdb, rfdb-server, vscode, lang-spec, api) — accurate
