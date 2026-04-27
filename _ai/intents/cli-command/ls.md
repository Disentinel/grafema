---
whenToUse: |
  List nodes by type. Use when you want to enumerate "all functions in
  this file", "every CLASS in the project", "all HTTP routes". Returns
  bare names + locations — for full structure pass to `describe` or
  `get`. Fastest way to scan a category.
seeAlso:
  - cli:command:get
  - cli:command:query
  - mcp:tool:find_nodes
gotchas:
  - Without `--type` it lists every node — usually not what you want.
    Default is FUNCTION.
---

## Every CLASS in the project

```sh
grafema ls --type CLASS
```

```
{captured: every-class-in-the-project}
```
