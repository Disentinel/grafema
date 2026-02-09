# Steve Jobs Review: REG-392

## Decision: REJECT

## Critical Finding: Architectural Mismatch

**The plan misunderstands the existing architecture.** This is a 30-minute fix, not a multi-file refactoring.

### What the Plan Claims

Plan says:
1. `detectArrayMutation` (push/unshift) classifies value types but doesn't create nodes
2. `extractArguments` creates the nodes separately
3. Pattern: "whoever detects the mutation creates the value nodes"

**This is WRONG.** I reviewed the actual code:

### What the Code Actually Does

**For push/unshift (CallExpressionVisitor, lines 881-934):**
- `detectArrayMutation` ONLY classifies types (LITERAL, VARIABLE, CALL, etc.)
- Does NOT create any nodes
- Sets `literalValue`, `valueName`, `callLine/callColumn` on `ArrayMutationArgument`
- **NEVER sets `valueNodeId`**

**For function call arguments (lines 263-412):**
- `extractArguments` creates LITERAL/OBJECT_LITERAL/ARRAY_LITERAL nodes
- These nodes are for `ArgumentInfo` (function call args), NOT `ArrayMutationArgument`
- Different type, different purpose

**Key insight:** Push/unshift mutations ALREADY have the same gap — they don't create nodes for non-variable values either. The plan is trying to match a pattern that doesn't exist for push/unshift.

### The RIGHT Solution

Look at line 2079-2080 in GraphBuilder:

```typescript
// For literals, object literals, etc. - we could create edges from LITERAL nodes
// but for now we just track variable -> array flows
```

**This comment IS the architecture.** Array mutations currently ONLY track VARIABLE flows. The gap exists for BOTH push/unshift AND indexed assignments.

### What REG-392 Should Actually Do

**Option A: Match existing behavior (current architecture)**
- Indexed assignments already work for VARIABLE (like push/unshift)
- For non-variable values: skip edge creation (like push/unshift does)
- Tests expecting non-variable edges are testing FUTURE behavior, not current

**Option B: Fix the root gap (right architecture)**
- Fix BOTH push/unshift AND indexed assignments at once
- Create nodes in GraphBuilder during edge creation phase
- This is where the pattern already exists for other edge types

### Evidence: bufferAssignmentEdges Pattern

GraphBuilder.bufferAssignmentEdges (line ~1436) already handles this correctly:

```typescript
// Direct LITERAL assignment: x = 42
if (sourceId && sourceType !== 'EXPRESSION') {
  this._bufferEdge({
    type: 'ASSIGNED_FROM',
    src: variableId,
    dst: sourceId  // sourceId comes from LITERAL node created during detection
  });
}
```

**This is the pattern.** Whoever DETECTS the value creates the node and stores the ID.

### Why the Plan is Wrong

1. **Duplication claim is false:** Push/unshift don't create value nodes either. No duplication to match.

2. **Collection bloat is unnecessary:** Plan adds 7+ parameters to `detectIndexedArrayAssignment` when push/unshift don't create nodes at all.

3. **Testing wrong behavior:** Tests are skipped because they test FUTURE functionality (non-variable edges), not current gaps.

4. **Complexity explosion:** Plan touches 2 files for what should be a 10-line change in GraphBuilder.

### Root Cause Violation

From CLAUDE.md:

> **CRITICAL: When behavior or architecture doesn't match project vision:**
> 1. STOP immediately
> 2. Do not patch or workaround
> 3. Identify the architectural mismatch

**The mismatch:** Array mutation edges (push/unshift/indexed) only track VARIABLE flows. Non-variable values are NOT tracked by design (see comment line 2079).

### What Should Happen

**Before proceeding:**

1. **Clarify scope with user:**
   - Is REG-392 about indexed assignments matching push/unshift behavior? (They already do — VARIABLE-only)
   - Or is it about extending ALL array mutations to handle non-variable values? (Bigger scope)

2. **If extending to non-variable values:**
   - Fix push/unshift AND indexed at the same time
   - Create nodes during detection (JSASTAnalyzer for indexed, CallExpressionVisitor for push/unshift)
   - Or create nodes during edge buffering (GraphBuilder) using existing patterns
   - Don't introduce architectural inconsistency

3. **If just indexed assignments:**
   - Explain to user that push/unshift have the same gap
   - Either fix both or neither
   - Don't create divergent behavior

## Complexity Check: PASS (when properly scoped)

If we fix this correctly (create nodes during detection):
- O(1) per mutation — no new iterations
- Matches existing assignment edge pattern
- No architectural gaps

## Vision Alignment: UNCLEAR

"AI should query the graph, not read code."

**Question:** Does the graph NEED non-variable mutation edges? If `arr[0] = 'test'`, does that literal flow matter for queries?

- For taint analysis: YES (tracking literal values matters)
- For cardinality: NO (we care about structural flow, not literal values)
- For refactoring: MAYBE (depends on transformation type)

**User should clarify the use case before we implement.**

## Verdict

**REJECT.** The plan is based on false architectural assumptions. Stop, clarify scope with user, then either:

1. Document that non-variable array mutations are out of scope (update tests)
2. Fix the gap properly for ALL array mutations (push/unshift + indexed)
3. Explain why indexed needs this but push/unshift doesn't (if there's a valid reason)

Don't proceed with the current plan. It would create architectural debt by making indexed assignments work differently than push/unshift for no clear reason.

---

**Next step:** Present this review to user (Вадим) for architectural decision.
