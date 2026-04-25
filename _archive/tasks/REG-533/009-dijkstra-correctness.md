# Dijkstra Correctness Review - REG-533

**Date:** 2026-02-20
**Reviewer:** Edsger Dijkstra (Correctness Review)
**Task:** REG-533 - Track operands in EXPRESSION nodes for DERIVES_FROM edge creation

## Verdict: REJECT

## Functions Reviewed

1. `JSASTAnalyzer.extractOperandName()` - /Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts:2520
2. `ControlFlowBuilder.bufferLoopTestDerivesFromEdges()` - /Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/builders/ControlFlowBuilder.ts:482
3. `ControlFlowBuilder.bufferLoopUpdateDerivesFromEdges()` - /Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/builders/ControlFlowBuilder.ts:579
4. `ControlFlowBuilder.bufferBranchDiscriminantDerivesFromEdges()` - /Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/builders/ControlFlowBuilder.ts:614
5. `LoopHandler` operand metadata extraction - /Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/handlers/LoopHandler.ts:160-200
6. `BranchHandler` operand metadata extraction - /Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/handlers/BranchHandler.ts:115-124

## Critical Issues Found

### Issue 1: UpdateExpression in Test Condition - Field Name Mismatch

**Location:** ControlFlowBuilder.ts:555

**Bug:** When an UpdateExpression appears in a loop test condition (e.g., `for(; i++;)`), there's a field name mismatch:

- `extractDiscriminantExpression()` returns `updateArgSourceName` for UpdateExpression nodes (JSASTAnalyzer.ts:2477)
- `LoopHandler` does NOT extract this field into `testUpdateArgSourceName` (only extracts `testUnaryArgSourceName`, etc.)
- `ControlFlowBuilder.bufferLoopTestDerivesFromEdges()` tries to access `loop.testObjectSourceName` for UpdateExpression

**Result:** UpdateExpression in test conditions will NEVER create DERIVES_FROM edges because the field doesn't exist.

**Enumeration of paths:**
- UpdateExpression as test → `updateArgSourceName` set → NOT extracted by LoopHandler → field undefined → NO edge created ❌

**Fix required:** Either:
1. Add `testUpdateArgSourceName?: string` to LoopInfo type and extract it in LoopHandler
2. OR use the correct field name in ControlFlowBuilder (line 555: change `testObjectSourceName` to `testUpdateArgSourceName`)

### Issue 2: Variable Scope Resolution - Incorrect Shadowing Behavior

**Location:** ControlFlowBuilder.ts:496, 591, 628 (all three `findSource` implementations)

**Bug:** The `findSource` function uses `.find()` to search all variables in a file, with NO scope awareness:

```typescript
const findSource = (name: string): string | null => {
  const variable = variableDeclarations.find(v => v.name === name && v.file === file);
  if (variable) return variable.id;
  const param = parameters.find(p => p.name === name && v.file === file);
  if (param) return param.id;
  return null;
};
```

**Enumeration of incorrect behaviors:**

1. **Same name in nested scopes:**
   ```javascript
   function outer() {
     let x = 1;
     function inner() {
       let x = 2;  // Shadows outer x
       while (x < 10) { }  // findSource returns FIRST x (order-dependent!)
     }
   }
   ```
   - Expected: Return inner `x` (line 4)
   - Actual: Returns whichever `x` appears first in `variableDeclarations` array
   - Correctness: WRONG - depends on traversal order, not lexical scope

2. **Parameter shadows variable (WRONG precedence):**
   ```javascript
   let count = 0;
   function process(count) {  // Parameter shadows outer variable
     while (count < 5) { }    // findSource returns outer variable 'count'!
   }
   ```
   - Expected: Return parameter `count`
   - Actual: Returns VARIABLE `count` (checked first)
   - Correctness: WRONG - variables are checked before parameters

3. **Global variables (not in variableDeclarations/parameters):**
   ```javascript
   while (globalVar < 10) { }
   ```
   - Expected: ??? (undefined behavior - globals not tracked)
   - Actual: `findSource` returns `null`, no edge created
   - Correctness: SILENT FAILURE - no error, no edge

4. **Out-of-scope references:**
   ```javascript
   function test() {
     if (true) { let temp = 1; }
     while (temp < 10) { }  // temp not in scope!
   }
   ```
   - Expected: ??? (should detect out-of-scope or error)
   - Actual: If `temp` exists anywhere in file, returns it
   - Correctness: WRONG - ignores block scope

**Impact:** DERIVES_FROM edges may point to the WRONG variable in the presence of:
- Nested scopes with same variable names
- Parameters shadowing outer variables
- Block-scoped variables

**Fix required:** Scope-aware variable lookup. Need to:
1. Track scope hierarchy for each loop/branch
2. Walk up scope chain to find closest declaration
3. Respect shadowing rules (inner declarations hide outer ones)
4. Prefer parameters over variables in same scope

This is a FUNDAMENTAL architectural issue, not a simple bug fix.

## Minor Issues

### Issue 3: Nested MemberExpression - Incomplete Handling

**Location:** JSASTAnalyzer.ts:2522

**Current code:**
```typescript
if (t.isMemberExpression(node) && t.isIdentifier(node.object)) return node.object.name;
```

**Limitation:** For deeply nested member expressions like `obj.nested.method`, this returns `undefined` if `node.object` is itself a MemberExpression (not an Identifier).

**Enumeration:**
- `x` → Identifier → returns `'x'` ✓
- `obj.prop` → MemberExpression, object is Identifier → returns `'obj'` ✓
- `obj.nested.prop` → MemberExpression, object is MemberExpression → returns `undefined` ❌

**Expected behavior (per test at line 926-933 of ControlFlowDerivesFrom.test.js):**
For `arr.length`, should return `'arr'` (base object). Current code handles this correctly.

For `obj.nested.prop`, should recursively extract base → return `'obj'`.

**Current behavior:** Returns `undefined` for nested MemberExpression where object is not an Identifier.

**Impact:** This may be acceptable as a documented limitation, BUT test at ControlFlowDerivesFrom.test.js:893 expects `arr.length` to work. Since `arr.length` has an Identifier object, it DOES work. However, deeper nesting would fail.

**Status:** Not a bug for single-level member expressions, but incomplete for multi-level. Document or fix.

## Expression Type Coverage

### Expressions Handled by extractOperandName:
- ✓ Identifier
- ✓ MemberExpression (single level only)
- ❌ All other types return `undefined`

This is CORRECT by design - complex expressions like CallExpression, ArrayExpression, etc. cannot be reduced to a single operand name.

### Expressions Handled by bufferLoopTestDerivesFromEdges:
- ✓ Identifier
- ✓ MemberExpression
- ✓ BinaryExpression
- ✓ LogicalExpression
- ✓ ConditionalExpression
- ✓ UnaryExpression
- ❌ UpdateExpression (BROKEN - wrong field name, see Issue 1)
- ✓ TemplateLiteral
- ⊘ CallExpression (skipped - correct)

All expression types that should be handled ARE handled, except UpdateExpression which is broken.

### Expressions that Fall Through (NO edge created):
- CallExpression - CORRECT (explicitly skipped, linked to CALL_SITE instead)
- ArrayExpression, ObjectExpression, etc. - CORRECT (no extractable operand)
- Deeply nested MemberExpression - LIMITATION (see Issue 3)

## Loop Termination

All loops in the reviewed functions:
1. `bufferLoopTestDerivesFromEdges` - iterates `loops` array → terminates ✓
2. `bufferLoopUpdateDerivesFromEdges` - iterates `loops` array → terminates ✓
3. `bufferBranchDiscriminantDerivesFromEdges` - iterates `branches` array → terminates ✓
4. `TemplateLiteral` handling - iterates `testExpressionSourceNames` array → terminates ✓

No infinite loops possible.

## Invariants

**Expected invariant:** If a DERIVES_FROM edge exists, it points to a VARIABLE or PARAMETER node in the same lexical scope or an outer scope.

**Violated by:** Issue 2 (scope resolution bug) - edge may point to wrong variable due to shadowing.

## Summary

The implementation has:
1. **One critical bug** (Issue 1) - UpdateExpression field mismatch prevents edge creation
2. **One fundamental architectural flaw** (Issue 2) - scope-unaware variable lookup breaks correctness in presence of shadowing
3. **One documented limitation** (Issue 3) - nested MemberExpression support incomplete

Until Issues 1 and 2 are resolved, this implementation cannot be considered correct.

## Recommendations

1. **Immediate fix:** Issue 1 (UpdateExpression field mismatch) - simple field name fix
2. **Architectural fix:** Issue 2 requires scope tracking infrastructure - may need to defer or accept as known limitation
3. **Tests required:** Add test cases for variable shadowing (nested scopes, parameters shadowing variables)
4. **Documentation:** If Issue 2 cannot be fixed immediately, document the limitation clearly

---

**Dijkstra's Law:** "Testing shows the presence, not the absence of bugs."
These issues were found by systematic enumeration, NOT by testing. Tests would catch Issue 1, but likely miss Issue 2 unless specifically designed for shadowing scenarios.
