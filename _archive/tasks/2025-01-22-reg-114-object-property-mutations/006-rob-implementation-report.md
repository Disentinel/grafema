# REG-114: Object Property Mutation Tracking - Implementation Report

**Author:** Rob Pike (Implementation Engineer)
**Date:** 2025-01-22
**Status:** Implemented with Known Limitations

---

## Summary

Implemented object property mutation tracking for FLOWS_INTO edge creation, following Joel's technical plan and the existing array mutation pattern (REG-113).

## Changes Made

### Phase 1: Types (`packages/core/src/plugins/analysis/ast/types.ts`)

1. Added `ObjectMutationInfo` interface for tracking object mutations
2. Added `ObjectMutationValue` interface for tracking assigned values
3. Added `objectMutations?: ObjectMutationInfo[]` to `ASTCollections` interface
4. Added `mutationType` and `propertyName` to `GraphEdge` interface

### Phase 2: Detection (`packages/core/src/plugins/analysis/JSASTAnalyzer.ts`)

1. Added `detectObjectPropertyAssignment()` method - detects `obj.prop = value` and `obj['prop'] = value`
2. Added `extractMutationValue()` helper - extracts value info for FLOWS_INTO edge creation
3. Added `detectObjectAssignInFunction()` method - detects `Object.assign()` inside functions
4. Wired up module-level detection in `AssignmentExpression` handler
5. Wired up function-level detection in `analyzeFunctionBody`

### Phase 3: CallExpressionVisitor (`packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`)

1. Added `detectObjectAssign()` method - detects `Object.assign(target, source...)` at module level
2. Wired up detection when `Object.assign` calls are encountered

### Phase 4: GraphBuilder (`packages/core/src/plugins/analysis/ast/GraphBuilder.ts`)

1. Added `bufferObjectMutationEdges()` method - creates FLOWS_INTO edges from source variables/parameters to mutated objects
2. Updated `build()` method to call `bufferObjectMutationEdges()`
3. Updated method to also search parameters (not just variableDeclarations) for source lookup

### Phase 5: Wiring

1. Added `objectMutations` initialization in `analyzeModule()`
2. Added to `allCollections` for passing through analysis
3. Passed to `graphBuilder.build()`

## Test Results

**Passing Tests (18/23):**
- `obj.prop = value` - all 3 tests pass
- `Object.assign(target, source)` - all 4 tests pass
- `Function-level mutations` - all 3 tests pass
- `Edge direction verification` - passes
- `Integration with real-world patterns` - all 3 tests pass
- `Edge cases` - all 3 tests pass

**Failing Tests (5/23):**
1. `obj['handler'] = handler` - string literal key not creating edge
2. `obj[key] = value` - computed key not creating edge with mutationType
3. `this.handler = handler` in constructor - parameter not found
4. `this.handler = h` in class method - parameter not found
5. Edge metadata verification - some edges have `mutationMethod` instead of `mutationType`

## Known Limitations

### 1. Class Parameter Tracking
Constructor and method parameters aren't being created as PARAMETER nodes in the current implementation. This is a pre-existing limitation in the codebase, not introduced by this PR.

**Impact:** `this.prop = param` mutations can't create edges because the parameter node doesn't exist.

**Recommendation:** Create a separate issue for class parameter node creation.

### 2. Computed Key Ambiguity
`arr[index] = value` is syntactically identical to `obj[key] = value`. At static analysis time, we can't distinguish arrays from objects.

**Current behavior:**
- `arr[0] = value` (NumericLiteral) -> Array mutation only (`mutationMethod: 'indexed'`)
- `obj['prop'] = value` (StringLiteral) -> Object mutation only (`mutationType: 'property'`)
- `obj[key] = value` (Identifier) -> BOTH array AND object mutation

**Impact:** The edge metadata tests expect all computed keys to have `mutationType`, but some have `mutationMethod` instead.

**Recommendation:** Either:
1. Accept both edge types for computed keys
2. Unify array and object mutation edge metadata

### 3. Arrow Function Constants
When the source value is an arrow function constant (`const handler = () => {}`), the lookup might fail due to how these are stored.

**Status:** Needs investigation.

## Files Modified

1. `/packages/core/src/plugins/analysis/ast/types.ts`
2. `/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
3. `/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`
4. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

## Build Status

TypeScript compilation passes with no errors.

## Next Steps

1. Review with Kevlin (code quality) and Linus (high-level review)
2. Discuss computed key ambiguity design decision
3. Create Linear issue for class parameter tracking if needed
4. Consider edge metadata unification between array and object mutations
