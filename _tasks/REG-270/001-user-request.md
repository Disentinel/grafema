# REG-270: Track generator function yields (YIELDS edge)

**Labels:** v0.3, Feature
**Priority:** Low
**Linear:** https://linear.app/reginaflow/issue/REG-270/track-generator-function-yields-yields-edge

## Problem

Generator functions have `generator: true` flag but their yielded values are not tracked.

```javascript
function* gen() {
  yield 1;           // What values are yielded? Not tracked
  yield* otherGen(); // Delegation to another generator - not tracked
}
```

## Why It Matters

* **Data flow through iterators** - Generators are used for async iteration, streams
* **Understanding generator output** - What values can a generator produce?
* **Delegation chains** - `yield*` creates invisible dependencies

## Proposed Solution

### New Edges

```
YIELDS         - FUNCTION → yielded value expression
DELEGATES_TO   - FUNCTION → delegated generator (for yield*)
```

### Implementation

1. Handle `YieldExpression` in FunctionVisitor
2. Create YIELDS edge from FUNCTION to yielded value/expression
3. For `yield*`, create DELEGATES_TO edge to target generator

## Example

```javascript
function* numbers() {
  yield 1;
  yield 2;
}

function* all() {
  yield* numbers();
  yield 3;
}
```

Graph:

```
FUNCTION(numbers)
  ├─[YIELDS]→ LITERAL(1)
  └─[YIELDS]→ LITERAL(2)

FUNCTION(all)
  ├─[DELEGATES_TO]→ FUNCTION(numbers)
  └─[YIELDS]→ LITERAL(3)
```

## Acceptance Criteria

- [ ] YIELDS edges created for yield expressions
- [ ] DELEGATES_TO edges created for yield* expressions
- [ ] Generator functions can be queried for their yield types
- [ ] Tests cover yield, yield*, async generators
