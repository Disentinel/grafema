# Linus Torvalds - Plan Review for REG-131

## Status: NOT APPROVED

---

## Executive Summary

The plan is a good start but **incomplete**. Don and Joel correctly identified the core problem and the pattern to follow. However, they missed several critical locations that generate legacy IDs, and the original request explicitly mentioned files that aren't in the plan.

---

## What's Good

1. **Root cause correctly identified** - The half-done migration is the real problem
2. **Pattern to follow is correct** - FunctionVisitor shows the right approach
3. **TDD approach is appropriate** - Tests first is the right way
4. **ClassVisitor analysis is accurate** - Lines 246, 307 are correct

---

## Critical Issues (BLOCKING)

### Issue 1: Missing Worker Files

The original request EXPLICITLY mentioned:
> "Possibly: AnalysisWorker.ts, QueueWorker.ts, ASTWorker.ts"

Neither Don nor Joel investigated these files.

**Verdict:** Must investigate and include in scope, or document why excluded.

### Issue 2: CallExpressionVisitor Dependency

`CallExpressionVisitor.ts` may have methods that generate IDs to match FunctionVisitor output. If FunctionVisitor now uses semantic IDs but CallExpressionVisitor generates legacy format, edge relationships will break.

**Verdict:** Must verify CallExpressionVisitor doesn't need changes.

### Issue 3: EXPRESSION Nodes Not Addressed

The original request explicitly mentions:
> "EXPRESSION nodes (currently use colon format `/path:EXPRESSION:MemberExpression:2:44`)"

The acceptance criteria says:
> "EXPRESSION nodes have consistent format (or documented exception)"

**Verdict:** Either include EXPRESSION nodes in scope or explicitly document why they're excluded.

---

## Medium Issues

### Issue 4: Test Plan Tests the Wrong Thing

The proposed tests verify that `computeSemanticId()` produces the right format. But `computeSemanticId()` isn't changing! The tests should verify that **ClassVisitor output** uses semantic IDs.

We need integration tests:
```javascript
it('ClassVisitor should produce semantic IDs for class methods', async () => {
  const result = await analyzer.analyzeFile('class Foo { bar() {} }');
  const method = result.functions.find(f => f.name === 'bar');
  assert.ok(method.id.includes('->'), 'ID should use semantic format');
  assert.ok(!method.id.startsWith('FUNCTION#'), 'ID should not use legacy format');
});
```

**Verdict:** Add integration tests that verify visitor output, not just unit tests for the utility.

### Issue 5: Breaking Change Not Handled

Removing `semanticId` field from `ClassFunctionInfo` is a breaking change for any code that reads this field. Did we grep for usages?

**Verdict:** Grep for `semanticId` usage before removing the field.

---

## Questions Not Answered

1. **Why keep fallback to legacy IDs?** If scopeTracker is always available in these contexts, why have a fallback at all? Fallbacks hide bugs.

2. **What happens to existing graphs?** If someone has an existing graph with legacy IDs and re-analyzes, do edges break?

3. **Are there tests asserting on legacy format?** Did we actually grep for `FUNCTION#` in test files?

---

## Before Implementation Can Proceed

1. **Investigate worker files** - AnalysisWorker.ts, QueueWorker.ts, ASTWorker.ts
2. **Check CallExpressionVisitor** - Does it generate matching IDs?
3. **Address EXPRESSION nodes** - Include or document exclusion
4. **Add integration tests** - Test visitor output, not just utility function
5. **Grep for semanticId usage** - Before removing the field
6. **Check for FUNCTION# in tests** - Verify no tests break

---

## Verdict

**NOT APPROVED**

The plan is 70% complete. Go back and investigate the missing files. Either include them in scope or document why they're excluded. Then we can proceed.

The core approach is correct. We just need to make sure we're doing the COMPLETE job, not a partial fix that leaves the codebase in an even more inconsistent state.
