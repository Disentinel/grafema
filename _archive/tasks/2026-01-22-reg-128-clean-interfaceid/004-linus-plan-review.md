# Linus Torvalds - Plan Review for REG-128

## Verdict: APPROVED with one correction

The plan is correct. Don's analysis is spot-on: the ID computations are either dead code or work by coincidence. This needs to be cleaned up.

---

## Answers to Key Questions

### 1. Is marking `id` as deprecated (but keeping it) the right approach?

**Yes, but only temporarily.**

Keeping the field as optional prevents breaking changes if anything external reads these Info types. The implementation should NOT set the `id` field at all in Phase 1 (just remove the computation AND the assignment).

### 2. Is computing the ID inline in `bufferImplementsEdges()` the right approach?

**No. This is wrong.**

Joel's plan duplicates the ID formula. This violates DRY. The formula already exists in `InterfaceNode.create()`.

**Correct approach:** Either:
- Add a static `InterfaceNode.buildId(file, name, line)` method to the factory
- Or at minimum, add a comment noting this is tech debt

For this scope: inline computation is acceptable as a transitional step, but it should be documented.

### 3. Do we really need a new test for IMPLEMENTS edges?

**Yes, absolutely.** Zero existing tests for IMPLEMENTS edges. TDD requires test coverage before changing code.

---

## Summary

1. The analysis is correct
2. The scope is right (cleaning up all three: interfaceId, typeId, enumId)
3. The implementation order is correct (test first)
4. One issue: document the ID formula duplication as tech debt

**Approved for implementation.**
