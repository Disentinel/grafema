# Rob Implementation Report: REG-554

**Date:** 2026-02-22
**Plan followed:** `005-don-plan-v2.md`
**Uncle Bob notes followed:** `007-uncle-bob-prepare.md`

---

## Files Changed

### 1. `packages/types/src/nodes.ts`
- Added `PROPERTY_ASSIGNMENT = 'PROPERTY_ASSIGNMENT'` to `NODE_TYPE` enum (after `PROPERTY_ACCESS`)
- Added `PropertyAssignmentNodeRecord` interface with fields: `type`, `objectName`, `className?`, `computed?`
- Added `PropertyAssignmentNodeRecord` to `NodeRecord` union type (after `PropertyAccessNodeRecord`)

### 2. `packages/core/src/plugins/analysis/ast/types.ts`
- Extended `ObjectMutationValue.valueType` union with `'MEMBER_EXPRESSION'`
- Added four new optional fields to `ObjectMutationValue`: `memberObject`, `memberProperty`, `memberLine`, `memberColumn`
- Added `PropertyAssignmentInfo` interface (after `PropertyAccessInfo`)
- Added `propertyAssignments?: PropertyAssignmentInfo[]` and `propertyAssignmentCounterRef?: CounterRef` to `ASTCollections`

### 3. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`
- **Import fix (line 55):** Added `computeSemanticIdV2` to existing `computeSemanticId` import
- **Import addition:** Added `PropertyAssignmentInfo` to the types import block
- **Collections interface:** Added `propertyAssignments?` and `propertyAssignmentCounterRef?` fields to the internal `Collections` interface (required to avoid `unknown` type errors at module-level call site)
- **`extractMutationValue()`:** Added `TSNonNullExpression` unwrapping (before all checks) and `MemberExpression` case (after `CallExpression` check)
- **`detectObjectPropertyAssignment()`:** Extended signature with two optional params (`propertyAssignments`, `propertyAssignmentCounterRef`). Added `propertyAssignments.push(...)` block after existing `objectMutations.push(...)` with guard: `objectName === 'this' && enclosingClassName && propertyAssignments`
- **Module-level call site (~line 1942):** Updated to initialize and pass `propertyAssignments` and `propertyAssignmentCounterRef` from `allCollections`

### 4. `packages/core/src/plugins/analysis/ast/handlers/AnalyzerDelegate.ts`
- Added `PropertyAssignmentInfo` to imports
- Extended `detectObjectPropertyAssignment` signature with two new optional params

### 5. `packages/core/src/plugins/analysis/ast/handlers/VariableHandler.ts`
- Added `PropertyAssignmentInfo` and `CounterRef` to imports
- Added collection initialization block for `propertyAssignments` and `propertyAssignmentCounterRef`
- Updated `detectObjectPropertyAssignment` call to pass new params

### 6. `packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts`
- Added `PropertyAssignmentInfo` to imports
- Destructured `propertyAssignments = []` in `buffer()`
- Added call to `this.bufferPropertyAssignmentNodes(...)` after `bufferPropertyAccessNodes()`
- Implemented `bufferPropertyAssignmentNodes()` (~45 lines): buffers node, CLASS->CONTAINS edge, delegates ASSIGNED_FROM to helper
- Implemented `bufferAssignedFromEdge()` (~35 lines): handles VARIABLE (scope chain lookup) and MEMBER_EXPRESSION (PROPERTY_ACCESS lookup) resolution

---

## Deviations from Plan

### 1. AnalyzerDelegate.ts (not in plan)
The plan listed 6 files to modify but did not mention `AnalyzerDelegate.ts`. Since `detectObjectPropertyAssignment()` is called from `VariableHandler` via the `AnalyzerDelegate` interface, the interface signature had to be updated to match the new parameters. Without this change, TypeScript would reject the call in `VariableHandler.ts`.

### 2. Internal `Collections` interface in JSASTAnalyzer.ts
The plan did not mention the internal `Collections` interface (separate from `ASTCollections`). This interface has `[key: string]: unknown`, so dynamic property access compiles but types as `unknown`. Added explicit `propertyAssignments?` and `propertyAssignmentCounterRef?` fields to match the pattern used by `propertyAccesses` and `propertyAccessCounterRef`.

### 3. `bufferPropertyAssignmentNodes` does not take `module` param for fallback CONTAINS
The plan's code (STEP 7d) passes `module` to `bufferPropertyAssignmentNodes` but never uses it as a fallback CONTAINS source (unlike PROPERTY_ACCESS which falls back to module.id). I kept the `module` parameter in the signature for consistency with `bufferPropertyAccessNodes`, but it is unused in the method body since PROPERTY_ASSIGNMENT nodes only exist inside class context.

---

## Build Result

```
pnpm build -> SUCCESS (all packages)
```

No TypeScript errors. No warnings in JS/TS packages.

---

## Issues Encountered

1. **AnalyzerDelegate mismatch:** First build failed because the plan omitted updating `AnalyzerDelegate.ts`. The `detectObjectPropertyAssignment` method is exposed through this interface for cross-module calls from handler classes. Fixed by adding the two new optional params to the interface.

2. **`Collections` interface typing:** First build also would have failed at the module-level call site where `allCollections.propertyAssignments` resolved to `unknown` (from the index signature). Fixed by adding typed fields to the internal `Collections` interface.

Both issues were straightforward type-system alignment, no design changes required.
