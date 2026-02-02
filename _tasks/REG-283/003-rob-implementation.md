# REG-283: Implementation Report

## Summary

Added `iterates` metadata to ITERATES_OVER edges to distinguish between for-in (key iteration) and for-of (value iteration).

## Changes Made

### 1. Type Definition (`packages/types/src/edges.ts`)

Added `IteratesOverEdge` interface:

```typescript
export interface IteratesOverEdge extends EdgeRecord {
  type: 'ITERATES_OVER';
  metadata?: {
    /** What the loop iterates over: 'keys' for for-in, 'values' for for-of */
    iterates: 'keys' | 'values';
  };
}
```

### 2. Edge Creation (`packages/core/src/plugins/analysis/ast/GraphBuilder.ts`)

Updated `bufferLoopEdges()` to add metadata:

```typescript
const iterates = loop.loopType === 'for-in' ? 'keys' : 'values';

this._bufferEdge({
  type: 'ITERATES_OVER',
  src: loop.id,
  dst: param.id,
  metadata: { iterates }
});
```

### 3. Tests (`test/unit/plugins/analysis/ast/loop-nodes.test.ts`)

Added two new tests:
- `should have iterates: keys metadata on for-in ITERATES_OVER edge (REG-283)`
- `should have iterates: values metadata on for-of ITERATES_OVER edge (REG-283)`

## Acceptance Criteria

| Criteria | Status |
|----------|--------|
| LOOP node with loopType: 'for-in' | ✅ Already implemented (REG-267) |
| DECLARES edge to loop variable | ✅ Already implemented (REG-272) |
| ITERATES_OVER edge to iterated object | ✅ Already implemented (REG-267) |
| `iterates: 'keys'` metadata | ✅ Implemented |

## Test Results

```
ok 4 - should have iterates: values metadata on for-of ITERATES_OVER edge (REG-283)
ok 3 - should have iterates: keys metadata on for-in ITERATES_OVER edge (REG-283)
```

## Commit

```
59fe35c feat(analysis): add iterates metadata to ITERATES_OVER edges (REG-283)
```
