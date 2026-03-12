---
id: kb:fact:backward-trace-requires-six-heuristics
type: FACT
confidence: high
projections:
  - epistemic
relates_to:
  - test/fixtures/dataflow-gauntlet/index.js
created: 2026-03-12
---

## Backward Reachability Trace Requires Six Key Heuristics

Tracing backward from a target variable to a SEED value through Grafema's graph requires these non-obvious heuristics beyond basic ASSIGNED_FROM/READS_FROM following:

1. **HAS_ELEMENT following** — values inside arrays (e.g., `[SEED]`) need descent into HAS_ELEMENT edges to find contained values
2. **HAS_PROPERTY following** — values inside objects (e.g., `{value: SEED}`) need descent into HAS_PROPERTY edges
3. **Receiver mutation heuristic** — `arr.push(x)`, `map.set(k,v)` etc. contribute data to the receiver. Pattern: CONSTANT ← READS_FROM ← REF ← READS_FROM(receiver) ← PA(mutationMethod) ← DERIVED_FROM ← CALL → PASSES_ARGUMENT → value
4. **FUNCTION RETURNS/YIELDS** — when reaching a FUNCTION node, its value is what it returns/yields. Follow RETURNS and YIELDS edges.
5. **Property write propagation** — connect read-side PA nodes to write-side PA nodes through shared receiver chain resolution (see fact: property-write-aliasing)
6. **Module-level THROWS + catch PARAMETER** — thrown values flow to catch parameters via THROWS edges on the MODULE node and catch scope's DECLARES

**Depth limit of 15** and visited set prevent cycles. Mutation methods tracked: push, unshift, splice, set, add, append, insert, enqueue, prepend.

**Result:** These 6 heuristics achieve 119/119 (100%) backward reachability on the dataflow gauntlet fixture.
