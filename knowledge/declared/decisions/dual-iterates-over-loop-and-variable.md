---
id: kb:decision:dual-iterates-over-loop-and-variable
type: DECISION
status: active
applies_to:
  - packages/js-analyzer/src/Rules/Statements.hs
effective_from: 2026-03-12
projections:
  - epistemic
created: 2026-03-12
---

## Emit Dual ITERATES_OVER Edges for For-of/For-in Loops

**Decision:** For `for (const item of arr)`, emit TWO ITERATES_OVER edges:
1. `ITERATES_OVER(LOOP, arr)` — structural: the loop iterates over the collection
2. `ITERATES_OVER(item, arr)` — data flow: the loop variable receives values from the collection

**Rationale:** The structural edge (loop→iterable) enables queries like "what does this loop iterate over?" The data flow edge (variable→iterable) enables backward tracing from the loop variable to the collection's values. Both are needed for different query perspectives.

**Rejected alternative:** Only emit the structural edge and have the trace algorithm infer the variable→iterable connection by walking the loop's scope. Rejected because: the loop variable could be declared in various ways (const, let, destructuring) and inferring which declaration corresponds to the loop's left side requires re-parsing the loop structure.

**Affected code:** `ruleForInOfStatement` in `packages/js-analyzer/src/Rules/Statements.hs`
