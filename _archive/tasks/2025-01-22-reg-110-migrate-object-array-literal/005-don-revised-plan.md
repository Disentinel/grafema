# Don Melton: Revised Plan for REG-110

## Summary

Migrate all inline OBJECT_LITERAL and ARRAY_LITERAL node creation in `CallExpressionVisitor.ts` to use existing factory methods (`ObjectLiteralNode.create()` and `ArrayLiteralNode.create()`). Add GraphBuilder integration to buffer these nodes to the graph. Use factories **as-is** without modifications.

**Key decision:** Accept ID format change for nested literals. Instead of property names (`propertyName`) or element indicators (`elem{N}`), nested literals will get default suffixes (`obj`/`arr`).

## Changes from Original Plan

### What Changed

1. **No factory modifications** - `ObjectLiteralNode` and `ArrayLiteralNode` remain unchanged. No `contextSuffix` option.

2. **ID format breaking change** - Nested literals will use different IDs:
   - **Before**: `OBJECT_LITERAL#{propertyName}#...` or `OBJECT_LITERAL#elem{N}#...`
   - **After**: `OBJECT_LITERAL#obj#...` or `ARRAY_LITERAL#arr#...`

3. **Top-level args unchanged** - These already match factory format:
   - `OBJECT_LITERAL#arg{N}#...` when `argIndex` provided

### Why This Is Right

- Factories have clear semantics: `arg{N}` for function arguments, `obj`/`arr` for generic literals
- No special-case options that leak traversal context into node contracts
- Consistent with other NodeContract migrations (EnumNode, InterfaceNode, etc.)
- If we need context info later, we add it through **edges** or **metadata fields**, not ID suffixes

## Implementation Steps

### Step 1: Migrate Top-Level Argument Literals

**File**: `/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Locations**:
- Line ~327: Object literal as function argument
- Line ~378: Array literal as function argument

**Changes**:
```typescript
// Add imports at top
import { ObjectLiteralNode } from '../../../../core/nodes/ObjectLiteralNode.js';
import { ArrayLiteralNode } from '../../../../core/nodes/ArrayLiteralNode.js';

// Replace inline creation with factory call
const objectNode = ObjectLiteralNode.create(
  module.file,
  argInfo.line,
  argInfo.column,
  {
    parentCallId: callId,
    argIndex: index,
    counter: objectLiteralCounterRef.value++
  }
);
(this.collections.objectLiterals as ObjectLiteralInfo[]).push(objectNode);
const objectId = objectNode.id;
```

**ID format**: Unchanged - already matches factory (`OBJECT_LITERAL#arg{N}#...`)

### Step 2: Migrate Nested Literals in Object Properties

**File**: Same file

**Locations**:
- Line ~557: Nested object literal as object property value
- Line ~588: Nested array literal as object property value

**Changes**:
```typescript
// For nested object
const nestedObjectNode = ObjectLiteralNode.create(
  module.file,
  value.loc?.start.line || 0,
  value.loc?.start.column || 0,
  {
    counter: objectLiteralCounterRef.value++
  }
);
objectLiterals.push(nestedObjectNode);
const nestedObjectId = nestedObjectNode.id;

// For nested array - same pattern with ArrayLiteralNode
```

**ID format change**:
- **Before**: `OBJECT_LITERAL#{propertyName}#...` (e.g., `OBJECT_LITERAL#config#...`)
- **After**: `OBJECT_LITERAL#obj#...` (default suffix, no argIndex)

### Step 3: Migrate Nested Literals in Array Elements

**File**: Same file

**Locations**:
- Line ~712: Nested object literal as array element
- Line ~739: Nested array literal as array element

**Changes**: Same pattern as Step 2 - factory call without `argIndex` or special context.

**ID format change**:
- **Before**: `OBJECT_LITERAL#elem{N}#...` (e.g., `OBJECT_LITERAL#elem0#...`)
- **After**: `OBJECT_LITERAL#obj#...` (default suffix)

### Step 4: Add GraphBuilder Integration

**File**: `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Changes**:

1. Import types:
```typescript
import type {
  ObjectLiteralInfo,
  ArrayLiteralInfo,
} from './types.js';
```

2. Destructure in `build()` method (after line ~121):
```typescript
const {
  // ... existing
  objectLiterals = [],
  arrayLiterals = [],
} = data;
```

3. Add buffer calls (after line ~231, before FLUSH):
```typescript
// 27. Buffer OBJECT_LITERAL nodes
this.bufferObjectLiteralNodes(objectLiterals);

// 28. Buffer ARRAY_LITERAL nodes
this.bufferArrayLiteralNodes(arrayLiterals);
```

4. Add buffer methods (after `bufferArrayMutationEdges`):
```typescript
/**
 * Buffer OBJECT_LITERAL nodes to the graph.
 * These are object literals passed as function arguments or nested in other literals.
 */
private bufferObjectLiteralNodes(objectLiterals: ObjectLiteralInfo[]): void {
  for (const obj of objectLiterals) {
    this._bufferNode({
      id: obj.id,
      type: obj.type,
      name: '<object>',
      file: obj.file,
      line: obj.line,
      column: obj.column,
      parentCallId: obj.parentCallId,
      argIndex: obj.argIndex
    } as GraphNode);
  }
}

/**
 * Buffer ARRAY_LITERAL nodes to the graph.
 * These are array literals passed as function arguments or nested in other literals.
 */
private bufferArrayLiteralNodes(arrayLiterals: ArrayLiteralInfo[]): void {
  for (const arr of arrayLiterals) {
    this._bufferNode({
      id: arr.id,
      type: arr.type,
      name: '<array>',
      file: arr.file,
      line: arr.line,
      column: arr.column,
      parentCallId: arr.parentCallId,
      argIndex: arr.argIndex
    } as GraphNode);
  }
}
```

## Test Strategy

Kent will write comprehensive tests covering:

1. **Factory behavior** (unit tests):
   - `ObjectLiteralNode.create()` with `argIndex` → `arg{N}` suffix
   - `ObjectLiteralNode.create()` without `argIndex` → `obj` suffix
   - Same for `ArrayLiteralNode`

2. **CallExpressionVisitor integration** (integration tests):
   - Top-level object/array literal arguments → correct IDs with `arg{N}`
   - Nested object in object property → ID with `obj` suffix (NOT property name)
   - Nested array in object property → ID with `arr` suffix (NOT property name)
   - Nested object in array element → ID with `obj` suffix (NOT `elem{N}`)
   - Nested array in array element → ID with `arr` suffix (NOT `elem{N}`)

3. **GraphBuilder integration** (integration tests):
   - Parse file with literals → verify nodes appear in graph
   - Verify all literal types buffered correctly
   - Verify node fields match factory output

## Commit Strategy

### Commit 1: Add GraphBuilder buffer methods
```
feat(REG-110): add GraphBuilder methods for object/array literals

- Add bufferObjectLiteralNodes() method
- Add bufferArrayLiteralNodes() method
- Import ObjectLiteralInfo and ArrayLiteralInfo types
- Add buffer calls in build() method
- Fixes product gap: literals now written to graph

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

**Why first**: Independent feature, closes the product gap immediately.

### Commit 2: Migrate top-level argument literals
```
feat(REG-110): migrate top-level arg literals to factories

- Use ObjectLiteralNode.create() for object args
- Use ArrayLiteralNode.create() for array args
- Add imports for node classes
- No ID format change (already matches factory)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

**Why second**: No breaking changes, safe migration.

### Commit 3: Migrate nested literals (BREAKING)
```
feat(REG-110): migrate nested literals to factories

BREAKING CHANGE: Nested literal IDs now use default suffixes:
- Before: OBJECT_LITERAL#{propertyName}#... or #elem{N}#...
- After: OBJECT_LITERAL#obj#... or ARRAY_LITERAL#arr#...

- Migrate nested object/array in object properties
- Migrate nested object/array in array elements
- Use factory defaults (no special context suffixes)
- Update tests for new ID format

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

**Why last**: Contains breaking changes, clearly documented.

## Risk Analysis

### Breaking Changes

**Nested literal IDs will change**:
- Impact: Any code/tests relying on specific nested literal IDs will break
- Scope: Nested literals only (property values, array elements)
- Top-level args: Unchanged

**Mitigation**:
- User explicitly approved this change
- Tests will be updated to reflect new format
- GraphBuilder integration ensures nodes still appear in graph with correct data

### Non-Breaking Improvements

- GraphBuilder now writes literals to graph (was a bug)
- Factory output is properly typed (`ObjectLiteralNodeRecord` vs plain object)
- Consistent node creation across codebase

### No Factory Changes

- Zero risk to existing factory users
- No new special-case options
- Factory contract remains clean and semantic

## Success Criteria

1. All 6 inline literal creations migrated to factories
2. GraphBuilder buffers both literal types
3. Tests pass with new ID formats
4. No modifications to ObjectLiteralNode or ArrayLiteralNode classes
5. Commit messages clearly document breaking changes

## Why This Plan Is Right

- **Simple**: Use factories as designed, no hacks
- **Consistent**: Matches other NodeContract migrations
- **Clean**: No leaking of traversal context into node IDs
- **Honest**: Breaking changes acknowledged and documented
- **Complete**: Fixes both migration task AND product gap

The ID format change is acceptable because:
1. It's semantically correct (nested literals ARE generic objects/arrays, not "property named X")
2. User approved it
3. If we need context later, we add it properly (edges or metadata), not through ID mangling
