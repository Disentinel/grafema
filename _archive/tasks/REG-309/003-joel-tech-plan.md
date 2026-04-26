# Joel Spolsky - Technical Implementation Plan for REG-309

**Task**: Scope-aware variable lookup for mutations
**Date**: 2026-02-01
**Author**: Joel Spolsky (Implementation Planner)

---

## Executive Summary

This plan implements Don's recommended **Option B: Late Binding with Scope Chain Resolution**. The implementation has 4 phases:

1. Extend mutation info types with scope path
2. Update analysis handlers to capture scope
3. Implement scope chain resolver in GraphBuilder
4. Update all three mutation edge handlers to use scope-aware lookup

**Key Finding**: Variable `id` field IS the semantic ID (when scopeTracker is available). There's NO separate `semanticId` field populated for variables, unlike parameters which set both fields.

---

## Phase 1: Extend Mutation Info Types

### File: `packages/core/src/plugins/analysis/ast/types.ts`

**Change 1: VariableReassignmentInfo** (around line 380)

```typescript
export interface VariableReassignmentInfo {
  variableName: string;           // Name of variable being reassigned
  variableLine: number;           // Line where variable is referenced on LHS
  mutationScopePath?: string[];   // NEW: Scope path where mutation happens (from ScopeTracker)
  valueType: 'VARIABLE' | 'CALL_SITE' | 'METHOD_CALL' | 'LITERAL' | 'EXPRESSION';
  // ... rest unchanged
}
```

**Change 2: ArrayMutationInfo** (around line 390)

```typescript
export interface ArrayMutationInfo {
  id?: string;                 // Semantic ID for the mutation (optional for backward compatibility)
  arrayName: string;           // Name of the array variable being mutated
  arrayLine?: number;          // Line where array is referenced (for scope resolution)
  mutationScopePath?: string[];  // NEW: Scope path where mutation happens
  mutationMethod: 'push' | 'unshift' | 'splice' | 'indexed';
  // ... rest unchanged
}
```

**Change 3: ObjectMutationInfo** (around line 405)

```typescript
export interface ObjectMutationInfo {
  id?: string;                   // Semantic ID for the mutation (optional for backward compatibility)
  objectName: string;            // Name of the object being mutated ('config', 'this', etc.)
  objectLine?: number;           // Line where object is referenced (for scope resolution)
  mutationScopePath?: string[];  // NEW: Scope path where mutation happens
  enclosingClassName?: string;   // Class name when objectName === 'this' (REG-152)
  // ... rest unchanged
}
```

**Rationale**: All three fields are optional (`?:`) for backward compatibility. Scope path is empty array `[]` for module-level mutations.

---

## Phase 2: Update Analysis Handlers to Capture Scope

### File: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Change 1: detectVariableReassignment - Add scopeTracker parameter**

**Location**: Method signature around line 3645

**Before**:
```typescript
private detectVariableReassignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  variableReassignments: VariableReassignmentInfo[]
): void {
```

**After**:
```typescript
private detectVariableReassignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  variableReassignments: VariableReassignmentInfo[],
  scopeTracker?: ScopeTracker
): void {
```

**Change 2: Capture scope path in detectVariableReassignment**

**Location**: Inside detectVariableReassignment, around line 3680 (where VariableReassignmentInfo is created)

**Before**:
```typescript
variableReassignments.push({
  variableName,
  variableLine: line,
  valueType,
  // ... other fields
  file: module.file,
  line,
  column
});
```

**After**:
```typescript
const scopePath = scopeTracker?.getContext().scopePath ?? [];

variableReassignments.push({
  variableName,
  variableLine: line,
  mutationScopePath: scopePath,  // NEW
  valueType,
  // ... other fields
  file: module.file,
  line,
  column
});
```

**Change 3: Update detectVariableReassignment call sites**

**Call Site 1**: Module-level (around line 1390)

**Before**:
```typescript
this.detectVariableReassignment(assignNode, module, variableReassignments);
```

**After**:
```typescript
this.detectVariableReassignment(assignNode, module, variableReassignments, scopeTracker);
```

**Call Site 2**: Function-level (around line 2748)

**Before**:
```typescript
this.detectVariableReassignment(assignNode, module, variableReassignments);
```

**After**:
```typescript
this.detectVariableReassignment(assignNode, module, variableReassignments, scopeTracker);
```

**Change 4: detectIndexedArrayAssignment - Add scopeTracker parameter**

**Location**: Method signature around line 3742

**Before**:
```typescript
private detectIndexedArrayAssignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  arrayMutations: ArrayMutationInfo[]
): void {
```

**After**:
```typescript
private detectIndexedArrayAssignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  arrayMutations: ArrayMutationInfo[],
  scopeTracker?: ScopeTracker
): void {
```

**Change 5: Capture scope path in detectIndexedArrayAssignment**

**Location**: Inside detectIndexedArrayAssignment, around line 3790 (where ArrayMutationInfo is created)

**Before**:
```typescript
arrayMutations.push({
  arrayName,
  mutationMethod: 'indexed',
  file: module.file,
  line,
  column,
  insertedValues: [argInfo]
});
```

**After**:
```typescript
const scopePath = scopeTracker?.getContext().scopePath ?? [];

arrayMutations.push({
  arrayName,
  mutationScopePath: scopePath,  // NEW
  mutationMethod: 'indexed',
  file: module.file,
  line,
  column,
  insertedValues: [argInfo]
});
```

**Change 6: Update detectIndexedArrayAssignment call sites**

**Call Site 1**: Module-level (around line 1395)

**Before**:
```typescript
this.detectIndexedArrayAssignment(assignNode, module, arrayMutations);
```

**After**:
```typescript
this.detectIndexedArrayAssignment(assignNode, module, arrayMutations, scopeTracker);
```

**Call Site 2**: Function-level (around line 2759)

**Before**:
```typescript
this.detectIndexedArrayAssignment(assignNode, module, arrayMutations);
```

**After**:
```typescript
this.detectIndexedArrayAssignment(assignNode, module, arrayMutations, scopeTracker);
```

**Change 7: Capture scope path in detectObjectPropertyAssignment**

**Location**: Inside detectObjectPropertyAssignment, around line 3850 (where ObjectMutationInfo is created)

**Note**: This method ALREADY receives scopeTracker parameter (line 3810), we just need to use it.

**Before**:
```typescript
objectMutations.push({
  objectName,
  propertyName: propertyName || '<unknown>',
  mutationType,
  computedPropertyVar,
  file: module.file,
  line,
  column,
  value: mutationValue,
  enclosingClassName
});
```

**After**:
```typescript
const scopePath = scopeTracker?.getContext().scopePath ?? [];

objectMutations.push({
  objectName,
  mutationScopePath: scopePath,  // NEW
  propertyName: propertyName || '<unknown>',
  mutationType,
  computedPropertyVar,
  file: module.file,
  line,
  column,
  value: mutationValue,
  enclosingClassName
});
```

### File: `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Change 8: Capture scope path in detectArrayMutation**

**Location**: Inside detectArrayMutation method, around line 885 (where ArrayMutationInfo is created)

**Note**: This class already has `this.scopeTracker` (line 188), we just need to use it for scope path.

**Before**:
```typescript
arrayMutations.push({
  id: mutationId,
  arrayName,
  mutationMethod: method,
  file: module.file,
  line,
  column,
  insertedValues: mutationArgs,
  // REG-117: Nested mutation fields
  isNested,
  baseObjectName,
  propertyName
});
```

**After**:
```typescript
const scopePath = this.scopeTracker?.getContext().scopePath ?? [];

arrayMutations.push({
  id: mutationId,
  arrayName,
  mutationScopePath: scopePath,  // NEW
  mutationMethod: method,
  file: module.file,
  line,
  column,
  insertedValues: mutationArgs,
  // REG-117: Nested mutation fields
  isNested,
  baseObjectName,
  propertyName
});
```

**Change 9: Capture scope path in detectObjectAssign**

**Location**: Inside detectObjectAssign method, around line 974 (where ObjectMutationInfo is created)

**Before**:
```typescript
objectMutations.push({
  objectName,
  propertyName: '<assign>',
  mutationType: 'assign',
  file: module.file,
  line,
  column,
  value: sourceValue
});
```

**After**:
```typescript
const scopePath = this.scopeTracker?.getContext().scopePath ?? [];

objectMutations.push({
  objectName,
  mutationScopePath: scopePath,  // NEW
  propertyName: '<assign>',
  mutationType: 'assign',
  file: module.file,
  line,
  column,
  value: sourceValue
});
```

---

## Phase 3: Implement Scope Chain Resolver in GraphBuilder

### File: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Change 1: Add parseSemanticId import**

**Location**: Top of file, around line 14

**Add**:
```typescript
import { computeSemanticId, parseSemanticId } from '../../../core/SemanticId.js';
```

**Change 2: Add resolveVariableInScope method**

**Location**: Add as private method, around line 1730 (before bufferVariableReassignmentEdges)

```typescript
/**
 * Resolve variable by name using scope chain lookup.
 * Mirrors JavaScript lexical scoping: search current scope, then parent, then grandparent, etc.
 *
 * @param name - Variable name
 * @param scopePath - Scope path where reference occurs (from ScopeTracker)
 * @param file - File path
 * @param variables - All variable declarations
 * @returns Variable declaration or null if not found
 */
private resolveVariableInScope(
  name: string,
  scopePath: string[],
  file: string,
  variables: VariableDeclarationInfo[]
): VariableDeclarationInfo | null {
  // Try current scope, then parent, then grandparent, etc.
  for (let i = scopePath.length; i >= 0; i--) {
    const searchScopePath = scopePath.slice(0, i);

    const matchingVar = variables.find(v => {
      if (v.name !== name || v.file !== file) return false;

      // Variable ID IS the semantic ID (when scopeTracker was available during analysis)
      // Format: file->scope1->scope2->TYPE->name
      // Legacy format: VARIABLE#name#file#line:column:counter

      // Try parsing as semantic ID
      const parsed = parseSemanticId(v.id);
      if (parsed && parsed.type === 'VARIABLE') {
        // Semantic ID found - compare scope paths
        return this.scopePathsMatch(parsed.scopePath, searchScopePath);
      }

      // Legacy ID - assume module-level if no semantic ID
      return searchScopePath.length === 0;
    });

    if (matchingVar) return matchingVar;
  }

  return null;
}

/**
 * Check if two scope paths match.
 * Handles: ['foo', 'if#0'] vs ['foo', 'if#0']
 */
private scopePathsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, idx) => item === b[idx]);
}
```

**Rationale**:
- Variable `id` IS the semantic ID (no separate `semanticId` field for variables)
- `parseSemanticId()` handles both semantic and legacy formats
- Scope chain walk mirrors JavaScript: inner scope first, then outer scopes
- Empty scope path `[]` means module-level variable

---

## Phase 4: Update Mutation Edge Handlers

### File: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Change 1: Update bufferVariableReassignmentEdges**

**Location**: Around line 1753-1796

**Before** (line 1760-1791):
```typescript
// Build lookup cache: O(n) instead of O(n*m)
const varLookup = new Map<string, VariableDeclarationInfo>();
for (const v of variableDeclarations) {
  varLookup.set(`${v.file}:${v.name}`, v);
}

const paramLookup = new Map<string, ParameterInfo>();
for (const p of parameters) {
  paramLookup.set(`${p.file}:${p.name}`, p);
}

for (const reassignment of variableReassignments) {
  // ... destructure fields ...

  // Find target variable node
  const targetVar = varLookup.get(`${file}:${variableName}`);
  const targetParam = !targetVar ? paramLookup.get(`${file}:${variableName}`) : null;
  const targetNodeId = targetVar?.id ?? targetParam?.id;

  if (!targetNodeId) {
    // Variable not found - could be module-level or external reference
    continue;
  }
```

**After**:
```typescript
// Note: No longer using Map-based cache - scope-aware lookup requires scope chain walk
// Performance: O(n*m*s) where s = scope depth (typically 2-3), acceptable for correctness

for (const reassignment of variableReassignments) {
  const {
    variableName,
    mutationScopePath,
    valueType,
    valueName,
    valueId,
    callLine,
    callColumn,
    operator,
    literalValue,
    expressionType,
    expressionMetadata,
    file,
    line,
    column
  } = reassignment;

  // Find target variable node using scope chain resolution
  const scopePath = mutationScopePath ?? [];
  const targetVar = this.resolveVariableInScope(variableName, scopePath, file, variableDeclarations);

  // If not found as variable, try parameters (parameters use separate lookup)
  let targetParam: ParameterInfo | undefined;
  if (!targetVar) {
    // Parameters are in function scope - try same scope chain logic
    targetParam = parameters.find(p => {
      if (p.name !== variableName || p.file !== file) return false;

      // Parameters have semanticId field populated (unlike variables)
      if (p.semanticId) {
        const parsed = parseSemanticId(p.semanticId);
        if (parsed && parsed.type === 'PARAMETER') {
          // Check if parameter's scope matches any scope in the chain
          for (let i = scopePath.length; i >= 0; i--) {
            if (this.scopePathsMatch(parsed.scopePath, scopePath.slice(0, i))) {
              return true;
            }
          }
        }
      }
      return false;
    });
  }

  const targetNodeId = targetVar?.id ?? targetParam?.id;

  if (!targetNodeId) {
    // Variable not found - could be external reference
    continue;
  }
```

**Change 2: Update bufferArrayMutationEdges**

**Location**: Around line 1587-1626

**Before** (line 1592-1626):
```typescript
// Build lookup cache once: O(n) instead of O(n*m) with find() per mutation
const varLookup = new Map<string, VariableDeclarationInfo>();
for (const v of variableDeclarations) {
  varLookup.set(`${v.file}:${v.name}`, v);
}

// Build parameter lookup cache for function-level mutations
const paramLookup = new Map<string, ParameterInfo>();
for (const p of parameters) {
  paramLookup.set(`${p.file}:${p.name}`, p);
}

for (const mutation of arrayMutations) {
  const { arrayName, mutationMethod, insertedValues, file, isNested, baseObjectName, propertyName } = mutation;

  // REG-117: For nested mutations (obj.arr.push), resolve target node
  // First try direct lookup, then fallback to base object
  let targetNodeId: string | null = null;
  let nestedProperty: string | undefined;

  if (isNested && baseObjectName) {
    // Skip 'this.items.push' - 'this' is not a variable node
    if (baseObjectName === 'this') continue;

    // Nested mutation: try base object lookup
    const baseVar = varLookup.get(`${file}:${baseObjectName}`);
    const baseParam = !baseVar ? paramLookup.get(`${file}:${baseObjectName}`) : null;
    targetNodeId = baseVar?.id ?? baseParam?.id ?? null;
    nestedProperty = propertyName;
  } else {
    // Direct mutation: arr.push()
    const arrayVar = varLookup.get(`${file}:${arrayName}`);
    const arrayParam = !arrayVar ? paramLookup.get(`${file}:${arrayName}`) : null;
    targetNodeId = arrayVar?.id ?? arrayParam?.id ?? null;
  }

  if (!targetNodeId) continue;
```

**After**:
```typescript
// Note: No longer using Map-based cache - scope-aware lookup requires scope chain walk

for (const mutation of arrayMutations) {
  const { arrayName, mutationScopePath, mutationMethod, insertedValues, file, isNested, baseObjectName, propertyName } = mutation;

  const scopePath = mutationScopePath ?? [];

  // REG-117: For nested mutations (obj.arr.push), resolve target node
  let targetNodeId: string | null = null;
  let nestedProperty: string | undefined;

  if (isNested && baseObjectName) {
    // Skip 'this.items.push' - 'this' is not a variable node
    if (baseObjectName === 'this') continue;

    // Nested mutation: try base object lookup with scope chain
    const baseVar = this.resolveVariableInScope(baseObjectName, scopePath, file, variableDeclarations);
    let baseParam: ParameterInfo | undefined;
    if (!baseVar) {
      baseParam = parameters.find(p => {
        if (p.name !== baseObjectName || p.file !== file) return false;
        if (p.semanticId) {
          const parsed = parseSemanticId(p.semanticId);
          if (parsed && parsed.type === 'PARAMETER') {
            for (let i = scopePath.length; i >= 0; i--) {
              if (this.scopePathsMatch(parsed.scopePath, scopePath.slice(0, i))) {
                return true;
              }
            }
          }
        }
        return false;
      });
    }
    targetNodeId = baseVar?.id ?? baseParam?.id ?? null;
    nestedProperty = propertyName;
  } else {
    // Direct mutation: arr.push()
    const arrayVar = this.resolveVariableInScope(arrayName, scopePath, file, variableDeclarations);
    let arrayParam: ParameterInfo | undefined;
    if (!arrayVar) {
      arrayParam = parameters.find(p => {
        if (p.name !== arrayName || p.file !== file) return false;
        if (p.semanticId) {
          const parsed = parseSemanticId(p.semanticId);
          if (parsed && parsed.type === 'PARAMETER') {
            for (let i = scopePath.length; i >= 0; i--) {
              if (this.scopePathsMatch(parsed.scopePath, scopePath.slice(0, i))) {
                return true;
              }
            }
          }
        }
        return false;
      });
    }
    targetNodeId = arrayVar?.id ?? arrayParam?.id ?? null;
  }

  if (!targetNodeId) continue;
```

**Change 3: Update bufferObjectMutationEdges**

**Location**: Around line 1665-1710

**Before** (line 1708-1710):
```typescript
// Find the source: can be variable, parameter, or function (arrow functions assigned to const)
const sourceVar = variableDeclarations.find(v => v.name === value.valueName && v.file === file);
const sourceParam = !sourceVar ? parameters.find(p => p.name === value.valueName && p.file === file) : null;
const sourceFunc = !sourceVar && !sourceParam ? functions.find(f => f.name === value.valueName && f.file === file) : null;
const sourceNodeId = sourceVar?.id ?? sourceParam?.id ?? sourceFunc?.id;
```

**After**:
```typescript
// Find the source: can be variable, parameter, or function (arrow functions assigned to const)
// Use scope chain resolution for variables
const mutationScopePath = mutation.mutationScopePath ?? [];
const sourceVar = this.resolveVariableInScope(value.valueName, mutationScopePath, file, variableDeclarations);

let sourceParam: ParameterInfo | undefined;
if (!sourceVar) {
  sourceParam = parameters.find(p => {
    if (p.name !== value.valueName || p.file !== file) return false;
    if (p.semanticId) {
      const parsed = parseSemanticId(p.semanticId);
      if (parsed && parsed.type === 'PARAMETER') {
        for (let i = mutationScopePath.length; i >= 0; i--) {
          if (this.scopePathsMatch(parsed.scopePath, mutationScopePath.slice(0, i))) {
            return true;
          }
        }
      }
    }
    return false;
  });
}

const sourceFunc = !sourceVar && !sourceParam ? functions.find(f => f.name === value.valueName && f.file === file) : null;
const sourceNodeId = sourceVar?.id ?? sourceParam?.id ?? sourceFunc?.id;
```

**Note**: Object mutation target lookup is more complex (around line 1665-1680) and handles `this` specially. We need to add scope-aware lookup for the TARGET variable as well:

**Location**: Around line 1665-1680

**Before**:
```typescript
// Determine target node based on objectName
let objectNodeId: string | null = null;
let effectiveMutationType = mutationType;

if (objectName === 'this') {
  // 'this' mutations in class context - resolve to class node
  if (enclosingClassName) {
    const targetClass = classDeclarations.find(c => c.name === enclosingClassName && c.file === file);
    objectNodeId = targetClass?.id ?? null;
    // Use special mutation type to distinguish from regular property mutations
    effectiveMutationType = 'this_property';
  }
} else {
  // Regular object mutation - find variable, parameter, or function
  const targetVar = variableDeclarations.find(v => v.name === objectName && v.file === file);
  const targetParam = !targetVar ? parameters.find(p => p.name === objectName && p.file === file) : null;
  const targetFunc = !targetVar && !targetParam ? functions.find(f => f.name === objectName && f.file === file) : null;
  objectNodeId = targetVar?.id ?? targetParam?.id ?? targetFunc?.id ?? null;
}
```

**After**:
```typescript
// Determine target node based on objectName
let objectNodeId: string | null = null;
let effectiveMutationType = mutationType;
const mutationScopePath = mutation.mutationScopePath ?? [];

if (objectName === 'this') {
  // 'this' mutations in class context - resolve to class node
  if (enclosingClassName) {
    const targetClass = classDeclarations.find(c => c.name === enclosingClassName && c.file === file);
    objectNodeId = targetClass?.id ?? null;
    // Use special mutation type to distinguish from regular property mutations
    effectiveMutationType = 'this_property';
  }
} else {
  // Regular object mutation - find variable, parameter, or function using scope chain
  const targetVar = this.resolveVariableInScope(objectName, mutationScopePath, file, variableDeclarations);

  let targetParam: ParameterInfo | undefined;
  if (!targetVar) {
    targetParam = parameters.find(p => {
      if (p.name !== objectName || p.file !== file) return false;
      if (p.semanticId) {
        const parsed = parseSemanticId(p.semanticId);
        if (parsed && parsed.type === 'PARAMETER') {
          for (let i = mutationScopePath.length; i >= 0; i--) {
            if (this.scopePathsMatch(parsed.scopePath, mutationScopePath.slice(0, i))) {
              return true;
            }
          }
        }
      }
      return false;
    });
  }

  const targetFunc = !targetVar && !targetParam ? functions.find(f => f.name === objectName && f.file === file) : null;
  objectNodeId = targetVar?.id ?? targetParam?.id ?? targetFunc?.id ?? null;
}
```

---

## Dependency Order

The changes MUST be done in this order to maintain working state:

1. **Phase 1**: Extend types (breaking change - requires rebuilds)
2. **Phase 2**: Update analysis handlers (populate new fields)
3. **Phase 3**: Add resolver to GraphBuilder (utility methods)
4. **Phase 4**: Update edge handlers (use resolver)

After each phase, run:
```bash
pnpm build
```

Do NOT run tests until all phases are complete - intermediate states will have type errors.

---

## Performance Analysis

**Before**: O(n) - Map-based lookup cache
**After**: O(n*m*s) where:
- n = number of mutations
- m = number of variables in file
- s = scope depth (typically 2-3)

**Mitigation**:
- Most files have shallow nesting (s ≤ 3)
- Most files have <100 variables (m ≤ 100)
- Correctness is more important than micro-optimization
- Can add scope-indexed cache later if profiling shows bottleneck

**Optimization possibility** (defer to future):
Build a Map with compound key `file:scope:name`:
```typescript
const scopedVarCache = new Map<string, VariableDeclarationInfo>();
for (const v of variableDeclarations) {
  const parsed = parseSemanticId(v.id);
  if (parsed) {
    const key = `${v.file}:${parsed.scopePath.join('->')}:${v.name}`;
    scopedVarCache.set(key, v);
  }
}
```

Then scope chain lookup becomes O(s) instead of O(m*s).

---

## Semantic ID Coverage

**Finding**: Variable `id` field IS the semantic ID (when scopeTracker was available).

**Evidence**:
1. `IdGenerator.generate()` returns semantic ID when scopeTracker is present (IdGenerator.ts:88)
2. Variables use `IdGenerator.generate()` (VariableVisitor.ts:278)
3. Parameters set BOTH `id` and `semanticId` to same value (createParameterNodes.ts:56-57, 72-73, 90-91)

**Fallback strategy**:
- If `parseSemanticId(v.id)` returns null → legacy ID format
- Assume module-level (scope path = `[]`)
- This handles old graph data or variables created without scopeTracker

**Question for Don**: Should we require ALL variables to have semantic IDs? Or is fallback acceptable?

---

## Module-Level Scope

**Answer**: Module-level variables have scope path = `[]` (empty array).

**Evidence**:
- `ScopeTracker.getContext()` returns `scopePath: this.scopeStack.map(s => s.name)` (ScopeTracker.ts:86)
- Empty stack → empty array
- `computeSemanticId()` with empty scope path generates: `file->VARIABLE->name`

**Testing**: Verify that module-level mutations work correctly with scope path `[]`.

---

## Parameter vs Variable Lookup

**Current approach**: Parameters have separate lookup logic because:
1. Parameters have `semanticId` field populated (variables don't)
2. Parameters are in function scope but declared at function level
3. Current code has separate `paramLookup` Map

**Proposed approach**: Use same scope chain logic for parameters.

**Rationale**:
- Parameters are just variables in function scope
- Scope chain walk handles both correctly
- Reduces code duplication

**Implementation**: For each mutation handler, if variable not found, try parameters with scope chain walk.

---

## Array Mutation Call Sites

**Finding**: Array mutations via method calls (push, pop, etc.) are tracked in `CallExpressionVisitor.detectArrayMutation()`.

**Location**: `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts:817`

**Scope availability**: Yes, via `this.scopeTracker` (constructor at line 195)

**Change required**: Capture scope path when creating ArrayMutationInfo (around line 885).

---

## Test Strategy

Kent Beck will create tests, but here are the scenarios:

1. **Basic shadowing** (variable reassignment):
   ```javascript
   let x = 1;
   function foo() {
     let x = 2;
     x += 3;  // Should FLOWS_INTO inner x, not outer x
   }
   ```

2. **Parent scope lookup** (variable reassignment):
   ```javascript
   let total = 0;
   for (const item of items) {
     total += item.price;  // Should FLOWS_INTO outer total
   }
   ```

3. **Array mutation shadowing**:
   ```javascript
   let arr = [];
   function foo() {
     let arr = [];
     arr.push(1);  // Should FLOWS_INTO inner arr
   }
   ```

4. **Object mutation shadowing**:
   ```javascript
   let obj = {};
   if (condition) {
     let obj = {};
     obj.prop = 1;  // Should FLOWS_INTO inner obj
   }
   ```

5. **Multiple nesting levels**:
   ```javascript
   let x = 1;
   function outer() {
     let x = 2;
     function inner() {
       let x = 3;
       x += 4;  // Should FLOWS_INTO innermost x
     }
   }
   ```

6. **Module-level mutation** (scope path = []):
   ```javascript
   let count = 0;
   count++;  // Should FLOWS_INTO module-level count
   ```

---

## Edge Cases

1. **Parameters in nested scopes**:
   ```javascript
   function outer(x) {
     function inner() {
       x++;  // Should FLOWS_INTO parameter x (parent scope)
     }
   }
   ```

2. **Arrow functions**:
   ```javascript
   let x = 1;
   const fn = () => {
     let x = 2;
     x++;  // Should FLOWS_INTO inner x
   };
   ```

3. **Class methods**:
   ```javascript
   class Foo {
     method() {
       let x = 1;
       x++;  // Should FLOWS_INTO method-scoped x
     }
   }
   ```

---

## Risks and Mitigation

### High Risk: Semantic ID parsing reliability

**Risk**: What if parseSemanticId fails on valid IDs?

**Mitigation**:
- Fallback to module-level (scope path = [])
- Add logging for parse failures
- Test with real codebase data

### Medium Risk: Performance regression

**Risk**: O(n*m*s) lookup is slower than O(n) Map lookup

**Mitigation**:
- Measure before/after on large files
- Most files have shallow nesting (s ≤ 3)
- Can optimize later with scope-indexed cache

### Low Risk: Parameter lookup complexity

**Risk**: Separate parameter logic is more complex

**Mitigation**:
- Extract parameter scope chain logic to helper method
- Reuse across all three handlers

---

## Open Questions for Don

1. **Semantic ID coverage**: Should we require ALL variables have semantic IDs? Or is fallback to module-level acceptable for legacy data?

2. **Performance optimization**: Should we build scope-indexed cache now, or defer until profiling shows bottleneck?

3. **Parameter lookup**: Should we extract parameter scope chain logic to separate helper method? Or inline in each handler?

4. **Function-level variables**: Should functions (arrow functions assigned to const) use same scope chain logic? Or keep current file-level lookup?

---

## Summary

This plan implements scope-aware variable lookup for all three mutation types (variable reassignment, array mutation, object mutation). The core insight is that variable `id` IS the semantic ID, and we can parse it to extract scope path for scope chain resolution.

**Total changes**:
- 3 interfaces extended (types.ts)
- 9 analysis handler updates (JSASTAnalyzer.ts + CallExpressionVisitor.ts)
- 2 new methods in GraphBuilder (resolveVariableInScope, scopePathsMatch)
- 3 edge handler updates (GraphBuilder.ts)

**Next step**: Don reviews this plan. If approved, Kent writes tests, Rob implements.

---

## Revision 1: Fixes for Linus's Review

**Date**: 2026-02-01
**Author**: Joel Spolsky
**Reviewer**: Linus Torvalds

### Critical Bugs Fixed

Linus identified two critical issues in my original plan:

1. **Module-level scope matching bug** - Empty search scope `[]` won't match semantic ID scope `['global']`
2. **Parameter lookup duplication** - Same logic copied six times across handlers

---

### Bug 1: Module-Level Scope Matching

**The Problem**:

From SemanticId.ts line 85:
```typescript
const scope = scopePath.length > 0 ? scopePath.join('->') : 'global';
```

When `scopePath = []` (empty), the scope string becomes `'global'`.

So module-level variable semantic ID is: `file->global->VARIABLE->name`

When `parseSemanticId()` parses this:
```typescript
const scopePath = parts.slice(1, -2);  // ['global']
```

Result: Module-level variables have `scopePath = ['global']`, NOT `[]`.

**My original code was WRONG**:
```typescript
// Legacy ID - assume module-level if no semantic ID
return searchScopePath.length === 0;
```

When searching for module-level variable (`searchScopePath = []`), this compares with semantic ID scope `['global']` - they DON'T match!

**The Fix**:

Updated `resolveVariableInScope` method:

```typescript
private resolveVariableInScope(
  name: string,
  scopePath: string[],
  file: string,
  variables: VariableDeclarationInfo[]
): VariableDeclarationInfo | null {
  // Try current scope, then parent, then grandparent, etc.
  for (let i = scopePath.length; i >= 0; i--) {
    const searchScopePath = scopePath.slice(0, i);

    const matchingVar = variables.find(v => {
      if (v.name !== name || v.file !== file) return false;

      // Variable ID IS the semantic ID (when scopeTracker was available during analysis)
      // Format: file->scope1->scope2->TYPE->name
      // Legacy format: VARIABLE#name#file#line:column:counter

      // Try parsing as semantic ID
      const parsed = parseSemanticId(v.id);
      if (parsed && parsed.type === 'VARIABLE') {
        // FIXED: Handle module-level scope matching
        // Empty search scope [] should match semantic ID scope ['global']
        if (searchScopePath.length === 0) {
          return parsed.scopePath.length === 1 && parsed.scopePath[0] === 'global';
        }
        // Non-empty scope: exact match
        return this.scopePathsMatch(parsed.scopePath, searchScopePath);
      }

      // Legacy ID - assume module-level if no semantic ID
      return searchScopePath.length === 0;
    });

    if (matchingVar) return matchingVar;
  }

  return null;
}
```

**Key changes**:
- When `searchScopePath = []`, check if variable's scope is `['global']`
- Non-empty search scopes use exact match via `scopePathsMatch()`
- Legacy IDs still fall back to module-level assumption

---

### Bug 2: Parameter Lookup Duplication

**The Problem**:

My original plan duplicated parameter lookup logic SIX times:
- `bufferVariableReassignmentEdges` - once
- `bufferArrayMutationEdges` - twice (target + base object)
- `bufferObjectMutationEdges` - twice (target + source)

Each copy was 15+ lines of identical code. If we find a bug in parameter lookup, we'd have to fix it six times.

**The Fix**:

Extract to `resolveParameterInScope()` helper:

```typescript
/**
 * Resolve parameter by name using scope chain lookup.
 * Same semantics as resolveVariableInScope but for parameters.
 *
 * @param name - Parameter name
 * @param scopePath - Scope path where reference occurs (from ScopeTracker)
 * @param file - File path
 * @param parameters - All parameter declarations
 * @returns Parameter declaration or null if not found
 */
private resolveParameterInScope(
  name: string,
  scopePath: string[],
  file: string,
  parameters: ParameterInfo[]
): ParameterInfo | null {
  // Parameters have semanticId field populated (unlike variables which use id field)
  return parameters.find(p => {
    if (p.name !== name || p.file !== file) return false;

    if (p.semanticId) {
      const parsed = parseSemanticId(p.semanticId);
      if (parsed && parsed.type === 'PARAMETER') {
        // Check if parameter's scope matches any scope in the chain
        for (let i = scopePath.length; i >= 0; i--) {
          const searchScopePath = scopePath.slice(0, i);

          // FIXED: Handle module-level scope matching for parameters
          if (searchScopePath.length === 0) {
            if (parsed.scopePath.length === 1 && parsed.scopePath[0] === 'global') {
              return true;
            }
          } else {
            if (this.scopePathsMatch(parsed.scopePath, searchScopePath)) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }) ?? null;
}
```

**Key points**:
- Same signature pattern as `resolveVariableInScope()`
- Includes the module-level scope fix (`[]` vs `['global']`)
- Scope chain walk logic: try current scope, then parent, etc.
- Returns `null` if not found (consistent with variable resolver)

---

### Updated Handler Code

With the helper extracted, all three handlers become much simpler:

**Pattern for all handlers**:
```typescript
const scopePath = mutation.mutationScopePath ?? [];

// Resolve target (variable or parameter)
const targetVar = this.resolveVariableInScope(targetName, scopePath, file, variableDeclarations);
const targetParam = !targetVar ? this.resolveParameterInScope(targetName, scopePath, file, parameters) : null;
const targetNodeId = targetVar?.id ?? targetParam?.id;

if (!targetNodeId) continue;  // Not found - skip this mutation
```

**Changes to Phase 4**:

**Change 1: bufferVariableReassignmentEdges** (replaces old code around line 469-523):

```typescript
// Note: No longer using Map-based cache - scope-aware lookup requires scope chain walk
// Performance: O(n*m*s) where s = scope depth (typically 2-3), acceptable for correctness

for (const reassignment of variableReassignments) {
  const {
    variableName,
    mutationScopePath,
    valueType,
    valueName,
    valueId,
    callLine,
    callColumn,
    operator,
    literalValue,
    expressionType,
    expressionMetadata,
    file,
    line,
    column
  } = reassignment;

  // Find target variable node using scope chain resolution
  const scopePath = mutationScopePath ?? [];
  const targetVar = this.resolveVariableInScope(variableName, scopePath, file, variableDeclarations);
  const targetParam = !targetVar ? this.resolveParameterInScope(variableName, scopePath, file, parameters) : null;
  const targetNodeId = targetVar?.id ?? targetParam?.id;

  if (!targetNodeId) {
    // Variable not found - could be external reference
    continue;
  }

  // ... rest of handler unchanged (create edges) ...
```

**Change 2: bufferArrayMutationEdges** (replaces old code around line 572-632):

```typescript
// Note: No longer using Map-based cache - scope-aware lookup requires scope chain walk

for (const mutation of arrayMutations) {
  const { arrayName, mutationScopePath, mutationMethod, insertedValues, file, isNested, baseObjectName, propertyName } = mutation;

  const scopePath = mutationScopePath ?? [];

  // REG-117: For nested mutations (obj.arr.push), resolve target node
  let targetNodeId: string | null = null;
  let nestedProperty: string | undefined;

  if (isNested && baseObjectName) {
    // Skip 'this.items.push' - 'this' is not a variable node
    if (baseObjectName === 'this') continue;

    // Nested mutation: try base object lookup with scope chain
    const baseVar = this.resolveVariableInScope(baseObjectName, scopePath, file, variableDeclarations);
    const baseParam = !baseVar ? this.resolveParameterInScope(baseObjectName, scopePath, file, parameters) : null;
    targetNodeId = baseVar?.id ?? baseParam?.id ?? null;
    nestedProperty = propertyName;
  } else {
    // Direct mutation: arr.push()
    const arrayVar = this.resolveVariableInScope(arrayName, scopePath, file, variableDeclarations);
    const arrayParam = !arrayVar ? this.resolveParameterInScope(arrayName, scopePath, file, parameters) : null;
    targetNodeId = arrayVar?.id ?? arrayParam?.id ?? null;
  }

  if (!targetNodeId) continue;

  // ... rest of handler unchanged (create edges) ...
```

**Change 3: bufferObjectMutationEdges - Target lookup** (replaces old code around line 681-743):

```typescript
// Determine target node based on objectName
let objectNodeId: string | null = null;
let effectiveMutationType = mutationType;
const mutationScopePath = mutation.mutationScopePath ?? [];

if (objectName === 'this') {
  // 'this' mutations in class context - resolve to class node
  if (enclosingClassName) {
    const targetClass = classDeclarations.find(c => c.name === enclosingClassName && c.file === file);
    objectNodeId = targetClass?.id ?? null;
    // Use special mutation type to distinguish from regular property mutations
    effectiveMutationType = 'this_property';
  }
} else {
  // Regular object mutation - find variable, parameter, or function using scope chain
  const targetVar = this.resolveVariableInScope(objectName, mutationScopePath, file, variableDeclarations);
  const targetParam = !targetVar ? this.resolveParameterInScope(objectName, mutationScopePath, file, parameters) : null;
  const targetFunc = !targetVar && !targetParam ? functions.find(f => f.name === objectName && f.file === file) : null;
  objectNodeId = targetVar?.id ?? targetParam?.id ?? targetFunc?.id ?? null;
}
```

**Change 4: bufferObjectMutationEdges - Source lookup** (replaces old code around line 649-674 in original plan):

```typescript
// Find the source: can be variable, parameter, or function (arrow functions assigned to const)
// Use scope chain resolution for variables and parameters
const mutationScopePath = mutation.mutationScopePath ?? [];
const sourceVar = this.resolveVariableInScope(value.valueName, mutationScopePath, file, variableDeclarations);
const sourceParam = !sourceVar ? this.resolveParameterInScope(value.valueName, mutationScopePath, file, parameters) : null;
const sourceFunc = !sourceVar && !sourceParam ? functions.find(f => f.name === value.valueName && f.file === file) : null;
const sourceNodeId = sourceVar?.id ?? sourceParam?.id ?? sourceFunc?.id;
```

---

### Verification Notes

**Scope Path Consistency**:

Both mutations and variable declarations use `ScopeTracker.getContext().scopePath`, so they should be consistent. Kent's tests should verify this explicitly.

**Test cases to add**:
1. Module-level variable mutation (scope path `[]` → matches semantic ID scope `['global']`)
2. Module-level parameter mutation (same fix applies)
3. Scope path consistency check - verify that mutations and variables use same scope path format

---

### Summary of Changes

**New helpers added to GraphBuilder** (Phase 3):
1. `resolveVariableInScope()` - WITH module-level scope fix
2. `resolveParameterInScope()` - NEW helper, includes same fix
3. `scopePathsMatch()` - unchanged from original plan

**Handler updates simplified** (Phase 4):
- All handlers now use the two helpers
- No more duplicated parameter lookup logic
- Consistent pattern across all three handlers

**Lines of code**:
- Original plan: ~180 lines of handler logic (with duplication)
- Revised plan: ~80 lines of handler logic (using helpers)
- **Net reduction: ~100 lines**

**Bugs fixed**:
- Module-level scope matching: FIXED in both helpers
- Parameter lookup duplication: ELIMINATED via extraction

---

**Joel Spolsky**
Implementation Planner, Grafema
