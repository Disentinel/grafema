---
id: kb:fact:assigned-from-edge-direction
type: FACT
confidence: high
projections:
  - epistemic
relates_to:
  - packages/util/src/notation/renderer.ts:resolveAnonymousNames:FUNCTION
created: 2026-03-11
---

## ASSIGNED_FROM edge direction: src=variable, dst=value

The ASSIGNED_FROM edge goes `src → dst` where src is the variable receiving the assignment and dst is the value being assigned.

For `const handler = () => {}`:
- `src = VARIABLE:handler, dst = FUNCTION:<arrow>, type = ASSIGNED_FROM`
- Reads as: "handler is assigned from arrow"

This is `flow_in` archetype (`<` operator), rendered as: `handler { < assigned from <arrow> }`

**Key insight for reverse lookups:** To find what variable an arrow is assigned to, build a reverse index by `dst` (the arrow's ID), then look up `edge.src` to get the variable node.
