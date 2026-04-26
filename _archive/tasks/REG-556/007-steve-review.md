## Steve Jobs — Vision Review

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK

---

### Vision Alignment

PASSES_ARGUMENT edges are a direct investment in the graph's usefulness for AI. Without them, a CALL node is a dead end — you can see that a function was called, but you cannot see what was passed to it. With these edges, an AI agent querying "what values flow into this call?" can get an answer from the graph alone without reading source code.

The original bug report (L104: `createLogger(options.logLevel ?? 'info')`, L160: `this.plugins.unshift(new SimpleProjectDiscovery())`) is exactly the kind of question Grafema must answer in legacy codebases. These are real, common call patterns. Fixing the gaps moves the graph from "partially queryable" to "fully queryable" for argument flow.

Three gaps fixed — function-body direct calls, module-level `new Foo()`, function-body `new Foo()` — together with support for `new X()` as an argument and `b.c` fallback resolution. That is the right set of fixes: not one gap, not some gaps, all the gaps.

The `b.c` fallback pointing to the VARIABLE node for `b` rather than to a dedicated expression node is a known limitation. For an AI querying "what object was passed?", getting `b` is useful. Getting nothing is not. This is acceptable for v0.x.

### Architecture

The implementation fits the existing architecture correctly:

- `ArgumentExtractor.extract` is the single extraction point. The three gaps were places that created CALL nodes but forgot to call it. The fix adds the missing call in each location — not a new mechanism, just closing an asymmetry.
- `CallFlowBuilder.bufferArgumentEdges` is the single resolution point. The two new branches (`CONSTRUCTOR_CALL`, `MemberExpression` fallback) follow the exact same positional-lookup pattern used for `CALL` and `FUNCTION` resolution. No new pattern introduced.
- The data flows correctly: extraction at analysis time (visitor/handler) → resolution at build time (builder). Each layer does its job.

One pre-existing issue Dijkstra flagged: `NewExpressionHandler.ts` line 122 omits `column` from `ctx.callSites.push` for function-body `new Foo()` CALL nodes. This means position-based lookup of these CALL nodes is unreliable. The fix does not depend on that lookup (it uses the call ID, not position), so REG-556 is not broken. But the missing column is a real gap that will bite future work. It should be tracked.

### Complexity

All index builds are single linear passes over node collections — O(n) over node count, same as every other enricher. No nested loops. The resolution lookups are `.find()` over already-small per-file or per-module arrays. Acceptable.

### Coverage Check

The Dijkstra table explicitly enumerated every call expression site in the codebase:

| Site | Fixed? |
|------|--------|
| `foo(a)` at module level | Was already working |
| `obj.method(a)` at module level | Was already working |
| `foo(a)` inside function body | Fixed (Gap 1) |
| `obj.method(a)` inside function body | Was already working |
| `new Foo(a)` at module level | Fixed (Gap 2) |
| `new ns.Foo(a)` at module level | Fixed (Gap 2) |
| `new Foo(a)` inside function body | Fixed (Gap 3) |
| `new ns.Foo(a)` inside function body | Fixed (Gap 3) |
| CONSTRUCTOR_CALL node | Was already working |

All eight cases accounted for. No gaps remain.

### Would Shipping This Embarrass Us?

No. Before this fix, an AI agent querying argument flow for any call inside a function body got nothing. That is a gap that blocks >50% of real-world usage (most interesting calls are inside function bodies). After this fix, the graph answers those questions correctly. The `b.c` resolution limitation is minor and clearly scoped. The missing `column` on function-body `new Foo()` CALL nodes is a pre-existing issue that should be filed separately.

**APPROVE.**

---

**Follow-up required (file as separate issue):**

The `column` field is missing from `ctx.callSites.push` in `NewExpressionHandler.ts` (Identifier branch, line 122). This means that when `new Foo()` appears inside a function body, the resulting CALL node has no column. Any position-based lookup of that node will silently fail. This needs to be fixed — file as `REG-NNN: NewExpressionHandler missing column on CALL node push`.
