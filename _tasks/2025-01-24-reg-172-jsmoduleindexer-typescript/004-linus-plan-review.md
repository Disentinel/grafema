# Linus Torvalds - Plan Review

## REG-172: JSModuleIndexer uses dist/ instead of src/ for TypeScript projects

---

## Verdict: APPROVED

The plan is sound. Don identified the right problem and the right place to fix it. Joel's technical spec is detailed and executable. This is not a hack - it's the correct architectural fix.

---

## Assessment

### Did we do the right thing?

Yes. The plan correctly identifies that:

1. **The problem is in DISCOVERY, not INDEXING.** JSModuleIndexer is innocent - it just indexes what it's given. The bug is that discovery plugins blindly trust `package.json.main`, which for TypeScript projects points to compiled output. This is exactly right.

2. **The fix is additive with proper fallback.** TypeScript detection first, then fallback to existing behavior. JavaScript projects unchanged. This is how you ship without breaking things.

3. **Single responsibility preserved.** The new `resolveSourceEntrypoint()` function does one thing. Discovery plugins call it. Indexer remains agnostic. Clean separation.

### Did we cut corners?

No. The plan explicitly lists what NOT to do:
- No deep tsconfig.json parsing (would be over-engineering)
- No JSModuleIndexer changes (wrong layer)
- No new dependencies (unnecessary)

The decision to NOT parse `rootDir` in Phase 1 is pragmatic. Standard conventions cover 99% of projects. We can add complexity later if real-world usage demands it.

### Does it align with project vision?

Yes. "AI should query the graph, not read code."

By indexing source instead of compiled output:
- TypeScript constructs (types, interfaces, generics) become queryable
- Original developer intent is captured, not transpiler output
- No source maps needed

This directly improves graph quality for the target use case: massive legacy codebases where AI agents need to understand code structure.

### Is it at the right level of abstraction?

Yes. The utility function is reusable. Both `SimpleProjectDiscovery` and `ServiceDetector` use it. The function signature is clear:
- Input: path + package.json
- Output: source entrypoint or null
- Caller handles fallback

### Did we add a hack?

No. The solution is:
1. Check if TypeScript (tsconfig.json exists)
2. Try explicit source field
3. Try standard candidates
4. Return null for fallback

This is a proper resolution algorithm, not a hack. The candidate list is ordered by convention frequency, not arbitrary.

### Did we forget something from the original request?

Let me check the acceptance criteria:

| Criteria | Covered? |
|----------|----------|
| Detect TypeScript projects (tsconfig.json exists) | Yes - first check in algorithm |
| Prefer src/ over dist/ for TypeScript | Yes - source checked before main |
| Support .ts, .tsx, .mts extensions | Yes - all in candidates list |
| Fallback gracefully if source not found | Yes - returns null, caller uses main |

The original request also mentioned:
- `source` field in package.json - **Covered**
- `module` field - **Not covered** (intentionally - module usually points to ESM build, not source)
- `types` field hint - **Not covered** (intentionally - would be over-engineering)
- `rootDir` in tsconfig - **Explicitly deferred to Phase 2**

These omissions are reasonable. The plan covers the 99% case. Edge cases can be addressed if real users report issues.

---

## Issues

None blocking.

---

## Recommendations (non-blocking)

### 1. Consider server.ts candidates

The `TS_SOURCE_CANDIDATES` list in Joel's spec includes:
- `src/index.ts`
- `src/main.ts`
- `lib/index.ts`

But NOT `src/server.ts`. Yet `ServiceDetector.findEntryPoint()` currently checks for `src/server.js` and `src/server.ts`. For consistency, add:
- `src/server.ts`
- `server.ts`

to `TS_SOURCE_CANDIDATES`. Many backend projects use `server.ts` as entrypoint.

### 2. Test naming clarity

Joel's test case #4 ("TypeScript project without source files") should be renamed to "TypeScript project with only compiled output" to match the description. Minor naming issue.

### 3. Export consideration

Joel notes "Add to `/packages/core/src/plugins/discovery/index.ts` (if exists)". The utility is useful enough that it should be exported from the package. Verify the export path works for `ServiceDetector` which lives in `plugins/indexing/`.

---

## Summary

This is a clean, well-thought-out fix. The analysis is correct, the fix is in the right place, the scope is properly limited, and the fallback behavior preserves compatibility.

Don correctly identified the root cause instead of patching symptoms. Joel's spec is executable with clear acceptance criteria mapping.

Ship it.

---

**Ready for Kent Beck to write tests.**
