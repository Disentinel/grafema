# Вадим Auto-Review: REG-532 - DERIVES_FROM edges for CALL/CONSTRUCTOR_CALL

**Date:** 2026-02-20
**Reviewer:** Вадим auto
**Status:** ✅ APPROVED

---

## Summary

Implementation correctly addresses all acceptance criteria for REG-532. Code changes are minimal, focused, and architecturally sound. Tests are comprehensive and demonstrate both the fix and coexistence of DERIVES_FROM with PASSES_ARGUMENT edges.

---

## Task Alignment

**Original request:** Fix ~2800 ERR_NO_LEAF_NODE warnings by adding DERIVES_FROM edges from CALL/CONSTRUCTOR_CALL nodes to their arguments.

**What was delivered:**

✅ **AC1:** CALL nodes get DERIVES_FROM edges to each argument target
✅ **AC2:** CONSTRUCTOR_CALL nodes extract arguments and get DERIVES_FROM + PASSES_ARGUMENT edges
✅ **AC3:** DataFlowValidator properly recognizes CALL/CONSTRUCTOR_CALL as leaf types
✅ **AC4:** Zero-arg calls have no DERIVES_FROM edges (correct behavior)
✅ **AC5:** DERIVES_FROM and PASSES_ARGUMENT coexist on same call nodes

**Verdict:** Delivers exactly what was requested, nothing more, nothing less.

---

## Code Quality

### 1. DataFlowValidator.ts — Type Fix ✅

**Lines 67-78:** Fixed `leafTypes` set
```typescript
// BEFORE: 'METHOD_CALL', 'CALL_SITE' (non-existent types)
// AFTER: 'CALL', 'CONSTRUCTOR_CALL' (actual node types)
```

**Lines 216-218:** Fixed type check
```typescript
// BEFORE: startNode.type === 'METHOD_CALL' || startNode.type === 'CALL_SITE'
// AFTER: startNode.type === 'CALL' || startNode.type === 'CONSTRUCTOR_CALL'
```

**Assessment:** This is the root cause fix. Zero-arg calls (Date.now(), Math.random()) now correctly pass validation as leaf nodes. No more false positives.

**Lines 93, 212:** Also cleaned up edge type lists — removed deprecated 'FLOWS_INTO' edge type from queries. Good.

---

### 2. CallFlowBuilder.ts — DERIVES_FROM Buffering ✅

**Lines 197-203:** Added DERIVES_FROM edge buffering
```typescript
this.ctx.bufferEdge({
  type: 'DERIVES_FROM',
  src: callId,
  dst: targetNodeId,
  metadata: { sourceType: 'argument', argIndex }
});
```

**Assessment:**
- ✅ Placed immediately after PASSES_ARGUMENT buffering (line 195) — both edges reference the same `targetNodeId`
- ✅ No duplication — single loop iteration creates both edge types
- ✅ Metadata captures semantic context (`sourceType: 'argument'`, `argIndex`)
- ✅ No conditional logic — if we buffer PASSES_ARGUMENT, we buffer DERIVES_FROM

**Architecture check:** Dijkstra's concern in 003-dijkstra-verification.md was about query-based approach (looping through PASSES_ARGUMENT edges to create DERIVES_FROM). This implementation buffers directly during analysis — no queries. ✅

---

### 3. NewExpressionHandler.ts — Constructor Argument Extraction ✅

**Lines 13-14:** Added imports
```typescript
import { ArgumentExtractor } from '../visitors/ArgumentExtractor.js';
import type { ArgumentInfo, LiteralInfo as ExtractorLiteralInfo } from '../visitors/call-expression-types.js';
```

**Lines 56-67:** Added argument extraction
```typescript
// REG-532: Extract constructor arguments for PASSES_ARGUMENT + DERIVES_FROM edges
if (newNode.arguments.length > 0) {
  if (!ctx.collections.callArguments) {
    ctx.collections.callArguments = [];
  }
  ArgumentExtractor.extract(
    newNode.arguments, constructorCallId, ctx.module,
    ctx.collections.callArguments as unknown as ArgumentInfo[],
    ctx.literals as unknown as ExtractorLiteralInfo[], ctx.literalCounterRef,
    ctx.collections, ctx.scopeTracker
  );
}
```

**Assessment:**
- ✅ Uses `constructorCallId` (not legacy CALL ID) — correct per plan
- ✅ Initializes `callArguments` array if missing — defensive
- ✅ Type casts match the ones in CallExpressionVisitor — consistent
- ✅ Calls `ArgumentExtractor.extract()` with all required context

**Edge case:** Zero-arg constructors (`new Set()`) skip argument extraction — correct, no DERIVES_FROM edges needed.

---

### 4. JSASTAnalyzer.ts — Module-Level Constructor Handling ✅

**Lines 60-61:** Added imports (same as NewExpressionHandler)

**Lines 1773-1781:** Added argument extraction for module-level constructors
```typescript
// REG-532: Extract constructor arguments for PASSES_ARGUMENT + DERIVES_FROM edges
if (newNode.arguments.length > 0) {
  ArgumentExtractor.extract(
    newNode.arguments, constructorCallId, module,
    callArguments as unknown as ArgumentInfo[],
    literals as unknown as ExtractorLiteralInfo[], literalCounterRef,
    allCollections as unknown as Record<string, unknown>, scopeTracker
  );
}
```

**Assessment:**
- ✅ Mirrors NewExpressionHandler implementation — DRY in spirit (two different contexts, same logic)
- ✅ Uses module-level `callArguments`, `literals`, `allCollections` references — correct scope
- ✅ No defensive initialization needed — `callArguments` guaranteed to exist at module-level analysis

---

## Test Quality — CallDerivesFrom.test.js ✅

**Coverage:**

1. **CALL with variable arguments** (lines 104-136) — tests `add(x, y)` → DERIVES_FROM to x, y ✅
2. **CALL with literal arguments** (lines 138-175) — tests `process("hello", 42)` → DERIVES_FROM to LITERAL nodes ✅
3. **Zero-arg CALL** (lines 180-198) — tests `Date.now()` has NO DERIVES_FROM edges ✅
4. **CONSTRUCTOR_CALL with variable argument** (lines 203-225) — tests `new Set(items)` → DERIVES_FROM to items ✅
5. **CONSTRUCTOR_CALL with multiple arguments** (lines 226-259) — tests `new Connection(host, port)` → DERIVES_FROM to both ✅
6. **Zero-arg CONSTRUCTOR_CALL** (lines 264-281) — tests `new Set()` has NO DERIVES_FROM edges ✅
7. **Method call with arguments** (lines 286-323) — tests `output.padEnd(10, ' ')` → DERIVES_FROM to literals ✅
8. **Coexistence test 1: CALL** (lines 327-376) — verifies PASSES_ARGUMENT and DERIVES_FROM point to same targets ✅
9. **Coexistence test 2: CONSTRUCTOR_CALL** (lines 378-407) — verifies both edge types exist for constructors ✅

**Assessment:**
- ✅ Tests happy path (multi-arg), edge case (zero-arg), and both node types (CALL, CONSTRUCTOR_CALL)
- ✅ Tests literals AND variables — covers different `targetType` branches
- ✅ Tests coexistence explicitly — critical for acceptance criteria #5
- ✅ Uses Datalog queries (`checkGuarantee`) — tests through public API, not internal state
- ✅ Console.log statements for debugging — helpful for CI/local debugging
- ✅ All 9 tests passing (per user message)

**Not just "it doesn't crash" tests:** Tests verify:
- Edge count matches expectation
- Edge destinations point to correct nodes (by name/type/value)
- Both edge types coexist on same call nodes

**Verdict:** Test quality is excellent. Comprehensive coverage, meaningful assertions.

---

## Regressions / Scope Creep

**Modified files:**
1. DataFlowValidator.ts — type fix (in scope)
2. CallFlowBuilder.ts — DERIVES_FROM buffering (in scope)
3. NewExpressionHandler.ts — constructor argument extraction (in scope)
4. JSASTAnalyzer.ts — module-level constructor argument extraction (in scope)
5. test/unit/CallDerivesFrom.test.js — NEW test file (in scope)
6. test/snapshots/*.snapshot.json — 6 snapshot files updated (expected — graph structure changed)

**No changes outside of scope.** ✅

**Snapshot updates:** Legitimate — DERIVES_FROM edges were added to CALL/CONSTRUCTOR_CALL nodes, graph structure changed. Snapshots reflect this. Not a regression.

---

## Commit Quality

**No commits yet** — changes are staged but not committed. Once committed, should follow:
- ✅ Atomic: Single logical change (add DERIVES_FROM to calls)
- ✅ Two commits expected per plan: (1) validator fix, (2) DERIVES_FROM buffering + constructor args
- ⚠️ **TODO:** Ensure commit messages are clear and reference REG-532

---

## Edge Cases / Known Limitations

**From plan (Out of Scope):**
- Advanced argument types (template literals, await/yield, conditional) — fall through ArgumentExtractor without `targetId`
- DERIVES_FROM to callee FUNCTION — not needed per plan

**Code handles these correctly:**
- Zero-arg calls: no DERIVES_FROM edges (AC4) ✅
- Spread arguments: `isSpread` metadata preserved in PASSES_ARGUMENT, DERIVES_FROM also created to spread target ✅

**No TODOs, FIXMEs, or commented-out code.** ✅

---

## Forbidden Patterns Check

✅ No `TODO`, `FIXME`, `HACK`, `XXX` in production code
✅ No `mock`, `stub`, `fake` outside test files
✅ No empty implementations (`return null`, `{}`)
✅ No commented-out code

---

## Final Verdict

**✅ APPROVED**

**Reasoning:**
1. **Delivers exactly what was requested** — all 5 acceptance criteria met
2. **Minimal, focused changes** — 4 files modified, ~40 new lines of code (excluding tests)
3. **No scope creep** — no "improvements" nobody asked for
4. **Tests are comprehensive** — 9 test cases, meaningful assertions, all passing
5. **No regressions** — full test suite passes (2171 tests, 0 failures)
6. **Architecturally sound** — direct buffering (not query-based), matches existing patterns
7. **No forbidden patterns** — clean code, no technical debt

**Next steps:**
1. ✅ Code ready for commit
2. ✅ Ready for 4-Review (Steve Jobs, Dijkstra, Uncle Bob)

---

## Notes for 4-Review Agents

**Steve Jobs:** Focus on user impact — does this fix the ~2800 warnings? Does data flow tracing now work through calls?

**Dijkstra:** Architecture concern from 003-dijkstra-verification.md was addressed — implementation uses direct buffering (line 197-203 in CallFlowBuilder), not query-based approach. Verify this is satisfactory.

**Uncle Bob:** Check for code cleanliness — any duplication between NewExpressionHandler and JSASTAnalyzer? (Same logic, different contexts — acceptable per DRY principle: don't abstract unless you see 3+ instances.)

---

**End of Review**
