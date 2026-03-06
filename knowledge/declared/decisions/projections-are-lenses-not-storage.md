---
id: kb:decision:projections-are-lenses-not-storage
type: DECISION
status: active
projections: [epistemic]
source: kb:session:2026-03-06-kb-architecture-design
created: 2026-03-06
---

The 12 projections from the sociotechnical context graph paper are
query-level lenses, not storage-level divisions. A single COMMIT node
belongs to both Temporal and Organizational projections simultaneously.

Storage is divided by lifecycle (derived/declared/synced), not by projection.
Projection tags on nodes enable query filtering (e.g., find all nodes
in the "organizational" projection).

Source: "The graph is one; the projections are lenses." — paper Section 3.1.
