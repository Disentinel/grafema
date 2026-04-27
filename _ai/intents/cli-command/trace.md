---
whenToUse: |
  Bidirectional dataflow trace with knobs `wtf` doesn't expose:
  `--to <sink>` (where does data flow into this sink?),
  `--from-route <method+path>` (the response body of an HTTP route
  back to its sources), depth control, file scoping. Use `wtf` for
  the simple "where does this come from?" case; reach for `trace`
  when you need precision.
seeAlso:
  - cli:command:wtf
  - mcp:tool:trace_dataflow
  - mcp:tool:trace_calls
gotchas:
  - Cross-language traces depend on bridge detection (the analyzer
    knows about specific HTTP / queue / RPC libraries). Bridges that
    aren't in effects-db won't propagate.
---

## Trace by name

```sh
grafema trace featureId
```

```
{captured: trace-by-name}
```

## Scope-pinned trace

```sh
grafema trace "featureId from collectFeatureSnapshots"
```
