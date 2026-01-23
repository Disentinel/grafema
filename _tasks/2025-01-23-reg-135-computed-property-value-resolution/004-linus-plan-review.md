# Linus Torvalds - High-Level Plan Review: REG-135

**Status: APPROVED**

## The Question

We need to eliminate `propertyName: '<computed>'` from query results. Currently, when code does `obj[key] = value`, we store the property name as `'<computed>'` if `key` is a variable, forcing users back to reading code instead of querying the graph. This breaks Grafema's core promise: "AI should query the graph, not read code."

## What Don and Joel Got Right

### 1. Didn't Over-Solve
This plan resolves a **specific, solvable subset** of computed properties:
- Direct literals: `const k = 'x'; obj[k] = value` ✓ RESOLVED
- Chains: `const a = 'x'; const b = a; obj[b] = value` ✓ RESOLVED
- Ternaries: `const k = cond ? 'a' : 'b'` ✓ RESOLVED_CONDITIONAL
- Parameters, runtime calls, cross-file: marked as UNKNOWN or DEFERRED ✓

It doesn't try to solve the unsolvable (like parameter introspection or dynamic runtime values). This is pragmatic.

### 2. Used Existing Infrastructure
Don's analysis is solid: `ValueDomainAnalyzer` already has 462 lines of battle-tested value tracing. We're not building from scratch or inventing new machinery. We're extending a proven pattern.

### 3. Follows the Existing Pattern
The `computedPropertyVar` + resolution approach mirrors what already exists for method calls (`MethodCallInfo`). This reduces cognitive load and keeps the codebase consistent.

### 4. Clean Separation of Concerns
- **Analysis phase**: Capture the variable name in `ObjectMutationInfo`
- **Enrichment phase**: Resolve the variable to literal values
- **Graph stores it**: Edge metadata becomes queryable

This is the right layering.

### 5. Honest About Limitations
The plan acknowledges what it can't do (cross-file resolution) and defers it cleanly. No pretense of solving everything in one go.

## What Concerns Me

### 1. Edge Deletion Approach (Medium Concern)

The plan uses "delete edge + recreate with metadata" pattern to update FLOWS_INTO edges:

```typescript
await graph.deleteEdge(edge.src, edge.dst, 'FLOWS_INTO');
await graph.addEdge({ src, dst, type: 'FLOWS_INTO', metadata: { ...resolved } });
```

**The problem:** RFDB stores edges by `(src, dst, edgeType)` key. If we delete the wrong tuple or have concurrent operations, we lose an edge mid-resolution.

**Joel's reasoning:** "InstanceOfResolver does this pattern, so it's safe."

**My verdict:** InstanceOfResolver runs synchronously in one place. ValueDomainAnalyzer is an enrichment plugin that runs after analysis. Are we 100% sure RFDB isn't reading edges concurrently while we're modifying them?

**Action item:** Kent must write a test that simulates concurrent reads during edge updates. If RFDB doesn't handle this gracefully, we need to reconsider.

**Alternative if concurrent reads are risky:** Store resolution data in a separate node type (`COMPUTED_PROPERTY_RESOLUTION`) and query both. Slower, but safer. We can optimize later if needed.

### 2. The Total Resolution Time

Joel estimates 4 hours total. That includes:
- 1.5 hours for the `resolveComputedMutations` method alone
- 462 lines of code across multiple files
- New test file with ~300 lines

This is substantial. On a massive codebase with thousands of computed properties, this enrichment step could become a bottleneck. The acceptance criteria say "< 5% performance impact" but we need to **verify this with real data**, not assumptions.

**Action item:** After implementation, run on a large codebase (10k+ files) and measure actual impact. If > 5%, we need to optimize or defer cross-file to Phase 2.

### 3. Resolution Status Nomenclature

The `ResolutionStatus` enum has this:
```typescript
'UNKNOWN_PARAMETER'   // Variable traces to function parameter
'UNKNOWN_RUNTIME'     // Variable traces to function call
'DEFERRED_CROSS_FILE' // Variable traces to import
```

This conflates three different **confidence levels**:
- UNKNOWN_* = We know there's an unknown source
- DEFERRED_* = We defer to future analysis

Cleaner would be:
```typescript
'RESOLVED'              // Definite value
'CONDITIONAL'           // Multiple definite values
'INDETERMINATE_PARAM'   // Could be anything (parameter)
'INDETERMINATE_CALL'    // Could be anything (call result)
'BLOCKED_CROSS_FILE'    // Need cross-file to resolve
```

**But honestly?** The current names are clear enough. Not worth changing. Consumers will understand what "UNKNOWN_RUNTIME" means.

### 4. Test Coverage Gaps

The test file is good, but it's **aspirational**. Tests assume:
- `computedPropertyVar` is captured correctly
- Edge deletion/creation works
- Metadata is preserved
- RFDB returns edges in predictable format

Joel's test file has comments like:
```javascript
// This test verifies we didn't break existing functionality
// The exact assertion depends on whether the class resolution works
```

This is wishy-washy. Tests should be **deterministic and specific**.

**Action item:** Kent must write **unit tests** first (mocks for RFDB), not just integration tests. If the enrichment logic is wrong, we need to know immediately.

## Did We Address the Original Request?

The user request (REG-135) asked for:
- ✓ Add `computedPropertyVar` field to `ObjectMutationInfo`
- ✓ Store variable name during AST analysis
- ✓ Implement `ResolutionStatus` enum
- ✓ Create enrichment step for resolution
- ✓ Update `FLOWS_INTO` edge metadata
- ✓ Handle conditional assignments
- ✓ Tests for all patterns
- ? Performance < 5% (assumed, not verified)

All acceptance criteria are addressed. Good.

## Does This Align With Project Vision?

**Yes, strongly.**

Grafema's thesis: "AI should query the graph, not read code."

Before: Query returns `propertyName: '<computed>'` → User must read code to know what property
After: Query returns `propertyName: 'actualName', resolutionStatus: 'RESOLVED'` → User gets deterministic answer from the graph

This is exactly what Grafema promises. No more `'<computed>'` lying to users.

## Is This the Right Level of Abstraction?

Yes.

- Not too granular (trying to infer individual parameter values from call sites)
- Not too coarse (treating all unknowns the same)
- Precisely targets the "low-hanging fruit" of deterministic resolution
- Defers hard cases to Phase 2 cleanly

## Final Verdict

**APPROVED** — but with two mandatory verification steps before Kent starts:

1. **Concurrent read safety:** Verify RFDB edge deletion doesn't lose data during concurrent reads
2. **Performance testing:** Have a plan to measure impact on real codebases and hit < 5% target

The architecture is sound. The plan is well-scoped. The implementation is straightforward. Joel's technical plan is detailed and specific.

Ship it.

---

## Minor Notes for Rob (Implementation Engineer)

When implementing:
- The `resolveComputedMutations` method has a lot of duplicate logic (two loops over VARIABLE and CONSTANT nodes). Refactor into a helper to avoid bugs.
- The type assertions in edge metadata access are ugly (`(edge as { mutationType?: string }).mutationType`). Consider a helper function.
- Test the edge case where a computed property resolves to multiple values — make sure `resolvedPropertyNames` array is handled correctly in all code paths.

---

## Questions for Steve (Demo)

Before marking this done, please verify:
1. When you query computed properties now, do you get actual property names? (Not `'<computed>'`)
2. Can you query by `resolutionStatus` to find "RESOLVED_CONDITIONAL" properties?
3. Does the resolved information appear in the CLI output cleanly?

If any of these feels awkward, it's not done yet.
