# User Request: REG-117 - Data Flow: Track nested array mutations

## Linear Issue

**ID:** REG-117
**Title:** Data Flow: Track nested array mutations (obj.arr.push)
**Priority:** Medium
**Related Issues:** REG-113 (array mutations), REG-114 (object property mutations)

## Problem Statement

Current array mutation tracking only handles direct array mutations:

```javascript
arr.push(item);  // ✓ Tracked
```

But nested mutations are not tracked:

```javascript
obj.arr.push(item);       // ✗ NOT tracked
this.items.push(item);    // ✗ NOT tracked
data.nested.list.push(x); // ✗ NOT tracked
```

## Why It Matters

Real codebases often have arrays as object properties:

```javascript
class Store {
  items = [];

  addItem(item) {
    this.items.push(item); // Not tracked!
  }
}
```

## Proposed Solution (from issue)

When detecting `.push()` / `.unshift()` / `.splice()`:

1. Check if receiver is `MemberExpression` (not just `Identifier`)
2. Resolve the property chain to find the target array variable
3. Create `FLOWS_INTO` edge to the nested array

## Acceptance Criteria

- [ ] `obj.arr.push(item)` creates edge from `item` to `obj.arr`
- [ ] `this.items.push(item)` works in class methods
- [ ] Tests for nested mutation patterns
