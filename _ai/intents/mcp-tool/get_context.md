---
whenToUse: |
  Single-call answer for "tell me everything you know about this
  node." Returns: source code snippet, immediate graph neighborhood
  (callers, callees, contains, contained-by), effects, throws.
  Cheaper than chaining multiple queries when you have a node id.
  Best paired with `find_nodes` (locate) → `get_context` (zoom in).
seeAlso:
  - mcp:tool:describe
  - mcp:tool:find_nodes
  - mcp:tool:get_function_details
gotchas:
  - Returns up to ~30 neighbors by default. For exhaustive
    traversal of a hub node (e.g. a popular utility), use
    `find_calls` + `traverse_graph` for paginated control.
---

## Get full context for a node

```json
{ "nodeId": "FUNCTION:authenticate@src/auth.ts" }
```
