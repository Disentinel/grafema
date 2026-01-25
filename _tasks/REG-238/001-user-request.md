# REG-238: Test assertions too permissive in query-http-routes.test.ts

## Problem

In `packages/cli/test/query-http-routes.test.ts`, assertions use loose `||` checks:

```typescript
assert.ok(
  result.stdout.includes('/api') || result.stdout.includes('http:route'),
  `Should find routes with /api`
);
```

This could pass even if the format is wrong — e.g., showing semantic ID instead of `METHOD PATH`.

## Proposed Solution

Tighten assertions to verify specific output format:

```typescript
assert.ok(
  result.stdout.includes('[http:route] GET /api'),
  'Should display as [http:route] METHOD PATH'
);
```

## Context

Tech debt from REG-207 implementation review (Kevlin Henney).
