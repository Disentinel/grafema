# Linus Torvalds Plan Review: REG-330 Strict Mode

## Verdict: APPROVE

This plan is solid. It does the right thing, in the right way, with appropriate scope.

---

## What They Got Right

### 1. Vision Alignment - Excellent

Don nailed it: "If the graph silently degrades, we're lying to users about what we know."

This is exactly the mindset Grafema needs. Silent failures are poison for an AI-first tool. When an LLM queries the graph and gets incomplete data because we quietly created a stub, that's not graceful degradation - that's lying by omission. Strict mode makes the honesty explicit.

### 2. Collect-All-Then-Fail - Correct Decision

The plan correctly chose to collect all errors before failing, rather than fail-fast on the first error. This is the right call because:

- One analysis run reveals ALL product gaps
- More efficient for dogfooding
- Consistent with existing validator pattern (DiagnosticCollector already works this way)

### 3. Architecture - Clean and Minimal

The changes are surgical:
- One new error class (StrictModeError)
- One new flag in PluginContext
- One config option
- One CLI flag
- Enricher updates are localized to the unresolved paths

No new abstractions, no framework changes, just extending existing patterns.

### 4. Scope Discipline - Appropriate

The plan correctly limits scope to ENRICHMENT phase only. Validators already have configurable severity - we don't need to complicate that. INDEXING phase errors are a different beast (parse failures, language support issues) and shouldn't be conflated with resolution failures.

The "Out of Scope" section is sensible: per-file overrides, whitelisting patterns - these are future refinements, not MVP requirements.

---

## Minor Concerns (Not Blockers)

### 1. Exit Code Semantics

Joel's plan mentions:
- Exit code 1: Fatal errors
- Exit code 2: Non-fatal errors

This is fine, but ensure the CLI actually implements this. Currently, most Node.js apps just exit with 1 for any error. If we're going to document specific codes, we need to enforce them.

**Action:** Verify in implementation that exit codes are explicitly set, not just bubbling up from uncaught exceptions.

### 2. Error Message Quality

The example error message format is good:
```
[STRICT_UNRESOLVED_METHOD] Cannot resolve method call: obj.method at file.js:42
  Suggestion: Check if class "obj" is imported and has method "method"
```

But the real test is: when a developer sees this, can they FIX the problem? The suggestion should be actionable. "Check if the class is imported" is okay, but for dogfooding purposes, we might want to add: "This might indicate a product gap in Grafema - consider filing an issue."

**Action:** Review error messages during implementation. Make them debuggable for BOTH the codebase being analyzed AND potential Grafema issues.

### 3. External Method Detection

The plan mentions "external methods (console.log, Math.random): NOT errors even in strict mode" and the current MethodCallResolver has `isExternalMethod()`.

Good - but make sure this list is comprehensive. Missing one external method will create false positives that annoy users and undermine trust in strict mode.

**Action:** Review `isExternalMethod()` implementation to ensure coverage.

---

## What Would Embarrass Us in 6 Months?

I checked for patterns that would make us cringe later:

1. **Hardcoded error codes** - They're using string constants like `STRICT_UNRESOLVED_METHOD`. This is fine. An enum would be overkill for 5 codes.

2. **Test coverage** - Joel's test plan covers the happy paths and basic sad paths. One gap: no test for "strict mode + external method = no error". Add it.

3. **Performance** - Collecting errors into an array adds negligible overhead. No concern here.

4. **Breaking changes** - None. Default behavior is unchanged (`strict: false`).

---

## Verification Checklist for Implementation

Before marking this done, verify:

1. `grafema analyze` behaves exactly as before (strict=false is default)
2. `grafema analyze --strict` on a known-clean codebase exits 0
3. `grafema analyze --strict` on a codebase with unresolved references:
   - Collects ALL errors (not just first)
   - Exits non-zero
   - Error messages include file, line, suggestion
4. External methods (console.log, etc.) do NOT trigger strict errors
5. Config file `strict: true` works
6. CLI `--strict` overrides config file `strict: false`
7. Dogfooding: run on Grafema itself, document any gaps found

---

## Final Assessment

**Is this the right thing to do?** Yes. Silent failures are antithetical to the project vision.

**Is this the simplest correct solution?** Yes. It extends existing patterns without over-engineering.

**Are we forgetting anything?** The acceptance criteria in the user request are fully covered.

**Will this embarrass us?** No. This is exactly the kind of feature a serious static analysis tool should have.

**APPROVED** - Proceed to implementation.

---

*Reviewed by Linus Torvalds, 2025-02-03*
