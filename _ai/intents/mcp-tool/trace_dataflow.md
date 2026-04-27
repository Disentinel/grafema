---
whenToUse: |
  Cross-function data trace. Forward: "where does this value flow
  next?" Backward: "where does this value come from?" Both: full
  lineage. Use for taint analysis, "is this user input ever logged",
  "is the password ever hashed before storage", "which response
  fields propagate to the cache".
seeAlso:
  - mcp:tool:trace_alias
  - mcp:tool:find_calls
  - cli:command:wtf
gotchas:
  - Start with `max_depth: 5` and increase if the trace truncates.
    Going to 20 on a large project may take seconds.
  - Cross-process flows (HTTP, queue messages) are surfaced via
    `CALLS_REMOTE` bridges only when the analyzer recognized the
    library — use the bridge-detection list to verify coverage.
---

## Forward trace from user input

```json
{ "source": "userInput", "file": "src/api.ts", "direction": "forward" }
```

## Backward trace to find sources

```json
{ "source": "response", "file": "src/api.ts", "direction": "backward", "max_depth": 7 }
```
