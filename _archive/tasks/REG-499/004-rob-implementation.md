# Rob Pike — Implementation Report: REG-499

## Change Made

Removed hardcoded developer path `/Users/vadimr/grafema` from the `possibleRoots` array in the `findServerBinary()` method.

**File:** `packages/vscode/src/grafemaClient.ts`, lines 172-181

**Before:**
```typescript
const possibleRoots = [
  // When running from extension host
  join(this.workspaceRoot, 'node_modules', '@grafema', 'rfdb-client'),
  // When in monorepo development
  join(__dirname, '..', '..', '..'),
  join(__dirname, '..', '..', '..', '..'),
  join(__dirname, '..', '..', '..', '..', '..'),
  // Known grafema monorepo location (development convenience)
  '/Users/vadimr/grafema',
];
```

**After:**
```typescript
const possibleRoots = [
  // When running from extension host
  join(this.workspaceRoot, 'node_modules', '@grafema', 'rfdb-client'),
  // When in monorepo development
  join(__dirname, '..', '..', '..'),
  join(__dirname, '..', '..', '..', '..'),
  join(__dirname, '..', '..', '..', '..', '..'),
];
```

## Build Result

```
Build complete
```

Build succeeded with no errors.

## Notes

The removed path was a development convenience that hardcoded the maintainer's local filesystem layout. It would cause the extension to silently pick up an unexpected server binary when run on any machine where `/Users/vadimr/grafema` happened to exist (or not find the binary at all on machines where it doesn't). The remaining `__dirname`-relative paths cover monorepo development correctly without embedding a specific user's home directory.
