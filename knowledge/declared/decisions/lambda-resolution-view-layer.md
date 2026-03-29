---
id: kb:decision:lambda-resolution-view-layer
type: DECISION
status: active
applies_to:
  - packages/util/src/notation/renderer.ts:resolveAnonymousNames:FUNCTION
  - packages/util/src/queries/NodeContext.ts:getNodeDisplayName:FUNCTION
effective_from: 2026-03-12
projections:
  - epistemic
created: 2026-03-11
---

## Lambda context resolution in view layer, not enrichment plugin

Resolve anonymous `<arrow>` and `<expression>` names in the notation renderer (view layer), not via a graph enrichment plugin.

**Priority chain:**
1. Assignment: `const handler = () => {}` → use variable name from ASSIGNED_FROM edge
2. Callback: `setRequestHandler(Schema, λ)` → compose `λ → callName(siblingArgs)` from PASSES_ARGUMENT edge
3. Fallback: `λ` (unicode symbol)

**Rejected alternatives:**
- **Enrichment plugin**: Would permanently rename nodes in the graph, losing the original `<arrow>` information. View-layer resolution keeps the graph truthful and applies display names only at render time.
- **CLI-only resolution**: Would miss MCP consumers. Placing in renderer covers all notation output paths.

**Rationale:** The graph should store what the code IS (`<arrow>`), the view should show what it MEANS (`handler` or `λ → setRequestHandler`). This is a display concern, not a data concern.
