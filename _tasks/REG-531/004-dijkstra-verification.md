# Dijkstra Plan Verification: REG-531

**Verifier:** Edsger Dijkstra
**Date:** 2026-02-20
**Verdict:** REJECT

## Executive Summary

Don's plan relies on **containment-based matching** as Phase 1, with a +100 type bonus as Phase 2. However, this approach has a **fatal flaw**: CALL nodes do NOT have `endLine`/`endColumn` in their metadata, so Phase 1 (containment) will NEVER match CALL nodes. The algorithm degenerates to proximity-based matching with a +100 bonus.

## Critical Precondition Violation

### Claim from Don's Plan (line 28-29)
> "CALL nodes don't populate endLine/endColumn:
> - `CallExpressionVisitor.ts` line 319-320: only calls `getLine(callNode)` and `getColumn(callNode)` (start only)"

### Verification Result: CONFIRMED

**Evidence from analyzer code:**

1. **Method calls** (`JSASTAnalyzer.ts` lines 2960-2978):
```typescript
methodCalls.push({
  id: methodCallId,
  type: 'CALL',
  name: fullName,
  object: objectName,
  method: methodName,
  file: module.file,
  line: getLine(callNode),        // START position only
  column: getColumn(callNode),    // START position only
  parentScopeId,
  // ... other fields, but NO endLine or endColumn
});
```

2. **Function calls** (`JSASTAnalyzer.ts` lines 2917-2931):
```typescript
callSites.push({
  id: callId,
  type: 'CALL',
  name: calleeName,
  file: module.file,
  line: getLine(callNode),        // START position only
  column: getColumn(callNode),    // START position only
  parentScopeId,
  // ... other fields, but NO endLine or endColumn
});
```

3. **PROPERTY_ACCESS nodes** (`ast/types.ts` lines 246-258):
```typescript
export interface PropertyAccessInfo {
  id: string;
  type: 'PROPERTY_ACCESS';
  objectName: string;
  propertyName: string;
  file: string;
  line: number;            // START position only
  column: number;          // START position only
  parentScopeId?: string;
  // NO endLine or endColumn
}
```

**Conclusion:** BOTH CALL and PROPERTY_ACCESS nodes have ONLY `line` and `column` (start position). Neither has end position data.

## What This Means for Don's Algorithm

Don's plan has two phases:

### Phase 1: Containment-based matching (lines 50-72 in plan)
```typescript
if (endLine !== undefined && endColumn !== undefined) {
  // Check if cursor is within [start, end] range
  // Compute specificity based on span size
}
```

**Result for CALL nodes:** This branch is NEVER executed because `endColumn === undefined`.

**Result for PROPERTY_ACCESS nodes:** This branch is NEVER executed because `endColumn === undefined`.

**Actual behavior:** BOTH node types fall through to the fallback (Phase 1b):

### Phase 1b: Fallback proximity matching (lines 68-72 in plan)
```typescript
else if (line === cursor.line) {
  // Fallback to proximity-based (current behavior)
  specificity = 1000 - Math.abs(column - cursor.column);
}
```

### Phase 2: Type precedence tiebreaker (lines 75-82 in plan)
```typescript
if (nodeType === 'CALL' && specificity > 0) {
  specificity += 100;  // CALL nodes preferred
}
```

**So the actual algorithm becomes:**
```
specificity = (1000 - |nodeColumn - cursorColumn|) + (nodeType === 'CALL' ? 100 : 0)
```

## Input Universe Enumeration

All possible node type combinations on a single line in real code:

| Input Pattern | Node Types Present | Example |
|---------------|-------------------|---------|
| Chained call | CALL + PROPERTY_ACCESS | `this.discoveryManager.buildIndexingUnits()` |
| Direct call | CALL only | `this.method()` |
| Multiple calls | CALL + CALL | `foo(); bar();` |
| Nested calls | CALL + CALL | `outer(inner())` |
| Property without call | PROPERTY_ACCESS only | `const x = obj.prop;` |
| Variable + call | VARIABLE + CALL | `const result = this.method();` |
| Function + call | FUNCTION + CALL | `function foo() { bar(); }` |
| Literal + call | LITERAL + CALL | `"string".toUpperCase()` |

**Note:** VARIABLE, FUNCTION, LITERAL nodes are irrelevant because they have different line numbers (declaration vs usage). The bug report specifically concerns **same-line conflicts** between CALL and PROPERTY_ACCESS.

## Completeness Table for Chained Call Bug

**Scenario:** `this.discoveryManager.buildIndexingUnits()`
- CALL node: `this.discoveryManager.buildIndexingUnits`, column 0 (start of expression)
- PROPERTY_ACCESS node: `discoveryManager`, column 5 (start of identifier)
- Cursor positions to test: columns 0, 5, 10, 25, 40

| Cursor Column | Node | Node Column | Distance | Base Specificity | Type Bonus | Final Specificity | Winner | Correct? |
|---------------|------|-------------|----------|------------------|------------|-------------------|---------|----------|
| 0 (on "this") | CALL | 0 | 0 | 1000 | +100 | 1100 | CALL | ✓ YES |
| 0 | PROPERTY_ACCESS | 5 | 5 | 995 | 0 | 995 | CALL | ✓ YES |
| 5 (on "discoveryManager") | CALL | 0 | 5 | 995 | +100 | 1095 | CALL | ✓ YES |
| 5 | PROPERTY_ACCESS | 5 | 0 | 1000 | 0 | 1000 | CALL | ✓ YES |
| 10 (middle of "discoveryManager") | CALL | 0 | 10 | 990 | +100 | 1090 | CALL | ✓ YES |
| 10 | PROPERTY_ACCESS | 5 | 5 | 995 | 0 | 995 | CALL | ✓ YES |
| 25 (on "buildIndexingUnits") | CALL | 0 | 25 | 975 | +100 | 1075 | CALL | ✓ YES |
| 25 | PROPERTY_ACCESS | 5 | 20 | 980 | 0 | 980 | CALL | ✓ YES |
| 40 (end of "buildIndexingUnits") | CALL | 0 | 40 | 960 | +100 | 1060 | CALL | ✓ YES |
| 40 | PROPERTY_ACCESS | 5 | 35 | 965 | 0 | 965 | CALL | ✓ YES |

**Result:** The +100 bonus ensures CALL wins in ALL positions. ✓ Bug is fixed.

## Completeness Table for Edge Cases

### Case 1: Multiple CALL nodes on same line
**Scenario:** `foo(); bar();`
- CALL "foo": column 0
- CALL "bar": column 7

| Cursor Column | Closest CALL | Distance | Base Specificity | Type Bonus | Final | Winner | Correct? |
|---------------|--------------|----------|------------------|------------|-------|---------|----------|
| 0 | foo | 0 | 1000 | +100 | 1100 | foo | ✓ YES |
| 2 | foo | 2 | 998 | +100 | 1098 | foo | ✓ YES |
| 3 | foo | 3 | 997 | +100 | 1097 | foo | **? MAYBE** |
| 3 | bar | 4 | 996 | +100 | 1096 | foo | **? MAYBE** |
| 4 | foo | 4 | 996 | +100 | 1096 | **tie** | **? MAYBE** |
| 4 | bar | 3 | 997 | +100 | 1097 | bar | **? MAYBE** |
| 7 | bar | 0 | 1000 | +100 | 1100 | bar | ✓ YES |

**Analysis:** In the middle region (columns 3-4, between the two calls), either node could win depending on exact cursor position. This is acceptable behavior — user gets whichever call is closer.

**Verdict:** ✓ Acceptable

### Case 2: Nested calls
**Scenario:** `outer(inner())`
- CALL "outer": column 0
- CALL "inner": column 6

| Cursor Column | Closest CALL | Distance | Base Specificity | Type Bonus | Final | Winner | Correct? |
|---------------|--------------|----------|------------------|------------|-------|---------|----------|
| 0 | outer | 0 | 1000 | +100 | 1100 | outer | ✓ YES |
| 6 | inner | 0 | 1000 | +100 | 1100 | inner | ✓ YES |
| 3 | outer | 3 | 997 | +100 | 1097 | outer | ✓ YES |
| 3 | inner | 3 | 997 | +100 | 1097 | **tie** | **? MAYBE** |

**Analysis:** Ties resolve to first node in sort order. User gets a reasonable node.

**Verdict:** ✓ Acceptable

### Case 3: Property access WITHOUT call
**Scenario:** `const x = obj.property;`
- PROPERTY_ACCESS "property": column 10
- No CALL node

| Cursor Column | Node | Distance | Base Specificity | Type Bonus | Final | Winner | Correct? |
|---------------|------|----------|------------------|------------|-------|---------|----------|
| 10 | PROPERTY_ACCESS | 0 | 1000 | 0 | 1000 | PROPERTY_ACCESS | ✓ YES |

**Verdict:** ✓ Correct

## Critical Question: Is +100 the Right Value?

Don's plan uses `specificity += 100` as the type bonus. Let's verify this is sufficient but not excessive.

**Maximum possible distance on a line:** ~200 characters (reasonable line length)

**Worst case scenario:**
- CALL node at column 0
- PROPERTY_ACCESS node at column 150
- Cursor at column 200 (end of line)

| Node | Distance | Base Specificity | Type Bonus | Final |
|------|----------|------------------|------------|-------|
| CALL | 200 | 800 | +100 | 900 |
| PROPERTY_ACCESS | 50 | 950 | 0 | 950 |

**Result:** PROPERTY_ACCESS wins! The +100 bonus is INSUFFICIENT for extreme distances.

**However:** In practice, chained calls don't span 200 columns. The real question is: what's the maximum realistic distance between CALL start and PROPERTY_ACCESS start in a chained call?

**Realistic example:** `this.veryLongObjectNameHere.veryLongPropertyNameHere.veryLongMethodNameHere()`
- CALL at column 0
- Last PROPERTY_ACCESS at column ~60
- Maximum realistic cursor position: column 100

| Node | Distance | Base Specificity | Type Bonus | Final |
|------|----------|------------------|------------|-------|
| CALL | 100 | 900 | +100 | 1000 |
| PROPERTY_ACCESS | 40 | 960 | 0 | 960 |

**Result:** CALL wins. ✓ OK

**Critical edge case to consider:**
```javascript
const result = someVeryLongVariableName.method();
```
If VARIABLE node exists at column 15 and cursor is at column 40:
- VARIABLE at 15: distance 25, specificity 975
- CALL at 0: distance 40, specificity 1060 (960 + 100)
- PROPERTY_ACCESS at 37: distance 3, specificity 997

Winner: CALL. ✓ Correct.

**Conclusion:** +100 is adequate for realistic code, though mathematically not proven for all possible inputs.

## The REAL Problem: Phase 1 is Dead Code

Don's plan includes a sophisticated containment algorithm (lines 50-72) that:
- Handles single-line spans
- Handles multi-line spans
- Handles cursor on start line, middle lines, end line
- Computes specificity based on span size

**This code will NEVER execute** because no nodes have `endLine`/`endColumn`.

The entire Phase 1 is **dead code** that will be removed by any minifier.

## Alternative: Why Not Fix at the Source?

Don's plan explicitly states (lines 100-109):
> "Constraint: 'Fix in findNodeAtCursor only, don't change how nodes are created.'"

But Don also provides the CORRECT fix:
> "If we fixed it properly (populate endLine/endColumn in analyzer):
> 1. Add getEndLocation calls in CallExpressionVisitor.ts line 320-321
> 2. Store in methodCallInfo: endLine, endColumn
> 3. Include in metadata when node is created"

**Question:** Why is this constraint in place?

If the constraint is lifted, the PROPER fix would be:
1. Add `endLine` and `endColumn` to `MethodCallInfo` and `CallSiteInfo` types
2. Update analyzers to populate these fields using `getEndLocation(callNode)`
3. Update `PropertyAccessInfo` to include `endLine`/`endColumn` as well
4. THEN implement Don's containment algorithm, which would actually work

## Gaps Found

1. **Precondition failure:** Phase 1 (containment) is dead code because no nodes have `endLine`/`endColumn`
2. **Degraded algorithm:** The actual algorithm is just proximity + type bonus, not containment
3. **Missing justification:** Why +100 specifically? Should be derived from max realistic column distance
4. **Edge case not considered:** What if cursor is on a PROPERTY_ACCESS that's NOT part of a chained call? (e.g., `return obj.prop;`)
   - Current algorithm: PROPERTY_ACCESS at column 7, specificity 1000 - 0 = 1000
   - No CALL node exists, so PROPERTY_ACCESS correctly wins
   - ✓ This works, but should be documented
5. **Test gap:** Plan includes tests for chained calls but not for "property access without call" scenario

## Test Coverage Analysis

Don's test plan (lines 117-159) includes:
- ✓ Basic chained calls
- ✓ Direct method calls (regression)
- ✓ Multiple calls same line
- ✓ Multi-line calls (WILL FAIL — no endLine data exists)
- ✓ Property access without call

**Multi-line test will fail** because the algorithm doesn't have endLine/endColumn to detect multi-line spans. It will fall back to proximity on `line` only.

Example:
```javascript
this.manager
  .buildIndexingUnits();
```
- CALL node: line 1, column 0
- Cursor: line 2, column 2
- `if (nodeLine === line)` → FALSE (line 1 ≠ line 2)
- CALL node is excluded from matching
- **Result:** No node found (or fallback to closest by line number)

**Verdict:** Test will expose algorithm failure for multi-line calls.

## Final Verdict

**REJECT** with two paths forward:

### Path A: Minimal Fix (Accept Degraded Algorithm)
1. Remove Phase 1 (containment) entirely — it's dead code
2. Document that the algorithm is proximity + type bonus only
3. Remove multi-line test case (not supported without endLine data)
4. Adjust test expectations: only single-line calls supported
5. Add explicit documentation: "Multi-line calls not supported — cursor must be on the starting line"

**Pros:** Minimal change, fixes the reported bug
**Cons:** Incomplete solution, technical debt, future confusion when engineers see dead containment code

### Path B: Proper Fix (Recommended)
1. Extend analyzer to populate `endLine`/`endColumn` for CALL and PROPERTY_ACCESS nodes
2. Implement Don's full containment algorithm (which will then work)
3. Support all test cases including multi-line calls
4. Future-proof: any new node types can use containment if they populate end position

**Pros:** Complete solution, no technical debt, supports all use cases
**Cons:** Larger change (touches analyzer), requires more testing

## Recommendation

**I recommend Path B** for the following reasons:

1. **Don already identified the proper fix** — we should do it right
2. **Technical debt accumulation** — Path A leaves dead code that will confuse future maintainers
3. **Test coverage** — Multi-line calls are a real use case; we shouldn't exclude them
4. **Architectural consistency** — Grafema's vision is graph-first; nodes should have complete location data
5. **Future-proofing** — Once endLine/endColumn exist, many other features benefit (hover, go-to-definition, etc.)

**If user insists on Path A**, we should:
- Explicitly remove the containment code (don't leave it as dead code)
- Document the limitation clearly
- File a follow-up task for Path B

## Metrics

**Estimated LOC for Path A:** ~40 lines (proximity + bonus only)
**Estimated LOC for Path B:** ~120 lines (analyzer changes + containment algorithm + tests)

**Risk for Path A:** Low (simple change)
**Risk for Path B:** Medium (touches analyzer, requires verifying all node types)

---

**Dijkstra's signature:** "Tests are specifications, not documentation. The algorithm must be proven correct for ALL inputs, not just the happy path."
