# Steve Jobs - High-Level Review of Don's Plan (REG-286)

## Decision: **REJECT**

## Summary

Don's plan shows solid understanding of the existing REG-311 infrastructure, but it **duplicates functionality without clear justification**. The plan proposes creating separate ThrowPatternInfo, throwPatterns collection, bufferThrowsEdges() method, and canThrow metadata when the existing RejectionPatternInfo infrastructure already handles throws (via `async_throw` pattern type).

**Core issue:** This isn't extending a pattern — it's duplicating it.

## Critical Problems

### 1. Unjustified Duplication

The plan proposes:
- New `ThrowPatternInfo` interface (identical fields to `RejectionPatternInfo`)
- New `throwPatterns` collection (parallel to `rejectionPatterns`)
- New `bufferThrowsEdges()` method (clone of `bufferRejectionEdges()`)
- New `canThrow` metadata (parallel to `canReject`)
- New `thrownBuiltinErrors` array (parallel to `rejectedBuiltinErrors`)

**Question:** Why can't `RejectionPatternInfo` be renamed to `ErrorPatternInfo` and handle BOTH?

Don's rationale (line 99-103): "Clear semantic distinction (sync vs async errors)."

**Counter:** The distinction is already encoded in `rejectionType`. We have:
- `async_throw` — already tracks throws in async functions
- `promise_reject` — promise rejections
- `executor_reject` — executor rejections

Why not add `sync_throw` to the SAME enum and reuse the infrastructure?

### 2. hasThrow vs canThrow — What's the Difference?

The plan adds `canThrow` metadata alongside existing `hasThrow`. What's the semantic difference?

- `hasThrow: boolean` — function has throw statements (REG-267)
- `canThrow: boolean` — function can throw (REG-286)

**If `hasThrow` is true, isn't `canThrow` always true?** This looks redundant.

If the distinction is "hasThrow tracks syntax, canThrow tracks semantics" — that needs to be explicit. Otherwise it's confusing metadata duplication.

### 3. Complexity Justification Missing

Don claims O(t) complexity (line 142), same as REG-311. But:
- Are we iterating throw statements twice (once for hasThrow, once for canThrow)?
- Are we buffering edges twice (REJECTS + THROWS)?
- Are we storing patterns twice (rejectionPatterns + throwPatterns)?

If we unified the infrastructure, we'd iterate ONCE and buffer edges based on pattern type.

### 4. Edge Semantics Unclear

The plan creates two edge types:
- `FUNCTION --[REJECTS]--> CLASS` (async errors)
- `FUNCTION --[THROWS]--> CLASS` (sync errors)

**Query impact:**
```cypher
// Without unification:
MATCH (f:FUNCTION)-[:THROWS|REJECTS]->(c:CLASS {name: 'ValidationError'})

// With unification (single edge type):
MATCH (f:FUNCTION)-[:CAN_FAIL]->(c:CLASS {name: 'ValidationError'})
```

**Question:** Does the sync/async distinction matter at the EDGE level, or should it be in edge metadata?

If someone queries "show me all functions that can produce ValidationError" — do they care if it's thrown sync or rejected async? If not, we're creating artificial complexity.

## What's RIGHT About This Plan

1. **Reusing proven patterns from REG-311** — excellent instinct
2. **O(t) iteration space** — complexity is correct
3. **Forward registration** — pattern collection happens during AST traversal
4. **Tests mirror REG-311** — good for consistency

## What Needs Fixing

### Option A: Unify Infrastructure (Recommended)

1. Rename `RejectionPatternInfo` → `ErrorPatternInfo`
2. Extend `rejectionType` enum to include `sync_throw`
3. Rename `bufferRejectionEdges()` → `bufferErrorEdges()`
4. Create BOTH edge types (THROWS/REJECTS) based on pattern type
5. Keep separate edges if query semantics require it

**Benefits:**
- Single iteration over error patterns
- Single storage mechanism
- Clear: "errors" encompass both throws and rejections
- Easy to extend for other error patterns later

### Option B: Justify Separation

If Don believes separate infrastructure is correct, the plan must answer:
1. Why does the sync/async distinction require separate data structures?
2. What queries become EASIER with separate edges/metadata?
3. What's the semantic difference between `hasThrow` and `canThrow`?
4. Are we OK with 2x storage and 2x iteration cost?

## Root Cause Concern

This feels like "extend by cloning" instead of "extend by abstracting."

REG-311 created `RejectionPatternInfo` for async errors. Now we need sync errors. The RIGHT solution isn't to clone the infrastructure — it's to recognize that the abstraction is "error patterns" not "rejection patterns."

**Grafema principle:** Reuse Before Build. This plan builds a parallel system when it could extend the existing one.

## Required Changes Before Approval

1. **Justify duplication** or propose unification
2. **Clarify hasThrow vs canThrow semantics**
3. **Explain edge type decision** — why two edge types instead of one with metadata?
4. **Address iteration cost** — are we iterating throws twice?

## Next Steps

Don: Revise the plan. Either:
- Show why separate infrastructure is architecturally necessary
- OR propose unified `ErrorPatternInfo` approach

Joel should NOT expand this plan until these questions are resolved.

---

**Stance:** Default REJECT. This isn't wrong, but it's not RIGHT yet.
