---
id: kb:decision:kb-file-based-storage
type: DECISION
status: active
projections: [epistemic]
relates_to:
  - "packages/cli:CLI:MODULE"
  - "packages/mcp:MCP:MODULE"
source: kb:session:2026-03-06-kb-architecture-design
created: 2026-03-06
---

Knowledge Base is stored as git-tracked files, not persisted in RFDB.
RFDB is used only as a runtime read cache for fast queries.
Source of truth = filesystem + git.

KB must merge through git between branches and worktrees. RFDB is rebuilt
from scratch on each analysis, making it unsuitable for persistent data.

Rejected alternatives:
- Shared RFDB server across worktrees: branch isolation impossible,
  knowledge valid for one branch may be invalid for another.
- Single RFDB with provenance tags (source: "analysis" | "manual"):
  same identity problems when clearing analysis nodes.
- Append-only versioned RFDB: storage growth, GC complexity, overkill.
