# REG-254: Linus Torvalds - Revised Plan Approval

**Status:** APPROVED FOR IMPLEMENTATION

---

## Summary

Joel's revised plan correctly addresses all critical feedback from my previous review. The architecture is sound, duplication is eliminated via shared utilities, and all edge cases are handled.

---

## Checklist Against My Previous Feedback

| Requirement | Status | Evidence |
|-------------|--------|----------|
| Remove "alternative structure" code | ✓ FIXED | Lines 332-338 of old plan completely removed, only HAS_SCOPE->SCOPE->CONTAINS |
| Add METHOD_CALL support | ✓ FIXED | Line 185 checks both types, lines 537+ format correctly |
| Fix CLI bug | ✓ ADDRESSED | Phase 6 imports shared utility instead of duplicating buggy code |
| Document duplication | ✓ SOLVED | Extract utilities to @grafema/core (Phases 1-4), both MCP+CLI import |
| Add missing test cases | ✓ INCLUDED | Phase 10 comprehensive, includes cycles, transitive, nested scopes |
| Add architecture comment | ✓ INCLUDED | Phase 2 (lines 124-139), Phase 3 (318-327), Phase 9 README |
| Clarify transitive calls | ✓ RESOLVED | Param-based approach, seenTargets dedup, depth field included |

---

## What's Right

**1. Shared Utilities Pattern**
- Placing in `packages/core/src/queries/` is correct
- No new package, no dependency issues
- MCP and CLI both already depend on core
- Future queries (find_unused_exports, etc.) will go here naturally

**2. Transitive Traversal Design**
- `seenTargets` Set prevents both direct recursion (A→A) and cycles (A→B→A)
- `transitiveDepth` parameter caps explosion risk
- Manual recursion in `collectTransitiveCalls` avoids double-traversal
- `depth` field communicates call chain hierarchy to AI agents

**3. Interface Abstraction**
- Minimal `GraphBackend` surface (3 methods only)
- Makes testing trivial
- Decouples from RFDBServerBackend implementation details

**4. Comprehensive Test Strategy**
- Direct calls, method calls, nested scopes, resolution status
- Transitive: cycles, depth limits, deduplication
- MCP integration tests for tool discovery, disambiguation
- Good coverage of failure modes

---

## High-Level Assessment

This solves the **original problem correctly**:
- Graph has the data (CALL/METHOD_CALL nodes inside SCOPE)
- We make it queryable without reading code
- Scales to both interactive (MCP) and CLI use

**No hacks.** No shortcuts. Proper solution.

---

## One Note

In Phase 2, `collectTransitiveCalls` (line 274) calls `findCallsInFunction` with `transitive: false`.

The comment explains this correctly: "Don't recurse from inner calls" - the recursion is managed at the top level in `collectTransitiveCalls`, not delegated. This prevents double-traversal. Good.

---

## Ready to Execute

- **Kent Beck:** Write tests first (Phase 10 sketched out)
- **Rob Pike:** Implement in order (Phases 1-9)
- **Tests before commits:** One atomic change per commit
- **Estimated time:** 3 hours per Joel's breakdown

---

## Success Criteria (from Joel's Phase 9)

After implementation, verify:
1. `get_function_details` appears in MCP tools list
2. Returns CALL and METHOD_CALL nodes (not just CALL)
3. Returns calledBy with caller info
4. Transitive mode follows chains correctly
5. No infinite loops on cyclic calls
6. CLI uses shared utilities
7. All tests pass

---

**Linus Torvalds**
High-Level Reviewer, REG-254
Revised Plan: APPROVED ✓
