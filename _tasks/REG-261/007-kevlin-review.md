# Kevlin Henney - Code Review for BrokenImportValidator (REG-261)

## Summary

**Verdict: APPROVED with minor observations**

The implementation is clean, well-structured, and follows established patterns in the codebase. Rob Pike has done good work here. The code is readable, the tests communicate intent clearly, and the structure matches existing validators (DataFlowValidator, CallResolverValidator).

---

## Detailed Review

### 1. BrokenImportValidator.ts

**Strengths:**

1. **Excellent documentation header** - The JSDoc block at lines 1-22 clearly explains:
   - What this plugin does (two distinct error types)
   - When each error type applies
   - What conditions are skipped
   - Where it fits in the architecture (VALIDATION phase)

2. **Well-organized structure** - Clean separation into:
   - Interfaces (lines 30-43)
   - Constants (lines 46-58)
   - Plugin class (lines 62-325)

3. **Consistent with existing patterns** - Matches DataFlowValidator and CallResolverValidator:
   - Same `createSuccessResult` usage
   - Same error logging pattern (first N errors + "...and X more")
   - Same summary structure in metadata

4. **Good naming**:
   - `ERROR_CODES` constant with semantic keys
   - `DEFINITION_TYPES` clearly describes its purpose
   - `stats.skipped.*` fields are self-documenting

5. **Defensive programming**:
   - Early returns for skip conditions
   - Null checks before accessing properties
   - Progress reporting every 100 items

**Observations (not blockers):**

1. **Line 70-73 - Config handling**: The custom globals config pattern is straightforward. No issues.

2. **Line 85-86 - Dependencies declaration**: Good to see explicit dependencies on `ImportExportLinker` and `FunctionCallResolver`. This makes the plugin ordering clear.

3. **Line 191 - Import name extraction**: The fallback chain `imp.imported || imp.local || imp.name` is correct for handling different import scenarios.

4. **Lines 228-234 - Edge check before adding to list**: This is a smart optimization - only adding calls to `callsToCheck` if they need checking, rather than checking inside the loop.

---

### 2. GlobalsRegistry (definitions.ts + index.ts)

**Strengths:**

1. **Comprehensive coverage** - ECMAScript, Node.js, Browser, and Test globals are well-organized with comments explaining categories.

2. **Extensibility** - The `GlobalsRegistry` class allows:
   - Custom globals via config
   - Removal of unwanted globals
   - Clean API: `isGlobal()`, `addCustomGlobals()`, `removeGlobals()`

3. **Separation of concerns** - Definitions in one file, class in another. This is a clean pattern that makes both files focused.

**Minor observation:**

- Line 139 in definitions.ts: `'fn'` in TEST_GLOBALS - this is a Jest-specific global. It works but is somewhat niche. Not a problem.

---

### 3. BrokenImportValidator.test.ts

**Strengths:**

1. **Clear test organization** - Tests grouped by error type:
   - ERR_BROKEN_IMPORT (6 tests)
   - ERR_UNDEFINED_SYMBOL (6 tests)
   - Custom Globals (1 test)
   - Metadata (2 tests)

2. **Intent communication** - Each test name describes the scenario clearly:
   - "should detect broken named import (no IMPORTS_FROM edge)"
   - "should NOT report error for method calls (have object property)"

3. **MockGraph is minimal but sufficient** - Only implements what's needed for these tests. This follows the principle of minimal mocking.

4. **Negative tests included** - Tests for what should NOT be flagged are just as important as tests for what should be flagged. Good coverage:
   - Valid imports (line 157)
   - External imports (line 187)
   - Namespace imports (line 204)
   - Type-only imports (line 221)
   - Local definitions (line 269)
   - Imported functions (line 293)
   - Globals (line 319)
   - Method calls (line 355)
   - Resolved calls (line 371)

**Observations:**

1. **Line 13-15 comment**: "NOTE: This import will fail until BrokenImportValidator is implemented. This is intentional TDD - tests first!" - This is good to keep for documentation, though it's now outdated. The comment could be removed or updated.

2. **createContext helper** (lines 89-102) - Clean, focused, provides silent logger. Matches the pattern in CoverageAnalyzer.test.ts.

---

### 4. Modified Files

**packages/core/src/index.ts:**
- Line 203: `GlobalsRegistry` and `ALL_GLOBALS` exported - correct placement in the "Globals registry" section
- Line 214: `BrokenImportValidator` exported - correct placement in "Validation plugins" section

**packages/cli/src/commands/check.ts:**
- Lines 65-69: New `'imports'` category added to `CHECK_CATEGORIES`. This follows the existing pattern for `'connectivity'`, `'calls'`, and `'dataflow'`.

All changes are minimal and correctly placed.

---

## Code Quality Checklist

| Criterion | Status | Notes |
|-----------|--------|-------|
| Readability | PASS | Clear structure, good naming, no cleverness |
| Test quality | PASS | 15 tests covering positive and negative cases |
| Intent communication | PASS | Tests describe what they verify |
| Naming | PASS | Consistent with codebase conventions |
| Duplication | PASS | No unnecessary duplication |
| Error handling | PASS | Proper ValidationError creation with context |
| Comments | PASS | Header docs are excellent, inline comments where needed |

---

## Comparison with Existing Validators

| Aspect | DataFlowValidator | CallResolverValidator | BrokenImportValidator |
|--------|-------------------|----------------------|----------------------|
| Phase | VALIDATION | VALIDATION | VALIDATION |
| Priority | 100 | 90 | 85 |
| Error creation | ValidationError | ValidationError | ValidationError |
| Result format | createSuccessResult | createSuccessResult | createSuccessResult |
| Logging pattern | logger.info/warn/error | logger.info/warn/debug | logger.info/warn/error/debug |
| Summary in metadata | Yes | Yes | Yes |

The new validator follows all established patterns.

---

## Final Notes

1. **No forbidden patterns detected** - No TODO/FIXME/HACK comments, no mocks in production code, no empty implementations.

2. **No style inconsistencies** - Code matches the project's TypeScript style.

3. **Good separation of concerns** - Globals handling is in its own module, validator is focused on its task.

**Recommendation:** Merge as-is. The code is clean and ready.

---

*Reviewed by Kevlin Henney*
*Date: 2025-01-26*
