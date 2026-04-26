# REG-187: Implementation Complete

## Summary

Fixed the `trace "X from Y"` scope filtering to use semantic ID parsing instead of file path heuristic.

## Changes Made

### 1. `/packages/cli/src/commands/trace.ts`

**Line 12** - Added import:
```typescript
import { RFDBServerBackend, parseSemanticId } from '@grafema/core';
```

**Lines 145-161** - Replaced file path heuristic with semantic ID parsing:

Before (broken):
```typescript
if (scopeName) {
  const file = (node as any).file || '';
  if (!file.toLowerCase().includes(scopeName.toLowerCase())) {
    continue;
  }
}
```

After (correct):
```typescript
const lowerScopeName = scopeName ? scopeName.toLowerCase() : null;
// ...
if (scopeName) {
  const parsed = parseSemanticId(node.id);
  if (!parsed) continue;

  if (!parsed.scopePath.some(s => s.toLowerCase() === lowerScopeName)) {
    continue;
  }
}
```

### 2. `/test/unit/commands/trace.test.js` (NEW)

Created comprehensive test suite with 27 tests covering:
- Exact scope matching
- Regression test (file path should NOT match)
- Nested scope handling (try#0, catch#0)
- Case insensitivity
- Invalid IDs gracefully skipped
- Multiple variables same name
- Special nodes (singletons, external modules)
- Global scope
- Class/method scopes

## Test Results

All 27 tests pass.

## Acceptance Criteria Verification

| Criteria | Status |
|----------|--------|
| `trace "X from Y"` finds variables within scope Y | ✅ PASS |
| Works for nested scopes (try blocks, if blocks) | ✅ PASS |
| Works when function name doesn't match file name | ✅ PASS |
| Error message is clear when scope Y doesn't exist | ✅ PASS |

## Reviews

- **Kevlin Henney (Code Quality)**: Conditional approval → Fixed performance issue
- **Linus Torvalds (High-level)**: APPROVED

## Performance Fix (per Kevlin's review)

- Moved `scopeName.toLowerCase()` outside the loop
- Changed from `map().includes()` to `some()` for early exit

## Tech Debt Noted (for Linear backlog)

1. Type safety: `(node as any)` pattern should be eliminated with proper RFDB types
2. Test architecture: Consider integration tests or extracting testable functions

## Files Modified

1. `packages/cli/src/commands/trace.ts` - 1 import + 8 lines changed
2. `test/unit/commands/trace.test.js` - NEW file, ~600 lines
