---
id: kb:fact:lod-extractor-only-fetches-outgoing
type: FACT
confidence: high
projections:
  - epistemic
relates_to:
  - packages/util/src/notation/lodExtractor.ts:extractSubgraph:FUNCTION
created: 2026-03-11
---

## lodExtractor only fetches outgoing edges — incoming edges require explicit fetch

`extractSubgraph()` in lodExtractor.ts uses `getOutgoingEdges()` exclusively. It never calls `getIncomingEdges()`. This means:

- `nodeMap` contains nodes that are **destinations** of edges (targets), plus containment children
- Nodes that are only **sources** of edges pointing into the subgraph are NOT included
- Any relationship where the interesting data is on the **source** side (like PASSES_ARGUMENT from CALL to arrow) requires an explicit `getIncomingEdges()` call

This is by design — BFS from root follows outgoing containment, then outgoing operator edges. But it creates blind spots for "who points at me?" queries within the subgraph.
