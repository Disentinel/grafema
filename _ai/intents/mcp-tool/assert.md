---
whenToUse: |
  The SINGLE knowledge-write tool. BATCH-NATIVE: pass an array of
  assertions; one fact is an array of one. Use when you discover something
  worth remembering across sessions — a decision, experiment result,
  dependency, contradiction, or any relationship between two entities.
  Both `from` and `to` become nodes if they don't exist yet.
  Relation-expressed facts are just `assert` with the right relation — to
  record that a newer finding replaces an older one, use
  relation:"supersedes" (no separate supersede/supersede_fact tool).
  Re-asserting the same {from, relation, to} updates that edge's
  context/confidence.
  Replaces remember / add_assertion / update_assertion / supersede(_fact).
  "Enox" is the assertion protocol Grafema supports, not a tool prefix —
  hence `assert`, not `enox_remember`.
seeAlso:
  - mcp:tool:retract
  - mcp:tool:recall
  - mcp:tool:save_document
gotchas:
  - Include a rich `context` string — that is what `recall` searches over.
  - `confidence` defaults to 0.9; `domain` scopes the fact to a knowledge
    domain that `recall`/`query_graph` can filter on.
  - To delete a fact entirely use `retract({fact_ids:[...]})`; prefer a
    "supersedes" assertion when you want to keep the history.
---

## Record a single fact

```json
{ "assertions": [
  { "from": "Grafema", "relation": "uses", "to": "RFDB",
    "context": "RFDB is the storage engine", "confidence": 1.0, "domain": "engineering" }
] }
```

## Batch several facts at once

```json
{ "assertions": [
  { "from": "V2 engine", "relation": "supersedes", "to": "V1 engine",
    "context": "segment-based persistence" },
  { "from": "compaction", "relation": "depends_on", "to": "RFDB",
    "context": "L1 compaction runs inside the storage engine" }
] }
```
