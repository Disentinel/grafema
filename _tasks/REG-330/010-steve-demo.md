# Demo Report: REG-330 - Strict Mode

**Demo by:** Steve Jobs
**Date:** 2026-02-03
**Feature:** Strict mode for analysis (--strict flag)

---

## Executive Summary

**Would I show this on stage?** Not yet. The feature works, but the UX needs polish.

**Overall verdict:** The concept is sound - strict mode reveals product gaps by failing fast on unresolved references. But the execution feels unfinished. The error messages lack context, and the user journey from error to resolution is unclear.

---

## What I Tested

### Setup
Created a minimal test case at `/tmp/strict-demo/index.js`:
```javascript
const user = getUser();
user.processData();  // This method can't be resolved
```

### Test 1: Analysis WITHOUT --strict (default behavior)

**Command:**
```bash
grafema analyze --log-level info
```

**Result:** SUCCESS (exit code 0)
```
Analysis complete in 0.27s
  Nodes: 5
  Edges: 6

Warnings: 2
  - 1 WARN_UNRESOLVED_CALL (run `grafema check --all`)
  - 1 ERR_UNDEFINED_SYMBOL (run `grafema check --all`)

Run `grafema check --all` for full diagnostics.
```

**Good:**
- Analysis completes successfully
- Warnings are surfaced clearly
- Suggests next action: `grafema check --all`
- Performance is snappy (0.27s)

**Needs work:**
- Warnings appear in three places (console warnings during analysis, then summary at end)
- Not clear what "WARN_UNRESOLVED_CALL" vs "ERR_UNDEFINED_SYMBOL" means

### Test 2: Analysis WITH --strict

**Command:**
```bash
grafema analyze --strict --log-level info
```

**Result:** FAILURE (exit code 1)
```
✗ Analysis failed: Fatal error in MethodCallResolver: Cannot resolve method call: user.processData

→ Run with --debug for detailed diagnostics

[FATAL] STRICT_UNRESOLVED_METHOD (/private/tmp/strict-demo/index.js:3) Cannot resolve method call: user.processData
   Suggestion: Check if class "user" is imported and has method "processData"

Fatal: 1
```

**Good:**
- Fails fast with clear exit code
- Shows file path and line number
- Provides actionable suggestion
- Error code is descriptive: STRICT_UNRESOLVED_METHOD

**Needs work:**
- Error appears TWICE (once in main message, once in [FATAL] line)
- Suggestion is generic and unhelpful in this case
- No indication of HOW to fix this (should I add type annotations? Import something?)
- "Run with --debug" - but what will debug show me? Not explained.

---

## Deep Dive: What's Wrong?

### 1. Error Message Duplication
```
✗ Analysis failed: Fatal error in MethodCallResolver: Cannot resolve method call: user.processData

[FATAL] STRICT_UNRESOLVED_METHOD (/private/tmp/strict-demo/index.js:3) Cannot resolve method call: user.processData
```

These say the same thing. Pick one format and stick with it. I prefer the second (more structured).

### 2. Generic Suggestions
```
Suggestion: Check if class "user" is imported and has method "processData"
```

In this case, `user` is NOT a class - it's the return value of `getUser()`. The suggestion is misleading.

Better suggestions would be:
- "getUser() return type is unknown. Add type annotations or JSDoc to resolve."
- "Cannot trace user object. Try adding /** @returns {{processData: function}} */ to getUser()"
- "This call depends on runtime data. Consider adding explicit type information."

### 3. Missing Context
The error tells me WHAT failed, but not WHY this matters or HOW to fix it.

Questions I have after seeing this error:
- Is this a bug in my code, or a limitation in Grafema's analysis?
- Should I add type annotations? If so, where and how?
- Can I whitelist this specific call if I know it's correct?
- What does "cannot resolve" mean? Unknown function? Unknown method? Unknown return type?

### 4. No Workflow Guidance
Error says "Run with --debug for detailed diagnostics" - but then what?

Ideal flow would be:
1. `grafema analyze --strict` fails
2. Error message shows exactly what to add/change
3. User makes change
4. `grafema analyze --strict` succeeds

Current flow:
1. `grafema analyze --strict` fails
2. User confused
3. User runs `--debug` (unclear what to do with output)
4. User gives up on strict mode

---

## What Needs to Change Before I'd Demo This

### Critical (must fix):
1. **Deduplicate error messages** - one clear, structured error per issue
2. **Context-aware suggestions** - analyze WHY resolution failed and suggest specific fix
3. **Show the chain** - if user.processData fails because getUser() return is unknown, say that
4. **Add escape hatch** - allow users to suppress specific errors (e.g., `// grafema-ignore-next-line`)

### Important (should fix):
1. **Better error codes** - STRICT_UNRESOLVED_METHOD is good, but add subcodes:
   - STRICT_UNKNOWN_RETURN_TYPE
   - STRICT_MISSING_IMPORT
   - STRICT_EXTERNAL_DEPENDENCY
2. **Link to docs** - error message should link to grafema.dev/docs/strict-mode or similar
3. **Progressive disclosure** - default error is brief, add `--verbose` for full trace
4. **Batch errors** - if there are 10 unresolved calls, show all 10, not just the first

### Nice to have:
1. **Auto-fix suggestions** - generate JSDoc comments that would satisfy strict mode
2. **Compare mode** - `grafema analyze --strict --compare` shows diff of what would break
3. **Gradual adoption** - `grafema analyze --strict=warn` fails on errors but warns on method calls

---

## Performance Notes

- Analysis without strict: 0.27s
- Analysis with strict: ~0.44s (failed partway through enrichment)
- RFDB server startup: ~1-2s (first run only)

Performance is acceptable. No concerns here.

---

## The Bigger Question: What is Strict Mode FOR?

After testing, I'm not sure who this feature is for:

**Is it for users debugging their code?**
- If so, the error messages need to be WAY more helpful
- Current errors feel like compiler errors, not user-friendly diagnostics

**Is it for Grafema developers debugging the tool?**
- If so, why is it a CLI flag? Should be internal only
- The error "Fatal error in MethodCallResolver" sounds like a Grafema bug, not a user issue

**Is it for CI/CD to enforce code quality?**
- If so, need better control (fail on errors, warn on method calls, ignore external deps)
- Need .grafemaignore or similar to suppress false positives

**My recommendation:** Pick ONE primary use case and optimize for that.

My guess: this is for Grafema developers to find product gaps (things that should resolve but don't). If so:
1. Rename to `--fail-fast` or `--dev-mode`
2. Add clear message: "This mode is for Grafema development. It reveals analysis gaps."
3. Include a "Report this issue" button that pre-fills a GitHub issue

---

## Final Verdict

**Concept:** A+ (strict mode is exactly what we need to find product gaps)
**Execution:** C+ (works but feels unfinished)
**UX:** C (confusing errors, unclear purpose, no guidance)
**Performance:** A (fast enough)

**Would I demo this on stage?** No. Not because it's broken, but because I can't explain what it's FOR in a way that makes users excited.

---

## Next Steps

Before marking this task done:
1. **Clarify the purpose** - who is this for and why do they care?
2. **Improve error messages** - context-aware, actionable, not duplicated
3. **Add documentation** - what is strict mode, when to use it, how to fix errors
4. **Test edge cases** - what happens with 100 errors? External dependencies? Type annotations?

Once those are done, I'll happily demo this. The bones are good - we just need to make it delightful.

---

**Demo status:** ❌ Not ready for public demo
**Recommendation:** Fix critical UX issues, then re-demo
