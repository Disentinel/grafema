---
whenToUse: |
  Explain or simulate derived (Datalog) facts — the provenance / what-if
  tool. Set `mode`:
  - "fact" — explain WHY a derived fact holds: the rule that derived it +
             supporting body facts. Requires predicate + key.
             "Why does module A depend on B?"
  - "gap"  — explain why a fact does NOT hold (why-not): the satisfied
             premise prefix and the first premise no binding satisfies
             (a missing positive premise, or a present negated one).
             Requires predicate + key.
  - "sim"  — predict which NEW derived facts a hypothetical overlay of
             nodes/edges would create, WITHOUT committing anything.
             Requires predicate + at least one hypothetical node or edge.
  Default program is the bundled depends.dl (so the common predicate is
  "depends"). Pass `source` for a custom Datalog program.
  Replaces the old explain_fact / explain_gap / sim_datalog tools — they
  are now `mode` values of one tool.
seeAlso:
  - mcp:tool:query_graph
  - mcp:tool:trace
  - cli:command:why
gotchas:
  - Keys/ids are wire-string terms — node ids as decimal strings.
  - mode="sim" overlay ids may be new/invented ids; nothing is persisted.
---

## Why does this derived fact hold? (fact)

```json
{ "mode": "fact", "predicate": "depends", "key": ["<A_id>", "<B_id>"] }
```

## Why does it NOT hold? (gap / why-not)

```json
{ "mode": "gap", "predicate": "depends", "key": ["<A_id>", "<B_id>"] }
```

## What-if: which facts would a new edge create? (sim)

```json
{
  "mode": "sim",
  "predicate": "depends",
  "edges": [{ "src": "<A_id>", "dst": "<B_id>", "edgeType": "IMPORTS_FROM" }]
}
```
