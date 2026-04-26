# REG-532: Dijkstra Re-Verification - DERIVES_FROM Edges for CALL Nodes

**Author:** Edsger Dijkstra (Plan Verifier)
**Date:** 2026-02-20
**Status:** REJECT - Critical Architectural Concerns

## Executive Summary

Don's plan v2 addresses most gaps from my initial review but reveals **critical architectural misunderstandings**:

1. CallFlowBuilder runs during **ANALYSIS phase**, but plan calls it "enrichment"
2. Plan proposes querying PASSES_ARGUMENT edges that don't exist yet (ordering bug)
3. File paths in plan are wrong (enrichers vs plugins)
4. No consideration of phase ordering or existing enrichment architecture

**Verdict:** REJECT. Don must clarify the **actual phase** where this work happens and ensure proper ordering.

---

## Gap-by-Gap Verification

### Gap 1: CONSTRUCTOR_CALL arguments not extracted
**Don's Resolution:** Change 3 - extract constructor args through ArgumentExtractor and create DERIVES_FROM edges.

**Verification:**
- ✅ Correct diagnosis: NewExpressionHandler.ts lines 56-86 only handle Promise executor, no general argument extraction
- ✅ Correct fix: Need to call ArgumentExtractor.extract() for `newNode.arguments`
- ❌ **CRITICAL ISSUE:** Plan says "query existing PASSES_ARGUMENT edges" (line 131-141 Change 3 Part B) but those edges don't exist yet!
  - Part A creates PASSES_ARGUMENT edges
  - Part B queries them to create DERIVES_FROM
  - **Problem:** If both run in same pass, Part B runs BEFORE Part A completes
  - CallFlowBuilder.bufferArgumentEdges() processes callArguments array AFTER NewExpressionHandler finishes
  - DERIVES_FROM logic in Change 3 Part B will find ZERO edges

**Required Fix:** Clarify WHEN Part B runs. If CallFlowBuilder is buffering, edges aren't queryable yet. Need flush or separate pass.

**Status:** ⚠️ CONDITIONALLY APPROVED - needs ordering clarification

---

### Gap 2: DataFlowValidator type string mismatch
**Don's Resolution:** Change 1 - fix line 216 to check `'CALL' || 'CONSTRUCTOR_CALL'` instead of `'METHOD_CALL' || 'CALL_SITE'`.

**Verification:**
- ✅ Correct diagnosis: Line 216 checks wrong type strings
- ✅ Correct fix: Change to `type === 'CALL' || type === 'CONSTRUCTOR_CALL'`
- ✅ Correct commit separation: This is a pre-existing bug, deserves own commit
- ❌ **FILE PATH ERROR:** Plan says `packages/core/src/enrichers/data-flow/DataFlowValidator.ts` but actual path is `packages/core/src/plugins/validation/DataFlowValidator.ts`

**Status:** ✅ APPROVED (after fixing file path)

---

### Gap 3: Zero-argument builtin calls
**Don's Resolution:** No action needed - Gap 2 fix resolves it.

**Verification:**
```
Math.random() flow:
1. VARIABLE:x → ASSIGNED_FROM → CALL:Math.random
2. Validator reaches CALL:Math.random
3. After Gap 2 fix: line 216 checks `type === 'CALL'` → TRUE
4. Returns `found: true` with label "(intermediate node)"
5. → Validation PASSES
```

**Logic:** After Gap 2 fix, CALL nodes with no outgoing edges are treated as leaf nodes (line 216-218). This is correct for zero-arg builtins.

**Status:** ✅ APPROVED

---

### Gap 4: Missing argument types
**Don's Resolution:** Out of scope, create follow-up issue REG-XXX.

**Verification:**
- ArgumentExtractor.ts lines 250-254 fallback case: unhandled types get `targetType = 'EXPRESSION'` but NO `targetId`
- CallFlowBuilder.ts line 183: `if (targetNodeId)` - skips edges when no targetId
- Impact: Template literals (`foo(\`hello ${x}\``), await expressions, conditionals, unary ops get no PASSES_ARGUMENT edges
- These ARE used in real code (template literals especially)

**Concern:** Don dismisses this as "uncommon patterns" but template literals are everywhere in modern JS. However, fixing this IS out of scope for REG-532's core thesis.

**Status:** ✅ APPROVED (acceptable scope decision for separate issue)

---

### Gap 5: DERIVES_FROM semantics
**Don's Resolution:** Documented as "behavioral derivation" - call's execution depends on arguments even if return value doesn't.

**Verification:**
```javascript
const result = console.log(x)  // result is undefined
```

Don's interpretation: CALL node's **behavior** derives from x, even if return value doesn't.

**Philosophical Check:**
- ✅ Consistent with "data flow tracing" use case
- ✅ Consistent with "impact analysis" use case
- ⚠️ NOT consistent with "value flow" semantic (return value doesn't derive from x)

**Counter-argument:** Grafema tracks **behavioral dependencies**, not just value flow. Mutation tracking already follows this pattern.

**Status:** ✅ APPROVED (with strong documentation)

---

## Critical Architectural Concerns

### Concern 1: Phase Confusion

**Plan says:** "CallFlowBuilder runs during enrichment phase" (implied by file path `enrichers/data-flow/`)

**Reality:** CallFlowBuilder is in `packages/core/src/plugins/analysis/ast/builders/CallFlowBuilder.ts` and runs during ANALYSIS phase as a DomainBuilder.

**Evidence:**
- CallFlowBuilder.ts line 42-56: `buffer()` method - this is analysis-time buffering
- No enrichment plugin imports CallFlowBuilder
- File path: `plugins/analysis/ast/builders/` not `enrichers/`

**Impact:** Don's plan proposes adding DERIVES_FROM logic to CallFlowBuilder (Changes 2 & 3), but:
- CallFlowBuilder buffers edges, doesn't write them to graph
- Can't query graph during buffering phase
- Need to either:
  - A) Add DERIVES_FROM to a SEPARATE enrichment plugin (correct architecture)
  - B) Extend CallFlowBuilder to buffer DERIVES_FROM edges too (architectural change)

**Required Clarification:** WHERE does DERIVES_FROM logic run? If in CallFlowBuilder (analysis), it must buffer edges. If in enrichment, it must query existing PASSES_ARGUMENT edges.

### Concern 2: Ordering Bug in Change 3

**Plan's Change 3 Part B (lines 128-155):**
```typescript
// In CallFlowBuilder:
const argEdges = this.graph.queryEdges({
  filter: {
    source: node.id,
    type: 'PASSES_ARGUMENT'
  }
});
```

**Problem:** CallFlowBuilder doesn't have `this.graph`. It has `this.ctx` (BuilderContext) which only has `bufferEdge()`, not query methods.

**Evidence:** CallFlowBuilder.ts line 40 - constructor takes `BuilderContext`, not `GraphBackend`.

**Impact:** Change 3 as written CANNOT work. Must either:
- Rewrite to buffer DERIVES_FROM edges instead of querying
- Move to enrichment phase where graph is queryable

### Concern 3: File Path Errors Throughout Plan

**Plan claims:**
| File (Plan v2) | Actual Path |
|----------------|-------------|
| `enrichers/data-flow/DataFlowValidator.ts` | `plugins/validation/DataFlowValidator.ts` |
| `enrichers/data-flow/CallFlowBuilder.ts` | `plugins/analysis/ast/builders/CallFlowBuilder.ts` |
| `enrichers/control-flow/visitors/NewExpressionVisitor.ts` | `plugins/analysis/ast/handlers/NewExpressionHandler.ts` |

**Impact:** Rob will waste time searching for files. Suggests Don didn't verify file locations.

---

## One Valid Architecture Path

**Option:** Buffer DERIVES_FROM edges in CallFlowBuilder during analysis

**Changes:**

1. **In ArgumentExtractor.extract()**: After creating PASSES_ARGUMENT in callArguments array, ALSO create DERIVES_FROM in new array
   ```typescript
   callArguments.push(argInfo);
   // NEW:
   derivesFromEdges.push({
     source: callId,
     target: argInfo.targetId,
     type: 'DERIVES_FROM',
     metadata: { kind: 'argument', position: argInfo.argIndex }
   });
   ```

2. **In CallFlowBuilder.bufferArgumentEdges()**: After buffering PASSES_ARGUMENT, buffer DERIVES_FROM
   ```typescript
   this.ctx.bufferEdge({
     type: 'PASSES_ARGUMENT',
     src: callId,
     dst: targetNodeId,
     metadata: { argIndex }
   });
   // NEW:
   this.ctx.bufferEdge({
     type: 'DERIVES_FROM',
     src: callId,
     dst: targetNodeId,
     metadata: { kind: 'argument', position: argIndex }
   });
   ```

**This works because:**
- No querying needed - all data available during buffering
- Single pass
- No phase ordering issues

---

## Verdict: REJECT

**Reasons:**

1. ❌ **Phase confusion** - plan calls analysis "enrichment", proposes querying during buffering
2. ❌ **Ordering bug** - Change 3 Part B queries edges that don't exist yet
3. ❌ **File path errors** - wrong paths throughout, suggests insufficient verification
4. ❌ **Missing architectural context** - no mention of buffering vs querying distinction

**Required Before Approval:**

1. Don must verify ACTUAL file paths in current codebase
2. Don must clarify: Analysis-phase buffering OR enrichment-phase querying?
3. If analysis: rewrite to buffer DERIVES_FROM directly (no querying)
4. If enrichment: specify which enrichment plugin and verify PASSES_ARGUMENT edges exist by then
5. Update Change 3 to fix ordering: extract args THEN buffer DERIVES_FROM in same pass

---

## Specific Questions for Don

1. Did you verify CallFlowBuilder is in `plugins/analysis/` not `enrichers/`?
2. Did you check that BuilderContext has no query methods?
3. How will Change 3 Part B query edges during buffering phase?
4. Should this be analysis-phase work (buffering) or enrichment-phase work (querying)?

---

**Dijkstra's Note:** The core idea is sound, but execution plan has architectural blind spots that will cause Rob to hit walls during implementation. Must resolve phase/location questions before writing code.
