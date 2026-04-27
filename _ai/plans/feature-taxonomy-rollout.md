# Feature-taxonomy rollout — implementation plan

**Status:** active. Created 2026-04-27 from theorist-mode session.
**Master research doc:** `_ai/research/feature-taxonomy.md`
**Companion docs:** `shape-and-contract-inference.md`, `cognitive-debt-and-feature-detection.md`.

This file lives in the repo so the work survives session death and Linear is
the canonical task tracker. Each row maps a logical task to its Linear issue.

## Linear issues

### Public-release critical path (v0.3 → publish gate)

| # | Linear | Title | Status | Blocks |
|---|---|---|---|---|
| 1 | **REG-1111** | Speced-contract framework + per-category extractors | Backlog | REG-1112, 1113, 1114, 1115, 1116, 1117, 1118 |
| 2 | **REG-1112** | commander.js → SpecedContract extractor | Backlog | (use case for REG-1116/1118) |
| 3 | **REG-1113** | MCP inputSchema → SpecedContract extractor | Backlog | (use case for REG-1116/1118). Was local task #28. |
| 4 | **REG-1114** | vscode contributes → SpecedContract extractor | Backlog | (use case for REG-1116/1118) |
| 5 | **REG-1115** | HTTP routes via effects-db (Express+Fastify+Koa+Hono) | Backlog | (use case for REG-1116). Was local task #26 / A1. |
| 6 | **REG-1116** | grafema export — multi-format spec emission | Backlog | autodoc product, REG-1118 |
| 7 | **REG-1117** | Regression-test infrastructure — CONTRACT diff + BEHAVIOR-hash golden | Backlog | (release-quality gate) |
| 8 | **REG-1118** | grafema describe --feature → markdown autodoc | Backlog | dogfood demo |
| 9 | **REG-1119** | Cross-modality dedup surfacing in CLI / MCP | Backlog | quick-win, no blockers |

### Post-release research thread (v0.5+)

| # | Linear | Title | Status | Notes |
|---|---|---|---|---|
| 10 | **REG-1120** | Emergent contract inference — channel-shape sender/receiver | Backlog | unique-segment value-prop |
| 11 | **REG-1121** | COMPONENT clustering (Phase 5) | Backlog | unblocks capability map + sociotechnical bridge |
| 12 | **REG-1122** | Graph-diff infra — semantic PR-diff per BEHAVIOR + CONTRACT | Backlog | extends REG-1117 |
| 13 | **REG-1123** | FEATURE_FLAG detection (Phase 10) | Backlog | hybrid Speced+Reflective |

### Sociotechnical bridge (separate session — see prompt)

Drafted as a brief at `_ai/prompts/sociotechnical-bridge-session-prompt.md` for
forking into a new Claude session. Not yet a Linear issue — open after the
bridge research lands. Tentatively lives at the COMPONENT layer (depends on
REG-1121).

## Implementation order

```
Sprint 4 (next):
   REG-1111 framework
   REG-1112 commander
   REG-1113 MCP
   → first two real Speced contracts on dogfood (Grafema's CLI + MCP)

Sprint 5:
   REG-1114 vscode contributes
   REG-1115 HTTP (Express/Fastify/Koa/Hono)
   REG-1119 cross-modality dedup surfacing  (quick-win parallel)
   → all five FEATURE-categories have real contracts

Sprint 6 (release prep):
   REG-1116 grafema export
   REG-1117 regression infra
   REG-1118 grafema describe --feature
   → autodoc and golden-tests gate; release-ready
```

## Local task / Linear correspondence

Local kanban task IDs from this session that overlap with Linear:

| Local | Linear | Note |
|---|---|---|
| #26 (Sprint 3 / A1) | REG-1115 | superseded |
| #28 (L1.5 MCP inputSchema) | REG-1113 | superseded |

After this commit, local tasks are deprecated; Linear is canonical.

## Cross-references

- `_ai/research/feature-taxonomy.md` — entity model
- `_ai/research/shape-and-contract-inference.md` — formal CONTRACT model
- `_ai/research/cognitive-debt-and-feature-detection.md` — detection phases, KB
- `_ai/prompts/sociotechnical-bridge-session-prompt.md` — separate-session brief
- `effects-db/` — registry of declarative extension surface

## Notes

- Killer-feature framing (positioning vs SwaggerGen / dataflow tools / FinOps /
  threat modeling / etc.) is held as **internal business analysis** for now,
  not in any of the public research docs. Discussed in chat 2026-04-27. Not
  for public surfacing — too many incumbents, want to pick our moment.
- REG-1118 may collapse into REG-1116 as `--as docs-md --feature <id>`; decide
  at implementation time of REG-1116.
