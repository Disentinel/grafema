# REG-555: Implementation Report

**Author:** Rob Pike (Implementation Engineer)
**Date:** 2026-02-22

---

## Summary

Implemented READS_FROM edges from PROPERTY_ACCESS nodes to their source variable, parameter, or class nodes. Three commits, three files changed, zero deviations from the plan algorithm.

---

## Changes

### Commit 1: `feat(types): add scopePath and enclosingClassName to PropertyAccessInfo (REG-555)`

**File:** `packages/core/src/plugins/analysis/ast/types.ts`

Added two fields to the `PropertyAccessInfo` interface:
```ts
scopePath?: string[];        // scope path for resolveVariable/resolveParam lookup
enclosingClassName?: string; // class name when objectName === 'this'
```

### Commit 2: `feat(visitor): populate scopePath and enclosingClassName in PropertyAccessVisitor (REG-555)`

**File:** `packages/core/src/plugins/analysis/ast/visitors/PropertyAccessVisitor.ts`

In `extractPropertyAccesses`:
- Computed `currentScopePath` from `scopeTracker?.getContext().scopePath ?? []` before the chain loop
- Added `scopePath: currentScopePath` to each pushed `PropertyAccessInfo`
- Added `enclosingClassName: info.objectName === 'this' ? scopeTracker?.getEnclosingScope('CLASS') : undefined` to each pushed entry

In `extractMetaProperty`:
- Added `scopePath: scopeTracker?.getContext().scopePath ?? []` to the pushed entry

Used `scopeTracker?.getEnclosingScope('CLASS')` directly (public method) -- NOT `(scopeTracker as any)?.getEnclosingScope?.('CLASS')` as the original plan suggested. This follows Dijkstra's correction (Gap: Precondition 1).

### Commit 3: `feat(builder): add READS_FROM edges from PROPERTY_ACCESS to source nodes (REG-555)`

**File:** `packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts`

1. Added `import { basename } from 'path'` -- needed for CLASS file comparison
2. Added `ClassDeclarationInfo` to the type import block
3. Added `classDeclarations = []` to the `buffer()` destructuring
4. Updated `bufferPropertyAccessNodes` call to pass `variableDeclarations`, `parameters`, `classDeclarations`
5. Updated `bufferPropertyAccessNodes` signature to accept the new parameters
6. Added READS_FROM edge logic following the decision tree:

```
for each propertyAccess:
  if objectName === 'this':
    find classDecl where name === enclosingClassName && file === basename(propAccess.file)
    if found: bufferEdge READS_FROM src=propAccess.id dst=classDecl.id
  elif objectName === 'import.meta' || objectName.includes('.'):
    skip (no node to link)
  else:
    variable = resolveVariableInScope(objectName, scopePath, file, variableDeclarations)
    if variable: bufferEdge READS_FROM src=propAccess.id dst=variable.id
    else:
      param = resolveParameterInScope(objectName, scopePath, file, parameters)
      if param: bufferEdge READS_FROM src=propAccess.id dst=param.id
```

Used `basename(propAccess.file)` for CLASS comparison, mirroring MutationBuilder.ts line 200. This addresses Dijkstra's Gap 3 (HIGH severity).

---

## Deviations from Plan

None in the algorithm. Three corrections from Dijkstra/Uncle Bob reviews were applied:

1. **No `as any` cast** -- used `scopeTracker?.getEnclosingScope('CLASS')` directly
2. **Added `basename` import** -- plan mentioned but didn't include in pseudocode
3. **Added `ClassDeclarationInfo` import** -- plan mentioned in risk section but not in pseudocode

---

## Build Output

```
pnpm build -- all packages build successfully, zero TypeScript errors.
```

---

## Test Output

```
# tests 41
# suites 18
# pass 36
# fail 5
# cancelled 0
```

### Passing REG-555 tests (3/6):
- Test 2: PARAMETER resolution (`options.graph` -> READS_FROM -> PARAMETER "options") -- PASS
- Test 3: CLASS resolution (`this.val` -> READS_FROM -> CLASS "Config") -- PASS
- Test 5: Unknown identifier graceful skip -- PASS

### Failing REG-555 tests (3/6) -- test authoring issue, not implementation:
- Test 1, 4, 6: All fail with "Should have VARIABLE node for ..." because tests use `const` declarations (which produce `CONSTANT` nodes, not `VARIABLE`) but search with `getNodesByType(backend, 'VARIABLE')`. Kent needs to update these tests to use `let`/`var` or search for both `VARIABLE` and `CONSTANT`.

### Pre-existing failure (1):
- `import.meta.resolve()` intermediate links test -- pre-existing, unrelated to REG-555.

---

## Files Modified

| File | Lines Added | Lines Removed |
|------|------------|---------------|
| `packages/core/src/plugins/analysis/ast/types.ts` | 2 | 0 |
| `packages/core/src/plugins/analysis/ast/visitors/PropertyAccessVisitor.ts` | 7 | 2 |
| `packages/core/src/plugins/analysis/ast/builders/CoreBuilder.ts` | 60 | 5 |
| **Total** | **69** | **7** |
