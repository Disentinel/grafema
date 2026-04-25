# Steve Jobs Review: REG-426

**Task:** Import resolution: .js to .ts redirects not followed in TS monorepos
**Verdict:** APPROVE

---

## Vision Alignment

"AI should query the graph, not read code."

This fix is a prerequisite for that vision to work at all. If Grafema cannot discover source files in a standard TypeScript monorepo -- and TypeScript ESM with `.js` extensions is the standard, not the exception -- then the graph is empty. An empty graph is worse than useless; it gives the illusion of analysis while missing the majority of the codebase. This was not a nice-to-have. It was a correctness gap that undermined the entire product thesis for TypeScript projects.

The fix directly serves the vision: more files discovered means a richer graph means better answers from the graph.

## Architecture Assessment

### Placement: Correct

The fix is in `resolveModulePath()`, the shared utility that all four resolution callers depend on (JSModuleIndexer, IncrementalModuleIndexer, MountPointResolver, FunctionCallResolver). This is exactly the right place. One fix, four beneficiaries. No duplication. No per-plugin hacks.

The prior REG-320 refactoring that unified module resolution into this single utility made this fix trivial. That is good architecture paying dividends -- a 10-line change with maximum blast radius in the right direction.

### Algorithm: Correct

The resolution order is:

1. Try all extensions (including exact match via empty string `''`)
2. If the path has a JS-family extension and the file was not found, try TS equivalents
3. Try index files in directory

This means:
- If `utils.js` exists, it is found in step 1 and returned. Redirect never fires. Correct precedence.
- If `utils.js` does not exist but `utils.ts` does, redirect fires in step 2. Correct behavior.
- The redirect only applies to JS-family extensions (`.js`, `.jsx`, `.mjs`, `.cjs`). `.coffee`, `.py`, etc. are not touched. No false positives.

This matches TypeScript's own module resolution semantics for ESM. Not a Grafema invention -- standard behavior that TypeScript projects depend on.

### Complexity: Acceptable

The redirect logic runs only when:
1. The extension loop (step 1) found nothing -- meaning we already iterated `DEFAULT_EXTENSIONS` without a match
2. The path has a JS extension -- a constant-time map lookup
3. We try 1-2 TS alternatives -- O(1)

No scanning of all nodes. No backward pattern matching. No new iteration over the graph. This is pure local resolution logic with zero performance impact on the broader system.

### Extensibility: Adequate

The `TS_EXTENSION_REDIRECTS` map is a clean, declarative data structure. Adding new redirects (if some future JS-to-X pattern emerges) is a one-line change to the map. No code changes needed.

## Code Quality

- 10 lines of implementation logic. Clean, obvious, no cleverness.
- Well-documented with JSDoc comment explaining the "why" (TypeScript ESM behavior).
- Uses `extname()` from `path` module -- correct, standard library.
- The `normalizedPath.slice(0, -ext.length)` pattern is straightforward string manipulation.
- Works in both filesystem and in-memory (fileIndex) modes -- the existing `pathExists()` abstraction handles the dispatch.

## Test Quality

13 new test cases covering:
- All four redirect pairs: `.js->.ts/.tsx`, `.jsx->.tsx`, `.mjs->.mts`, `.cjs->.cts`
- Precedence: existing `.js` file wins over redirect (both filesystem and fileIndex modes)
- `.js->.tsx` fallback when `.ts` does not exist
- In-memory mode (fileIndex) equivalence
- `resolveRelativeSpecifier()` integration (the higher-level API)
- False positive prevention: `.coffee` does not redirect, nonexistent files return null

The tests verify what they claim. The precedence tests are particularly important -- they ensure we do not break existing JS projects by incorrectly preferring TS files.

60/60 tests pass. Zero regressions.

## Potential Concerns (Addressed)

**"What about tsconfig paths?"** -- Out of scope for this fix. `tsconfig` path aliases are a separate resolution mechanism (REG-320 already handles the basic cases). This fix is specifically about the `.js->.ts` extension redirect, which is orthogonal.

**"What about declaration files (.d.ts)?"** -- Not relevant here. Grafema analyzes source files, not declaration files. A `.js` import in a TS project points to source, not declarations.

**"Could the redirect mask a real missing file?"** -- No. The redirect only fires when the requested file genuinely does not exist. If neither `.js` nor `.ts` exist, null is returned. No false positives.

## Conclusion

This is the kind of change I want to see: minimal, surgical, in the right architectural layer, with comprehensive tests. It fixes a real-world problem (TS monorepos being nearly invisible to Grafema) by implementing standard TypeScript resolution behavior in the shared utility that all callers depend on.

No hacks. No shortcuts. No "we will fix it later" limitations. This works for 100% of the standard TS ESM extension patterns.

**APPROVE** -- escalate to Vadim auto-review.
