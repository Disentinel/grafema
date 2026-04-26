# Don Melton: High-Level Plan for REG-110

## Analysis

### Current State

**Issue description is WRONG.** The Linear issue (REG-110) references non-existent methods:
- `GraphBuilder.bufferObjectLiteralNodes()` at line 1247
- `GraphBuilder.bufferArrayLiteralNodes()` at line 1316

These methods **do not exist**. GraphBuilder.ts is 1429 lines and has no handling for object/array literals at all.

### Where Object/Array Literals Are Actually Created

The inline OBJECT_LITERAL and ARRAY_LITERAL creation happens in:

**`packages/core/src/plugins/analysis/ast/visitors/CallExpressionVisitor.ts`**

There are **6 distinct locations** creating these nodes inline:

1. **Lines 325-336** - Top-level object literal as function argument:
```typescript
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

2. **Lines 376-387** - Top-level array literal as function argument (similar pattern)

3. **Lines 555-562** - Nested object literal inside object property value

4. **Lines 586-593** - Nested array literal inside object property value

5. **Lines 710-717** - Nested object literal inside array element

6. **Lines 737-744** - Nested array literal inside array element

### Existing Factory Methods

`NodeFactory.ts` already has the factory methods ready:

```typescript
static createObjectLiteral(file: string, line: number, column: number, options: ObjectLiteralOptions = {}) {
  return ObjectLiteralNode.create(file, line, column, options);
}

static createArrayLiteral(file: string, line: number, column: number, options: ArrayLiteralOptions = {}) {
  return ArrayLiteralNode.create(file, line, column, options);
}
```

The node contracts in `ObjectLiteralNode.ts` and `ArrayLiteralNode.ts` handle:
- ID generation with counter support
- Required field validation
- Standard field set

### Pattern From Recent Migrations

Looking at REG-100 to REG-105 migrations, the pattern is:
1. Import the NodeContract from `./nodes/`
2. Replace inline object creation with `NodeContract.create()` or `NodeFactory.createX()`
3. Remove duplicate interface definitions
4. Update type annotations to use the Record type

However, **those migrations were in different files** (ASTWorker.ts, QueueWorker.ts) - not in CallExpressionVisitor.

### Key Architectural Question

**Why are object/array literals created in CallExpressionVisitor but NOT buffered in GraphBuilder?**

Looking at the data flow:
1. CallExpressionVisitor creates `ObjectLiteralInfo[]` and `ArrayLiteralInfo[]`
2. These are part of `Collections` interface in `types.ts`
3. GraphBuilder.build() receives `ASTCollections` but **does NOT destructure or use** `objectLiterals` or `arrayLiterals`

This is a **product gap**: object/array literal nodes are collected but never written to the graph!

## High-Level Plan

### Step 0: Clarify Scope

**Before implementation**, confirm with user:
1. Do we ONLY migrate the node creation pattern (use factory methods)?
2. Or do we ALSO need to add the missing `bufferObjectLiteralNodes()` and `bufferArrayLiteralNodes()` to GraphBuilder?

Based on the issue title "use existing NodeFactory methods", the scope appears to be:
- Migrate 6 inline creations in CallExpressionVisitor to use `NodeFactory.createObjectLiteral()` / `NodeFactory.createArrayLiteral()`

### Step 1: Write Tests (TDD)

Write tests that lock current behavior:
- Test that OBJECT_LITERAL nodes are created with correct ID format
- Test that ARRAY_LITERAL nodes are created with correct ID format
- Test nested object/array literals get unique IDs via counter

### Step 2: Migrate CallExpressionVisitor

Replace all 6 inline creations:

**For each inline creation:**
```typescript
// BEFORE:
const objectId = `OBJECT_LITERAL#arg${index}#${module.file}#${line}:${column}:${counter++}`;
objectLiterals.push({
  id: objectId,
  type: 'OBJECT_LITERAL',
  file: module.file,
  line: line,
  column: column,
  parentCallId: callId,
  argIndex: index
});

// AFTER:
const objectNode = NodeFactory.createObjectLiteral(
  module.file,
  argInfo.line,
  argInfo.column,
  {
    parentCallId: callId,
    argIndex: index,
    counter: objectLiteralCounterRef.value++
  }
);
objectLiterals.push(objectNode);
```

### Step 3: Import NodeFactory

Add import at top of CallExpressionVisitor.ts:
```typescript
import { NodeFactory } from '../../../../core/NodeFactory.js';
```

### Step 4: Verify Tests Pass

Run existing tests + new tests to verify behavioral identity is preserved.

## Risks/Concerns

### ID Format Compatibility

**CRITICAL**: The factory methods generate IDs differently from inline code.

**Inline code (CallExpressionVisitor):**
```typescript
`OBJECT_LITERAL#arg${index}#${file}#${line}:${column}:${counter++}`
```

**Factory (ObjectLiteralNode.create):**
```typescript
const argSuffix = options.argIndex !== undefined ? `arg${options.argIndex}` : 'obj';
const id = `OBJECT_LITERAL#${argSuffix}#${file}#${line}:${column || 0}${counter}`;
```

Differences:
1. Counter format: `:${counter}` vs `${counter}` (with vs without colon before counter)
2. argSuffix logic: inline uses `arg${index}` always, factory uses `arg${argIndex}` or `obj` fallback

This means **ID format will change** which could break existing graphs or tests.

**Decision needed**: Accept ID format change or modify factory to match current format?

### Missing GraphBuilder Integration

The collections `objectLiterals` and `arrayLiterals` are never used in GraphBuilder. This is a separate issue but related. If we migrate the creation, we should also ensure they get buffered.

### Nested Literals Counter State

The nested literal extraction passes counters around via refs. Need to ensure factory counter option works correctly in recursive calls.

## Verdict

**This is NOT fully the RIGHT approach yet.**

The issue description is based on wrong assumptions about the codebase structure. Before proceeding:

1. **Clarify the ID format question** - breaking change or preserve exact format?
2. **Decide on GraphBuilder integration** - should this task also add buffering, or is that a separate issue?
3. **Update the Linear issue** with correct file location (CallExpressionVisitor.ts, not GraphBuilder.ts)

If the decision is:
- Accept ID format change from factory
- Only migrate creation, not add GraphBuilder buffering

Then the migration is straightforward but has breaking change implications.

**Recommendation**:
1. Create a sub-task for fixing factory ID format to match existing inline format
2. Or accept this as a breaking change with full reanalysis needed

The RIGHT thing is to have consistent factory usage across the codebase. The question is whether we fix the factory or accept the format change.
