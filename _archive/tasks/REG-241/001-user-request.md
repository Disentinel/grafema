# REG-241: Minor code quality improvements in query.ts

## Issues

Bundle of minor improvements for `packages/cli/src/commands/query.ts`:

### 1. Magic string duplication

`'http:route'` is repeated multiple times. Extract to constant:

```typescript
const HTTP_ROUTE_TYPE = 'http:route';
```

### 2. Type casting

`nodeType as any` when calling `queryNodes()`. Consider fixing the type definition or adding proper type guards.

### 3. Input validation

`--limit` parameter is not validated. Invalid values like `-1` or `abc` could cause issues:

```typescript
const limit = parseInt(options.limit, 10);
if (isNaN(limit) || limit < 1) {
  exitWithError('Invalid limit', ['Use a positive number']);
}
```

### 4. Comment consistency

Some functions have JSDoc, some have inline comments, some have none. Standardize documentation style.

## Context

Tech debt from REG-207 implementation review (Kevlin Henney).
