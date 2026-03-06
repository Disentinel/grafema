---
id: kb:decision:knowledge-dir-at-project-root
type: DECISION
status: active
projections: [epistemic]
source: kb:session:2026-03-06-kb-architecture-design
created: 2026-03-06
---

Knowledge directory lives at project root (`knowledge/`), not under
`.grafema/`. Reason: KB is human-readable, git-tracked content that
should be visible on GitHub, in PR reviews, in IDE file tree, and
findable by grep/search.

`.grafema/` remains a runtime/cache directory (gitignored), analogous
to `.git/` — infrastructure nobody browses directly.
