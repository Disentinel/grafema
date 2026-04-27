---
whenToUse: |
  "Why is the code structured this way?" Use `why` to query the
  knowledge base for decisions, facts, and historical reasoning
  attached to a code area. Returns DECISION / FACT / SESSION nodes
  linked via `applies_to` to the queried entity. The KB grows over
  time as Claude / agents annotate the codebase via `add_knowledge`
  and `extract-knowledge`.
seeAlso:
  - mcp:tool:query_decisions
  - mcp:tool:query_knowledge
  - mcp:tool:add_knowledge
gotchas:
  - Returns nothing on a fresh project — KB is empty until decisions
    are added (manually or via `/extract-knowledge` skill).
  - Symbol resolution is fuzzy; pass `--exact` if you want strict
    match on a specific node.
---

## Query knowledge base for a function

```sh
grafema why authMiddleware
```

```
{captured: query-knowledge-base-for-a-function}
```

## JSON output for tooling

```sh
grafema why authMiddleware --json
```
