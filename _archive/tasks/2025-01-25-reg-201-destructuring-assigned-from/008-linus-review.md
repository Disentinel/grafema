# Linus Torvalds — Implementation Review for REG-201

## Verdict: NEEDS REVISION

## Summary

Tests pass but the implementation is fundamentally incomplete. We created ASSIGNED_FROM edges to EXPRESSION nodes (good), but we're missing DERIVES_FROM edges from those EXPRESSION nodes to the source variables (bad). This isn't a nitpick - it's a data integrity bug that breaks graph traversal.

The root cause: we introduced a new field `baseName` but GraphBuilder still only checks for `objectSourceName` to create DERIVES_FROM edges. The tests don't catch this because they never check for DERIVES_FROM edges.

## Critical Issues

### 1. Missing DERIVES_FROM Edges (BLOCKER)

**What's wrong:**
- JSASTAnalyzer.trackDestructuringAssignment() sets `baseName: sourceBaseName` (line 894, 925)
- VariableVisitor does the same (line 274)
- GraphBuilder.bufferAssignmentEdges() extracts `baseName` (line 848) but never uses it
- GraphBuilder only creates DERIVES_FROM when `objectSourceName` is present (line 886)
- Since we never set `objectSourceName`, DERIVES_FROM edges are never created

**Why this matters:**
```javascript
const { headers } = req;
```

Current implementation creates:
- `headers ASSIGNED_FROM EXPRESSION(req.headers)` ✓

But MISSING:
- `EXPRESSION(req.headers) DERIVES_FROM req` ✗

**Impact:**
Graph traversal queries will fail. If you query "what variables does this expression depend on?", you get nothing. Value domain analysis needs DERIVES_FROM to trace values back through the graph.

**The fix:**
In GraphBuilder.ts line 886, change:
```typescript
if (expressionType === 'MemberExpression' && objectSourceName) {
```
To:
```typescript
if (expressionType === 'MemberExpression' && (objectSourceName || baseName)) {
  const sourceName = objectSourceName || baseName;
```

### 2. Tests Don't Verify Data Integrity (BLOCKER)

**What's wrong:**
DestructuringDataFlow.test.js checks for:
- ASSIGNED_FROM edges ✓
- EXPRESSION node structure ✓

But never checks for:
- DERIVES_FROM edges ✗

**Why this matters:**
Expression.test.js (line ~120) explicitly tests DERIVES_FROM for `obj.method`. Destructuring should have the same guarantee. We shipped incomplete graph data because tests don't verify completeness.

**The fix:**
Add DERIVES_FROM assertions to every destructuring test. Example:
```javascript
// After checking ASSIGNED_FROM edge
const derivesEdges = await backend.getOutgoingEdges(target.id, ['DERIVES_FROM']);
assert.strictEqual(derivesEdges.length, 1, 'EXPRESSION should DERIVE_FROM source variable');
const sourceVar = await backend.getNode(derivesEdges[0].dst);
assert.strictEqual(sourceVar.name, 'req', 'Should derive from req');
```

### 3. Inconsistent Field Naming (MINOR but confusing)

**What's wrong:**
- Regular MemberExpression tracking uses `objectSourceName`
- Destructuring tracking uses `baseName`
- Both represent the same concept: "the variable that this expression reads from"

**Why this matters:**
GraphBuilder now has to check both fields. Code smell. We're building technical debt.

**Better approach:**
Just set `objectSourceName` in trackDestructuringAssignment() instead of `baseName`. Match existing patterns. Don't invent new field names for the same concept.

## Did We Achieve the Goal?

**User request:** "Trace destructured variables back to their source"

**What we delivered:**
- ✓ Can trace variable → EXPRESSION node
- ✗ Cannot trace EXPRESSION node → source variable
- ✗ Graph integrity incomplete

**Answer:** NO. We're 80% there but the missing DERIVES_FROM edges make this unusable for actual queries.

## Alignment with Project Vision

"AI should query the graph, not read code."

If an AI asks "where does `headers` come from?", it gets:
1. `headers → ASSIGNED_FROM → EXPRESSION(req.headers)` ✓
2. `EXPRESSION(req.headers) → DERIVES_FROM → ???` **DEAD END** ✗

The AI has to give up or read source code. That's exactly what we're trying to avoid.

This isn't about perfectionism. It's about basic graph completeness. If DERIVES_FROM exists for `const x = obj.prop`, it MUST exist for `const { prop } = obj`. Same data, same edges.

## Other Observations

**Good things:**
1. VariableVisitor was cleaned up - removed duplicate EXPRESSION node creation (line 218-280)
2. Both call sites (handleVariableDeclaration, processBlockVariables) were updated consistently
3. Phase 1 limitation (simple Identifier only) is clearly documented and reasonable
4. Code matches existing patterns in structure

**Concerns:**
1. VariableVisitor has `isRest?: boolean` in VariableInfo (line 11) but it's not in ExtractedVariable interface. Type safety gap?
2. Mixed use of `propertyPath[propertyPath.length - 1]` (line 891) vs `propertyPath[0]` (VariableVisitor line 256) - which is correct?
3. No console.warn in trackDestructuringAssignment when skipping complex init, but VariableVisitor does skip silently. Inconsistent.

## Recommendation

**DO NOT SHIP.**

Fix the DERIVES_FROM bug and add proper test coverage. This should take 15 minutes:

1. Add `|| baseName` to GraphBuilder line 886 check
2. Add DERIVES_FROM assertions to all 9 destructuring tests
3. Run tests, verify all pass
4. THEN ship

Alternatively (cleaner):
1. Change trackDestructuringAssignment to use `objectSourceName` instead of `baseName`
2. Remove `baseName` field entirely - don't need it
3. Add DERIVES_FROM test assertions
4. Ship

We did 80% of the work correctly. Don't ruin it by shipping incomplete graph data.

## To Don

After Rob fixes DERIVES_FROM:
- Review again whether `baseName` field serves any purpose, or if we should just use `objectSourceName`
- Check if we need both `property` and `propertyPath` fields, or if one is redundant
- Consider adding a graph integrity test: "every EXPRESSION node with type=MemberExpression MUST have exactly one DERIVES_FROM edge (except for literals)"

This was close. Really close. But incomplete graph data is worse than no data - it makes queries fail silently.
