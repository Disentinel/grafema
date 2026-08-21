---
whenToUse: |
  The unified node inspector — single-call answer for "tell me about
  this node." `target` is a semantic ID (from find_nodes/query_graph), a
  node name, or a file path. Pick how much to return with `detail`:
  - "record"    — raw node record only (fast lookup, no edges)
  - "neighbors" — direct in/out edges grouped by type (no source code)
  - "context"   — (default) source code + full neighborhood with code context
  - "full"      — for a FUNCTION/METHOD: callers + callees, transitive chains
  Smart defaults when detail is omitted: a file path / MODULE → a file
  overview (imports, exports, classes, functions, constants); a
  CLASS/INTERFACE/typed VARIABLE → its shape (methods + properties).
  Best paired with `find_nodes` (locate) → `get_node` (zoom in).
  Replaces the old get_context / get_file_overview / get_function_details /
  get_shape / describe tools — they are now `detail` levels of one tool.
seeAlso:
  - mcp:tool:find_nodes
  - mcp:tool:find_calls
  - mcp:tool:trace
gotchas:
  - "context" returns up to ~30 neighbors by default. For exhaustive
    traversal of a hub node (e.g. a popular utility), use `find_calls` +
    `trace(along="edges")` for paginated control.
  - Set `graph: "knowledge"` to inspect an entity in the project knowledge
    graph (its edges and metadata) instead of the code graph.
  - `format: "dsl"` renders compact Grafema notation; with it you may pass
    `perspective` (security|data|errors|api|events) and `context_lines`
    maps to DSL depth.
---

## Full context for a node (default)

```json
{ "target": "FUNCTION:authenticate@src/auth.ts" }
```

## Just the record, no edges

```json
{ "target": "UserService", "detail": "record" }
```

## Overview of a source file (file path ⇒ file overview)

```json
{ "target": "packages/cli/src/cli.ts" }
```

## Comprehensive function details (callers + callees, transitive)

```json
{ "target": "processOrder", "detail": "full" }
```

## Inspect a knowledge-graph entity

```json
{ "target": "RFDB", "graph": "knowledge", "detail": "neighbors" }
```
