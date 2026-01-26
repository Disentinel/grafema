# REG-261: Validation: Detect broken imports (non-existent exports, undefined symbols)

## Problem

Grafema doesn't detect broken imports:

1. Importing a non-existent export from a module
2. Using a symbol that's neither defined locally nor imported

TypeScript catches this at compile time, but for untyped JS codebases (Grafema's target audience), these are **runtime errors**.

## Test Case (Jammers)

```typescript
// Invitations.tsx line 3 - changed import
import { nonExistentFunction } from './utils';  // ← should error: doesn't exist
// ... later in code ...
existingFunction();  // ← should error: not imported, undefined
```

TSC shows error, project won't build. Without TS = runtime crash.

**Grafema found nothing.**

## Expected Behavior

`grafema check` should report:

```
[ERR_BROKEN_IMPORT] Import "nonExistentFunction" from "./utils" - export doesn't exist
  /path/to/Invitations.tsx:3

[ERR_UNDEFINED_SYMBOL] "existingFunction" is used but not defined or imported
  /path/to/Invitations.tsx:45
```

## Implementation

Create `BrokenImportValidator` or extend `ImportExportLinker`:

1. For each IMPORT edge, verify target EXPORT exists in source module
2. For each CALLS/REFERENCES edge from a function, verify target is:
   * Defined in same module, OR
   * Imported, OR
   * Global (console, setTimeout, etc.)

## Priority

High — this is exactly the kind of bug Grafema should catch for untyped codebases.
