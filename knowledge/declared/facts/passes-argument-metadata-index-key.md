---
id: kb:fact:passes-argument-metadata-index-key
type: FACT
confidence: high
projections:
  - epistemic
relates_to:
  - packages/util/src/queries/NodeContext.ts:formatEdgeMetadata:FUNCTION
created: 2026-03-11
---

## PASSES_ARGUMENT metadata uses `index` key (not `argIndex`)

The orchestrator emits PASSES_ARGUMENT edges with `metadata.index` (0-based) for argument position. The older `argIndex` key is used in `formatEdgeMetadata` display in NodeContext.ts but the actual graph data uses `index`.

**Evidence:** `get_context` on CALL `server.setRequestHandler` showed PASSES_ARGUMENT edges with `metadata: { index: 0 }` and `metadata: { index: 1 }`.

The lambda resolution code checks both: `passEdge.metadata?.index ?? passEdge.metadata?.argIndex`.
