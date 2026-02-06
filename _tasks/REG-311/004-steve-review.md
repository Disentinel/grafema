# Steve Jobs - High-Level Review for REG-311

## Decision: REJECT

This plan has a fundamental architectural flaw that will create technical debt and confusion. The core idea is sound, but the execution violates lessons we already learned in REG-200.

---

## Vision Alignment: GOOD

The feature aligns perfectly with "AI should query the graph, not read code":

- Enables queries like "what errors can this function reject?"
- Tracks async error patterns that are currently invisible
- Complements existing throw tracking (REG-267)
- Uses forward registration pattern (analyzer marks data during traversal)

The goal is RIGHT. The implementation has critical flaws.

---

## Critical Architectural Flaw: Synthetic Builtin CLASS Nodes

**Joel's Plan (Step 7d, lines 354-366):**

```typescript
} else {
  // Error class not found in codebase (likely built-in like Error, TypeError)
  // Create edge to a synthetic CLASS node ID
  const syntheticClassId = `CLASS:${pattern.errorClassName}:builtin`;
  this._bufferEdge({
    type: 'REJECTS',
    src: pattern.functionId,
    dst: syntheticClassId,
    metadata: {
      rejectionType: pattern.rejectionType,
      line: pattern.line,
      isBuiltin: true
    }
  });
}
```

**This is the EXACT same mistake we rejected in REG-200.**

From Linus's REG-200 review:

> "What does `BUILTIN_JS:Date` give us? **Nothing**. It's not user code. We can't analyze it. The `className` field in CONSTRUCTOR_CALL already tells us it's Date. The `isBuiltin` flag already tells us it's built-in."

**The same logic applies here:**

- `CLASS:Error:builtin` is NOT user code - we can't analyze it
- It doesn't exist in the graph as a real node
- It creates dangling edges to phantom nodes
- The error class name is already in the edge metadata

**Consequences:**

1. **Queries will break**: `MATCH (f:FUNCTION)-[:REJECTS]->(c:CLASS)` fails when dst is a synthetic ID
2. **Inconsistent graph**: Some REJECTS edges point to real CLASS nodes, others to fake ones
3. **Technical debt**: Every query must handle both cases
4. **Violates graph integrity**: Edges should reference actual nodes

**What REG-200 taught us:**

Create nodes for things we analyze. Don't create phantom nodes for built-ins. Use metadata instead.

---

## The Right Fix: Edge Metadata Over Phantom Nodes

**WRONG (current plan):**
```
FUNCTION --REJECTS--> CLASS:Error:builtin (phantom node)
                      ^^^^^^^^^^^^^^^^^^^
                      This doesn't exist!
```

**RIGHT:**
```
FUNCTION --REJECTS--> CLASS (user-defined error, when available)

Or just store metadata:

REJECTS edge metadata: {
  errorClassName: 'Error',
  isBuiltin: true,         // Built-in error class
  rejectionType: 'promise_reject'
}
```

**For built-in errors, DON'T create an edge at all.** Just track in metadata on the FUNCTION node or as separate enrichment data.

**Alternative (if we must have edges):** Create a single sentinel node `BUILTIN_ERRORS` that all builtin error rejections point to. But even this is questionable.

**Best approach:** Only create REJECTS edges when we have an actual CLASS node to point to. For built-ins, store `canReject: true` and track error names in a `rejectedErrorTypes: string[]` array on the function's metadata.

---

## Secondary Concern: REJECTS vs RESOLVES_TO Duplication

**Current state (REG-334):**
- `RESOLVES_TO` edge with `metadata.isReject: true` tracks `reject()` calls
- Tracks data flow: where the rejected value comes from

**Proposed (REG-311):**
- `REJECTS` edge from FUNCTION to error CLASS
- Tracks error type: what kind of error can be rejected

**Analysis:**

These are NOT duplicates - they answer different questions:

| Edge | Question | Example |
|------|----------|---------|
| RESOLVES_TO (isReject=true) | "Where does the rejected value come from?" | `reject(dbError)` → traces dbError origin |
| REJECTS | "What error types can this function reject?" | FUNCTION → ValidationError CLASS |

**Verdict: COMPLEMENTARY, not redundant.** This is fine.

**BUT:** We should document this clearly. If someone queries RESOLVES_TO with isReject=true, they get data flow. If they query REJECTS, they get error typing.

---

## Third Concern: Limitation on Variable Rejections

**Out of scope:**
```javascript
function forward(err) {
  return Promise.reject(err);  // err is variable
}
```

**Question:** Is this acceptable for MVP?

**Analysis:**

Joel's test explicitly documents this (line 555-566):

```javascript
it('should NOT create REJECTS edge for variable rejection (out of scope)', async () => {
  // ...
  assert.strictEqual(rejectsEdges.length, 0, 'Should NOT have REJECTS edge for variable');
});
```

This means queries for "what errors can this function reject?" will MISS functions that forward errors.

**Is this >50% of real-world cases?**

In typical Node.js code:
- Direct rejections: `reject(new Error('msg'))` - **tracked**
- Promise.reject with new error: `Promise.reject(new Error())` - **tracked**
- Forwarding errors: `reject(err)`, `Promise.reject(error)` - **NOT tracked**

**Estimate:** Forwarding is common in wrapper functions. This could be 30-40% of rejection sites.

**However:** This is a data flow limitation, not an architectural flaw. We can extend later with DERIVES_FROM analysis. This is acceptable for MVP IF:

1. We document the limitation clearly
2. We create a follow-up issue (v0.3+) for variable rejection tracking
3. We ensure the architecture supports extension (it does - just trace arg to its source)

**Verdict: ACCEPTABLE LIMITATION** - but must be documented and tracked for future.

---

## Fourth Concern: Separate REJECTS vs THROWS?

**Semantic question:** Should async rejections use the same edge type as sync throws?

**Plan says:** NO - use separate REJECTS edge type.

**Rationale from Don:**
- Semantic distinction: throw is sync, reject is async
- Different error handling: try/catch vs .catch()
- Query clarity: "what can throw?" vs "what can reject?"

**Counterpoint:**

From a user's perspective, both are "errors this function can produce." Having two separate edge types means:

- Two separate queries: `MATCH (f)-[:THROWS]->` AND `MATCH (f)-[:REJECTS]->`
- Harder to answer "what are ALL the error types from this function?"
- More complexity in enrichers

**Alternative:** One `PRODUCES_ERROR` edge with metadata distinguishing sync vs async.

**Steve's Take:**

This is a **close call**, but I lean toward **SEPARATE edge types** for one reason:

**The semantics ARE fundamentally different:**
- `throw new Error()` - execution stops, unwinding stack until caught
- `reject(new Error())` - returns a rejected Promise, execution continues

These are not the same operation. Queries asking "what throws?" are asking a different question than "what rejects?".

**If we combine them**, every query must filter by metadata. If we separate them, queries are clearer.

**Verdict: SEPARATE edge types is correct.** But we need a helper query that combines both for "all errors."

---

## Complexity Check: PASS

No new O(n) iterations - integrates into existing traversal. ✓

Joel's analysis (line 573-583):
```
| Step | Operation | Complexity |
|------|-----------|------------|
| 5    | Promise.reject detection | O(1) per call |
| 6    | Executor reject detection | O(d) d=nesting |
| 7    | Edge buffering | O(r) r=patterns |
| **Total per file** | | O(n + r) n=calls |
```

This is fine. No architectural concern here.

---

## Plugin Architecture: PASS

Extends existing JSASTAnalyzer (forward registration). ✓
Adds new edge type to existing infrastructure. ✓
GraphBuilder.bufferRejectionEdges() follows existing pattern. ✓

No concerns.

---

## Required Changes Before Approval

### 1. CRITICAL: Remove Synthetic Builtin CLASS Nodes

**In `GraphBuilder.bufferRejectionEdges()` (Step 7d):**

**DELETE this block:**
```typescript
} else {
  // Error class not found in codebase (likely built-in like Error, TypeError)
  // Create edge to a synthetic CLASS node ID
  const syntheticClassId = `CLASS:${pattern.errorClassName}:builtin`;
  // ...
}
```

**REPLACE with:**

**Option A (Recommended):** Only create edges for user-defined error classes:
```typescript
} else {
  // Built-in error class (Error, TypeError, etc.) - no CLASS node exists
  // Don't create edge to phantom node
  // Store in function metadata instead
  continue;  // Skip edge creation
}
```

Then extend ControlFlowMetadata:
```typescript
export interface ControlFlowMetadata {
  // ... existing fields ...
  hasThrow: boolean;
  canReject: boolean;
  rejectedBuiltinErrors?: string[];  // NEW: ['Error', 'TypeError']
  cyclomaticComplexity: number;
}
```

**Option B:** Create a single sentinel node (less preferred):
```typescript
} else {
  // Point all builtin rejections to a sentinel node
  const sentinelId = 'BUILTIN_ERRORS';  // Single node for all builtins
  this._bufferEdge({
    type: 'REJECTS',
    src: pattern.functionId,
    dst: sentinelId,
    metadata: {
      errorClassName: pattern.errorClassName,  // Store actual name
      isBuiltin: true,
      rejectionType: pattern.rejectionType
    }
  });
}
```

**I strongly recommend Option A.** Don't create edges when we don't have target nodes.

### 2. Document Limitations Clearly

Add to Joel's test plan:

```typescript
// Test: Document known limitations
it('documents known MVP limitations', () => {
  // Limitation 1: Variable rejections not tracked
  // Example: reject(err) where err is a variable
  
  // Limitation 2: Built-in errors don't create REJECTS edges
  // Only user-defined error classes have CLASS nodes to link to
  
  // Limitation 3: Implicit rejections in async functions not tracked
  // Example: async function foo() { throw new Error(); }
  // This implicitly rejects, but we only track explicit reject() calls
});
```

### 3. Create Follow-up Issues

**Issue 1:** "Track variable rejections via DERIVES_FROM analysis" (v0.3)
**Issue 2:** "Track implicit rejections in async functions" (v0.3)
**Issue 3:** "Create helper query for all error types (THROWS + REJECTS)" (v0.2)

### 4. Clarify Relationship with RESOLVES_TO

Add to Don's plan (Section 11):

**RESOLVES_TO vs REJECTS:**
- RESOLVES_TO (isReject=true): tracks DATA FLOW - where rejected value comes from
- REJECTS: tracks ERROR TYPING - what error classes function can reject
- These are complementary, answer different questions
- Both are needed for complete async error analysis

---

## What's Right About This Plan

1. **Core idea is excellent** - filling a real gap in async error tracking
2. **Reuses existing infrastructure** - extends REG-334, follows patterns
3. **Forward registration pattern** - correct architectural approach
4. **No new O(n) iterations** - integrates into existing traversal
5. **Separate REJECTS edge type** - correct semantic distinction
6. **Comprehensive test plan** - Kent would approve

---

## Verdict

**REJECT the plan as written.**

**Reason:** Creating synthetic `CLASS:Error:builtin` nodes repeats the exact mistake we rejected in REG-200. This will create technical debt, graph integrity issues, and make queries fragile.

**Required fix:** Remove all synthetic builtin CLASS node creation. Use Option A (metadata) or Option B (sentinel node) instead.

**After this fix, the plan is EXCELLENT.** But we cannot ship code that creates phantom nodes. This is a hard line.

---

## Final Assessment

**If synthetic builtin nodes are removed:**
- Vision alignment: ✓ EXCELLENT
- Architecture: ✓ SOLID
- Complexity: ✓ NO CONCERNS
- Extensibility: ✓ GOOD
- Test coverage: ✓ COMPREHENSIVE

**With current plan:**
- Architecture: ✗ CRITICAL FLAW (phantom nodes)

**The gap between REJECT and APPROVE is small** - just remove 15 lines of code (the else block that creates synthetic IDs). But those 15 lines are poison. They violate graph integrity.

---

## Recommendation to User

**User should escalate to Don and Joel:**

"Steve rejected the plan due to synthetic builtin CLASS nodes. This repeats the REG-200 mistake. Two options:

1. **Preferred:** Only create REJECTS edges for user-defined error classes. Store builtin error names in `rejectedBuiltinErrors` metadata array.

2. **Alternative:** Create single sentinel `BUILTIN_ERRORS` node, all builtin rejections point there, actual error name in edge metadata.

Which approach should we use?"

Wait for decision before proceeding to implementation.

---

**Steve Jobs**
*High-level Reviewer*
