# Rob Pike - Implementation Report

## REG-153: Use Semantic IDs for PARAMETER Nodes

**Status: IMPLEMENTED**

---

## Summary

Successfully migrated PARAMETER node IDs from legacy format (`PARAMETER#name#file#line:index`) to semantic format (`file->scope->PARAMETER->name#discriminator`).

This aligns the sequential analysis path (FunctionVisitor/ClassVisitor) with the parallel path (ASTWorker), fixing the consistency bug identified in Don's analysis.

---

## Changes Made

### 1. `packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts`

**Full rewrite of the shared utility:**

- Added imports for `ScopeTracker` and `computeSemanticId`
- Made `scopeTracker` parameter **REQUIRED** (not optional, per Linus's directive)
- Replaced all 3 legacy ID generation points with `computeSemanticId`:
  - Identifier parameters (line 54)
  - AssignmentPattern parameters (line 70)
  - RestElement parameters (line 88)
- Added `semanticId` field to all ParameterInfo objects (same value as `id`)
- Updated JSDoc to reflect new semantics

**Key code pattern:**
```typescript
const paramId = computeSemanticId('PARAMETER', name, scopeTracker.getContext(), { discriminator: index });
parameters.push({
  id: paramId,
  semanticId: paramId,  // Populated for consistency with other node types
  type: 'PARAMETER',
  name,
  // ... rest of fields
});
```

### 2. `packages/core/src/plugins/analysis/ast/visitors/FunctionVisitor.ts`

**Removed tech debt from REG-134:**

- Removed local duplicate `createParameterNodes` function (57 lines, was lines 218-275)
- Added import for shared `createParameterNodes` utility
- Added import for `ParameterInfo` type from `../types.js`
- Removed local `ParameterInfo` interface (was duplicating the shared type)
- Made `scopeTracker` constructor parameter **REQUIRED** (was optional)
- Removed `if (scopeTracker)` guards (3 occurrences) since scopeTracker is now required
- Updated `generateAnonymousName()` helper to not check for undefined scopeTracker

**Critical ordering fix:**
- Moved `scopeTracker.enterScope()` call BEFORE `createParameterNodes()` call
- This ensures parameters have the correct function scope in their semantic IDs
- Format: `file->functionName->PARAMETER->paramName#index`

**Before (wrong order):**
```typescript
createParameterNodes(node.params, ...);  // Would use parent scope!
scopeTracker.enterScope(name, 'FUNCTION');
```

**After (correct order):**
```typescript
scopeTracker.enterScope(name, 'FUNCTION');  // Enter function scope first
createParameterNodes(node.params, ..., scopeTracker);  // Now uses function scope
```

### 3. `packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`

**Minor update to pass scopeTracker:**

- Updated ClassProperty handler call (line 274): added `scopeTracker` parameter
- Updated ClassMethod handler call (line 350): added `scopeTracker` parameter
- No other changes needed - ClassVisitor already:
  - Has scopeTracker as REQUIRED (not optional)
  - Enters method scope before creating parameters

### 4. `packages/core/src/plugins/analysis/ast/IdGenerator.ts`

**Documentation update:**

- Removed PARAMETER from the `generateLegacy()` comment
- Added note that PARAMETER nodes use `computeSemanticId()` instead
- Points to `createParameterNodes.ts` for implementation reference

**Before:**
```typescript
/**
 * Used for: LITERAL (arguments), PARAMETER, DECORATOR, PROPERTY
 */
```

**After:**
```typescript
/**
 * Used for: LITERAL (arguments), DECORATOR, PROPERTY
 *
 * NOTE: PARAMETER nodes use computeSemanticId() for stable, semantic identifiers.
 * See createParameterNodes.ts for the implementation.
 */
```

---

## Semantic ID Format

### Old (Legacy)
```
PARAMETER#userId#src/auth.js#42:0
```

Components: `TYPE#name#file#line:paramIndex`

### New (Semantic)
```
src/auth.js->login->PARAMETER->userId#0
```

Components: `file->scope->TYPE->name#discriminator`

### Examples

| Code | Old ID | New ID |
|------|--------|--------|
| `function greet(name) {}` | `PARAMETER#name#src/app.js#5:0` | `src/app.js->greet->PARAMETER->name#0` |
| `function add(a, b) {}` (param b) | `PARAMETER#b#src/math.js#10:1` | `src/math.js->add->PARAMETER->b#1` |
| `const fn = (x) => x` | `PARAMETER#x#src/util.js#3:0` | `src/util.js->fn->PARAMETER->x#0` |
| `class User { login(userId) {} }` | `PARAMETER#userId#src/user.js#15:0` | `src/user.js->User->login->PARAMETER->userId#0` |

---

## Build Verification

```
$ npm run build

packages/types build: Done
packages/rfdb build: Done
packages/core build: Done   <-- SUCCESS
packages/cli build: Done
packages/mcp build: Failed  <-- Pre-existing, unrelated issue
```

The core package builds successfully. The MCP package failure is a pre-existing type issue with `db.clear()` possibly being undefined - not related to our changes.

---

## Code Quality

1. **No fallback logic** - As per Linus's directive, removed all conditional ID generation. If scopeTracker is undefined, TypeScript will catch it at compile time.

2. **Single source of truth** - All PARAMETER IDs now flow through `createParameterNodes.ts`. The duplicate in FunctionVisitor is removed.

3. **Consistent with ASTWorker** - The pattern now matches what ASTWorker uses (lines 419-432), ensuring parallel/sequential parity.

4. **Proper scope ordering** - Parameters are created AFTER entering function scope, so their semantic IDs correctly include the function name.

---

## Risks and Migration

### Breaking Change

This is a **breaking change** for existing graphs:
- Saved graphs with legacy PARAMETER IDs won't match new semantic IDs
- First analysis after update will recreate all PARAMETER nodes

### Mitigation

Users should run:
```bash
grafema analyze --clear
```

After updating to regenerate all graphs with new ID format.

---

## Files Changed Summary

| File | Lines Changed | Net Change |
|------|---------------|------------|
| `createParameterNodes.ts` | ~25 | +10 (added imports, semanticId field) |
| `FunctionVisitor.ts` | ~70 | -55 (removed duplicate function) |
| `ClassVisitor.ts` | 2 | 0 (just added scopeTracker param) |
| `IdGenerator.ts` | 4 | +3 (documentation update) |

**Total: ~100 lines changed, net reduction of ~40 lines**

---

## Next Steps

1. **Review requested** - Kevlin for code quality, Linus for architecture alignment
2. **Test verification** - Once test infrastructure is fixed, run ParallelSequentialParity tests
3. **Commit** - After review approval, commit with breaking change note
