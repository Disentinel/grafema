## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK with one noted smell (documented below)

---

### Vision Alignment

The thesis is: AI should query the graph, not read code. This feature advances that directly.

Before this change, a PROPERTY_ACCESS node was an island. The graph knew that `options.graph` existed somewhere in a file, but nothing connected it to the `options` parameter. An AI agent wanting to trace "where does `options.graph` come from?" had no graph path to follow — it had to fall back to reading code.

After this change: `PROPERTY_ACCESS(options.graph) --READS_FROM--> PARAMETER(options)`. The agent can now follow edges:
`options.graph` → `READS_FROM` → `options` (PARAMETER) → `PASSES_ARGUMENT` → call site → caller → what was passed.

This is exactly the kind of edge that makes the graph queryable instead of code being required. Value Trace can now follow property access chains through the graph without reading source.

The `this.prop` → CLASS link is also correct in intent: it anchors `this`-accesses to the class node, enabling "all properties read from this class" queries.

**Verdict on vision:** This is not a nice-to-have. It is a load-bearing feature for Value Trace. Approve.

---

### Architecture

**Complexity (mandatory checklist):**

1. **Iteration space:** O(P × (V + Pa)) per module — for each property access, scan variables then parameters. V and Pa are per-module, not global. This is the same pattern already used by MutationBuilder and is accepted as correct. No O(n) over ALL nodes anywhere.

2. **Reuse of existing iteration:** Yes. `bufferPropertyAccessNodes` already iterated over all property accesses for CONTAINS edges. The READS_FROM logic is appended inside the same loop — no new traversal pass added.

3. **O(n) over ALL nodes:** None found. `resolveVariableInScope` and `resolveParameterInScope` take the current-module slice as input, not the global graph.

**Existing abstractions:** Yes. `resolveVariableInScope` and `resolveParameterInScope` are the established pattern, used identically in MutationBuilder and CallFlowBuilder. The `this`-to-CLASS lookup uses the same basename comparison established in MutationBuilder (REG-152). No new resolution logic was invented.

**Forward registration pattern:** Yes. This is analysis-phase work, not enrichment-phase. The data is available at build time (within-module variables and parameters are known). Correct placement.

---

### Limitations (acknowledged, not blocking)

**Chained access:** For `a.b.c`, only the first link `PROPERTY_ACCESS(a.b) --READS_FROM--> VARIABLE(a)` gets the edge. The second link `PROPERTY_ACCESS(a.b.c)` has `objectName = "a.b"` — a dotted string — which is explicitly skipped by the `objectName.includes('.')` guard. This means transitive tracing requires two hops: PA(a.b.c) → PA(a.b) [via chain structure] → VARIABLE(a). This is correct and intentional, not a defect. The comment in the code is honest about this.

**`this.prop` → CLASS:** This links to the CLASS node, not to a specific PROPERTY node declared on the class. For "trace where this.graph was set" queries, the path is: PA(this.graph) → CLASS → MUTATION(this.graph). Two hops but fully traversable. Works.

**One noted smell:** The file basename comparison for CLASS lookup (`basename(propAccess.file)` vs `c.file`) duplicates an existing inconsistency that MutationBuilder already works around. This is a pre-existing data model issue — classes store basename, everything else stores full path. The implementation correctly inherits the same workaround. This should be fixed at the root in a future task (class nodes should store full path), but that is out of scope for REG-555.

---

### Summary

The implementation is correct, scoped, and architecturally aligned. It reuses established patterns, adds no new traversal passes, and directly enables graph-based value tracing that was previously impossible without reading code. The limitations are real but bounded and honestly documented.

Approve.
