# Linus Torvalds: REG-230 Plan Review

**Status: APPROVED with Recommendations**

## 1. Is this the right approach?

**Yes.** The `--to` flag on `grafema trace` is the correct architectural decision.

The reasoning is sound:
- Both forward and backward tracing use the same underlying graph infrastructure
- Unified mental model: "trace" = show value flow (either direction)
- Simpler for agents to remember: one command, two modes

Creating a separate `grafema sink` command would be arbitrary fragmentation.

## 2. Is the sink spec format right?

**The format `functionName#argIndex.property` is acceptable** but I have concerns:

**Good:**
- `#` as separator is unambiguous (not used in JS identifiers)
- Numeric argIndex is clear
- Dot-notation for properties matches JS syntax

**Concerns:**

1. **Method calls vs direct calls:** What about `obj.addNode()` vs `addNode()`? The spec doesn't distinguish.

   **Recommendation:** Document clearly that `addNode` matches both direct calls AND method calls where the method name is `addNode`.

2. **No property requirement:** Joel's plan says `fn#0` (no property) should error. I disagree. Tracing the raw argument value is useful:
   ```bash
   grafema trace --to "addNode#0"  # What values are passed to first arg?
   ```

   **Recommendation:** Make property path optional. If omitted, trace the entire argument.

## 3. Are we over-engineering or under-engineering?

**Slightly over-engineered in one area.**

**Over-engineering:**
Joel proposes creating `sinkResolver.ts` as a separate file with 6 distinct functions. This is too much abstraction for what is essentially:

```
CALL node -> PASSES_ARGUMENT edge (filter by argIndex) -> target node -> HAS_PROPERTY edge (if needed) -> value node -> getValueSet()
```

**Recommendation:** Implement directly in `trace.ts` as a single `handleSinkTrace()` function with inline helper logic. Don't create a new file.

**Under-engineering:**
The plan assumes we can reliably find CALL nodes by function name. For method calls, CALL nodes store `method` attribute. Joel's `findCallSites()` needs to query BOTH:
```typescript
// Direct calls: CALL nodes where name === targetFunctionName
// Method calls: CALL nodes where method === targetFunctionName
```

## 4. Does it align with "AI should query the graph, not read code"?

**Yes, absolutely.** This is pure graph traversal:
1. Find CALL nodes by name attribute
2. Follow PASSES_ARGUMENT edges to get argument
3. Follow HAS_PROPERTY edges for property drilling
4. Use existing `getValueSet()` for value tracing

Zero code reading. Zero AST parsing. This is exactly what Grafema should be.

## 5. What's missing?

**Critical issues:**

1. **Edge metadata access:** Verify `getOutgoingEdges` returns edge metadata for `argIndex`.

2. **Property drilling for non-OBJECT_LITERAL arguments:** If the argument is a VARIABLE, we need to trace through ASSIGNED_FROM first to find the object, THEN drill into properties.

**Minor issues:**

3. **Output format:** Align on final format before implementation.

4. **`--to` flag validation:** What if user passes `--to` AND a pattern? Should be mutually exclusive.

## Recommendations Summary

1. ✅ Keep `--to` flag approach (approved)
2. ⚠️ Make property path optional (`fn#0` should work)
3. ⚠️ Don't create separate `sinkResolver.ts` - implement inline in trace.ts
4. ⚠️ Explicitly handle both direct calls and method calls in findCallSites
5. ⚠️ Verify edge metadata access for argIndex
6. ⚠️ Handle VARIABLE -> OBJECT_LITERAL property drilling explicitly

## Critical Files for Implementation

- `packages/cli/src/commands/trace.ts` - Add `--to` flag and `handleSinkTrace()` function
- `packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts` - Existing `getValueSet()` to reuse
- `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Reference for PASSES_ARGUMENT edge structure
