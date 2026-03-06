---
id: kb:decision:kb-semantic-id-format
type: DECISION
status: active
projections: [epistemic]
source: kb:session:2026-03-06-kb-architecture-design
created: 2026-03-06
---

Every KB node has a stable semantic ID in format `kb:<type>:<slug>`.

Examples:
- kb:decision:kb-file-based-storage
- kb:fact:auth-uses-bcrypt
- kb:commit:48ae46c
- kb:ticket:REG-626

ID lives in frontmatter, not in filename. Filename can change freely.
Slugs are unique within type (kb:fact:X and kb:decision:X can coexist).

LLM generates slugs. On collision — error, not auto-suffix.
Collision is a useful signal: likely a duplicate that should be superseded.

For derived nodes: natural IDs (git hash, external ID) serve as slugs.
