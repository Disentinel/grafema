# REG-117: Nested Array Mutations - Implementation Report

**Author:** Rob Pike (Implementation Engineer)
**Date:** 2025-01-23
**Status:** Complete

---

## Summary

Implemented nested array mutation tracking following Joel's technical plan. The implementation enables tracking of `obj.arr.push(item)` and similar patterns by extracting the base object and property during detection, then resolving to the base object in GraphBuilder.

---

## Implementation Details

### Phase 1: Type Extension

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

Added 3 optional fields to `ArrayMutationInfo`:

```typescript
export interface ArrayMutationInfo {
  // ... existing fields ...

  // Nested property tracking (REG-117)
  isNested?: boolean;          // true if object is MemberExpression (obj.arr.push)
  baseObjectName?: string;     // "obj" extracted from obj.arr.push()
  propertyName?: string;       // "arr" - immediate property containing the array

  // ... rest of fields ...
}
```

---

### Phase 2: Helper Method

**File:** `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

Added `extractNestedProperty()` method:

```typescript
private extractNestedProperty(
  memberExpr: MemberExpression
): { baseName: string; isThis: boolean; property: string } | null
```

This method:
- Checks if the callee object is a MemberExpression (one level of nesting)
- Verifies base is Identifier or ThisExpression
- Verifies property is non-computed Identifier
- Returns null for computed properties or complex bases

---

### Phase 3a: CallExpressionVisitor Updates

**File:** `packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

1. **Updated `detectArrayMutation` signature** to accept:
   - `isNested?: boolean`
   - `baseObjectName?: string`
   - `propertyName?: string`

2. **Updated `getHandlers()` MemberExpression block** to:
   - Check for nested array mutations BEFORE existing handling
   - Extract nested info using `extractNestedProperty()`
   - Create method call info with full name (`obj.arr.push`)
   - Call `detectArrayMutation` with nested info
   - Return early to avoid duplicate processing

---

### Phase 3b: JSASTAnalyzer Updates

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

1. **Updated `handleCallExpression`** to:
   - Check for nested array mutations before standard method call handling
   - Extract base object and property from nested MemberExpression
   - Call `detectArrayMutationInFunction` with nested info
   - Create method call with full nested name

2. **Updated `detectArrayMutationInFunction` signature** to accept:
   - `isNested?: boolean`
   - `baseObjectName?: string`
   - `propertyName?: string`

---

### Phase 4: GraphBuilder Resolution

**File:** `packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

1. **Updated `bufferArrayMutationEdges` signature** to accept `parameters: ParameterInfo[]`

2. **Updated resolution logic**:
   - Try direct lookup first (backward compatible)
   - If not found AND nested flag is set, try base object lookup
   - Also try parameters for both target and source (enables function parameter tracking)
   - Add metadata with `nestedProperty` for nested mutations

---

## Deviations from Joel's Plan

### Minor Enhancement: Parameter Support

Added parameter lookup support in `bufferArrayMutationEdges` beyond Joel's plan. This was necessary to make function-level tests pass:

```javascript
function addToState(state, item) {
  state.items.push(item);  // Both 'state' and 'item' are parameters
}
```

Without parameter support, these FLOWS_INTO edges would not be created.

---

## Test Results

All 20 tests pass:

```
# tests 20
# suites 11
# pass 20
# fail 0
# cancelled 0
# skipped 0
# duration_ms 6146.544567
```

### Test Coverage

1. **Simple nested mutation** - `obj.arr.push(item)` creates edge to base object
2. **Separate declaration** - `container.items.push(value)` works correctly
3. **this.items.push** - Expected limitation documented (no crash, no edge)
4. **Multiple arguments** - Correct argIndex values (0, 1, 2)
5. **Spread operator** - isSpread flag preserved
6. **Regression tests** - Direct `arr.push(item)` still works
7. **Mixed mutations** - Both direct and nested in same file
8. **unshift and splice** - All mutation methods supported
9. **Out of scope cases** - No edges for computed, function returns, multi-level
10. **Edge metadata** - nestedProperty included in metadata
11. **Function-level detection** - Both regular and arrow functions

---

## Files Changed

| File | Changes |
|------|---------|
| `types.ts` | +3 fields to ArrayMutationInfo |
| `CallExpressionVisitor.ts` | +helper method, +nested detection block, +signature update |
| `JSASTAnalyzer.ts` | +nested detection block, +signature update |
| `GraphBuilder.ts` | +parameter support, +fallback resolution, +metadata |

---

## Issues Encountered

None. The implementation followed Joel's plan closely with one minor enhancement (parameter support) that was necessary for complete functionality.

---

## Build Status

```bash
npm run build  # Success
node --test test/unit/NestedArrayMutations.test.js  # 20/20 pass
```

---

## Ready for Review

Implementation complete and ready for Kevlin (code quality) and Linus (architecture) review.
