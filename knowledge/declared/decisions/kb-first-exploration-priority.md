---
id: kb:decision:kb-first-exploration-priority
type: DECISION
status: active
projections:
  - epistemic
relates_to:
  - CLAUDE.md
created: 2026-03-06
---

When exploring code or understanding a codebase area, the priority order is:

1. **Knowledge Base first** — `query_knowledge`, `query_decisions` for existing decisions, facts, session notes
2. **Code graph second** — `find_nodes`, `find_calls`, `get_file_overview` for structural understanding
3. **File reads last** — only when KB and graph don't have what's needed

This extends the existing "graph-first" dogfooding rule by adding the KB layer on top. The KB contains human-validated knowledge (decisions, facts, rationale) that is often more valuable than raw code structure for understanding "why" questions.

Rejected alternatives:
- Graph-only (no KB layer): misses architectural context, rationale, known gotchas
- KB-only: can't answer structural questions about current code state
