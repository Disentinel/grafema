---
id: kb:decision:trace-property-write-in-algorithm-not-analyzer
type: DECISION
status: active
applies_to:
  - packages/js-analyzer/src/Rules/Expressions.hs
effective_from: 2026-03-12
projections:
  - epistemic
created: 2026-03-12
---

## Property Write Propagation Lives in Trace Algorithm, Not Analyzer

**Decision:** Property write aliasing (connecting `obj.prop = value` write sites to `x = obj.prop` read sites) is handled by the trace algorithm via receiver chain matching, NOT by emitting new edges in the Haskell analyzer.

**Rationale:** The analyzer correctly creates two distinct PROPERTY_ACCESS nodes — one for each syntactic access site. Adding a cross-referencing edge in the analyzer would require tracking all property accesses across the file and matching them, which is a resolution concern (like READS_FROM resolution), not an analysis concern.

**Rejected alternative:** Emit PROPERTY_ALIAS edges in the analyzer connecting PA nodes that access the same property on the same receiver. Rejected because: (1) requires O(n²) matching during analysis, (2) receiver identity is hard to determine statically, (3) the trace algorithm already has the infrastructure to resolve chains.

**Trade-off:** The trace algorithm is more complex, but the analyzer stays simpler and the graph stays closer to the syntactic truth.
