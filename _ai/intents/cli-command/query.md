---
whenToUse: |
  Free-form search by name, type, route, or scope. Use for "I know
  roughly what I'm looking for" cases when you don't have a precise
  symbol. For Datalog-level queries, pass `--raw '<datalog>'`.
seeAlso:
  - cli:command:ls
  - cli:command:get
  - mcp:tool:query_graph
  - mcp:tool:find_nodes
gotchas:
  - The DSL parses your query — `function login` matches type=FUNCTION
    name=login, but ambiguous text falls back to substring search.
  - Datalog `--raw` queries fail open with a helpful warning if
    predicates are unknown — typos won't crash.
---

## Find by name

```sh
grafema query authenticate
```

```
{captured: query-name}
```

## Datalog raw query

```sh
grafema query --raw 'violation(F) :- node(F, "FUNCTION"), \+ edge(_, F, "CALLS").'
```
