---
whenToUse: |
  "Is this safe to change?" Use `who` to enumerate every caller and
  reference of a function, method, class, or constant. Returns
  resolved call sites with file:line so you can audit breakage scope
  before refactoring. Pairs naturally with `wtf` (data side) — `who`
  is the call side.
seeAlso:
  - cli:command:wtf
  - cli:command:impact
  - mcp:tool:find_calls
gotchas:
  - Calls through aliases (`const fn = obj.method`) are resolved via
    the trace_alias chain — they show up correctly, unlike a plain
    grep.
  - Method names common to many classes (`get`, `parse`) return many
    matches; filter with `--type METHOD` and `--in <file>` to narrow.
---

## Find callers of a function

```sh
grafema who handleRequest
```

```
{captured: find-callers-of-a-function}
```

## JSON output for scripts

```sh
grafema who handleRequest --json
```
