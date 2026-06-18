---
whenToUse: |
  Fetch Grafema's own usage documentation inline — query syntax, tool
  guidance, node/edge vocabulary, and "how do I…" help — without leaving
  the agent loop. Use when unsure how to phrase a Datalog/Cypher query,
  which tool answers a question, or what a node/edge type means.
  Renamed from get_documentation.
seeAlso:
  - mcp:tool:get_stats
  - mcp:tool:query_graph
gotchas:
  - For the live type vocabulary of a specific graph (not prose docs), use
    `get_stats(include=["schema"])` instead.
---

## Get usage docs for a topic

```json
{ "topic": "queries" }
```
