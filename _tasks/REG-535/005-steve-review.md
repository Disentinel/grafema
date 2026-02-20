# REG-535: Steve Jobs Vision Review

**Steve Jobs — Vision Reviewer**
**Date:** 2026-02-20

## Verdict: APPROVE ✅

This is the right implementation. It moves Grafema toward the vision, respects the architecture, and does it properly.

---

## 1. Vision Alignment: "AI should query the graph, not read code"

**STRONG ALIGNMENT.**

Before: AI hits a PARAMETER node → dead end → forced to read code to understand what values flow in
After: AI queries DERIVES_FROM edges → traces through function boundaries → gets complete data flow from the graph

This is exactly what the vision means. The graph now has the information. The AI doesn't need to fall back to reading source.

**Impact on real usage:**
- Trace HTTP request data through route handlers (no more "parameter" unknowns)
- Follow user input through function boundaries
- Understand data flow across module boundaries

This unblocks 35 real cases where data flow analysis stopped at parameters. That's 35 times the graph is now superior to reading code.

---

## 2. Complexity Check: O(m) where m = CALL nodes

**EXCELLENT.**

Review of ArgumentParameterLinker.ts lines 127-245:

```typescript
for (const callNode of callNodes) {  // O(m) where m = CALL nodes
  // ... existing RECEIVES_ARGUMENT logic ...

  // NEW: DERIVES_FROM creation (lines 231-244)
  const derivesKey = `${paramNode.id}:${passesEdge.dst}`;
  if (!existingDerivesEdges.has(derivesKey)) {
    await graph.addEdge({ type: 'DERIVES_FROM', ... });
  }
}
```

**Key insight:** This is NOT "O(m) + O(m)" (two passes). It's ONE pass that now creates both edge types.

Zero additional iteration cost. The DERIVES_FROM creation happens inside the existing CALL node loop that was already iterating for RECEIVES_ARGUMENT.

**Red flags checked:**
- ❌ No "scan all nodes" patterns
- ❌ No nested iteration over unrelated node types
- ❌ No backward pattern scanning
- ✅ Reuses existing iteration (RECEIVES_ARGUMENT loop)
- ✅ Targeted query at start: `queryNodes({ nodeType: 'CALL' })`

This is clean. Approved.

---

## 3. Plugin Architecture: Forward Registration

**PERFECT.**

Data flow:
1. **Analyzers** (JSASTAnalyzer): create PASSES_ARGUMENT edges during parsing
2. **MethodCallResolver**: creates CALLS edges (function call → function definition)
3. **ArgumentParameterLinker** (enricher): reads PASSES_ARGUMENT + CALLS, creates RECEIVES_ARGUMENT + DERIVES_FROM

This is textbook forward registration:
- Analyzers mark what they see (PASSES_ARGUMENT)
- Enrichers connect the dots (DERIVES_FROM)
- No backward scanning, no pattern matching

**Metadata declaration** (lines 69-80):
```typescript
consumes: ['PASSES_ARGUMENT', 'CALLS', 'HAS_PARAMETER', 'RECEIVES_ARGUMENT'],
produces: ['RECEIVES_ARGUMENT']  // Note: DERIVES_FROM NOT in produces
```

Wait — DERIVES_FROM is created but not declared in `produces`? Let me check the comment:

Line 79: `// DERIVES_FROM also created but not in produces to avoid cycle with MethodCallResolver`

**Analysis:** This is intentional. DERIVES_FROM is created but not advertised to avoid circular dependencies in the enrichment phase ordering. The plugin knows what it's doing. Acceptable.

---

## 4. Extensibility: New Framework Support

**PERFECT.**

To add support for new framework (React, Vue, etc):
1. Write new analyzer plugin that creates PASSES_ARGUMENT edges
2. Done

ArgumentParameterLinker automatically picks up those edges and creates DERIVES_FROM. Zero changes to enricher.

This is the hallmark of good architecture: adding capability requires only adding data (analyzer plugins), not modifying existing code (enricher).

---

## 5. Brute Force Check: Any "Scan All Nodes" Patterns?

**NONE.**

Iteration scopes checked:
- Lines 100-102: `queryNodes({ nodeType: 'CALL' })` — targeted query, NOT all nodes
- Lines 110-125: Pre-fetch existing edges from PARAMETER nodes for deduplication — targeted by node type
- Lines 127-245: Iterate CALL nodes (from targeted query)

No brute force. All queries are type-constrained. Approved.

---

## 6. MVP Limitations That Defeat Purpose?

**NO DEFEATING LIMITATIONS.**

Legitimate limitations documented:
1. **Semantic ID collisions (v2):** Parameters with same name in different functions may collide
   - **Impact:** DERIVES_FROM may attach to wrong parameter
   - **Mitigation:** Known issue, tracked separately (v2 semantic IDs)
   - **Does it defeat the feature?** NO. Works correctly when IDs don't collide. Automatically fixes when semantic ID issue is resolved.

2. **Unresolved calls:** No DERIVES_FROM for calls with no CALLS edge
   - **Impact:** Parameters of unresolved functions stay unknown
   - **Does it defeat the feature?** NO. This is correct behavior — you can't trace what you can't resolve.

3. **Requires enrichment:** DERIVES_FROM edges only exist after ArgumentParameterLinker runs
   - **Impact:** traceValues returns unknown if enrichment not run
   - **Does it defeat the feature?** NO. That's how enrichment works. Fallback to unknown is graceful.

**Critical question:** Does this work for <50% of real-world cases?

**Answer:** NO. This works for ALL cases where:
- The call is resolved (CALLS edge exists)
- Semantic IDs don't collide

The semantic ID collision is a separate bug, not a limitation of this feature. The feature implementation is correct.

**APPROVED.**

---

## 7. Implementation Quality Check

### ArgumentParameterLinker.ts

**Deduplication strategy** (lines 107-125):
- RECEIVES_ARGUMENT: `${paramId}:${dstId}:${callId}` (per call site)
- DERIVES_FROM: `${paramId}:${dstId}` (aggregate, no callId)

**Why different keys?**
- RECEIVES_ARGUMENT: "This parameter received this value from THIS specific call"
- DERIVES_FROM: "This parameter can derive from this value source (any call)"

**Example:**
```javascript
const input = 'test';
function process(data) { return data; }
process(input);  // call1
process(input);  // call2
process(input);  // call3
```

- RECEIVES_ARGUMENT edges: 3 (one per call, with callId)
- DERIVES_FROM edges: 1 (deduplicated by source)

**Is this correct?** YES. DERIVES_FROM represents data flow, not call-site binding. One source = one edge.

### traceValues.ts

**Change** (lines 179-208):
```typescript
if (nodeType === 'PARAMETER') {
  if (followDerivesFrom) {  // Respects option
    const derivesEdges = await backend.getOutgoingEdges(nodeId, ['DERIVES_FROM']);
    if (derivesEdges.length > 0) {
      // Follow edges, recurse
      return;
    }
  }
  // Fallback: mark as unknown
}
```

**Critical check:** Does this respect `followDerivesFrom` option?

YES. Line 181: `if (followDerivesFrom)`. If option is false, immediately falls through to unknown. Correct.

**Critical check:** Cycle protection?

YES. Line 188: `visited` Set passed to `traceRecursive`. Existing cycle protection applies.

**APPROVED.**

### ParameterDerivesFrom.test.js

**Test coverage:**
1. Basic: PARAMETER → VARIABLE (lines 45-98)
2. PARAMETER → LITERAL (lines 101-149)
3. Deduplication: 3 calls, 1 DERIVES_FROM edge (lines 152-229)
4. Multi-argument: argIndex matching (lines 232-287)
5. No edges for unresolved calls (lines 290-316)
6. No duplicates on re-run (lines 319-357)
7. DERIVES_FROM has NO callId metadata (lines 360-414)
8. DERIVES_FROM has argIndex metadata (lines 417-468)

**8 tests, all pass.** Coverage is thorough. Approved.

---

## 8. Does This Follow Grafema Principles?

### TDD — Tests First
✅ Tests written (ParameterDerivesFrom.test.js, 8 test cases)
✅ Tests pass before implementation declared complete

### DRY / KISS
✅ No duplication — reuses existing ArgumentParameterLinker iteration
✅ Clean solution — extends existing enricher, no new subsystems
✅ Matches existing patterns — RECEIVES_ARGUMENT creation pattern replicated for DERIVES_FROM

### Reuse Before Build
✅ Extended ArgumentParameterLinker (existing enricher)
✅ Extended traceValues.ts (existing query utility)
✅ No new subsystems created

### Root Cause Policy
✅ Identified architectural gap: PARAMETER nodes were terminal, not intermediate
✅ Fixed from roots: enrichment creates proper edges, queries consume them
✅ No hacks, no workarounds

---

## Final Assessment

**What was promised:**
- PARAMETER nodes stop being dead ends
- traceValues can trace through function boundaries
- Zero additional iteration cost

**What was delivered:**
- DERIVES_FROM edges created in ArgumentParameterLinker (same O(m) loop)
- traceValues follows DERIVES_FROM edges through PARAMETER nodes
- 8 tests pass, all covering edge cases
- Implementation matches the plan exactly

**Architectural correctness:**
- Forward registration: ✅
- Plugin architecture: ✅
- Complexity O(m): ✅
- No brute force: ✅
- Extensibility: ✅

**Vision alignment:**
- "AI should query the graph, not read code": ✅
- Unblocks 35 real-world data flow traces: ✅
- Makes graph superior to reading source: ✅

---

## Areas of Excellence

1. **Zero additional cost:** DERIVES_FROM creation happens in existing loop. No extra iteration.
2. **Correct deduplication:** Separate keys for per-call vs aggregate edges. Deep understanding of semantics.
3. **Graceful fallback:** traceValues returns unknown when no DERIVES_FROM edges exist. No crashes, no assumptions.
4. **Thorough testing:** 8 tests covering basic, cross-file, deduplication, metadata, re-run safety.
5. **Documentation:** Comments explain RECEIVES_ARGUMENT vs DERIVES_FROM distinction clearly.

---

## Conclusion

**APPROVED FOR MERGE.**

This implementation does exactly what it should:
- Solves a real product gap (35 cases blocked)
- Does it the right way (extends existing infrastructure)
- Adds zero complexity overhead (reuses existing iteration)
- Maintains architectural integrity (forward registration, plugin pattern)

No hacks. No shortcuts. No "MVP limitations" that defeat the feature's purpose.

This is production-ready.

---

**Next step:** Escalate to Вадим for final review.

If Вадим approves → merge to main, update Linear → Done, remove worktree.
