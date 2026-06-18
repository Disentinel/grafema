---
whenToUse: |
  "Where the hell does this value come from?" Use `wtf` to trace
  backward from a variable, expression, or property access to every
  source that writes to it — across function boundaries, files, and
  packages. The classic case: a bug log shows `req.user.id` is
  undefined, and you need to find the upstream code that should have
  set it.
seeAlso:
  - cli:command:trace
  - cli:command:who
  - mcp:tool:trace
gotchas:
  - Symbol resolution falls back to fuzzy match if the literal name
    doesn't exist. Quote the symbol or pass `--no-fuzzy` for strict.
  - Cross-package traces depend on `grafema analyze` having seen both
    sides. Re-run `grafema analyze` if a recently-added dependency
    isn't traced.
  - "`wtf` traces variables, parameters, and property accesses — not
    function or class names. `grafema wtf validateSession` returns
    'Symbol not found' even if the function is in the graph. For
    callers of a function, use `who`; for downstream impact, use
    `impact`."
---

## Backward trace from a variable

```sh
grafema wtf featureId
```

```
{captured: backward-trace-from-a-variable}
```

## Custom depth

```sh
grafema wtf featureId --depth 15
```
