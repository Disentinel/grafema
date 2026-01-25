# REG-240: Fragile JSON parsing in query tests silently ignores errors

## Problem

In `packages/cli/test/query-http-routes.test.ts`, JSON parsing errors are silently caught:

```typescript
try {
  const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
  // assertions...
} catch {
  // JSON parsing may fail if feature not implemented - that's OK
}
```

This was intentional for TDD (tests written before implementation), but now that the feature is implemented, these should fail loudly if JSON is malformed.

## Proposed Solution

Remove the try-catch or make it fail on parsing errors:

```typescript
const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
assert.ok(Array.isArray(parsed), 'Should be valid JSON array');
```

## Context

Tech debt from REG-207 implementation review (Kevlin Henney).

## Scope

Two locations in the test file need to be fixed:
1. Lines 300-322: "should NOT return POST routes when searching for GET /api/users"
2. Lines 467-487: "should NOT match function named 'postMessage' when searching for HTTP POST"
