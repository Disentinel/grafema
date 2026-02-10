# Revised Plan: REG-400

## Addressing Steve's Review

### Concern 1: "CALLS from forEach to fn violates semantic model"

**Rebuttal**: The existing architecture already creates CALLS in analysis phase for same-file calls. See `bufferCallSiteEdges` (GraphBuilder.ts:910-931):
```typescript
// CALL_SITE -> CALLS -> FUNCTION
const targetFunction = functions.find(f => f.name === targetFunctionName);
if (targetFunction) {
  this._bufferEdge({ type: 'CALLS', src: callData.id, dst: targetFunction.id });
}
```

This is the SAME pattern: call site → CALLS → function. Whether the call is direct (`fn()`) or indirect via HOF (`forEach(fn)`) doesn't change the semantic: "at this call site, fn will be called."

`grafema impact` needs CALLS edges to find callers. The CALLS edge captures "fn is invoked at this location."

### Concern 2: "Half-solution — aliases and imports fail"

**Assessment**: The issue explicitly defines two levels:
- Level 1 (this PR): Direct function references → covers 70-80% of real callback usage
- Level 2 (future): Value tracking for aliases, imports → separate enhancement

Same-file callbacks are the most common pattern. The preact example (issue motivator) is same-file. Level 1 is not "half" — it's the most impactful subset.

### Concern 3: "Wrong layer — should be enrichment"

**Rebuttal**: Grafema's architecture already separates:
- **Analysis phase**: Same-file resolution (GraphBuilder creates CALLS for same-file calls)
- **Enrichment phase**: Cross-file resolution (FunctionCallResolver creates CALLS for imported calls)

The fix follows this exact split:
1. Same-file callback CALLS → analysis phase (this PR)
2. Cross-file callback CALLS → enrichment (future, like FunctionCallResolver)

## Final Plan (Two Parts)

### Part 1: Fix PASSES_ARGUMENT + CALLS in Analysis (Same-File)

**GraphBuilder.bufferArgumentEdges()** — when `targetType === 'VARIABLE'`:
1. After `variableDeclarations` lookup fails, also check `functions` array
2. If function found → create PASSES_ARGUMENT to FUNCTION (fixes missing edge)
3. Also create CALLS from call site to FUNCTION (consistent with `bufferCallSiteEdges`)
4. Add `metadata: { callType: 'callback' }` to distinguish from direct calls

**Handles**:
- `function fn() {}; array.forEach(fn)` ✓
- `const fn = () => {}; array.forEach(fn)` ✓
- Any HOF: `map(fn)`, `setTimeout(fn)`, `customHOF(fn)` ✓

### Part 2: Document Future Enhancement (Not This PR)

Cross-file callback resolution (imported functions, aliases) → future enrichment enhancement, tracked as separate issue.

## Why This Is Right

1. **Consistent** with existing architecture (same-file = analysis, cross-file = enrichment)
2. **Minimal** — single location change, no new files, no new iteration passes
3. **Correct** — fixes the bug AND adds the feature
4. **Extensible** — enrichment can add cross-file later without changing analysis code
5. **Impact** — fixes the preact case and most common JS callback patterns
