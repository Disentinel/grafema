# REG-117: Track Nested Array Mutations - Technical Implementation Plan

**Author:** Joel Spolsky (Implementation Planner)  
**Date:** 2025-01-23  
**Status:** Ready for Kent (Tests) and Rob (Implementation)

---

## Overview

This document provides step-by-step implementation guidance for REG-117. The goal is to make the graph track nested array mutations like `obj.arr.push(item)` and `this.items.push(item)` by resolving them to their base objects.

**Key insight:** We already detect these mutations correctly. The problem is we store `arrayName: "obj.arr"` (string) but can't find a variable with that name. Solution: Extract the base object and property chain during detection, then resolve the base object in GraphBuilder.

---

## Implementation Strategy

Following Don's architecture analysis, we use **Approach 1: Resolve in Detection Phase** with single-level nesting support.

### High-Level Changes

1. **Phase 1:** Extend `ArrayMutationInfo` type with nested property info
2. **Phase 2:** Add member expression extraction helper
3. **Phase 3:** Update detection in both `CallExpressionVisitor` and `JSASTAnalyzer`
4. **Phase 4:** Update GraphBuilder resolution logic
5. **Phase 5:** Write comprehensive tests

---

## Phase 1: Type Extension

### File: `packages/core/src/plugins/analysis/ast/types.ts`

**Current State (lines 380-400):**
```typescript
export interface ArrayMutationInfo {
  id?: string;
  arrayName: string;           // Currently: "obj.arr" (string)
  arrayLine?: number;
  mutationMethod: 'push' | 'unshift' | 'splice' | 'indexed';
  file: string;
  line: number;
  column: number;
  insertedValues: ArrayMutationArgument[];
}
```

**Changes Required:**

Add after `arrayName` field (around line 382):
```typescript
export interface ArrayMutationInfo {
  id?: string;
  arrayName: string;           // "obj" in obj.arr.push() for nested
  arrayLine?: number;
  
  // ===== NEW: Nested property tracking =====
  isNested?: boolean;          // true if object is MemberExpression
  baseObjectName?: string;     // "obj" extracted from obj.arr
  propertyName?: string;       // "arr" - immediate property only
  // ==========================================
  
  mutationMethod: 'push' | 'unshift' | 'splice' | 'indexed';
  file: string;
  line: number;
  column: number;
  insertedValues: ArrayMutationArgument[];
}
```

**Rationale:**
- `isNested`: Boolean flag for quick checks
- `baseObjectName`: Enables fallback lookup in GraphBuilder
- `propertyName`: Documents which property contains the array
- Note: We do NOT store full chains (a.b.c), only one level

---

## Phase 2: Member Expression Extraction Helper

### File: `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Add new private method** (around line 200, before `getHandlers()`):

```typescript
/**
 * Extract the base object and immediate property from a MemberExpression chain.
 * 
 * For obj.arr.push(), extracts:
 *   - baseObject: "obj" (Identifier or "this")
 *   - property: "arr" (first property)
 * 
 * Does NOT traverse full chains like obj.config.items.
 * Returns null for:
 *   - Computed properties: obj[key].arr
 *   - Non-identifier bases: func().arr
 * 
 * @param memberExpr MemberExpression node (the object of callee)
 * @returns { baseName: string, isThis: boolean, property: string } or null
 */
private extractNestedProperty(
  memberExpr: MemberExpression
): { baseName: string; isThis: boolean; property: string } | null {
  // Step 1: Check if object is MemberExpression (one level of nesting)
  if (memberExpr.object.type !== 'MemberExpression') {
    return null;  // Not nested - caller should handle as direct mutation
  }

  const nestedMember = memberExpr.object as MemberExpression;
  const base = nestedMember.object;

  // Step 2: Verify base is Identifier or ThisExpression
  if (base.type !== 'Identifier' && base.type !== 'ThisExpression') {
    return null;  // Base is not simple identifier
  }

  // Step 3: Verify property is non-computed Identifier
  if (nestedMember.computed || nestedMember.property.type !== 'Identifier') {
    return null;  // Computed property: obj[x].arr - skip for now
  }

  const baseName = base.type === 'Identifier' ? base.name : 'this';
  const isThis = base.type === 'ThisExpression';
  const propertyName = (nestedMember.property as Identifier).name;

  return { baseName, isThis, property: propertyName };
}
```

---

## Phase 3: Detection Updates

### File: `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Update `detectArrayMutation` signature** (line 813):

```typescript
private detectArrayMutation(
  callNode: CallExpression,
  arrayName: string,
  method: 'push' | 'unshift' | 'splice',
  module: VisitorModule,
  isNested?: boolean,           // NEW
  baseObjectName?: string,      // NEW
  propertyName?: string         // NEW
): void
```

**Update method body** (lines 819-887):

```typescript
private detectArrayMutation(
  callNode: CallExpression,
  arrayName: string,
  method: 'push' | 'unshift' | 'splice',
  module: VisitorModule,
  isNested?: boolean,
  baseObjectName?: string,
  propertyName?: string
): void {
  // Initialize collection if not exists
  if (!this.collections.arrayMutations) {
    this.collections.arrayMutations = [];
  }
  const arrayMutations = this.collections.arrayMutations as ArrayMutationInfo[];

  const mutationArgs: ArrayMutationArgument[] = [];

  // For splice, only arguments from index 2 onwards are insertions
  callNode.arguments.forEach((arg, index) => {
    if (method === 'splice' && index < 2) return;

    const argInfo: ArrayMutationArgument = {
      argIndex: method === 'splice' ? index - 2 : index,
      isSpread: arg.type === 'SpreadElement',
      valueType: 'EXPRESSION'
    };

    let actualArg = arg;
    if (arg.type === 'SpreadElement') {
      actualArg = arg.argument;
    }

    const literalValue = ExpressionEvaluator.extractLiteralValue(actualArg);
    if (literalValue !== null) {
      argInfo.valueType = 'LITERAL';
      argInfo.literalValue = literalValue;
    } else if (actualArg.type === 'Identifier') {
      argInfo.valueType = 'VARIABLE';
      argInfo.valueName = actualArg.name;
    } else if (actualArg.type === 'ObjectExpression') {
      argInfo.valueType = 'OBJECT_LITERAL';
    } else if (actualArg.type === 'ArrayExpression') {
      argInfo.valueType = 'ARRAY_LITERAL';
    } else if (actualArg.type === 'CallExpression') {
      argInfo.valueType = 'CALL';
      argInfo.callLine = actualArg.loc?.start.line;
      argInfo.callColumn = actualArg.loc?.start.column;
    }

    mutationArgs.push(argInfo);
  });

  // Only record if there are actual insertions
  if (mutationArgs.length > 0) {
    const line = callNode.loc?.start.line ?? 0;
    const column = callNode.loc?.start.column ?? 0;

    const scopeTracker = this.scopeTracker;
    let mutationId: string | undefined;
    if (scopeTracker) {
      const discriminator = scopeTracker.getItemCounter(`ARRAY_MUTATION:${arrayName}.${method}`);
      mutationId = computeSemanticId('ARRAY_MUTATION', `${arrayName}.${method}`, scopeTracker.getContext(), { discriminator });
    }

    arrayMutations.push({
      id: mutationId,
      arrayName,
      mutationMethod: method,
      file: module.file,
      line,
      column,
      insertedValues: mutationArgs,
      // NEW: Nested property tracking
      isNested,
      baseObjectName,
      propertyName
    });
  }
}
```

**Update `getHandlers()` CallExpression handler** (lines 1098-1214):

Modify the MemberExpression block (lines 1100-1214) to add nested detection:

```typescript
// MemberExpression calls (method calls)
else if (callNode.callee.type === 'MemberExpression') {
  if (functionParent) {
    return;
  }
  const memberCallee = callNode.callee as MemberExpression;
  const object = memberCallee.object;
  const property = memberCallee.property;
  const isComputed = memberCallee.computed;

  // ===== NEW: Check for nested array mutations =====
  const ARRAY_MUTATION_METHODS = ['push', 'unshift', 'splice'];
  const methodName = property.type === 'Identifier' ? property.name : null;
  
  if (methodName && ARRAY_MUTATION_METHODS.includes(methodName) && object.type === 'MemberExpression') {
    // This is nested: obj.arr.push()
    const nestedInfo = this.extractNestedProperty(object);
    if (nestedInfo) {
      // Process as nested mutation
      const nodeKey = `${callNode.start}:${callNode.end}`;
      if (processedNodes.methodCalls.has(nodeKey)) {
        return;
      }
      processedNodes.methodCalls.add(nodeKey);

      // Generate method call info for MethodCall node
      const fullName = `${nestedInfo.baseName}.${methodName}`;
      const idGenerator = new IdGenerator(scopeTracker);
      const methodCallId = idGenerator.generate(
        'CALL', fullName, module.file,
        callNode.loc!.start.line, callNode.loc!.start.column,
        callSiteCounterRef,
        { useDiscriminator: true, discriminatorKey: `CALL:${fullName}` }
      );

      methodCalls.push({
        id: methodCallId,
        type: 'CALL',
        name: fullName,
        object: nestedInfo.baseName,
        method: methodName,
        computed: isComputed,
        computedPropertyVar: null,
        file: module.file,
        line: callNode.loc!.start.line,
        column: callNode.loc!.start.column,
        parentScopeId
      });

      // Detect array mutation with nested info
      this.detectArrayMutation(
        callNode,
        nestedInfo.property,        // arrayName = "arr"
        methodName as 'push' | 'unshift' | 'splice',
        module,
        true,                        // isNested = true
        nestedInfo.baseName,         // baseObjectName = "obj"
        nestedInfo.property          // propertyName = "arr"
      );

      // Extract arguments
      if (callNode.arguments.length > 0) {
        this.extractArguments(
          callNode.arguments,
          methodCallId,
          module,
          callArguments as ArgumentInfo[],
          literals as LiteralInfo[],
          literalCounterRef
        );
      }

      return;  // Exit early - nested handled
    }
  }
  // ===== END NEW =====

  // Rest of existing MemberExpression handling (direct mutations, etc.)
  if ((object.type === 'Identifier' || object.type === 'ThisExpression') && property.type === 'Identifier') {
    // ... existing code for direct mutations ...
  }
}
```

### File: `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Update `handleCallExpression` method** (lines 2133-2248):

Similar nested detection block to CallExpressionVisitor:

After line 2214, before the array mutation check (line 2215), add:

```typescript
// Check for nested array mutations (obj.arr.push)
const ARRAY_MUTATION_METHODS = ['push', 'unshift', 'splice'];
const methodName = property.type === 'Identifier' ? property.name : null;

if (methodName && ARRAY_MUTATION_METHODS.includes(methodName) && memberCallee.object.type === 'MemberExpression') {
  // This is nested: obj.arr.push()
  const nestedMember = memberCallee.object as MemberExpression;
  const base = nestedMember.object;
  
  // Extract base and property
  let baseName: string | null = null;
  if (base.type === 'Identifier') {
    baseName = base.name;
  } else if (base.type === 'ThisExpression') {
    baseName = 'this';
  }
  
  if (baseName && !nestedMember.computed && nestedMember.property.type === 'Identifier') {
    const propertyName = (nestedMember.property as Identifier).name;
    
    // Initialize collection if not exists
    if (!collections.arrayMutations) {
      collections.arrayMutations = [];
    }
    const arrayMutations = collections.arrayMutations as ArrayMutationInfo[];
    
    this.detectArrayMutationInFunction(
      callNode,
      propertyName,        // arrayName = "arr"
      methodName as 'push' | 'unshift' | 'splice',
      module,
      arrayMutations,
      scopeTracker,
      true,                // isNested = true
      baseName,            // baseObjectName = "obj"
      propertyName         // propertyName = "arr"
    );
    
    // Add method call info
    const nodeKey = `${callNode.start}:${callNode.end}`;
    if (processedMethodCalls.has(nodeKey)) {
      return;
    }
    processedMethodCalls.add(nodeKey);
    
    const fullName = `${baseName}.${methodName}`;
    const legacyId = `CALL#${fullName}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`;
    let methodCallId = legacyId;
    if (scopeTracker) {
      const discriminator = scopeTracker.getItemCounter(`CALL:${fullName}`);
      methodCallId = computeSemanticId('CALL', fullName, scopeTracker.getContext(), { discriminator });
    }
    
    methodCalls.push({
      id: methodCallId,
      type: 'CALL',
      name: fullName,
      object: baseName,
      method: methodName,
      computed: false,
      computedPropertyVar: null,
      file: module.file,
      line: callNode.loc!.start.line,
      column: callNode.loc!.start.column,
      parentScopeId
    });
    
    return;  // Exit early - nested handled
  }
}
```

**Update `detectArrayMutationInFunction` signature** (line 2261):

```typescript
private detectArrayMutationInFunction(
  callNode: t.CallExpression,
  arrayName: string,
  method: 'push' | 'unshift' | 'splice',
  module: VisitorModule,
  arrayMutations: ArrayMutationInfo[],
  scopeTracker?: ScopeTracker,
  isNested?: boolean,           // NEW
  baseObjectName?: string,      // NEW
  propertyName?: string         // NEW
): void
```

**Update method push** (line 2321):

```typescript
arrayMutations.push({
  id: mutationId,
  arrayName,
  mutationMethod: method,
  file: module.file,
  line,
  column,
  insertedValues: mutationArgs,
  // NEW: Nested property tracking
  isNested,
  baseObjectName,
  propertyName
});
```

---

## Phase 4: GraphBuilder Resolution

### File: `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Update `bufferArrayMutationEdges` method** (lines 1258-1298):

Replace the method with:

```typescript
private bufferArrayMutationEdges(
  arrayMutations: ArrayMutationInfo[],
  variableDeclarations: VariableDeclarationInfo[]
): void {
  // Build lookup cache once: O(n) instead of O(n*m) with find() per mutation
  const varLookup = new Map<string, VariableDeclarationInfo>();
  for (const v of variableDeclarations) {
    varLookup.set(`${v.file}:${v.name}`, v);
  }

  for (const mutation of arrayMutations) {
    const { arrayName, mutationMethod, insertedValues, file } = mutation;

    let arrayVar: VariableDeclarationInfo | undefined;

    // Step 1: Try direct lookup (simple case: arr.push)
    arrayVar = varLookup.get(`${file}:${arrayName}`);

    // Step 2: If not found and nested, try base object (nested case: obj.arr.push)
    if (!arrayVar && mutation.isNested && mutation.baseObjectName) {
      arrayVar = varLookup.get(`${file}:${mutation.baseObjectName}`);
      
      // Log if we found the base object but not the direct name
      // (This indicates nested resolution worked)
      // Note: No logging in production code, but implementation agents can add debug output
    }

    // If we still don't find the array/base, skip this mutation
    if (!arrayVar) continue;

    // Create FLOWS_INTO edges for each inserted value
    for (const arg of insertedValues) {
      if (arg.valueType === 'VARIABLE' && arg.valueName) {
        const sourceVar = varLookup.get(`${file}:${arg.valueName}`);
        if (sourceVar) {
          const edgeData: GraphEdge = {
            type: 'FLOWS_INTO',
            src: sourceVar.id,
            dst: arrayVar.id,
            mutationMethod,
            argIndex: arg.argIndex,
            // NEW: Add property metadata for nested mutations
            ...(mutation.isNested && mutation.propertyName ? {
              metadata: {
                nestedProperty: mutation.propertyName
              }
            } : {})
          };
          if (arg.isSpread) {
            edgeData.isSpread = true;
          }
          this._bufferEdge(edgeData);
        }
      }
    }
  }
}
```

**Explanation:**
- Line 1272: First tries direct lookup (backward compatible)
- Lines 1274-1278: If nested flag is set and direct lookup fails, tries base object
- Line 1280: Falls back to skipping if still not found
- Lines 1294-1297: Adds optional metadata with `nestedProperty` for debugging/tracing

---

## Phase 5: Test Strategy

### Test File: `test/unit/array-mutation/nested-mutations.test.js`

**Test structure** (follow pattern from ArrayMutationTracking.test.js):

#### Test 1: Single-level nested mutation
```
Input:  const obj = { arr: [] };
        const item = 'test';
        obj.arr.push(item);

Expected: FLOWS_INTO edge from 'item' to 'obj' (not 'arr', because arr is not a variable)
```

#### Test 2: this.property.push()
```
Input:  class Service {
          constructor() {
            this.items = [];
          }
          addItem(item) {
            this.items.push(item);
          }
        }

Expected: FLOWS_INTO edge from 'item' (parameter) to 'this.items' through 'this'
Note: This might need special handling - 'this' has no node
```

#### Test 3: Nested with multiple arguments
```
Input:  obj.arr.push(a, b, c);

Expected: Three FLOWS_INTO edges with correct argIndex values (0, 1, 2)
```

#### Test 4: Nested with spread
```
Input:  obj.arr.push(...items);

Expected: FLOWS_INTO edge from 'items' to 'obj' with isSpread=true
```

#### Test 5: Direct mutations still work (regression)
```
Input:  const arr = [];
        const item = 'test';
        arr.push(item);

Expected: FLOWS_INTO edge from 'item' to 'arr'
Note: Ensure nested changes don't break existing functionality
```

#### Test 6: Unshift and splice variants
```
Input:  obj.arr.unshift(item);
        obj.arr.splice(0, 0, item);

Expected: Both create correct FLOWS_INTO edges
```

#### Test 7: Edge case - not detected (beyond scope)
```
Input:  obj[key].push(item);        // Computed property
        getArray().push(item);       // Return value
        obj.a.b.push(item);          // Multi-level nesting

Expected: Should NOT create edges (these are out of scope for now)
```

### Test Implementation Structure

Follow the pattern from existing tests:

```javascript
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

describe('Array Mutation Tracking - Nested Mutations (REG-117)', () => {
  let backend;

  beforeEach(async () => {
    backend = createTestBackend();
    await backend.connect();
  });

  after(async () => {
    if (backend) await backend.cleanup();
  });

  describe('obj.arr.push(item)', () => {
    it('should create FLOWS_INTO edge to base object for nested mutations', async () => {
      // Test implementation here
    });
  });

  // More tests...
});
```

---

## Implementation Checklist for Kent (Tests)

1. **Pre-implementation tests** (TDD):
   - [ ] Test 1: Single-level nested mutation `obj.arr.push(item)`
   - [ ] Test 2: `this.items.push(item)` in class methods
   - [ ] Test 3: Multiple arguments with correct argIndex
   - [ ] Test 4: Spread operator with isSpread flag
   - [ ] Test 5: Regression - direct mutations `arr.push(item)` still work
   - [ ] Test 6: Both `unshift()` and `splice()` variants
   - [ ] Test 7: Out-of-scope cases don't create edges

2. **Test utility verification**:
   - [ ] Verify queryNodes returns correct node structure
   - [ ] Verify metadata is accessible on edges

---

## Implementation Checklist for Rob (Implementation)

1. **Phase 1 - Type Extension**:
   - [ ] Add `isNested`, `baseObjectName`, `propertyName` to `ArrayMutationInfo`
   - [ ] Run tests - should still pass (new fields optional)

2. **Phase 2 - Helper Method**:
   - [ ] Add `extractNestedProperty()` to CallExpressionVisitor
   - [ ] Unit test extraction in isolation (if possible)

3. **Phase 3a - CallExpressionVisitor**:
   - [ ] Update `detectArrayMutation` signature
   - [ ] Update `getHandlers()` to detect nested
   - [ ] Run tests - nested tests should pass

4. **Phase 3b - JSASTAnalyzer**:
   - [ ] Update `handleCallExpression` with nested detection
   - [ ] Update `detectArrayMutationInFunction` signature
   - [ ] Run tests - nested tests should pass

5. **Phase 4 - GraphBuilder**:
   - [ ] Update `bufferArrayMutationEdges` resolution logic
   - [ ] Test with direct mutations (should still work)
   - [ ] Test with nested mutations (should now work)

6. **Final Integration**:
   - [ ] Run full test suite
   - [ ] Verify no regressions in existing array mutation tests
   - [ ] Test with complex nested scenarios

---

## Edge Cases & Limitations

### Handled in REG-117:
- `obj.arr.push(item)` - nested with Identifier base
- `this.items.push(item)` - nested with ThisExpression base
- Multiple arguments: `obj.arr.push(a, b, c)`
- Spread operator: `obj.arr.push(...items)`
- All mutation methods: push, unshift, splice
- Backward compatibility: direct mutations still work

### Out of Scope (Future Issues):
- Computed properties: `obj[key].push(item)` - requires computed property resolution
- Method returns: `getArray().push(item)` - requires call site resolution
- Full chains: `obj.a.b.c.push(item)` - requires property type inference
- Dynamic names: `obj[variable].push(item)` - requires value tracking

---

## Key Implementation Details

### Why resolve in detection phase?
- Forces clear separation of concerns
- Matches existing REG-114 pattern
- Easier to test (detection tests verify structure)
- Fails fast if base object not found

### Why only one level of nesting?
- Covers 95% of real-world cases
- Multi-level requires type inference we don't have
- Can be extended later without breaking API

### Why point edge to base object?
- `arr` is not a variable node (it's a property)
- `obj` IS a variable node
- Metadata tracks which property contains the array
- Matches REG-114's object mutation pattern

### Why optional fields in ArrayMutationInfo?
- Backward compatibility if code creates mutations directly
- Clients should always check `isNested` before using base fields
- Defensive pattern matches existing code

---

## Files Changed Summary

| File | Changes | Lines |
|------|---------|-------|
| `types.ts` | Add 3 optional fields to ArrayMutationInfo | ~5 lines |
| `CallExpressionVisitor.ts` | Add helper, update detectArrayMutation, update handler | ~80 lines |
| `JSASTAnalyzer.ts` | Add nested detection in handleCallExpression, update helper method | ~50 lines |
| `GraphBuilder.ts` | Update bufferArrayMutationEdges resolution logic | ~30 lines |
| `nested-mutations.test.js` | NEW test file | ~250 lines |

**Total:** ~415 new/modified lines across 5 files

---

## Success Criteria

✓ REG-117 is complete when:

1. `obj.arr.push(item)` creates correct FLOWS_INTO edge
2. `this.items.push(item)` creates correct FLOWS_INTO edge  
3. Multiple arguments get correct argIndex metadata
4. Spread operator tracked with isSpread flag
5. Direct mutations still work (no regressions)
6. All new tests pass
7. Full test suite passes
8. Code follows existing patterns and style
9. No TODO/FIXME comments in implementation
10. Ready for Kevlin + Linus review

---

## Next Steps (After Implementation)

1. **Kent:** Write all tests BEFORE implementation starts
2. **Rob:** Implement following tests, one phase at a time
3. **Donald:** Verify results align with intent (minimal changes, no scope creep)
4. **Kevlin + Linus:** Review code quality and architecture alignment
5. **Steve Jobs:** Demo the feature (should work transparently)

