# Linus Torvalds - Implementation Review: REG-261 BrokenImportValidator

## Verdict: APPROVED

This is solid work. Clean architecture, correct implementation, no hacks.

## High-Level Assessment

### 1. Did we do the right thing?

**Yes.** This is exactly what Grafema should do - detect broken imports by querying the graph, not by re-parsing code. The implementation correctly leverages the data that ImportExportLinker and FunctionCallResolver already compute.

### 2. Did we cut corners?

**No.** The implementation follows the plan almost exactly:
- Clean separation: VALIDATION phase plugin, not polluting ENRICHMENT
- Proper globals handling: dedicated GlobalsRegistry with categorized definitions
- All edge cases handled: namespace imports, type-only imports, external modules
- Correct error severities: `error` for definite breaks, `warning` for potential false positives

### 3. Does it align with project vision?

**Yes.** The core thesis is "AI queries graph, not code." This validator:
- Queries IMPORT nodes and checks for IMPORTS_FROM edges
- Queries CALL nodes and checks for CALLS edges
- Does NOT re-read or re-parse any source files
- All data comes from graph queries

This is pure graph-driven validation.

### 4. Did we add any hacks?

**No hacks found.** The code is straightforward:
- Build indexes of definitions and imports per file
- Query imports, check for IMPORTS_FROM edges
- Query calls, check against local defs / imports / globals
- Report issues with proper context

### 5. Is it at the right level of abstraction?

**Yes.**
- `GlobalsRegistry` is reusable by other validators (will be useful)
- `BrokenImportValidator` follows existing validator patterns exactly
- Error codes and categories integrate cleanly with existing infrastructure

### 6. Do tests actually test what they claim?

**Yes.** The 15 tests cover:
- Detection: broken named import, broken default import, undefined symbol
- False positive prevention: valid imports, external imports, namespace imports, type-only imports
- False positive prevention: local definitions, imported functions (even broken), globals, method calls, resolved calls
- Configuration: custom globals
- Metadata: correct plugin metadata, proper result structure

Each test sets up the exact scenario it claims to test and asserts the expected behavior.

### 7. Did we forget something from the original request?

**One minor omission**: Don's plan mentioned `ERR_BROKEN_REEXPORT` for broken re-export chains. This was not implemented. However, looking at the plan more carefully:

> Re-exports / Barrel Files: Must follow IMPORTS_FROM chains through re-exports. ImportExportLinker already does this when creating edges - if the chain is broken, no edge is created.

This means broken re-exports would already be caught by `ERR_BROKEN_IMPORT` - the re-exporting module's IMPORT node would have no IMPORTS_FROM edge. A separate error code isn't strictly necessary for v1.

If we want `ERR_BROKEN_REEXPORT` as a distinct diagnostic, it can be added in a future iteration. Not a blocker.

## Code Quality Notes

### Good

1. **Clear documentation header** - Explains what the validator does and how it works
2. **Proper async iteration** - Uses `for await` on graph queries correctly
3. **Progress reporting** - Reports progress every 100 imports (good for large codebases)
4. **Comprehensive stats** - Tracks everything: checked, skipped, reasons for skipping
5. **Helpful error messages** - Includes what to check: `Check if "${importedName}" is exported from "${imp.source}"`

### Globals Organization

The globals definitions in `definitions.ts` are well-organized:
- `ECMASCRIPT_GLOBALS` - standard JS
- `NODEJS_GLOBALS` - Node.js environment
- `BROWSER_GLOBALS` - DOM/browser
- `TEST_GLOBALS` - testing frameworks

This is comprehensive enough for v1. We can always add more later.

## Comparison with CallResolverValidator

Looking at the existing `CallResolverValidator`, there's potential overlap - both check for unresolved calls. However:

- `CallResolverValidator` uses Datalog and reports `ERR_UNRESOLVED_CALL`
- `BrokenImportValidator` distinguishes between:
  - `ERR_BROKEN_IMPORT` - import exists but points to nothing
  - `ERR_UNDEFINED_SYMBOL` - no import exists at all

This distinction is valuable. A developer needs to know if they typo'd an import name vs forgot to import entirely. Different problems, different fixes.

## Minor Suggestions (Not Blocking)

1. **Future iteration**: Add test for `../` relative imports (currently only `./` in tests)
2. **Future iteration**: Consider environment-specific globals configuration in config.yaml

Neither of these blocks the current implementation.

## Final Verdict

**APPROVED for merge.**

This is clean, correct work that follows the plan, aligns with the vision, and doesn't embarrass us. The globals infrastructure will be useful for future validators. The code reads well and does exactly what it says.

Good job, Rob.

---

**Next steps:**
1. Create commit
2. Update Linear to In Review
3. Ready for merge to main
