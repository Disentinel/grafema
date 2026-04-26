# Вадим Решетников - High-Level Review: REG-332 Improve Strict Mode Error UX

**Date:** 2026-02-05
**Status:** APPROVED WITH CONDITIONS
**Reviewed:** Joel's technical spec `_tasks/REG-332/003-joel-tech-plan.md`

---

## Executive Summary

**APPROVED** with minor conditions.

This is a solid UX improvement that directly addresses Steve's demo feedback. The plan is architecturally sound, uses existing abstractions correctly, and avoids the common pitfalls.

However, I have some concerns about scope creep and implementation order that need addressing.

---

## Complexity & Architecture Checklist

### ✅ Complexity Check: PASSED

- **Phase 1 (Deduplicate):** O(n) over diagnostics - GOOD (n is small, typically < 10)
- **Phase 2 (Chain):** O(c) where c = chain length - GOOD (c typically < 10)
- **Phase 3 (Suggestions):** O(1) switch statement + O(k) for failure analysis (k < 5) - GOOD
- **Phase 4 (grafema-ignore):** O(c) per node for comment parsing (c = 0-3) - GOOD

No iteration over all graph nodes. All work is done during existing passes. This is exactly right.

### ✅ Plugin Architecture: PASSED

- **Phase 1-3:** Works with existing error/diagnostic infrastructure
- **Phase 4:** Extends INDEXING phase (comment parsing) + ENRICHMENT phase (check ignore flag)
- No new enricher required - extends existing MethodCallResolver
- Forward registration: analyzer marks nodes with grafema-ignore metadata

This follows the Grafema pattern correctly.

### ✅ Extensibility: PASSED

Adding new error codes or failure reasons requires:
- Only updating enum/types in GrafemaError.ts
- Adding new case in switch statement
- No enricher changes

Good abstraction level.

---

## Vision Alignment

**Question:** Does this move us toward "AI queries graph, not code"?

**Answer:** YES, indirectly.

Strict mode exists to reveal product gaps - places where Grafema SHOULD resolve references but doesn't. Better error UX means users:
1. Understand WHY Grafema couldn't resolve (not just THAT it couldn't)
2. Can add type information to help Grafema
3. Can suppress false positives without abandoning strict mode

This keeps users engaged with strict mode rather than disabling it entirely. More users using strict mode = more feedback on what Grafema needs to improve.

**Alignment score: 8/10**

---

## Architectural Soundness

### ✅ StrictModeFailure Error Class

Good separation of concerns. The error carries diagnostics without duplicating the message. CLI formats output from diagnostics, not from `error.message`.

This is the right abstraction. No concerns.

### ✅ Resolution Chain Infrastructure

Adding `resolutionChain` and `failureReason` to `ErrorContext` is clean. These fields are optional, so backward compatibility is maintained.

The chain is built during resolution (not by separate traversal), so performance impact is minimal.

### ✅ Context-Aware Suggestions

The `analyzeResolutionFailure()` function looks reasonable. It uses existing indexes (classMethodIndex, variableTypes) rather than traversing the graph.

The suggestion generation is straightforward - switch statement based on failure reason.

### ⚠️ grafema-ignore Comment Parsing

This is the riskiest part. Comment parsing has edge cases:
- Multi-line comments
- Block comments vs line comments
- Comments with special characters
- Multiple ignore directives

**Condition 1:** Phase 4 must include comprehensive tests for comment parsing edge cases. See test spec requirements below.

---

## Concerns & Conditions

### Concern 1: Implementation Order

Joel proposes:
1. Deduplicate
2. Show chain
3. Context-aware
4. grafema-ignore (parallel)

**My concern:** Phase 4 (grafema-ignore) is marked as "can be parallel" but it touches INDEXING phase. This could cause merge conflicts if other work is happening in JSASTAnalyzer.

**Condition 2:** Phase 4 should NOT be parallelized unless you're certain no other work is touching JSASTAnalyzer. Otherwise, do it sequentially after Phase 3.

### Concern 2: Scope Creep Risk

Joel mentions "nice-to-have" improvements:
- Better error subcodes
- Link to documentation
- Progressive disclosure

**Condition 3:** These are OUT OF SCOPE for this task. If you start implementing them during this task, I will REJECT.

Stick to the 4 critical issues from Steve's demo. Everything else goes to backlog.

### Concern 3: Test Coverage

The test specifications are good, but I want to ensure they're comprehensive.

**Condition 4:** Tests MUST cover:
- Multi-line `grafema-ignore` comments
- Block comments: `/* grafema-ignore STRICT_UNRESOLVED_METHOD */`
- Invalid formats: `// grafema-skip`, `// grafema-ignore` (missing code)
- Multiple comments on same node (which one takes precedence?)
- Comments with special characters in reason field

---

## What I Like

1. **No new enricher** - extends existing MethodCallResolver. This is correct.
2. **No additional graph iterations** - uses existing indexes. This is critical.
3. **Forward registration** - analyzer marks nodes with grafema-ignore metadata. This is the Grafema way.
4. **Clean abstractions** - StrictModeFailure, ResolutionStep, ResolutionFailureReason are all well-defined.
5. **Complexity analysis** - Joel included Big-O for each phase. This is excellent.

---

## What Could Be Better

### Better: Comment Parsing Implementation

The proposed `getGrafemaIgnore()` function checks `leadingComments` but doesn't specify:
- Does it check the LAST comment only?
- Does it check ALL comments and take the first match?
- What happens if there are multiple grafema-ignore directives?

**Recommendation:** Check LAST comment first (closest to node). If multiple directives, last one wins.

### Better: Error Message Format

The proposed format is:
```
STRICT_UNRESOLVED_METHOD /tmp/test.js:3

  Cannot resolve method call: user.processData

  Resolution chain:
    ...

  Suggestion: ...
```

This is good, but consider adding:
- **Context line:** Show the actual code line where the error occurred

Example:
```
STRICT_UNRESOLVED_METHOD /tmp/test.js:3

  3 | user.processData();
      ^^^^

  Cannot resolve method call: user.processData
  ...
```

**Optional:** This is NOT a condition for approval. If it's easy to add, do it. If not, defer to v0.2.

---

## Approval Conditions

**APPROVED IF:**

1. ✅ Phase 4 includes comprehensive comment parsing tests (see Concern 3)
2. ✅ Phase 4 is NOT parallelized if other work touches JSASTAnalyzer
3. ✅ Nice-to-have improvements are OUT OF SCOPE (defer to backlog)
4. ✅ Tests cover edge cases listed in Condition 4

**If any condition is not met → REJECT and escalate to me.**

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Comment parsing edge cases | Medium | High | Comprehensive tests (Condition 4) |
| Merge conflicts in JSASTAnalyzer | Low | Medium | Sequential implementation (Condition 2) |
| Scope creep to nice-to-haves | Medium | Low | Strict scope enforcement (Condition 3) |
| Backward compatibility break | Low | High | Test imports in CLI package |

---

## Questions for Implementation Team

1. **For Kent:** Do the test specs in Joel's plan cover all edge cases? Add tests for block comments `/* */` in addition to line comments `//`.

2. **For Rob:** When implementing `getGrafemaIgnore()`, clarify precedence rules if multiple comments exist. I recommend: last comment wins (closest to node).

3. **For Don:** After Phase 1 completes, verify visually that error output is actually deduplicated. This is critical - if users still see duplication, the feature fails.

---

## Final Verdict

**APPROVED WITH CONDITIONS**

This is good work. Joel's spec is thorough, includes complexity analysis, and uses existing abstractions correctly.

The conditions are minor and mostly about test coverage + scope discipline. If the team follows the spec and meets the conditions, this will be a solid UX improvement.

---

## Next Steps

1. Kent writes tests per Joel's spec + edge cases from Condition 4
2. Rob implements per spec (phases 1→2→3→4 sequentially, no parallelization unless confirmed safe)
3. Don reviews after EACH phase - not just at the end
4. Steve demos after all phases complete

**Reminder:** Task reports must be committed to main when merging. Don't forget to copy from worker worktree.

---

**Signature:** Вадим Решетников
**Date:** 2026-02-05
**Verdict:** APPROVED WITH CONDITIONS
