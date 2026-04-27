---
whenToUse: |
  "If I change X, what else breaks?" Returns the downstream impact
  set — every node reachable from X via CALLS / READS_FROM / IMPORTS_FROM.
  Use before refactoring a hub function, before deprecating a public
  API, before changing a protected method's signature.
seeAlso:
  - cli:command:who
  - mcp:tool:trace_dataflow
gotchas:
  - Reports nodes, not callers — use `who` if you want the call-site
    list. `impact` is about "what data depends on this", `who` is
    "what code calls this".
  - Default depth 5; pass `--depth 10` for deeper hubs.
---

## Impact of changing a function

```sh
grafema impact handleRequest
```

```
{captured: impact-fn}
```
