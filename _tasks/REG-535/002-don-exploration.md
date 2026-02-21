# Don Melton Exploration Report: REG-535

## Key Findings

### Where to Implement
**ArgumentParameterLinker** (`packages/core/src/plugins/enrichment/ArgumentParameterLinker.ts`) — already iterates CALL nodes, creates RECEIVES_ARGUMENT edges. Add DERIVES_FROM edges in the same pass.

### Algorithm
For each CALL node → get PASSES_ARGUMENT edges → find target function → match argument index to parameter index → create DERIVES_FROM edge (PARAMETER → argument source).

### Complexity
O(m) where m = CALL nodes (typically 1000-10000). Safe — reuses existing enricher iteration.

### Edge Semantics
- RECEIVES_ARGUMENT: call-site specific (`metadata: {argIndex, callId}`)
- DERIVES_FROM: data flow relationship (no metadata needed, deduplicated across calls)

### Files to Modify
1. `ArgumentParameterLinker.ts` — add DERIVES_FROM edge creation + deduplication
2. `ReceivesArgument.test.js` — add DERIVES_FROM test cases

### Edge Already Defined
DERIVES_FROM exists in `packages/types/src/edges.ts` and is already used by traceValues.ts.
