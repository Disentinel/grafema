# REG-309: Scope-aware variable lookup for mutations

## Context

Variable reassignment tracking (REG-290) uses file-level variable lookup, not scope-aware. This means shadowed variables in nested scopes incorrectly resolve to outer scope variable.

## Example

```javascript
let x = 1;
function foo() {
  let x = 2;
  x += 3;  // Currently creates edge to outer x (WRONG)
}
```

## Impact

- Affects variable reassignments (REG-290)
- Affects array mutations (`bufferArrayMutationEdges`)
- Affects object mutations (`bufferObjectMutationEdges`)

## Acceptance Criteria

- [ ] Implement scope-aware variable lookup in GraphBuilder
- [ ] Update all mutation handlers to use scope-aware lookup
- [ ] Add tests for shadowed variable scenarios
