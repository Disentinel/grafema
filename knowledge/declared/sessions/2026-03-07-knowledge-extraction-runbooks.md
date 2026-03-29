---
id: kb:session:2026-03-07-knowledge-extraction-runbooks
type: SESSION
task_id: REG-630
projections:
  - epistemic
produced:
  - kb:decision:kb-extraction-via-skill-and-workflow
  - kb:decision:kb-first-exploration-priority
  - kb:decision:runbook-three-pass-template
  - kb:fact:kb-mcp-tools-require-rebuild
  - kb:fact:no-vector-search-in-kb
  - kb:fact:claude-hooks-are-shell-only
created: 2026-03-07
---

Implemented REG-630: Knowledge Extraction Runbooks + automation infrastructure.

Created 3 extraction runbooks following a 3-pass template (entity extraction, relationship extraction, cross-reference validation):
- `01-git-history.md` — extract COMMIT and AUTHOR nodes from git log
- `02-claude-sessions.md` — extract SESSION, DECISION, FACT from Claude sessions
- `03-existing-docs.md` — extract DECISION, FACT from existing .md files (ADRs, READMEs, research)

Created validation framework (README.md) with 6 checks: ID validation, collision, edge validation, semantic address resolution, duplicate detection, provenance.

Built automation layer:
- `/extract-knowledge` skill for manual/workflow invocation
- Added step 6 (Knowledge Extraction) to workflow pipeline
- Added KB-first exploration priority to CLAUDE.md dogfooding rules
- Added mandatory extraction rule to CLAUDE.md

Key finding: KB MCP tools require MCP server rebuild+reconnect to be available in workers.
