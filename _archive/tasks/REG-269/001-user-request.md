# REG-269: Track transitive closure captures (multi-level scope chains)

## Problem

Closure capture tracking (`SCOPE -[CAPTURES]→ VARIABLE`) only works for immediate parent scope. Multi-level captures are not tracked.

```javascript
function outer() {
  const x = 1;
  return function inner() {
    return function deepest() {
      return x;  // Captures from 2 levels up - NOT tracked
    }
  }
}
```

Currently, `deepest` doesn't have a CAPTURES edge to `x` because it's defined in grandparent scope.

## Why It Matters

* **Memory leak detection** - Closures holding onto large data structures
* **Debugging unexpected behavior** - Understanding what's captured where
* **Refactoring safety** - Know what variables a function depends on

## Proposed Solution

When analyzing a function, trace upward through ALL enclosing scopes to find captured variables:

```typescript
// For each identifier reference in function body:
// 1. Check local scope - if found, not a capture
// 2. Walk up scope chain to root
// 3. For each scope that defines the variable, create CAPTURES edge
```

## Edge Metadata

Add capture depth to CAPTURES edge:

```typescript
interface CapturesEdge {
  type: 'CAPTURES';
  depth: number;  // 1 = immediate parent, 2 = grandparent, etc.
}
```

## Acceptance Criteria

- [ ] CAPTURES edges created for all levels of scope chain
- [ ] `depth` metadata on CAPTURES edges
- [ ] Tests verify 3+ level deep captures
- [ ] Performance acceptable (scope chain walking is O(depth))
