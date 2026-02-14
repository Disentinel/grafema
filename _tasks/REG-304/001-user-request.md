# REG-304: AST: Track conditional types

## Gap
Conditional types not represented in the graph.

## Example

```typescript
type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;
```

## Acceptance Criteria

- [ ] TYPE node with conditionalType: true
- [ ] Track check, extends, true, false branches
