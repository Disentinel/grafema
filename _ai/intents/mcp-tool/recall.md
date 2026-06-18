---
whenToUse: |
  Broad "what do we know about X" retrieval over the project knowledge
  graph — combines name/content (semantic) search with graph traversal.
  Use at session start or before making decisions to check for prior art,
  known failures, and existing context. `depth` controls how far to
  traverse from matched seed nodes (1 = direct matches, 2 = + neighbors,
  3 = two hops out). `top_k` caps matched seed nodes; `domain` filters to
  one knowledge domain.
  This is the single knowledge-retrieval entry point — the old
  semantic_search (pure embedding similarity) is folded into recall; for
  exact name/type/domain filtering use `query_graph`/`find_nodes` with
  `graph: "knowledge"`.
seeAlso:
  - mcp:tool:assert
  - mcp:tool:query_graph
  - mcp:tool:get_node
gotchas:
  - depth=3 is broader but slower; start at depth=2 for a good balance.
  - Results include `age_days` — older findings in fast-moving domains may
    be stale; check before relying on them.
---

## What do we know about a topic?

```json
{ "query": "federation architecture", "depth": 2, "top_k": 10 }
```

## Scope to one knowledge domain

```json
{ "query": "compaction tradeoffs", "domain": "engineering", "depth": 2 }
```
