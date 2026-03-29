---
id: kb:fact:call-nodes-lack-containment-edges
type: FACT
confidence: high
projections:
  - epistemic
relates_to:
  - packages/util/src/notation/lodExtractor.ts:fetchCallbackContext:FUNCTION
created: 2026-03-11
---

## CALL nodes at module level lack containment edges

CALL nodes (e.g., `server.setRequestHandler(...)`) at the top level of a TypeScript file are **not** connected to the MODULE node via CONTAINS edges. They exist in the graph with correct PASSES_ARGUMENT outgoing edges, but have zero incoming containment edges.

**Evidence:** `get_context` on `CALL->server.setRequestHandler[h:5170]` with edgeType `CONTAINS,DECLARES,HAS_SCOPE` returned zero incoming edges. Meanwhile, FUNCTION and VARIABLE nodes at the same file level ARE properly contained.

**Impact:** `extractSubgraph` BFS from MODULE never visits these CALL nodes, so their PASSES_ARGUMENT edges don't appear in the subgraph. Workaround: `fetchCallbackContext()` in lodExtractor fetches incoming PASSES_ARGUMENT directly for arrow nodes.

**Root cause:** Likely the Rust orchestrator's containment visitor doesn't emit CONTAINS edges for standalone ExpressionStatement → CallExpression at module level.
