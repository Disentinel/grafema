# REG-226: ExternalCallResolver - Final Approval

## Status: APPROVED

The revised plan addresses all critical issues from my initial review. This is ready for Kent Beck to write tests and Rob Pike to implement.

## Verification Summary

### Issue 1: Node Metadata Strategy - RESOLVED
- **Original problem:** Spec assumed `graph.updateNode()` exists (it doesn't)
- **Fix:** Option B implemented - derive resolution type from graph structure
- **Result:** ExternalCallResolver creates edges only, CallResolverValidator derives types from edge destinations
- **Verification:** All metadata update logic removed from spec (006, lines 64-97)

### Issue 2: Built-ins List Too Broad - RESOLVED
- **Original problem:** List included constructors (Array, Object) and objects with methods (JSON, Math)
- **Fix:** Narrowed to 13 actual global functions: parseInt, parseFloat, isNaN, isFinite, eval, URI functions, timers, require
- **Result:** Clear separation - constructors and objects excluded, only standalone functions
- **Verification:** Correct list in 006, lines 44-55 with detailed rationale

### Issue 3: Priority Order Not Justified - RESOLVED
- **Original problem:** Priority 70 stated without dependency analysis
- **Fix:** Full dependency analysis provided
- **Result:**
  - MUST run after FunctionCallResolver (80) - handles non-relative after relative imports
  - SHOULD run before MethodCallResolver (50) - logical order, no overlap
  - SHOULD run before NodejsBuiltinsResolver (45) - JS vs Node.js separation
- **Verification:** Don's analysis (005, lines 128-204), Joel's verification (006, lines 441-477)

### Issue 4: Test Coverage Gaps - RESOLVED
- **Original problem:** Missing tests for namespace imports, aliased imports, mixed resolution, re-exports
- **Fix:** All four test cases added
- **Result:**
  1. Namespace imports (006, lines 102-151) - verifies skip for method calls
  2. Aliased imports (006, lines 158-205) - verifies exportedName uses imported name
  3. Mixed resolution (006, lines 208-315) - full pipeline test for all resolution types
  4. Re-exported externals (006, lines 318-384) - documents known limitation
- **Verification:** Complete test implementations with assertions and rationale

## Architecture Quality

**Good:**
- Clean separation of concerns - edges only, no metadata updates
- Follows existing patterns (matches FunctionCallResolver structure)
- Proper pipeline integration (justified priority 70)
- Idempotent design
- Clear backlog planning for known limitations

**Limitations (documented for future work):**
- Re-exported external modules currently unresolved (Linear issue to be created after completion)
- This is the RIGHT decision - extending FunctionCallResolver is correct approach, not duplicating logic

## Alignment with Grafema Vision

**Enables critical queries:**
```
Query: What external packages does service X depend on?
Query: Show all calls to lodash in this file
Query: Which functions are unresolved?
```

**Before:** Requires reading code
**After:** Query the graph

This is exactly what Grafema should do.

## Implementation Readiness

**Technical specifications:**
- Algorithm clear and complete (005, lines 296-330)
- Test cases comprehensive (006, sections 2.1-2.9)
- Edge cases covered
- Integration points defined (006, lines 393-438)

**No blockers:**
- No GraphBackend changes required
- No RFDB changes required
- Fits existing plugin architecture
- Dependencies clear

## Next Steps

1. **Kent Beck:** Write tests following spec sections 2.1-2.9
2. **Rob Pike:** Implement ExternalCallResolver per revised algorithm (005, lines 296-330)
3. **After completion:** Create Linear issue for re-export limitation (template in 006, lines 514-543)
4. **Steve Jobs:** Demo the feature - show queries for external dependencies

## Bottom Line

The plan is architecturally sound, follows Grafema principles, and addresses all concerns from initial review.

No hacks. No shortcuts. This is the right way to do it.

Ready to implement.

---

**Approved by:** Linus Torvalds
**Date:** 2026-01-26
**Next:** Kent Beck - write tests
