# REG-303: AST: Track type parameter constraints

## Issue

**Gap:** Generic constraints not tracked.

**Example:**

```typescript
function process<T extends Serializable>(item: T): string { }
```

## Acceptance Criteria

- [ ] TYPE_PARAMETER node with constraint reference
- [ ] EXTENDS edge to constraint type
