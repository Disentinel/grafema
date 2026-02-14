# Don Melton — Analysis and Plan for REG-399

## Current State Analysis

### What Works Today

**Parameter nodes are created for:**
- Simple identifiers: `function(a, b)` → creates PARAMETER nodes for `a` and `b`
- Default parameters: `function(a = 1)` → creates PARAMETER with `hasDefault: true`
- Rest parameters: `function(...args)` → creates PARAMETER with `isRest: true`

Implementation: `/packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts` (lines 52-101)

**Destructuring works for variables:**
- `const { x, y } = obj` → creates VARIABLE nodes for `x` and `y`
- Creates EXPRESSION nodes for member access (`obj.x`, `obj.y`)
- Creates ASSIGNED_FROM edges linking variables to expressions
- Pattern: REG-201 (destructuring ASSIGNED_FROM edges)

Implementation: `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts::extractVariableNamesFromPattern()` (lines 571-632)

### What's Missing

**Destructured parameters are silently skipped:**
```typescript
// In createParameterNodes.ts, line 102:
// ObjectPattern and ArrayPattern (destructuring parameters) can be added later
```

When you write:
```javascript
function greetUser({ name, greeting = 'Hello' }) {
  return `${greeting}, ${name}!`;
}
```

**Current behavior:**
- NO PARAMETER nodes created for `name` or `greeting`
- Function appears to have 0 parameters
- Variables `name` and `greeting` are undefined in the graph
- Cannot trace where these values come from

**Expected behavior (per acceptance criteria):**
- PARAMETER node for `name`
- PARAMETER node for `greeting` with `hasDefault: true`
- Proper semantic IDs: `file->greetUser->PARAMETER->name`
- HAS_PARAMETER edges from function to parameters

### How Variables Handle Destructuring

The `VariableVisitor` already solves this problem for variable declarations (REG-201).

**Key insight from VariableVisitor.ts (lines 242-246):**
```typescript
variables.forEach((varInfo: VariableInfo) => {
  // varInfo has: name, loc, propertyPath?, arrayIndex?, isRest?
  const varId = idGenerator.generate(nodeType, varInfo.name, ...);
  // Creates VARIABLE node with just the name, not the full pattern
})
```

**Each destructured binding gets its own VARIABLE node:**
- `const { a, b } = obj` → 2 VARIABLE nodes (`a`, `b`)
- `const { x: { y } } = obj` → 1 VARIABLE node (`y`) with `propertyPath: ['x']`
- `const [first, second] = arr` → 2 VARIABLE nodes with `arrayIndex`
- `const { a, ...rest } = obj` → VARIABLE for `a`, VARIABLE for `rest` with `isRest: true`

**Data flow tracking happens separately:**
- VARIABLE nodes are just identifiers
- ASSIGNED_FROM edges connect them to source
- EXPRESSION nodes represent member access (lines 330-386)

## Critical Architectural Decision

### PARAMETER vs VARIABLE nodes for destructured params

**Question:** Should `function({ x }) {}` create PARAMETER or VARIABLE nodes?

**Answer: PARAMETER nodes.**

**Reasoning:**

1. **Semantic correctness:**
   - Parameters are function arguments, not local variables
   - They have different lifecycle (bound at call time)
   - Query semantics: "what are this function's parameters?" should return `x`

2. **Consistency with simple parameters:**
   - `function(x) {}` → PARAMETER node
   - `function({ x }) {}` → should also be PARAMETER node
   - Only difference is the binding pattern, not the semantic role

3. **Graph structure:**
   - HAS_PARAMETER edges connect functions to their parameters
   - Using VARIABLE would break these edges
   - Would make "list function parameters" queries fail

4. **Existing patterns:**
   - AssignmentPattern (default params) creates PARAMETER nodes
   - RestElement (rest params) creates PARAMETER nodes
   - ObjectPattern/ArrayPattern should follow same pattern

5. **Type system alignment:**
   - In type systems, `({ x }: { x: number })` has parameter `x`
   - Not a local variable that happens to be destructured

**Decision: Create PARAMETER nodes, reuse extractVariableNamesFromPattern logic.**

### Metadata Strategy

**ParameterInfo currently has:**
```typescript
{
  id, semanticId, type: 'PARAMETER', name, file, line, index,
  hasDefault?, isRest?, parentFunctionId
}
```

**For destructured params, we need to track:**
- `propertyPath?: string[]` — for nested destructuring
- `arrayIndex?: number` — for array destructuring
- Keep existing `hasDefault` and `isRest` flags

**But ParameterInfo doesn't have these fields.**

**Options:**

**A. Extend ParameterInfo (recommended):**
```typescript
export interface ParameterInfo {
  // ... existing fields ...
  propertyPath?: string[];  // NEW: ['data', 'user'] for ({ data: { user } })
  arrayIndex?: number;      // NEW: 0 for ([first, second])
}
```

**Pros:**
- Parallel structure with VariableInfo
- Enables future queries: "which parameters are destructured?"
- Supports nested destructuring metadata

**Cons:**
- Schema change (but backward compatible)

**B. Flatten destructured params (no metadata):**
Just create flat PARAMETER nodes without tracking structure.

**Pros:**
- No schema change

**Cons:**
- Loses information about destructuring structure
- Can't distinguish `({ x })` from `(x)`
- Blocks future queries about destructuring patterns

**Decision: Option A — extend ParameterInfo with propertyPath and arrayIndex.**

This is the right thing to do. Matches existing patterns from REG-201.

## High-Level Plan

### Phase 1: Extend ParameterInfo Schema

**File:** `/packages/core/src/plugins/analysis/ast/types.ts`

**Change:**
```typescript
export interface ParameterInfo {
  id: string;
  semanticId?: string;
  type: 'PARAMETER';
  name: string;
  file: string;
  line: number;
  index?: number;
  hasDefault?: boolean;
  isRest?: boolean;
  functionId?: string;
  parentFunctionId?: string;
  // NEW: Destructuring metadata
  propertyPath?: string[];  // For nested object destructuring
  arrayIndex?: number;      // For array destructuring
}
```

**Impact:** Backward compatible (optional fields).

### Phase 2: Reuse extractVariableNamesFromPattern

**File:** `/packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts`

**Current approach:**
- Loop through `params`
- Pattern match on `Identifier`, `AssignmentPattern`, `RestElement`
- Skip `ObjectPattern`, `ArrayPattern`

**New approach:**
- For `ObjectPattern` or `ArrayPattern`:
  - Call `extractVariableNamesFromPattern(param)` (imported from JSASTAnalyzer)
  - Returns `VariableInfo[]` with `{ name, loc, propertyPath?, arrayIndex?, isRest? }`
  - Create PARAMETER node for each extracted name
  - Copy metadata (`propertyPath`, `arrayIndex`, `isRest`) to ParameterInfo

**Implementation strategy:**
1. Import `extractVariableNamesFromPattern` from JSASTAnalyzer
   - **PROBLEM:** It's a method on JSASTAnalyzer class, not a standalone function
   - **SOLUTION:** Extract it to a shared utility module
2. Use it in createParameterNodes for ObjectPattern/ArrayPattern
3. Handle AssignmentPattern wrapping (defaults in destructuring)

### Phase 3: Extract Shared Utility

**New file:** `/packages/core/src/plugins/analysis/ast/utils/extractVariableNamesFromPattern.ts`

**Move:**
- `JSASTAnalyzer.extractVariableNamesFromPattern()` → standalone function
- `VariableInfo` interface → move to shared types

**Import in:**
- `JSASTAnalyzer.ts` (use utility instead of method)
- `createParameterNodes.ts` (use for destructured params)

**Why this is the right thing:**
- DRY: One implementation for both variables and parameters
- Correctness: Ensures identical behavior
- Maintainability: Bug fixes apply to both

### Phase 4: Update createParameterNodes

**File:** `/packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts`

**Add handling for ObjectPattern and ArrayPattern:**

```typescript
else if (param.type === 'ObjectPattern' || param.type === 'ArrayPattern') {
  // Extract all parameter names from destructuring pattern
  const extractedParams = extractVariableNamesFromPattern(param);

  extractedParams.forEach((paramInfo, subIndex) => {
    const paramId = computeSemanticId(
      'PARAMETER',
      paramInfo.name,
      scopeTracker.getContext(),
      { discriminator: index * 1000 + subIndex }  // Ensure unique IDs
    );

    parameters.push({
      id: paramId,
      semanticId: paramId,
      type: 'PARAMETER',
      name: paramInfo.name,
      file: file,
      line: paramInfo.loc.start.line,
      index: index,  // Original parameter position
      parentFunctionId: functionId,
      // NEW: Destructuring metadata
      propertyPath: paramInfo.propertyPath,
      arrayIndex: paramInfo.arrayIndex,
      isRest: paramInfo.isRest,
      hasDefault: false  // Will handle in Phase 5
    });
  });
}
```

**Handle AssignmentPattern wrapping:**
```typescript
else if (param.type === 'AssignmentPattern') {
  const assignmentParam = param as AssignmentPattern;

  if (assignmentParam.left.type === 'ObjectPattern' ||
      assignmentParam.left.type === 'ArrayPattern') {
    // Default values in destructuring: function({ x = 42 }) {}
    const extractedParams = extractVariableNamesFromPattern(assignmentParam.left);

    extractedParams.forEach((paramInfo, subIndex) => {
      // ... same as above but with hasDefault: true
    });
  }
  // ... existing Identifier handling
}
```

### Phase 5: Handle Nested Defaults

**Challenge:** Destructuring can have defaults at multiple levels:
```javascript
function foo({ x = 1, y: { z = 2 } = {} }) {}
//              ^^^^          ^^^^   ^^^ — three different defaults
```

**Current extractVariableNamesFromPattern:**
- Handles AssignmentPattern by recursing: `pattern.left`
- Does NOT track "this parameter has a default"

**Solution:**
Modify extractVariableNamesFromPattern to return `hasDefault` flag:
```typescript
export interface VariableInfo {
  name: string;
  loc: { start: { line: number; column: number } };
  propertyPath?: string[];
  arrayIndex?: number;
  isRest?: boolean;
  hasDefault?: boolean;  // NEW
}
```

Track it while recursing through AssignmentPattern nodes.

## Files That Need Modification

1. **`/packages/core/src/plugins/analysis/ast/types.ts`**
   - Extend `ParameterInfo` with `propertyPath` and `arrayIndex`

2. **`/packages/core/src/plugins/analysis/ast/visitors/VariableVisitor.ts`**
   - Export `VariableInfo` interface (move to shared location)

3. **NEW: `/packages/core/src/plugins/analysis/ast/utils/extractVariableNamesFromPattern.ts`**
   - Extract shared utility from JSASTAnalyzer
   - Add `hasDefault` tracking for defaults in destructuring

4. **`/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`**
   - Replace method with import of shared utility
   - Pass through to extracted function

5. **`/packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts`**
   - Import extractVariableNamesFromPattern utility
   - Add ObjectPattern/ArrayPattern handling
   - Add AssignmentPattern wrapping for destructured params with defaults
   - Update discriminator logic for unique semantic IDs

6. **Tests:**
   - Create new test file: `/test/unit/plugins/analysis/ast/destructured-parameters.test.ts`
   - Test all acceptance criteria
   - Test semantic ID stability
   - Test HAS_PARAMETER edges

## Risks and Considerations

### 1. Semantic ID Collisions

**Risk:** Multiple destructured params could generate same semantic ID.

**Example:**
```javascript
function foo({ x }, { x }) {}  // Two params named 'x'
//            ^^^^  ^^^^
```

**Mitigation:**
- Use `discriminator` based on parameter index
- For sub-parameters: `index * 1000 + subIndex`
- Ensures uniqueness even with name collisions

### 2. Parameter Index Semantics

**Risk:** What should `index` field represent?

**Options:**
- A. Original parameter position in function signature
- B. Flat index across all extracted parameters

**Decision: Option A (original position).**

**Reasoning:**
- `function({ a, b }, c)` has 2 parameters at positions 0, 1
- Extracting `a`, `b` from position 0 should keep `index: 0`
- Preserves "which argument slot does this come from?"

**For queries:**
- "Parameters at position 0" → returns `a` and `b`
- "All parameters" → returns `a`, `b`, `c`

### 3. Breaking Change Potential

**Risk:** Does extending ParameterInfo break existing code?

**Analysis:**
- New fields are optional (`?`)
- Existing code ignores unknown fields
- Backward compatible

**Validation:**
- Run full test suite after schema change
- Check graph serialization/deserialization

### 4. extractVariableNamesFromPattern Assumptions

**Risk:** Function assumes variable declaration context, might not work for parameters.

**Differences:**
- Variables: can have initializer expressions
- Parameters: no initializer (default values handled differently)

**Validation needed:**
- Test with all parameter patterns
- Ensure no crashes on parameter-specific AST structures

### 5. Arrow Function Edge Cases

**Risk:** Arrow functions have different syntax:
```javascript
({ x }) => x         // No parentheses around single param
({ x }, { y }) => {} // Parentheses required for multiple params
```

**Mitigation:**
- Babel parser handles this, AST is same
- Test arrow functions explicitly

### 6. TypeScript Annotations

**Risk:** TypeScript type annotations in destructured params:
```typescript
function foo({ x }: { x: number }) {}
//               ^^^^^^^^^^^^^^^^^^^ — type annotation
```

**Analysis:**
- Type annotations are separate AST nodes
- extractVariableNamesFromPattern operates on pattern, not types
- Should work without changes

**Validation:**
- Test TypeScript fixtures
- Ensure no crashes

## Open Questions

### Q1: Should we create EXPRESSION nodes for parameter destructuring?

**Context:** Variable destructuring creates EXPRESSION nodes:
```javascript
const { x } = obj;
// Creates: VARIABLE(x) -> ASSIGNED_FROM -> EXPRESSION(obj.x)
```

**For parameters:**
```javascript
function foo({ x }) {
  // Option A: Just PARAMETER(x), no EXPRESSION
  // Option B: PARAMETER(x) + EXPRESSION for "argument.x"
}
```

**Recommendation: Option A (just PARAMETER), defer EXPRESSION to future task.**

**Reasoning:**
- Parameters don't have a source object in AST (it's the call site)
- EXPRESSION would be `arguments[0].x` which is runtime, not static
- Data flow through parameters needs CALL_SITE → PARAMETER edges (different pattern)
- Acceptance criteria only ask for PARAMETER nodes, not data flow

**Future work:**
- REG-XXX: Track data flow through destructured parameters
- Link call site arguments to destructured parameters
- Requires call site analysis, out of scope for REG-399

### Q2: Should rest parameters in destructuring get special handling?

**Example:**
```javascript
function foo({ a, ...rest }) {}
//                 ^^^^^^^ — rest of object
```

**Current plan:**
- `isRest: true` flag on PARAMETER
- Same as `function(...rest)` for array rest

**Question:** Is this sufficient?

**Answer: Yes.**
- Matches existing rest parameter handling
- Semantics are same: "all remaining values"
- Queries can filter by `isRest` flag

## Summary

### What We're Building

Extend `createParameterNodes()` to handle destructured parameters by:
1. Extending ParameterInfo schema with destructuring metadata
2. Extracting shared `extractVariableNamesFromPattern` utility
3. Using it for ObjectPattern/ArrayPattern parameters
4. Creating PARAMETER nodes for each destructured binding

### Why This Is Right

- **Semantically correct:** Parameters are parameters, not variables
- **Architecturally sound:** Reuses proven REG-201 pattern
- **DRY:** One implementation for all destructuring
- **Complete:** Handles all acceptance criteria cases
- **Extensible:** Metadata enables future data flow queries

### What We're NOT Building (Yet)

- Data flow edges from call sites to destructured parameters
- EXPRESSION nodes for parameter member access
- Call argument → parameter binding (different feature)

### Success Criteria

All acceptance criteria pass:
- ✓ Object destructuring: `function({ x }) {}`
- ✓ Nested destructuring: `function({ data: { user } }) {}`
- ✓ Renaming: `function({ old: newName }) {}`
- ✓ Array destructuring: `function([first, second]) {}`
- ✓ Rest parameters: `function({ a, ...rest }) {}`
- ✓ Default values: `function({ x = 42 }) {}`
- ✓ Arrow functions: `({ x }) => x`

Each creates proper PARAMETER nodes with correct metadata and semantic IDs.

## Next Steps

Pass this plan to Joel Spolsky for detailed technical specification.

Key areas for Joel to detail:
1. Exact utility extraction steps (imports, exports, type moves)
2. Discriminator formula for semantic ID uniqueness
3. Test cases covering edge cases
4. Migration strategy if any existing tests break
