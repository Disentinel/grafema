---
id: kb:decision:semantic-address-lazy-rebind
type: DECISION
status: active
projections: [epistemic]
relates_to:
  - "packages/core:SemanticID:CLASS"
source: kb:session:2026-03-06-kb-architecture-design
created: 2026-03-06
---

Knowledge nodes reference code through semantic addresses (file:name:TYPE),
not node IDs. After code re-analysis, node IDs change. Rebinding resolves
semantic addresses to fresh IDs at query time (lazy, not eager).

Unresolvable addresses become "dangling refs" — a staleness signal,
not an error. Dangling refs are queryable and valuable information.

Prerequisite: Semantic IDs must be stable for unchanged code.
This is an invariant (guarantee), not an assumption — must be
continuously verified via check_guarantees.
