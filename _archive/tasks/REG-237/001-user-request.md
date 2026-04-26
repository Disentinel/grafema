# REG-237: Silent error suppression in query.ts catch blocks

## Problem

In `packages/cli/src/commands/query.ts`, catch blocks silently swallow errors:

```typescript
} catch {
  // Ignore errors
}
```

This makes debugging difficult when something goes wrong in:

* `getCallers()`
* `findContainingFunction()`
* `getCallees()`
* `findCallsInFunction()`

## Proposed Solution

Add minimal error logging to stderr for debuggability:

```typescript
} catch (error) {
  if (process.env.DEBUG) {
    console.error('[query] Error in getCallers:', error);
  }
}
```

Or use a proper debug logger.

## Context

Tech debt from REG-207 implementation review (Kevlin Henney).
