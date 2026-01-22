# Joel Spolsky: Technical Implementation Plan for REG-110

## Summary

Migrate inline OBJECT_LITERAL and ARRAY_LITERAL node creation in `CallExpressionVisitor.ts` to use `ObjectLiteralNode.create()` and `ArrayLiteralNode.create()` factory methods. Additionally, implement GraphBuilder integration to buffer these nodes to the graph (currently they're collected but never written).

**Key decisions from user:**
1. Accept breaking ID format change (factory format vs legacy format)
2. Fix GraphBuilder integration in this task

## Prerequisites

Before implementation:
1. Understand current ID formats (inline vs factory)
2. Understand nested literal contexts (arg, property name, elem)
3. Understand GraphBuilder buffer pattern
4. NodeFactory import already exists in CallExpressionVisitor (line 18)

## ID Format Analysis

### Current Inline Format (CallExpressionVisitor)

| Context | ID Format |
|---------|-----------|
| Top-level arg | `OBJECT_LITERAL#arg{index}#{file}#{line}:{column}:{counter}` |
| Nested in object property | `OBJECT_LITERAL#{propertyName}#{file}#{line}:{column}:{counter}` |
| Nested in array element | `OBJECT_LITERAL#elem{index}#{file}#{line}:{column}:{counter}` |

### Factory Format (ObjectLiteralNode.create / ArrayLiteralNode.create)

```typescript
const argSuffix = options.argIndex !== undefined ? `arg${options.argIndex}` : 'obj';
const id = `OBJECT_LITERAL#${argSuffix}#${file}#${line}:${column || 0}${counter}`;
```

**Problems with current factory:**
1. Only supports `arg{N}` or `obj` suffix - no support for property names or `elem{N}`
2. Factory defaults to `obj`/`arr` for nested contexts, but inline uses property name or `elem{N}`

### Solution: Extend Factory Options

Add `contextSuffix` option to both factories to support all contexts:

```typescript
interface ObjectLiteralNodeOptions {
  parentCallId?: string;
  argIndex?: number;
  counter?: number;
  contextSuffix?: string;  // NEW: for nested contexts like 'propertyName' or 'elem0'
}
```

Factory logic becomes:
```typescript
const suffix = options.contextSuffix ??
               (options.argIndex !== undefined ? `arg${options.argIndex}` : 'obj');
```

## Implementation Steps

### Step 1: Extend Factory Options (ObjectLiteralNode.ts)

**File**: `/packages/core/src/core/nodes/ObjectLiteralNode.ts`

**Changes**:
```typescript
// In ObjectLiteralNodeOptions interface (add):
contextSuffix?: string;

// In create() method, replace:
const argSuffix = options.argIndex !== undefined ? `arg${options.argIndex}` : 'obj';

// With:
const suffix = options.contextSuffix ??
               (options.argIndex !== undefined ? `arg${options.argIndex}` : 'obj');
const id = `OBJECT_LITERAL#${suffix}#${file}#${line}:${column || 0}${counter}`;
```

### Step 2: Extend Factory Options (ArrayLiteralNode.ts)

**File**: `/packages/core/src/core/nodes/ArrayLiteralNode.ts`

**Changes**: Same pattern as Step 1, but with `'arr'` as default instead of `'obj'`.

### Step 3: Update NodeFactory Options Types

**File**: `/packages/core/src/core/NodeFactory.ts`

**Changes**: Add `contextSuffix?: string` to both `ObjectLiteralOptions` and `ArrayLiteralOptions` interfaces.

### Step 4: Migrate Top-Level Object Literal (Line ~327)

**File**: `/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Before** (lines 326-338):
```typescript
const objectLiteralCounterRef = this.collections.objectLiteralCounterRef as CounterRef;
const objectId = `OBJECT_LITERAL#arg${index}#${module.file}#${argInfo.line}:${argInfo.column}:${objectLiteralCounterRef.value++}`;

(this.collections.objectLiterals as ObjectLiteralInfo[]).push({
  id: objectId,
  type: 'OBJECT_LITERAL',
  file: module.file,
  line: argInfo.line,
  column: argInfo.column,
  parentCallId: callId,
  argIndex: index
});
```

**After**:
```typescript
const objectLiteralCounterRef = this.collections.objectLiteralCounterRef as CounterRef;
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
```

Also: update objectId variable to use `objectNode.id`.

### Step 5: Migrate Top-Level Array Literal (Line ~378)

**File**: Same file

**Before** (lines 377-389):
```typescript
const arrayLiteralCounterRef = this.collections.arrayLiteralCounterRef as CounterRef;
const arrayId = `ARRAY_LITERAL#arg${index}#${module.file}#${argInfo.line}:${argInfo.column}:${arrayLiteralCounterRef.value++}`;

(this.collections.arrayLiterals as ArrayLiteralInfo[]).push({
  id: arrayId,
  type: 'ARRAY_LITERAL',
  ...
});
```

**After**:
```typescript
const arrayLiteralCounterRef = this.collections.arrayLiteralCounterRef as CounterRef;
const arrayNode = ArrayLiteralNode.create(
  module.file,
  argInfo.line,
  argInfo.column,
  {
    parentCallId: callId,
    argIndex: index,
    counter: arrayLiteralCounterRef.value++
  }
);
(this.collections.arrayLiterals as ArrayLiteralInfo[]).push(arrayNode);
```

### Step 6: Migrate Nested Object Literal in Object Property (Line ~557)

**Before** (lines 557-564):
```typescript
const nestedObjectId = `OBJECT_LITERAL#${propertyName}#${module.file}#${value.loc?.start.line}:${value.loc?.start.column}:${objectLiteralCounterRef.value++}`;
objectLiterals.push({
  id: nestedObjectId,
  type: 'OBJECT_LITERAL',
  file: module.file,
  line: value.loc?.start.line || 0,
  column: value.loc?.start.column || 0
});
```

**After**:
```typescript
const nestedObjectNode = ObjectLiteralNode.create(
  module.file,
  value.loc?.start.line || 0,
  value.loc?.start.column || 0,
  {
    contextSuffix: propertyName,
    counter: objectLiteralCounterRef.value++
  }
);
objectLiterals.push(nestedObjectNode);
const nestedObjectId = nestedObjectNode.id;
```

### Step 7: Migrate Nested Array Literal in Object Property (Line ~588)

**Before** (lines 588-595):
```typescript
const nestedArrayId = `ARRAY_LITERAL#${propertyName}#${module.file}#${value.loc?.start.line}:${value.loc?.start.column}:${arrayLiteralCounterRef.value++}`;
(arrayLiterals as ArrayLiteralInfo[]).push({
  id: nestedArrayId,
  type: 'ARRAY_LITERAL',
  ...
});
```

**After**:
```typescript
const nestedArrayNode = ArrayLiteralNode.create(
  module.file,
  value.loc?.start.line || 0,
  value.loc?.start.column || 0,
  {
    contextSuffix: propertyName,
    counter: arrayLiteralCounterRef.value++
  }
);
(arrayLiterals as ArrayLiteralInfo[]).push(nestedArrayNode);
const nestedArrayId = nestedArrayNode.id;
```

### Step 8: Migrate Nested Object Literal in Array Element (Line ~712)

**Before** (lines 712-719):
```typescript
const nestedObjectId = `OBJECT_LITERAL#elem${index}#${module.file}#${elemLine}:${elemColumn}:${objectLiteralCounterRef.value++}`;
objectLiterals.push({
  id: nestedObjectId,
  type: 'OBJECT_LITERAL',
  ...
});
```

**After**:
```typescript
const nestedObjectNode = ObjectLiteralNode.create(
  module.file,
  elemLine,
  elemColumn,
  {
    contextSuffix: `elem${index}`,
    counter: objectLiteralCounterRef.value++
  }
);
objectLiterals.push(nestedObjectNode);
const nestedObjectId = nestedObjectNode.id;
```

### Step 9: Migrate Nested Array Literal in Array Element (Line ~739)

**Before** (lines 739-746):
```typescript
const nestedArrayId = `ARRAY_LITERAL#elem${index}#${module.file}#${elemLine}:${elemColumn}:${arrayLiteralCounterRef.value++}`;
arrayLiterals.push({
  id: nestedArrayId,
  type: 'ARRAY_LITERAL',
  ...
});
```

**After**:
```typescript
const nestedArrayNode = ArrayLiteralNode.create(
  module.file,
  elemLine,
  elemColumn,
  {
    contextSuffix: `elem${index}`,
    counter: arrayLiteralCounterRef.value++
  }
);
arrayLiterals.push(nestedArrayNode);
const nestedArrayId = nestedArrayNode.id;
```

### Step 10: Add Import for Node Classes

**File**: `/packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`

**Changes**: Add imports at top of file (after NodeFactory import):
```typescript
import { ObjectLiteralNode } from '../../../../core/nodes/ObjectLiteralNode.js';
import { ArrayLiteralNode } from '../../../../core/nodes/ArrayLiteralNode.js';
```

### Step 11: Add GraphBuilder Integration - bufferObjectLiteralNodes()

**File**: `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Changes**:

1. Import ObjectLiteralInfo and ArrayLiteralInfo types:
```typescript
import type {
  // ... existing imports
  ObjectLiteralInfo,
  ArrayLiteralInfo,
} from './types.js';
```

2. Destructure in build() method (after existing destructuring around line 121):
```typescript
const {
  // ... existing
  objectLiterals = [],
  arrayLiterals = [],
} = data;
```

3. Add buffer calls after line 231 (before FLUSH comment):
```typescript
// 27. Buffer OBJECT_LITERAL nodes
this.bufferObjectLiteralNodes(objectLiterals);

// 28. Buffer ARRAY_LITERAL nodes
this.bufferArrayLiteralNodes(arrayLiterals);
```

4. Add new buffer methods (after bufferArrayMutationEdges):
```typescript
/**
 * Buffer OBJECT_LITERAL nodes
 * These are object literals passed as function arguments or nested in other literals
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
 * Buffer ARRAY_LITERAL nodes
 * These are array literals passed as function arguments or nested in other literals
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

## Test Plan

### Unit Tests to Write

Create `/test/unit/ObjectArrayLiteralMigration.test.js`:

1. **Test ObjectLiteralNode.create() with argIndex**
   - Verify ID format: `OBJECT_LITERAL#arg{N}#...`
   - Verify all fields populated

2. **Test ObjectLiteralNode.create() with contextSuffix**
   - Verify ID uses contextSuffix instead of arg
   - Test with property names

3. **Test ArrayLiteralNode.create() with argIndex**
   - Same as object literal tests

4. **Test ArrayLiteralNode.create() with contextSuffix**
   - Verify `elem{N}` suffix works

5. **Integration test: Call with object literal argument**
   - Parse `foo({ key: value })`
   - Verify OBJECT_LITERAL node created with correct ID
   - Verify node appears in graph

6. **Integration test: Call with nested object in object**
   - Parse `foo({ outer: { inner: 1 } })`
   - Verify both OBJECT_LITERAL nodes created
   - Verify nested uses property name suffix

7. **Integration test: Call with array containing objects**
   - Parse `foo([{ a: 1 }, { b: 2 }])`
   - Verify ARRAY_LITERAL and both OBJECT_LITERAL nodes created
   - Verify objects use `elem{N}` suffix

8. **Integration test: GraphBuilder writes literals**
   - Verify OBJECT_LITERAL/ARRAY_LITERAL nodes appear in graph after build()

### Manual Verification

```bash
# Run specific test
node --test test/unit/ObjectArrayLiteralMigration.test.js

# Run all unit tests
npm test

# Build check
npm run build
```

## Commit Strategy

### Commit 1: Extend factory options
- `ObjectLiteralNode.ts` - add contextSuffix option
- `ArrayLiteralNode.ts` - add contextSuffix option
- `NodeFactory.ts` - update option types
- Tests for factory contextSuffix

### Commit 2: Migrate top-level literals
- `CallExpressionVisitor.ts` - migrate lines ~327 and ~378
- Add imports
- Tests for top-level arg literals

### Commit 3: Migrate nested literals
- `CallExpressionVisitor.ts` - migrate lines ~557, ~588, ~712, ~739
- Tests for nested literals (property name and elem context)

### Commit 4: GraphBuilder integration
- `GraphBuilder.ts` - add buffer methods and calls
- Import types
- Integration tests for graph writes

## Risk Analysis

### Breaking Changes
- **ID format change**: IDs will change from legacy format to factory format
- **Impact**: Any stored graphs will have different node IDs
- **Mitigation**: User accepted this as breaking change

### Behavioral Differences
- Factory adds `name: '<object>'` / `name: '<array>'` field which inline code didn't have
- Factory returns proper typed records vs plain objects
- These are improvements, not regressions

### Type Compatibility
- `ObjectLiteralNodeRecord` from factory vs `ObjectLiteralInfo` interface
- Need to verify collection types accept factory output
- May need to cast or update interface
