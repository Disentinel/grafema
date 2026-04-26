# Linus Torvalds - Plan Review: REG-140

## VERDICT: Plan Direction is Right, But Phase 3 is Incomplete

### The Good

- Don's analysis is thorough and correct — stableId = id everywhere (verified)
- Strategic decision to remove stableId entirely (Option A) is right
- The approach aligns with project vision (single authoritative IDs)
- Phases 1, 2, 4, and 5 are correctly identified

### The Problem

Joel's Phase 3 plan has a critical gap that will cause **runtime failures**.

## The Critical Issue

**IncrementalAnalysisPlugin.ts** has a method `findCalleeAndCreateEdge()` that:
1. Defines a local interface `VersionAwareGraph` (line 71) that includes `getNodesByStableId()`
2. Casts the graph to this interface with an unsafe cast: `graph as unknown as VersionAwareGraph`
3. Actually calls the method: `await graph.getNodesByStableId(calleeStableId)`

**But `getNodesByStableId()` is NOT implemented on GraphBackend or anywhere else.** It only exists as a pretend interface contract via the unsafe cast.

Joel's plan says: "Mark `getNodesByStableId` method as deprecated with JSDoc comment."

This is a no-op. You cannot deprecate a method that has no implementation. When the code runs, it will throw: `TypeError: graph.getNodesByStableId is not a function`

## Recommendation

**Pause implementation.** Before Rob starts coding, answer these questions:

1. **Is the `getNodesByStableId()` call actually necessary?** Could `findCalleeAndCreateEdge()` use `getNodesByVersion()` instead?
2. **Is this dead code** inherited from stableId usage, or is it functionally required for incremental analysis?

### Two paths forward:

- **Option A (Recommended):** Remove the call entirely and refactor `findCalleeAndCreateEdge()` to query by version + id instead. Since we're removing stableId, there's no point in looking things up by stableId.
- **Option B:** Implement `getNodesByStableId()` properly on GraphBackend, then deprecate and remove it in future versions.

**Option A is simpler** and makes more sense — if stableId is going away, incremental analysis shouldn't be using it at all.

## Action Required

The rest of the plan is solid. This is a 1-2 hour clarification before coding starts, not a blocker. But it must be decided before implementation.

---

**Status:** Plan approved with required investigation before Phase 3.
