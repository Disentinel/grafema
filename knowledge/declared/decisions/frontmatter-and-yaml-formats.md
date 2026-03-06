---
id: kb:decision:frontmatter-and-yaml-formats
type: DECISION
status: active
projections: [epistemic]
source: kb:session:2026-03-06-kb-architecture-design
created: 2026-03-06
---

Two file formats in KB:

- **.md with YAML frontmatter**: for human/AI-authored content (facts,
  decisions, ADRs, sessions). Readable in any editor and on GitHub.
  Frontmatter is a standard pattern (Jekyll, Hugo, Obsidian, gray-matter).
  Body markdown = content of the node.

- **.yaml**: for machine-generated structured data (commits, authors,
  tickets, edges). No prose needed, pure data.

Unified parser: if .md -> gray-matter extracts frontmatter + body.
If .yaml -> direct parse.
