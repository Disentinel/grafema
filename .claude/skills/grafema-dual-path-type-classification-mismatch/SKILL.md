---
name: grafema-dual-path-type-classification-mismatch
description: |
  Debug coordinate-based node lookup failures in Grafema when two code paths classify
  the same AST node differently. Use when: (1) bufferArrayMutationEdges or similar
  GraphBuilder methods fail to find nodes by line/column despite nodes existing,
  (2) one method classifies a value as LITERAL while another creates an OBJECT_LITERAL
  or ARRAY_LITERAL node at the same coordinates, (3) extractLiteralValue returns non-null
  for ObjectExpression/ArrayExpression with all-literal properties, causing type mismatch.
  Root cause: check order differs between detection (detectArrayMutation) and node creation
  (extractArguments). Solution: align check order across both paths.
author: Claude Code
version: 1.0.0
date: 2026-02-09
---

# Grafema Dual-Path Type Classification Mismatch

## Problem

When two separate code paths classify the same AST node independently, differences in
check order can cause one path to assign a different type than the other. Coordinate-based
lookups then fail because they search the wrong collection.

## Context / Trigger Conditions

- FLOWS_INTO (or similar) edges not created despite value nodes existing in the graph
- `bufferArrayMutationEdges` finds no matching node at expected line/column
- `arr.push({name: 'test'})` or `arr.push([1, 2, 3])` don't create edges
- `detectArrayMutation` sets `valueType: 'LITERAL'` but `extractArguments` creates
  an `OBJECT_LITERAL` or `ARRAY_LITERAL` node
- Any scenario where `ExpressionEvaluator.extractLiteralValue()` returns non-null for
  ObjectExpression or ArrayExpression (objects/arrays with all-literal properties)

## Root Cause

`ExpressionEvaluator.extractLiteralValue()` handles ObjectExpression and ArrayExpression:
it returns `{name: 'test'}` as a literal value when all properties are literals. This
means the check order matters critically:

**Path A (detection — `detectArrayMutation`):**
```
1. extractLiteralValue(node) → non-null for {name:'test'} → classifies as LITERAL
2. ObjectExpression check → NEVER REACHED
```

**Path B (node creation — `extractArguments`):**
```
1. ObjectExpression check → creates OBJECT_LITERAL node
2. extractLiteralValue → only reached for primitives
```

In `bufferArrayMutationEdges`, the lookup searches `literals` collection for a LITERAL
node at the coordinates, but the actual node is in `objectLiterals` as OBJECT_LITERAL.

## Solution

Align check order across both paths. Always check structural types (ObjectExpression,
ArrayExpression) BEFORE calling `extractLiteralValue`:

```typescript
// CORRECT ORDER (matches extractArguments):
if (actualArg.type === 'ObjectExpression') {
  argInfo.valueType = 'OBJECT_LITERAL';
} else if (actualArg.type === 'ArrayExpression') {
  argInfo.valueType = 'ARRAY_LITERAL';
} else if (actualArg.type === 'Identifier') {
  argInfo.valueType = 'VARIABLE';
} else if (actualArg.type === 'CallExpression') {
  argInfo.valueType = 'CALL';
} else {
  const literalValue = ExpressionEvaluator.extractLiteralValue(actualArg);
  if (literalValue !== null) {
    argInfo.valueType = 'LITERAL';
  }
}
```

## Verification

1. Run tests for the specific mutation type: `node --test test/unit/ArrayMutationTracking.test.js`
2. Verify FLOWS_INTO edges are created for `arr.push({obj})` and `arr.push([arr])`
3. Check that LITERAL classification still works for primitives (`arr.push('hello')`)

## General Pattern

This is a broader pattern in Grafema: **when two code paths independently classify
the same data, their classification logic must be identical in order.** Watch for this
whenever:

- Detection runs separately from node creation
- Coordinate-based lookups bridge the gap between detection and node creation
- `ExpressionEvaluator` helper methods have broad matching (e.g., extractLiteralValue
  matching objects/arrays)

## Notes

- `extractLiteralValue` handling ObjectExpression/ArrayExpression is intentional and
  correct for its primary use case (evaluating constant expressions)
- The mismatch only manifests when coordinate-based lookup is used; direct `valueNodeId`
  paths are unaffected
- This same pattern could affect `detectIndexedArrayAssignment` which still checks
  `extractLiteralValue` before `ObjectExpression` — tracked as tech debt
