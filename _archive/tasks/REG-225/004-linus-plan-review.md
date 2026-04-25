# REG-225: Linus Torvalds - Plan Review

## Summary

**APPROVED** with minor clarifications needed.

This is the RIGHT thing to do. It's a bug fix, not a feature. Internal function calls should resolve regardless of file boundaries.

---

## What's Right

### 1. Problem Understanding
You nailed it. GraphBuilder only creates CALLS edges for same-file functions. This is stupid - a function call is a function call whether the function is in the same file or imported. The graph should reflect the actual program structure, not be limited by file boundaries.

### 2. Abstraction Level
ENRICHMENT phase at priority 80 is correct. This is exactly what enrichment is for - connecting dots that analysis couldn't connect due to incomplete information.

The chain is clean:
```
CALL_SITE -> IMPORT -> IMPORTS_FROM -> EXPORT -> FUNCTION
```

You follow existing edges (IMPORTS_FROM from ImportExportLinker) and create new ones (CALLS). This is the right level of abstraction.

### 3. Alignment with Vision
**"AI should query the graph, not read code"** - this directly supports that vision. Without these CALLS edges, the graph is incomplete. AI would have to read imports and trace them manually. With this plugin, the graph tells the truth about what calls what.

### 4. Test Coverage
Test cases are comprehensive:
- Named imports ✓
- Default imports ✓
- Aliased imports ✓
- Namespace imports (correctly skipped) ✓
- Already-resolved (no duplicates) ✓
- External imports (correctly skipped) ✓
- Missing edges (graceful handling) ✓

This covers the happy paths and all the edge cases that matter.

### 5. Implementation Plan
Joel's spec is detailed and follows existing patterns from MethodCallResolver and ImportExportLinker. Build indices, process in a single pass, O(1) lookups. This is efficient and straightforward.

---

## What Needs Clarification

### 1. Re-exports (Out of Scope, But...)

Joel's spec says "skip re-exports for v1" but Don's analysis doesn't explicitly state this limitation. The user's original request mentions:

> - [ ] Re-exports: `export { foo } from './other';`

**Question**: Is this in scope or out of scope?

**My take**: If re-exports are common in the codebase we're analyzing, skipping them will leave gaps in the graph. That's fine for v1 IF we:
1. Log a warning when we skip a re-export
2. Count them in the result (`skipped.reExports`)
3. Create a follow-up issue for deep re-export resolution

**Action**: Confirm with user whether simple (single-hop) re-exports should be supported in v1. Complex multi-hop chains can be deferred.

### 2. Namespace Imports - Are We Punting?

Joel says "leave to MethodCallResolver" but does MethodCallResolver actually handle namespace imports correctly?

`import * as utils from './utils'; utils.foo();`

This creates a CALL node with `object='utils'` and `method='foo'`. MethodCallResolver expects the object to be a CLASS instance, not a namespace.

**Question**: Does MethodCallResolver already handle this, or are we silently NOT resolving namespace imports?

**Action**: Check if namespace import method calls are currently resolved. If not, either:
- Add support in FunctionCallResolver, OR
- Create follow-up issue for NamespaceCallResolver

Don't punt on this if we're leaving a gap. Be explicit.

### 3. Performance Requirement - Is 1000 Imports Enough?

Spec says "<100ms for 1000 imports". That's a micro-benchmark. What about a real codebase with 50,000 imports and 100,000 function calls?

**Concern**: Are we testing at the right scale?

**Action**: The algorithm is O(n) so it should scale fine. But don't just test with toy data. Run it on the Grafema codebase itself and measure real performance.

### 4. Missing Tests for Arrow Functions

Don mentioned this as a potential edge case:

> Arrow functions assigned to variables (`const foo = () => {}; export { foo }`)

Joel's test plan doesn't explicitly cover this. Does GraphBuilder create FUNCTION nodes for arrow functions? If not, FunctionCallResolver won't find them.

**Action**: Add a test case for arrow function exports. If they're not FUNCTION nodes, this might surface a gap in GraphBuilder (separate issue).

---

## What Could Go Wrong

### Risk 1: EXPORT.local Doesn't Exist
Joel's algorithm assumes `EXPORT.local` exists:

```typescript
const targetFunctionName = exportNode.local || exportNode.name;
```

What if EXPORT nodes don't have `local` for default exports? What if it's always the literal string "default"?

**Mitigation**: Check actual EXPORT node structure. If `local` is unreliable, trace EXPORT -> DEFINES -> FUNCTION instead (if that edge exists).

### Risk 2: Function Name Collisions
Don mentioned:

> Functions with same name in different scopes (handle via file-level scoping)

The function index is `Map<file, Map<name, FunctionNode>>` which handles file-level scoping. But what about multiple functions with the same name in the SAME file (e.g., nested functions, closure scope)?

**Mitigation**: This is probably fine. We're looking up top-level exports, not nested closures. But if it becomes an issue, we'll see it in tests.

### Risk 3: Performance of getOutgoingEdges
The algorithm calls `await graph.getOutgoingEdges(call.id, ['CALLS'])` for EVERY call site. If there are 100,000 call sites, that's 100,000 async calls to the graph backend.

**Mitigation**: Build an index of existing CALLS edges FIRST, then check the index instead of querying per-call. This is O(n) upfront instead of O(n) queries.

**Action**: Profile this. If it's slow, refactor to batch-check existing edges.

---

## Did We Forget Anything?

Re-reading the original request:

> FunctionCallResolver should:
> 1. Run after ImportExportLinker (priority 80) ✓
> 2. Find CALL_SITE nodes without CALLS edges ✓
> 3. For each, look for IMPORT with matching local name ✓
> 4. Follow IMPORTS_FROM -> EXPORT -> DEFINES chain ← **WAIT**

The spec says "EXPORT -> FUNCTION" by name lookup. The original request says "EXPORT -> DEFINES chain".

**Is there a DEFINES edge from EXPORT to FUNCTION?**

If there is, we should use it instead of name-based lookup. If there isn't, name lookup is fine but more fragile (what if names don't match due to aliasing?).

**Action**: Check the graph schema. If DEFINES exists, use it. If not, name lookup is acceptable but document the limitation.

---

## Final Verdict

**APPROVED** pending clarifications:

1. **Re-exports**: Confirm scope. If out of scope, log warnings and create follow-up issue.
2. **Namespace imports**: Verify MethodCallResolver handles them OR create follow-up issue.
3. **Performance**: Test on real codebase, not just 1000 imports.
4. **Arrow functions**: Add test case.
5. **EXPORT -> FUNCTION link**: Use DEFINES edge if it exists, otherwise name lookup is fine.

The core design is solid. The algorithm is correct. The test plan is comprehensive. Fix the clarifications above and this is ready to implement.

---

## Nitpicks (Not Blockers)

- Joel's spec uses `name` field for function lookup but FUNCTION nodes might use `label` or something else. Check the actual schema.
- Logging should include skipped counts prominently so we can see if we're missing a lot of re-exports or namespace imports.
- The spec says "create a separate issue for deep re-export resolution if needed" - let's create it NOW, not "if needed". We know it's needed.

---

## Conclusion

This is the right fix at the right abstraction level. The graph will be more complete and more useful for AI queries. Do it.

**Next**: Kent writes tests. Address clarifications above. Then Rob implements.

---

**Linus**
