---
id: kb:session:2026-03-06-kb-architecture-design
type: SESSION
projections: [epistemic]
task_id: REG-626
session_path: ~/.claude/projects/-Users-vadimr-grafema/sessions
produced:
  - kb:decision:kb-file-based-storage
  - kb:decision:three-lifecycle-types
  - kb:decision:frontmatter-and-yaml-formats
  - kb:decision:semantic-address-lazy-rebind
  - kb:decision:projections-are-lenses-not-storage
  - kb:decision:kb-semantic-id-format
  - kb:decision:knowledge-dir-at-project-root
  - kb:fact:clear-deletes-filesystem-directory
  - kb:fact:rejected-shared-rfdb-server
  - kb:fact:twelve-projection-ontology
  - kb:ticket:RFD-47
  - kb:ticket:REG-626
  - kb:ticket:REG-627
  - kb:ticket:REG-628
  - kb:ticket:REG-629
  - kb:ticket:REG-630
created: 2026-03-06
---

Design session for Knowledge Graph persistence architecture.

Started with the question: how to persist non-code graph data (ADRs, tasks, etc.)
when the code graph is frequently rebuilt from scratch?

Design evolved through 3 iterations:
1. RFDB multi-database with selective CLEAR (rejected: still can't merge across branches)
2. Shared RFDB server across worktrees (rejected: branch-specific knowledge impossible)
3. Git-tracked files with RFDB as runtime cache (accepted)

Analyzed sociotechnical-context-graph paper, mapped 12 projections to storage lifecycle types.
Ran POC extraction on this session itself, discovered gaps in extraction process.
