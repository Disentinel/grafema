# Don Melton — High-Level Plan for REG-201

## Analysis

### Current State

I've analyzed the codebase and found the following:

**1. Variable Extraction Works, Assignment Tracking Doesn't**

The `extractVariableNamesFromPattern()` method in `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` (lines 482-543) already handles destructuring patterns correctly:

- It extracts variable names from ObjectPattern
- It extracts variable names from ArrayPattern
- It tracks propertyPath (e.g., `['headers']` for `const { headers } = req`)
- It tracks arrayIndex (e.g., `0` for first element in array destructuring)
- It handles nested patterns recursively
- It handles rest elements (`...rest`)
- It handles renaming (`oldName: newName`)

This is EXCELLENT — the hard AST work is already done.

**2. Assignment Tracking Exists But Ignores Destructuring**

The `trackVariableAssignment()` method (lines 548-697) creates ASSIGNED_FROM edges for:
- Literals
- CallExpression
- Identifier (simple variable assignment)
- NewExpression
- FunctionExpression
- MemberExpression

BUT it only receives `declarator.init` (the right-hand side of the assignment). It has no information about the destructuring pattern structure.

**3. The Gap**

In `handleVariableDeclaration()` (line 1267) and `processBlockVariables()` (line 1404), the code does this:

```typescript
const variables = this.extractVariableNamesFromPattern(declarator.id);

variables.forEach(varInfo => {
  // ... create variable node ...

  if (declarator.init) {
    this.trackVariableAssignment(
      declarator.init,      // Only the source object/array
      varId,
      varInfo.name,
      // ...
    );
  }
});
```

The problem: `trackVariableAssignment` receives `declarator.init` (e.g., `req`), but doesn't know about the destructuring pattern. So for `const { headers } = req`, it would try to create `headers ASSIGNED_FROM req` (wrong) instead of `headers ASSIGNED_FROM req.headers` (correct).

**4. Tests Exist**

`/Users/vadimr/grafema-worker-4/test/unit/DestructuringDataFlow.test.js` contains comprehensive tests for exactly this feature. Currently these tests are failing because the edges don't exist.

### Root Cause Confirmation

**CONFIRMED**: The root cause is that `trackVariableAssignment()` doesn't receive information about the destructuring pattern structure (propertyPath, arrayIndex) that was extracted by `extractVariableNamesFromPattern()`.

**However, the original issue description is slightly incomplete**. It's not just about "detecting destructuring" — the detection works. It's about **creating the correct ASSIGNED_FROM target**.

For `const { headers } = req`, we need:
- Source: `headers` (VARIABLE node)
- Target: EXPRESSION node representing `req.headers` (MemberExpression)

For `const [first, second] = arr`, we need:
- Source: `first` (VARIABLE node)
- Target: EXPRESSION node representing `arr[0]` (MemberExpression with computed: true)

## Root Cause Deep Dive

The actual problem has two parts:

**Part 1 (Information Loss)**: The `varInfo` object returned by `extractVariableNamesFromPattern` contains `propertyPath` and `arrayIndex`, but this information is discarded before calling `trackVariableAssignment`.

**Part 2 (Wrong Abstraction)**: `trackVariableAssignment` is designed for simple assignments like `const x = y`, not destructuring. It needs to be enhanced or we need a parallel code path.

## High-Level Plan

### Phase 1: Simple ObjectPattern Destructuring

**Goal**: Make `const { headers } = req` create `headers ASSIGNED_FROM req.headers`

**Approach**:

1. **Modify `handleVariableDeclaration` and `processBlockVariables`**:
   - After extracting variables, check if `declarator.id` is ObjectPattern or ArrayPattern
   - If yes, call new specialized method instead of (or in addition to) `trackVariableAssignment`

2. **Create new method `trackDestructuringAssignment`**:
   ```typescript
   trackDestructuringAssignment(
     pattern: t.ObjectPattern | t.ArrayPattern,
     initExpression: t.Expression,
     variables: ExtractedVariable[],  // Already has propertyPath/arrayIndex
     module: VisitorModule,
     variableAssignments: VariableAssignmentInfo[],
     // ...
   )
   ```

3. **For ObjectPattern**:
   - For each extracted variable with `propertyPath`
   - Create EXPRESSION node representing `init.propertyPath[0].propertyPath[1]...`
   - Add VariableAssignmentInfo with sourceType='EXPRESSION'
   - Let existing GraphBuilder code create the ASSIGNED_FROM edge

4. **Keep GraphBuilder unchanged** (if possible):
   - GraphBuilder already handles EXPRESSION nodes (lines 829-898)
   - We just need to emit the right VariableAssignmentInfo structure

### Phase 2: Simple ArrayPattern Destructuring

**Goal**: Make `const [first, second] = arr` create edges to array elements

**Approach**:

1. **For ArrayPattern**:
   - For each extracted variable with `arrayIndex`
   - Create EXPRESSION node representing `init[arrayIndex]`
   - Use `computed: true` for the MemberExpression metadata

### Phase 3: Handle Edge Cases

1. **Renaming** (`const { oldName: newName } = obj`):
   - `extractVariableNamesFromPattern` already tracks this (propertyPath contains 'oldName', variable name is 'newName')
   - Should work automatically if Phase 1 is correct

2. **Rest elements** (`const { x, ...rest } = obj`):
   - ExtractedVariable already has `isRest: true`
   - For now: create edge to the whole object (not incorrect, just imprecise)
   - Full solution: needs special handling in ValueDomainAnalyzer

3. **Defaults** (`const { x = 5 } = obj`):
   - AssignmentPattern wraps the Identifier
   - `extractVariableNamesFromPattern` already handles this
   - Should work automatically

4. **Nested destructuring** (`const { x: { y } } = obj`):
   - `extractVariableNamesFromPattern` already handles this (propertyPath = ['x', 'y'])
   - Create EXPRESSION for `obj.x.y`
   - Should work with same code as simple case

### What NOT to Do

1. **Don't modify `trackVariableAssignment`** — it's for simple assignments, keep it clean
2. **Don't modify GraphBuilder** (if possible) — it already handles EXPRESSION nodes correctly
3. **Don't touch `extractVariableNamesFromPattern`** — it already works perfectly

## Implementation Strategy

### Step 1: Add `trackDestructuringAssignment` method
- Parallel to `trackVariableAssignment`
- Only called when `declarator.id` is ObjectPattern or ArrayPattern
- Uses the already-extracted `propertyPath`/`arrayIndex` from ExtractedVariable

### Step 2: Modify call sites
- In `handleVariableDeclaration` (line 1346)
- In `processBlockVariables` (line 1444)
- Check pattern type, call appropriate tracking method

### Step 3: Handle EXPRESSION node creation
- For `const { headers } = req`:
  - expressionType: 'MemberExpression'
  - object: 'req' (from init identifier)
  - property: 'headers' (from propertyPath[0])
  - computed: false

- For `const [first] = arr`:
  - expressionType: 'MemberExpression'
  - object: 'arr' (from init identifier)
  - property: '0' (from arrayIndex)
  - computed: true

### Step 4: Test with existing test suite
- `/Users/vadimr/grafema-worker-4/test/unit/DestructuringDataFlow.test.js` should pass

## Risks and Considerations

### Risk 1: Init Expression Complexity

**Problem**: What if `init` is not a simple Identifier?

```javascript
const { headers } = getRequest();  // CallExpression
const { x } = obj.nested;          // MemberExpression
const { y } = arr[0];              // MemberExpression with computed
```

**Mitigation**:
- Phase 1: Only handle Identifier init expressions
- Log warning for complex cases
- Phase 2: Extend to handle other expression types

### Risk 2: EXPRESSION Node ID Generation

**Problem**: Need to generate consistent IDs for EXPRESSION nodes

**Current approach** (line 831-851): Uses VariableAssignmentInfo with `sourceId` as the ID.

**Solution**: Follow existing pattern — let JSASTAnalyzer assign IDs, GraphBuilder uses them.

### Risk 3: Nested Destructuring Complexity

**Problem**: `const { x: { y: { z } } } = obj` creates deep property paths

**Mitigation**:
- Start with simple (depth 1) cases
- Extend to nested if simple cases work
- `extractVariableNamesFromPattern` already handles nesting, we just use the full propertyPath

### Risk 4: Value Domain Integration

**Problem**: ValueDomainAnalyzer needs to understand these ASSIGNED_FROM edges

**Observation**: ValueDomainAnalyzer already traces ASSIGNED_FROM chains (see AliasTracker lines 268-274). Should work automatically once edges exist.

**Validation**: Test with real-world code after implementation.

## Alignment with Vision

**"AI should query the graph, not read code"**

This feature is CRITICAL for this vision:

1. **Current state**: AI must read source code to understand `const { headers } = req` because graph has no edge
2. **After fix**: AI can query `headers -> ASSIGNED_FROM -> req.headers` directly
3. **Impact**: 30-40% of modern JS uses destructuring — this isn't a nice-to-have, it's core functionality

**This is not a feature request, this is a data integrity bug**. The graph is lying by omission.

## Success Metrics

1. All tests in `DestructuringDataFlow.test.js` pass
2. Can query "where does this destructured variable come from" via graph
3. ValueDomainAnalyzer can resolve computed property access through destructured variables
4. No regressions in existing ASSIGNED_FROM edges

## Open Questions for Discussion

1. **Should we handle destructuring in function parameters?**
   ```javascript
   function foo({ headers }) { ... }
   ```
   This is technically a parameter, not a variable declaration. Separate issue?

2. **Should rest elements get special edge type?**
   ```javascript
   const { x, ...rest } = obj;  // rest = obj minus x
   ```
   Or just `rest ASSIGNED_FROM obj` (imprecise but not wrong)?

3. **What about destructuring in catch blocks?**
   ```javascript
   try { ... } catch ({ message }) { ... }
   ```
   Already handled in `processBlockVariables`? Need to verify.

## Recommended Next Steps

1. **Joel**: Expand this into detailed technical spec
2. **Research**: Check if function parameter destructuring is already handled elsewhere
3. **Decision needed**: Simple Identifier init only, or handle complex init expressions in Phase 1?

---

**Bottom line**: This is the right thing to do. The infrastructure is already there (`extractVariableNamesFromPattern` does the hard work). We just need to connect the dots and create the edges.

We're not building a new feature — we're fixing a missing data flow that should have existed from day one.
