# Linus Torvalds - Plan Review: REG-205

## Verdict: APPROVED

## Assessment

This is exactly the kind of fix I like to see:

1. **Right problem identified**: Don nailed it. Legacy ID format hardcoded in one spot during incomplete migration to semantic IDs. Not a symptom, the actual bug.

2. **Surgical fix**: Joel's plan is minimal and precise:
   - One import
   - One line changed
   - No refactoring, no "improvements", no scope creep

3. **Test strategy is smart**: Add NEW test for semantic IDs, keep old tests for backward compat. This is TDD done right - we're not rewriting history, we're adding a regression guard.

4. **Analysis depth is appropriate**: Joel checked InstanceOfResolver, confirmed no changes needed. That's the kind of due diligence that prevents "fixed one bug, created two new ones" situations.

## Why This Is Good

- **Fixes from the root**: Not a workaround. Changes the ID generation to match what CLASS nodes actually use.
- **Low risk**: Isolated change, existing tests validate we don't break anything, new test validates the fix.
- **No migration needed**: Old edges were broken anyway. This is a bug fix, not a format change.
- **Aligns with vision**: Semantic IDs everywhere. This completes the migration Don referenced from task 2025-01-22.

## What I Like About Joel's Plan

- Clear edge case analysis (nested scopes, cross-file, same-file)
- "What NOT to do" section - prevents implementation drift
- Realistic effort estimate (40 min)
- No hand-waving about "just do semantic IDs" - specific function call, specific parameters

## What Could Go Wrong (Low probability)

1. **InstanceOfResolver assumption**: Joel says it's fine because it uses `node.id` from actual CLASS nodes. I trust the analysis but Kent should verify this in tests. If cross-file instantiation breaks, we'll know immediately.

2. **Nested scope classes**: The fix assumes `scopePath: []` (global scope). For nested classes, edge will still be dangling. Joel acknowledges this is existing behavior and out of scope. **That's correct** - don't solve problems you weren't asked to solve.

3. **Test might not catch everything**: The new test covers external classes and same-file classes. It doesn't explicitly test cross-file with imports. That path depends on InstanceOfResolver working correctly. If we want paranoia-level coverage, add a third test case with imports. **Not required** but nice-to-have.

## Recommendations

None required. This is good to go.

**Optional enhancement** (discuss with user, don't just do it):
- After this lands, consider adding a test for cross-file class instantiation with imports to validate InstanceOfResolver integration. But that's a separate concern, not blocking this fix.

## Sign-off

Execute the plan. Kent writes the test first, Rob makes the two-line fix, Kevlin reviews code quality, I'll review the result.

Let's ship it.
