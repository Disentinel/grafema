---
whenToUse: |
  Fetch a single node by its semantic ID. Use after `ls` or `query`
  hand you back an ID — `get` returns its full attributes (file, line,
  exports, imports, metadata). Cheaper than `describe` when you just
  need fields, not relationships.
seeAlso:
  - cli:command:describe
  - cli:command:ls
  - mcp:tool:get_node
gotchas:
  - Semantic IDs include `::`, `@`, `<…>` — quote the ID when passing
    as shell argument so the shell doesn't expand parts.
---

## Get a node by semantic ID

```sh
grafema get "packages/util/src/enrichers/specedContractEnricher.ts->FUNCTION->enrichSpecedContracts"
```

```
{captured: get-a-node-by-semantic-id}
```
