# REG-305: AST: Track mapped types

## Gap
Mapped types not represented.

## Example
```typescript
type Readonly<T> = { readonly [K in keyof T]: T[K] };
```

## Acceptance Criteria
- [ ] TYPE node with mappedType: true
- [ ] Track key constraint and value type
