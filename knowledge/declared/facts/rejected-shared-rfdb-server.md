---
id: kb:fact:rejected-shared-rfdb-server
type: FACT
projections: [epistemic]
confidence: high
source: kb:session:2026-03-06-kb-architecture-design
created: 2026-03-06
---

The "shared RFDB server across worktrees" approach was rejected for KB
persistence. In this design, one RFDB server per project would serve all
worktrees, with a shared knowledge database.

Rejected because: knowledge can be branch-specific. A fact true for one
branch may be false for another. Git merge provides the correct semantics
for isolating and merging branch-specific knowledge. CRDT/locking for
concurrent writes would be overkill and wouldn't solve the branch
isolation problem.
