# REG-272: Track loop variable declarations (for...of/for...in destructuring)

## Problem

Loop variable declarations in for...of and for...in are not tracked at all:

```javascript
for (const { x, y } of points) {
  console.log(x, y);  // x and y are invisible in the graph
}

for (const key in obj) {
  console.log(key);  // key is not tracked
}
```

## Why It Matters

* **Data flow tracing** - Values from arrays/objects flow into loop variables
* **Variable usage** - These variables are used in loop bodies but appear undefined
* **Destructuring patterns** - Complex patterns extract multiple values

## Proposed Solution

1. When processing ForOfStatement/ForInStatement:
   * Create VARIABLE nodes for declared loop variables
   * Handle destructuring patterns (ObjectPattern, ArrayPattern)
   * Create DERIVES_FROM edges from iterated collection

### Example

```javascript
for (const { name, age } of users) {
  process(name, age);
}
```

Graph:

```
LOOP#for-of
  ├─[ITERATES_OVER]→ VARIABLE(users)
  ├─[DECLARES]→ VARIABLE(name)
  │    └─[DERIVES_FROM]→ VARIABLE(users).name
  ├─[DECLARES]→ VARIABLE(age)
  │    └─[DERIVES_FROM]→ VARIABLE(users).age
  └─[HAS_BODY]→ SCOPE
       └─[CONTAINS]→ CALL(process)
            ├─[PASSES_ARGUMENT]→ VARIABLE(name)
            └─[PASSES_ARGUMENT]→ VARIABLE(age)
```

## Acceptance Criteria

- [ ] Simple loop variables tracked (for const x of arr)
- [ ] Destructuring patterns tracked (for const { a, b } of arr)
- [ ] Array destructuring tracked (for const [a, b] of arr)
- [ ] DERIVES_FROM edges connect to source collection
- [ ] Variables scoped correctly to loop body
