---
id: kb:fact:clear-deletes-filesystem-directory
type: FACT
projections: [epistemic]
relates_to:
  - "packages/cli:CLI:MODULE"
confidence: high
source: kb:session:2026-03-06-kb-architecture-design
created: 2026-03-06
---

Current implementation of `--clear` deletes the `.grafema/` directory
via filesystem rm, not through an RFDB CLEAR command. Any persistent
data stored in that directory is destroyed.

This is the root cause for why KB cannot live under `.grafema/` alongside
volatile code graph data.
