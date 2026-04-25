# Joel Spolsky Technical Plan: REG-329 Scope Chain Resolution for Object Properties

## Executive Summary

This plan extends the existing `resolveVariableInScope` infrastructure (proven in REG-309) to resolve variable references in object property values. The change follows the established pattern used for array mutations and object mutations.

## 1. Scope of Changes

### Files to Modify

| File | Change Type | Description |
|------|-------------|-------------|
| `packages/core/src/plugins/analysis/ast/types.ts` | Type Extension | Add `valueScopePath?: string[]` to `ObjectPropertyInfo` |
| `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts` | Analysis | Capture scope path when extracting object properties with variable values |
| `packages/core/src/plugins/analysis/ast/GraphBuilder.ts` | Resolution | Use `resolveVariableInScope` in `bufferObjectPropertyEdges` for VARIABLE properties |

### Files to Add/Modify for Tests

| File | Change Type |
|------|-------------|
| `test/unit/object-property-scope-resolution.test.js` | New test file |

## 2. Data Structure Changes

### 2.1 ObjectPropertyInfo Type Extension

**Location:** `/packages/core/src/plugins/analysis/ast/types.ts` (lines 464-481)

**Current:**
```typescript
export interface ObjectPropertyInfo {
  objectId: string;
  propertyName: string;
  valueNodeId?: string;
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL' | 'SPREAD';
  valueName?: string;       // For VARIABLE
  literalValue?: unknown;   // For LITERAL
  file: string;
  line: number;
  column: number;
  // ... other fields
}
```

**Proposed Addition:**
```typescript
export interface ObjectPropertyInfo {
  // ... existing fields ...
  valueScopePath?: string[];  // Scope path where property value is defined (for VARIABLE resolution)
}
```

**Rationale:** This follows the exact pattern established in REG-309 for:
- `ArrayMutationInfo.mutationScopePath` (types.ts:525)
- `ObjectMutationInfo.mutationScopePath` (types.ts:558)
- `VariableReassignmentInfo.mutationScopePath` (types.ts:719)

## 3. Implementation Steps

### Step 1: Extend ObjectPropertyInfo Type (types.ts)

**File:** `packages/core/src/plugins/analysis/ast/types.ts`
**Line:** 481 (before closing brace of ObjectPropertyInfo)

Add:
```typescript
  // For VARIABLE values - scope path for scope-aware lookup (REG-329)
  valueScopePath?: string[];
```

### Step 2: Capture Scope Path in CallExpressionVisitor (extractObjectProperties)

**File:** `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`
**Method:** `extractObjectProperties` (lines 481-663)
**Target:** Line 632-634 where `valueType: 'VARIABLE'` is set

**Current (lines 632-634):**
```typescript
// Variable reference
else if (value.type === 'Identifier') {
  propertyInfo.valueType = 'VARIABLE';
  propertyInfo.valueName = value.name;
}
```

**Proposed:**
```typescript
// Variable reference
else if (value.type === 'Identifier') {
  propertyInfo.valueType = 'VARIABLE';
  propertyInfo.valueName = value.name;
  // REG-329: Capture scope path for scope-aware variable resolution
  propertyInfo.valueScopePath = this.scopeTracker?.getContext().scopePath ?? [];
}
```

**Note:** The same pattern must be applied in other places where VARIABLE properties are detected:
- Line 507-510 (spread properties with VARIABLE)
- Any recursive calls within nested object handling

### Step 3: Modify bufferObjectPropertyEdges in GraphBuilder

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
**Method:** `bufferObjectPropertyEdges` (lines 2873-2885)
**Dependencies:** Need access to `variableDeclarations` and `parameters` collections

**Current (lines 2873-2885):**
```typescript
private bufferObjectPropertyEdges(objectProperties: ObjectPropertyInfo[]): void {
  for (const prop of objectProperties) {
    // Only create edge if we have a destination node ID
    if (prop.valueNodeId) {
      this._bufferEdge({
        type: 'HAS_PROPERTY',
        src: prop.objectId,
        dst: prop.valueNodeId,
        propertyName: prop.propertyName
      });
    }
  }
}
```

**Proposed:**
```typescript
private bufferObjectPropertyEdges(
  objectProperties: ObjectPropertyInfo[],
  variableDeclarations: VariableDeclarationInfo[],
  parameters: ParameterInfo[]
): void {
  for (const prop of objectProperties) {
    // REG-329: Handle VARIABLE value types with scope resolution
    if (prop.valueType === 'VARIABLE' && prop.valueName) {
      const scopePath = prop.valueScopePath ?? [];
      const file = prop.file;

      // Resolve variable using scope chain
      const resolvedVar = this.resolveVariableInScope(
        prop.valueName, scopePath, file, variableDeclarations
      );
      const resolvedParam = !resolvedVar
        ? this.resolveParameterInScope(prop.valueName, scopePath, file, parameters)
        : null;

      const resolvedNodeId = resolvedVar?.id ?? resolvedParam?.id;

      if (resolvedNodeId) {
        this._bufferEdge({
          type: 'HAS_PROPERTY',
          src: prop.objectId,
          dst: resolvedNodeId,
          propertyName: prop.propertyName
        });
      }
      continue;
    }

    // Existing logic for non-VARIABLE types
    if (prop.valueNodeId) {
      this._bufferEdge({
        type: 'HAS_PROPERTY',
        src: prop.objectId,
        dst: prop.valueNodeId,
        propertyName: prop.propertyName
      });
    }
  }
}
```

### Step 4: Update Method Signature at Call Site

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
**Line:** ~329 (where bufferObjectPropertyEdges is called)

**Current:**
```typescript
this.bufferObjectPropertyEdges(objectProperties);
```

**Proposed:**
```typescript
this.bufferObjectPropertyEdges(objectProperties, variableDeclarations, parameters);
```

## 4. Big-O Complexity Analysis

### Current Implementation
- `bufferObjectPropertyEdges`: O(P) where P = number of object properties
- Each property edge creation: O(1)

### Proposed Implementation
- `bufferObjectPropertyEdges`: O(P * V) in worst case
  - P = number of object properties
  - V = number of variable declarations (for linear scan in `resolveVariableInScope`)

**However**, this matches the existing pattern for mutations:
- `bufferArrayMutationEdges`: O(M * V)
- `bufferObjectMutationEdges`: O(M * V)

### Mitigation
The scope chain walk-up limits the number of comparisons:
```typescript
for (let i = scopePath.length; i >= 0; i--) {
  // At most scopePath.length + 1 iterations
}
```

For typical code with shallow nesting (3-5 scope levels), this is effectively O(P * 5 * V/S) where S is the average scope-filtered variable count.

### Performance Impact Assessment
**LOW RISK**: This operation runs during graph building (one-time analysis phase), not during queries. The pattern is already proven with mutations.

## 5. Edge Cases

### 5.1 Shadowing

```javascript
const x = 'outer';
function handler() {
  const x = 'inner';  // Shadows outer
  return { value: x };  // Should resolve to inner x
}
```

**Handled by:** Scope chain walk-up algorithm starts from innermost scope and returns first match.

### 5.2 Module-Level Variables

```javascript
const API_KEY = 'secret';  // Module level
router.get('/', (req, res) => {
  res.json({ key: API_KEY });  // Should resolve to module-level
});
```

**Handled by:** REG-309 fix already handles empty scope path `[]` matching semantic ID scope `['global']` (GraphBuilder.ts lines 2150-2152).

### 5.3 Parameter References

```javascript
function transform(input) {
  return { data: input };  // input is a parameter, not variable
}
```

**Handled by:** Resolution falls back to `resolveParameterInScope` if variable lookup fails.

### 5.4 Nested Object Literals

```javascript
const config = { url: 'api' };
fetch({
  options: {
    endpoint: config  // Nested object with variable ref
  }
});
```

**Handled by:** Recursive call to `extractObjectProperties` passes same scopeTracker, so scope context is preserved.

### 5.5 Computed Properties

```javascript
const key = 'name';
obj = { [key]: value };  // Computed property key
```

**Current behavior:** propertyName is `<computed>`, and value resolution applies if value is VARIABLE.

### 5.6 Spread Properties

```javascript
const defaults = { a: 1 };
obj = { ...defaults };  // Spread
```

**Current behavior:** valueType is SPREAD (not VARIABLE), so no scope resolution needed. The spread source variable is already tracked via `valueName` for SPREAD type.

## 6. Test Plan

### 6.1 New Test File

Create: `test/unit/object-property-scope-resolution.test.js`

### 6.2 Test Cases

#### TC1: Module-Level Variable Reference
```javascript
const API_KEY = 'secret';
configure({ key: API_KEY });
```
**Assert:** HAS_PROPERTY edge from OBJECT_LITERAL to VARIABLE node for API_KEY

#### TC2: Local Scope Variable Reference
```javascript
function handler() {
  const localVar = 'value';
  process({ data: localVar });
}
```
**Assert:** HAS_PROPERTY edge resolves to correct VARIABLE in handler scope

#### TC3: Variable Shadowing
```javascript
const x = 'outer';
function handler() {
  const x = 'inner';
  process({ value: x });
}
```
**Assert:** Edge resolves to inner `x`, not outer `x`

#### TC4: Nested Function Scope
```javascript
function outer() {
  const outerVar = 1;
  function inner() {
    process({ data: outerVar });
  }
}
```
**Assert:** Edge resolves to `outerVar` in outer scope via scope chain

#### TC5: Parameter Reference
```javascript
function transform(input) {
  return { data: input };
}
```
**Assert:** HAS_PROPERTY edge to PARAMETER node

#### TC6: Multiple Properties with Different Scopes
```javascript
const globalConfig = { };
function handler() {
  const localConfig = { };
  merge({ global: globalConfig, local: localConfig });
}
```
**Assert:** Two edges resolve to correct scopes respectively

#### TC7: Deeply Nested Object with Variable
```javascript
const secret = 'key';
api({ options: { auth: { token: secret } } });
```
**Assert:** Edge from innermost nested object to module-level variable

## 7. Rollback Plan

### Minimal Rollback
1. Remove `valueScopePath` field addition from `ObjectPropertyInfo`
2. Revert `bufferObjectPropertyEdges` to original implementation
3. Revert call site to not pass extra parameters

### Git Strategy
All changes in single commit. Use `git revert <commit>` if issues arise.

## 8. Implementation Order

1. **types.ts** - Add `valueScopePath` field (no runtime impact)
2. **CallExpressionVisitor.ts** - Capture scope path (data collection only)
3. **GraphBuilder.ts** - Add resolution logic
4. **Tests** - Verify behavior
5. **Existing tests** - Ensure no regression

## 9. Dependencies and Blockers

### Prerequisites
- REG-309 (scope chain resolution) - **DONE** (already merged)

### Blocks
- REG-326 (blocked by this task per user request)
