---
id: kb:decision:three-lifecycle-types
type: DECISION
status: active
projections: [epistemic]
source: kb:session:2026-03-06-kb-architecture-design
created: 2026-03-06
---

Knowledge in KB is split into three lifecycle types by soundness level
(from the 12-projection ontology in the sociotechnical context graph paper):

- **derived** (heuristic soundness): rebuildable from git.
  Temporal + Organizational projections. On conflict: regenerate.
- **declared** (declared soundness): human/AI-created artifacts,
  never auto-rebuilt. Epistemic projection. On conflict: human resolves.
- **synced** (declared soundness): API cache (Linear, PagerDuty),
  refreshable from source. Intentional + Causal projections.
  On conflict: refresh from API.

Different lifecycles require different --clear semantics, different
merge strategies, and different rebuild procedures.
