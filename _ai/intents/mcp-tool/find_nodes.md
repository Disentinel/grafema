---
whenToUse: |
  Primary entry point for navigating the code graph. Find functions,
  classes, modules, or any node by type and/or name pattern.
  Replaces grep for structural questions: instead of "where is the
  string `UserService`", ask "where is the CLASS named `UserService`."
  Returns semantic IDs you can hand to other tools (`get_node`,
  `find_calls`, `trace`).
seeAlso:
  - mcp:tool:get_node
  - mcp:tool:find_calls
  - mcp:tool:trace
gotchas:
  - Name match is partial by default. Pass `fuzzyNameFallback: false`
    if you need exact substring instead of CamelCase-aware fuzzy.
  - For broad type categories (e.g. all FUNCTIONs in a project) use
    `limit` + `offset` for pagination — defaults cap at 10.
---

## Find a class by name

```json
{ "name": "DragAndDrop", "type": "CLASS" }
```

## All HTTP routes in a directory

```json
{ "type": "http:route", "file": "src/api/" }
```
