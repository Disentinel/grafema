## Steve Jobs — Vision Review

**Verdict:** APPROVE

---

**Vision alignment:** OK

**Architecture:** OK, with one observation worth tracking

---

### What this is

A regression fix. REG-487 made analysis 5.2x faster by introducing deferred indexing via `commitBatch`. That optimization broke a protocol assumption: two phases (INDEXING and ANALYSIS) both call `commitBatch` on the same file, and the delete-then-add semantics of `commitBatch` caused ANALYSIS to destroy MODULE nodes that INDEXING had created. Result: 42.9% of nodes disconnected, 316 of 330 MODULE nodes gone.

The fix: add `protectedTypes` to the `commitBatch` wire protocol. When ANALYSIS commits, it passes `protectedTypes: ['MODULE']`, which instructs the server to skip deletion of MODULE nodes during the replacement pass.

---

### MANDATORY Complexity & Architecture Checklist

**1. Complexity Check**

The `protected_types` check runs inside the existing file-deletion loop that already iterates over nodes for `changedFiles`. This is not a new iteration — it is a conditional inside an existing loop. The `get_node` call for protected-type checking only happens when `protected_types` is non-empty (guarded by `if !protected_types.is_empty()`). When the list is empty, which is the case for all calls except ANALYSIS batches, there is zero overhead.

This is O(m) over files being committed, not O(n) over all nodes. There is no graph scan. **No red flag.**

**2. Plugin Architecture**

The implementation uses forward registration: JSASTAnalyzer declares at the call site that it needs MODULE preservation. The server obeys. There is no backward scanning, no "find all MODULE nodes and protect them globally". The declaration travels with the commit message. **Good pattern.**

PhaseRunner additionally hard-codes `protectedTypes: ['MODULE']` for the ANALYSIS phase name at line 98:

```typescript
const protectedTypes = phaseName === 'ANALYSIS' ? ['MODULE'] : undefined;
```

This is a policy decision expressed at the runner level. It is visible, centralized, and not scattered. Any plugin running in ANALYSIS phase that manages its own batch (`managesBatch: true`) falls through the `if (!graph.beginBatch ... || plugin.metadata.managesBatch)` guard at line 83-87 and bypasses PhaseRunner's batch entirely — which is exactly what JSASTAnalyzer does. JSASTAnalyzer declares `managesBatch: true` and issues its own per-module `commitBatch(['MODULE'])` call. The PhaseRunner path with `protectedTypes` is therefore a defense-in-depth for non-`managesBatch` ANALYSIS plugins. Both paths are correct.

**3. Extensibility**

If a future phase introduces another structural node type that must survive a later phase's commit, the caller adds that type to `protectedTypes`. No server changes required — the protocol already carries the list. **Good extensibility.**

**4. Grafema doesn't brute-force**

Confirmed. No scan of all nodes looking for a pattern. The filter is applied only within the deletion pass for files being changed. **Correct.**

---

### Vision alignment

The fix is internal plumbing — it restores the graph's structural integrity so that cross-file queries and enrichment can work correctly. Without MODULE nodes surviving, graph queries for module-level relationships return incomplete results. Fixing this directly serves the vision: the graph must be the superior way to understand code, and a graph with 42.9% disconnected nodes fails that test completely.

This change does not make AI read code instead of the graph. It makes the graph worth querying again.

---

### Architecture observation (not a rejection)

The `protectedTypes` field is a string slice passed over the wire. The type strings ("MODULE", "FUNCTION", etc.) are not validated against any schema on the server. The server will silently accept any string, including typos. This is a known trade-off in the existing Grafema wire protocol design (node types are generally unvalidated strings throughout). It is consistent with the existing patterns and is not a new gap introduced by this fix. Worth noting as existing tech debt.

---

### One gap to verify

`executeParallel` (the `context.parallelParsing` path in JSASTAnalyzer, lines 511-590) does NOT call `commitBatch` at all. It builds graph data via `graphBuilder.build()` for each module without per-module batch commits. If `parallelParsing` is enabled, the MODULE protection in the WorkerPool path (lines 392-400) is bypassed entirely because `executeParallel` is a different code path. This means: in parallel parsing mode, MODULE nodes may still be at risk.

However: (1) parallel parsing is an experimental path behind a flag (`context.parallelParsing`), (2) it does not call `commitBatch` itself, so the INDEXING-ANALYSIS interleaving problem may not manifest the same way — but this warrants a test or explicit comment. The current implementation does not document this gap. This is a pre-existing condition in `executeParallel`, not introduced by this fix.

This observation does not cause a REJECT because the primary regression is fixed in the active code path. But it should be filed as a follow-up.

---

### Would shipping this embarrass us?

No. The change is:
- Minimal: four files, additive change
- Backward-compatible: `#[serde(default)]` on the Rust field, optional parameter in TypeScript
- Tested: dedicated Rust unit tests for protected-type preservation and legacy behavior, plus the integration test path
- Clearly motivated: the commit message and code comment reference REG-489, the invariant is documented in the plan

The abstraction name `protectedTypes` is honest about what it does. It is not a workaround masquerading as an architecture — it is a precise protocol extension to express cross-phase node ownership semantics. The root cause (two phases sharing a file scope in `commitBatch`) is correctly identified and addressed at the right level (the deletion loop in the server).

**APPROVE.**
