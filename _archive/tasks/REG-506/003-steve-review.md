# Steve Jobs — High-level Review: REG-506

**Verdict: APPROVE with mandatory fix**

---

## Summary

The plan is structurally sound. Don correctly identified the right insertion points, the right semantic layer for `warnings` (on `QueryResult`, not `QueryStats`), and the right detection mechanism (structural pattern, not threshold). The scope is appropriately tight. The vision alignment is good — this is pure observability tooling that helps users write better Datalog queries, which directly serves "AI should query the graph, not read code."

However, there is one concrete gap that MUST be fixed before implementation starts. It is not a blocker that requires re-planning — it is a missing file in the change list.

---

## The Gap: Missing File in Change List

Don's plan says:

> **Potential issue:** Check if the RFDB client in `RFDBServerBackend.ts` does explicit field mapping when deserializing explain results. If it does, `warnings` needs to be added there. Quick grep of the client code will confirm.

I did that grep. The client is NOT in `RFDBServerBackend.ts`. It is in `packages/rfdb/ts/client.ts`. And the answer is: **yes, there is explicit field mapping**.

The method `_parseExplainResponse` in `packages/rfdb/ts/client.ts` constructs the result object by explicit enumeration:

```typescript
private _parseExplainResponse(response: RFDBResponse): DatalogExplainResult {
    const r = response as unknown as DatalogExplainResult & { requestId?: string };
    return {
      bindings: r.bindings || [],
      stats: r.stats,
      profile: r.profile,
      explainSteps: r.explainSteps || [],
      // <-- NO warnings field here
    };
}
```

This function is called by all three explain paths: `datalogQuery`, `checkGuarantee`, and `executeDatalog`. If `warnings` is not added here, the Rust server can emit it all day long and TypeScript will never see it.

**This is not a minor oversight.** Without this fix, the feature literally does not work end-to-end. The warnings get silently swallowed at the client boundary.

**Fix required:** Add `packages/rfdb/ts/client.ts` to the change list. In `_parseExplainResponse`, add `warnings: r.warnings || []` to the returned object. Also add `warnings: string[]` to `DatalogExplainResult` in `packages/types/src/rfdb.ts` (already planned).

---

## Other Observations (Non-blocking)

**1. Threshold-vs-pattern decision is correct.** Don is right to ignore the "warn if result > 1000" implementation note. The AC says structural pattern detection. The note is inconsistent with the AC. Pattern detection at eval time is zero-overhead and always accurate. This decision is sound.

**2. Scope boundaries are correct.** Not warning on `incoming(X, ...)` with unbound destination is the right call — it already silently returns empty, which is a separate bug. Not warning on `path()` is correct — bound-source BFS is the intended use. Keeping basic `Evaluator` unchanged is correct.

**3. `warnings` on `QueryResult` vs `QueryStats` is correct.** Stats are metrics; warnings are user-facing diagnostics. Different semantic layer. The AC language ("QueryStats/QueryProfile includes warnings") is loose — the actual requirement is "warnings in explain response." Don read this correctly.

**4. The duplicate-warning question is handled correctly.** If a query has both `node(X, Y)` and `edge(X, _, _)` with unbound X, both warnings fire independently. This is correct behavior. Multi-literal queries may trigger a warning on each pass through `eval_query` for each binding context — Don should verify that warning deduplication (e.g., using a HashSet instead of Vec in the accumulator) is considered. This is implementation detail for Joel/Kent to nail down, not a plan-level rejection.

**5. Wildcard arm in `eval_edge`.** The current code has three arms in `eval_edge`'s source match: `Const`, `Var`, and `_ => vec![]`. The `_` arm would catch `Term::Wildcard`. A wildcard source in edge is semantically identical to an unbound variable for the purposes of full-scan detection. Implementation should consider whether `Term::Wildcard` should also trigger the warning. This is a minor correctness point, not a rejection reason.

---

## Vision Alignment Check

- **"AI should query the graph, not read code"** — This feature makes Datalog more usable for AI agents. If an agent writes a slow query and gets a warning in explain mode, it can self-correct. Directly aligned.
- **No performance overhead on basic evaluator** — Correct. Zero-cost for production paths.
- **Additive only** — Correct. No existing behavior changes.
- **Would shipping this embarrass us?** — No. The feature is small, clean, and well-scoped. The missing `client.ts` fix is exactly what code review exists to catch. With that fix, this ships cleanly.

---

## Required Action Before Implementation

Add to the files-to-modify table:

| File | Change |
|------|--------|
| `packages/rfdb/ts/client.ts` | Add `warnings: r.warnings \|\| []` in `_parseExplainResponse` |

Joel's tech plan must include this file. Kent must test the full end-to-end path including the client boundary (not just Rust unit tests).

---

**APPROVE** — plan is correct with the above mandatory addition. No re-planning required. Joel proceeds with the client.ts fix included.
