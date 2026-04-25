# Linus Torvalds Review: REG-229 Argument-Parameter Binding Plan

## Overall Verdict: APPROVED with minor concerns

The plan is fundamentally sound. Don and Joel have identified the right architectural approach: enrichment phase, following the MethodCallResolver pattern, creating RECEIVES_ARGUMENT edges from PARAMETER to argument source. This is the RIGHT thing to do.

---

## 1. Is this the RIGHT thing to do?

**YES.** This is exactly what Grafema needs for data flow analysis across function boundaries.

The core thesis is "AI should query the graph, not read code." Without RECEIVES_ARGUMENT edges, the AI cannot answer "what values can reach parameter X?" - it would have to read code and trace manually. This closes a fundamental gap.

---

## 2. Edge Direction: PARAMETER -> argument_source

**CORRECT.** This aligns with existing data flow semantics in Grafema:
- `ASSIGNED_FROM`: variable <- source
- `DERIVES_FROM`: derived <- source
- `RECEIVES_ARGUMENT`: parameter <- source

The direction follows "what can reach me?" query pattern, which is the natural direction for taint analysis and backward tracing.

---

## 3. Enrichment vs Analysis Phase

**CORRECT for cross-file calls.**

However, I have a **minor concern**: Don's analysis shows that same-file CALLS edges are already created in the analysis phase (see `bufferCallSiteEdges` at line 362 of GraphBuilder.ts):

```typescript
const targetFunction = functions.find(f => f.name === targetFunctionName);
if (targetFunction) {
  this._bufferEdge({ type: 'CALLS', src: callData.id, dst: targetFunction.id });
}
```

This means for same-file calls, the CALLS edge and target PARAMETER nodes already exist during analysis. We COULD create RECEIVES_ARGUMENT edges for same-file calls in analysis phase.

**Decision:** Enrichment-only approach is still acceptable because:
1. Keeps the logic in one place (simpler)
2. Avoids duplicating argument-parameter matching logic
3. Performance difference is negligible (we process once per CALL node either way)

The plan correctly chose simplicity over marginal optimization. This is the right call.

---

## 4. Architectural Concerns

**Priority 55 is correct.** The dependency chain is:
- MethodCallResolver (50) - resolves METHOD_CALL -> CALLS -> METHOD
- ArgumentParameterLinker (55) - needs CALLS edges to exist
- AliasTracker (60) - can use the new edges
- ValueDomainAnalyzer (65) - can use the new edges for value tracking

**One concern:** ImportExportLinker creates cross-file connections. For cross-file calls between modules, need to verify ArgumentParameterLinker runs AFTER ImportExportLinker in the config array.

---

## 5. Is the Plan Complete?

**Mostly yes.** The plan covers:
- Basic function calls
- Method calls
- Arrow functions
- Unresolved calls (skip gracefully)
- Rest parameters
- Missing/extra arguments

**Edge cases not explicitly addressed:**

1. **Destructuring parameters:** `function fn({a, b}) {}` - parameters are not simple nodes
2. **Default parameter values:** `function fn(x = 10) {}` - what if no argument passed?
3. **Already existing RECEIVES_ARGUMENT edges:** Duplicate prevention

These are minor and can be handled during implementation. Not blockers.

---

## 6. Test Strategy

**Adequate.** Following PassesArgument.test.js pattern is correct.

**One missing test:** Cross-file case where function is imported. Critical for proving enrichment approach works.

---

## Summary

| Question | Answer |
|----------|--------|
| Right thing to do? | YES |
| Edge direction correct? | YES |
| Enrichment phase correct? | YES |
| Any architectural issues? | Minor: ImportExportLinker ordering |
| Plan complete? | 95% - minor edge cases |

**APPROVED** - Proceed with implementation.

**Required before merge:**
1. Verify/fix ArgumentParameterLinker position relative to ImportExportLinker in default config
2. Add test for cross-file imported function case
