---
whenToUse: |
  "Who calls this?" — the structural question grep can't answer
  because of aliases, re-exports, dynamic dispatch. Returns every
  resolved call site of a function or method with file:line. The
  callable side mirror of `trace(along="data")` (data side); for the
  transitive call graph use `trace(along="calls")`.
seeAlso:
  - mcp:tool:trace
  - mcp:tool:find_nodes
  - cli:command:who
gotchas:
  - For methods, pass `className` to disambiguate when the same
    method name exists on multiple classes (`get`, `parse`, …).
---

## Find all callers of a function

```json
{ "name": "createTerminal" }
```

## Method on a specific class

```json
{ "name": "get", "className": "redis" }
```
