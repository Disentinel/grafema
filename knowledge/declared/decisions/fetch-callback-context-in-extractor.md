---
id: kb:decision:fetch-callback-context-in-extractor
type: DECISION
status: active
applies_to:
  - packages/util/src/notation/lodExtractor.ts:fetchCallbackContext:FUNCTION
  - packages/util/src/notation/lodExtractor.ts:extractSubgraph:FUNCTION
effective_from: 2026-03-12
projections:
  - epistemic
created: 2026-03-11
---

## Fetch PASSES_ARGUMENT edges for arrows in lodExtractor, not renderer

Added `fetchCallbackContext()` step to `extractSubgraph()` that fetches incoming PASSES_ARGUMENT edges for anonymous arrow/expression nodes, plus resolves the CALL source node and sibling args into the nodeMap.

**Rejected alternatives:**
- **Make renderer async with backend access**: Would break the pure-function design of the renderer. The renderer should only work with pre-fetched SubgraphData.
- **Fix CALL node containment in orchestrator**: The root cause is that CALL nodes at module level lack containment edges (not CONTAINS'd by MODULE). Fixing the orchestrator would be correct long-term but is a separate task affecting graph structure.
- **Parse semantic IDs to extract names**: Could extract `server.setRequestHandler` from the edge.src semantic ID string without fetching the node, but fragile and wouldn't work for sibling arg resolution.

**Rationale:** The extractor is already the place that fetches graph data into SubgraphData. Adding one more fetch step keeps the renderer pure while working around the missing containment edges.
