# Steve Jobs - Product Design Review: REG-332 Improve Strict Mode Error UX

**Date:** 2026-02-05
**Status:** APPROVED WITH CONDITIONS
**Reviewers:** Steve Jobs

---

## Executive Summary

**APPROVED WITH CONDITIONS.**

This plan addresses the four critical UX issues I identified in my demo review of REG-330. The core approach is sound, but there are execution details that need tightening before implementation.

The good news: This will transform strict mode from a "debugging tool with cryptic internals" into a "conversational assistant that helps you fix your code." That's the right direction.

The concerns: Some complexity in Phase 3 and Phase 4 could be simplified. I'm also worried about the escape hatch becoming an excuse to ignore real problems.

---

## What I Love About This Plan

### 1. Single Structured Output (Phase 1)

**Perfect.** The duplication was embarrassing - like a broken record. The new approach is clean:

```
STRICT_UNRESOLVED_METHOD /tmp/test.js:3

  Cannot resolve method call: user.processData

  Suggestion: Add JSDoc to getUser() or check if class is imported.

  Run without --strict for graceful degradation.
```

One message. Clear location. Actionable suggestion. Escape route. This is how you talk to users.

### 2. Show the Chain (Phase 2)

**Brilliant.** This is the Elm compiler approach - show the whole deduction path, not just the failure:

```
Resolution chain:
  getUser() return -> unknown (not declared)
  user variable -> inherits unknown type
  user.processData -> FAILED (no type information)
```

This teaches users how Grafema thinks. It's not magic - it's following the code, and now you can see where it lost the trail.

### 3. Prior Art Research

Don did the homework. The references to Elm's "compiler errors for humans" and Rust's structured errors are exactly right. We're not inventing something new - we're bringing best practices to graph analysis.

That's smart product design.

---

## Concerns & Conditions for Approval

### Concern 1: Complexity Creep in Phase 3

**Issue:** The `analyzeResolutionFailure` function (lines 597-657 in Joel's spec) is doing a lot:

- Checking class indexes
- Checking local scope
- Building resolution chains
- Determining failure reasons

**Question:** Are we duplicating logic that already exists in the resolver?

**Condition:** Before implementing Phase 3, Rob must verify that `analyzeResolutionFailure` reuses existing resolution logic rather than reimplementing it. If the resolver already tries these lookups, we should capture that information during the FIRST pass, not run a second "analysis" pass.

**Why this matters:** If we're running the same lookups twice (once to resolve, once to analyze failure), that's wasteful. The resolution attempt should ALREADY be collecting this data.

### Concern 2: grafema-ignore as a Crutch

**Issue:** The escape hatch (Phase 4) is necessary, but it's dangerous. Users might suppress errors instead of fixing them.

**Example of abuse:**
```javascript
// grafema-ignore-next-line STRICT_UNRESOLVED_METHOD
user.processData();  // I don't know what this returns, but ship it!
```

**Condition:** The plan requires specifying the error code (good), but we should also REPORT suppressions at the end:

```
✓ Analysis passed

Suppressions:
  1 error suppressed by grafema-ignore comments
  Run without suppressions: grafema analyze --no-respect-ignores
```

This keeps users honest. If you're suppressing 50 errors, that's a code smell.

**Action Required:** Add suppression summary to the CLI output spec. Joel should update Phase 4 to track and report suppression count.

### Concern 3: Comment Parsing Fragility

**Issue:** Phase 4a adds comment parsing to `JSASTAnalyzer`. Comments are notoriously fragile in AST parsing.

**Risk:** What if Babel doesn't attach `leadingComments` in all cases? What if the comment is separated by a blank line?

```javascript
// grafema-ignore-next-line STRICT_UNRESOLVED_METHOD

user.processData();  // Does this still work with blank line?
```

**Condition:** Kent's tests MUST include edge cases:
- Comment separated by blank line
- Comment inside a block
- Multi-line comment syntax
- Comment on same line as code

If any of these fail silently (comment not detected), that's a UX disaster. Better to error loudly than suppress silently.

### Concern 4: Progressive Disclosure Deferred

**Issue:** Joel's spec mentions "progressive disclosure" (brief default, `--verbose` for full chain) but marks it as nice-to-have.

**Strong recommendation:** Do this NOW, not later. Here's why:

**Default output:**
```
STRICT_UNRESOLVED_METHOD /tmp/test.js:3

  Cannot resolve method call: user.processData

  Suggestion: Add JSDoc to getUser()
```

**With --verbose:**
```
STRICT_UNRESOLVED_METHOD /tmp/test.js:3

  Cannot resolve method call: user.processData

  Resolution chain:
    getUser() return -> unknown (not declared)
    user variable -> inherits unknown type
    user.processData -> FAILED (no type information)

  Suggestion: Add JSDoc to getUser() at line 1.
```

Most users don't need the chain. But when they DO need it (debugging complex aliases), it's invaluable.

**Condition:** Add progressive disclosure to Phase 2. It's a 1-hour addition that doubles the usability.

---

## Complexity & Architecture Review

**Mandatory Checklist:**

### 1. Complexity Check

**Phase 1 (Deduplicate):**
- O(n) where n = number of diagnostics
- ✓ PASS - Small set, no graph iteration

**Phase 2 (Show Chain):**
- O(c) where c = chain length (< 10 typically)
- ✓ PASS - Chain built during resolution, not additional traversal

**Phase 3 (Context-Aware):**
- O(k) where k = number of lookups (< 5)
- ⚠️ CAUTION - Verify no duplication with existing resolution logic (see Concern 1)

**Phase 4 (grafema-ignore):**
- O(c) where c = number of comments per node (0-3)
- ✓ PASS - Metadata annotation, no graph iteration

**Overall:** No red flags. All phases are O(small constant) operations.

### 2. Plugin Architecture

**Does it use existing abstractions?**

✓ YES - Extends existing error reporting (DiagnosticReporter)
✓ YES - Uses existing metadata system for ignore annotations
✓ YES - Context-aware suggestions use existing failure detection

**Does it scan backward?**

✓ NO - grafema-ignore is forward registration (parser marks nodes)
✓ NO - Resolution chain is built during resolution, not post-hoc

**Extensibility:**

✓ GOOD - Adding new error codes (subcodes) is trivial
✓ GOOD - Adding new suppression types follows same pattern
✓ GOOD - Other enrichers can use same chain/suggestion infrastructure

---

## Vision Alignment Check

**"AI should query the graph, not read code."**

Does this plan move us toward that vision?

**YES.** Here's why:

1. **Better errors → more engagement:** Users won't abandon strict mode if errors are helpful. They'll fix the issues instead of disabling the feature.

2. **Resolution chain teaches the graph:** When users see the chain, they understand how Grafema follows references. This builds mental models.

3. **Context-aware suggestions guide improvement:** Instead of "this failed," we're saying "this failed BECAUSE X, fix it with Y." That's assistant-level UX.

4. **Escape hatch prevents abandonment:** Some false positives are inevitable. Rather than making users disable strict mode entirely, let them suppress specific cases. They stay in the ecosystem.

**Verdict:** This is product-gap fixing, not feature creep. Ship it.

---

## Conditions Summary

Before implementation begins:

1. **Phase 3:** Rob verifies no duplication with existing resolution logic. Capture failure context during FIRST pass, not second analysis pass.

2. **Phase 4:** Add suppression summary to CLI output. Joel updates spec.

3. **Phase 4:** Kent includes edge-case tests for comment parsing (blank lines, blocks, multi-line).

4. **Phase 2:** Add progressive disclosure (default brief, `--verbose` for chain). Joel updates spec.

---

## Questions for Vadim's Review

I'm approving this, but I'd like Vadim to weigh in on:

1. **grafema-ignore naming:** Is `grafema-ignore` the right name? It's clear, but verbose. Could we do `@grafema-skip` or similar?

2. **Suppression reporting:** My suggestion to report suppression count at the end - does this align with Grafema's diagnostic philosophy?

3. **Chain verbosity:** My push for progressive disclosure by default - is this overkill, or is it the right call?

Vadim, you have the final say on these UX details.

---

## Demo Expectations

When Rob finishes implementation, the demo should show:

1. **Before/After comparison:** Same code, old vs new error output
2. **Chain visualization:** Error with full resolution chain
3. **Context-aware suggestion:** Show how suggestion changes based on failure reason
4. **grafema-ignore in action:** Suppress an error, show it doesn't appear
5. **Suppression summary:** Show "N suppressions" at the end

If those 5 things work beautifully, this ships.

---

## Final Verdict

**APPROVED WITH CONDITIONS.**

This plan transforms strict mode from "frustrating debug tool" into "helpful coding assistant." That's the bar.

Don and Joel nailed the vision. Now execution is everything.

Rob, when you implement this, remember: Every error message is a conversation with the user. Make it a conversation worth having.

---

**Steve Jobs**
*Product Design / Demo*
