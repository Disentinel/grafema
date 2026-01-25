# REG-219: RFDB Binary Not Found in ESM Context - Root Cause Analysis

**Don Melton - Tech Lead Analysis**
**Date:** 2025-01-25

## Executive Summary

This is NOT an ESM compatibility issue. This is a **code duplication and architectural violation** issue.

We have **THREE separate implementations** of the same binary lookup logic, and TWO of them are broken. The @grafema/rfdb package already provides the correct solution via `getBinaryPath()`, but we're not using it.

## The Problem

### Location 1: packages/cli/src/commands/server.ts (BROKEN)
**Line 31:** Uses bare `require.resolve('@grafema/rfdb')` in ESM context

```typescript
function findServerBinary(): string | null {
  try {
    const rfdbPkg = require.resolve('@grafema/rfdb');  // ❌ BROKEN - bare require in ESM
    const rfdbDir = dirname(rfdbPkg);
    // ... manual path construction
  } catch {
    // @grafema/rfdb not installed
  }
  // ... fallback to monorepo paths
}
```

**Problem:** This file is ESM (uses `import`, `import.meta.url`), but line 31 uses bare `require.resolve` without importing `createRequire` from 'module'. This will fail.

### Location 2: packages/core/src/storage/backends/RFDBServerBackend.ts (WORKS)
**Line 175-176:** Uses `createRequire(import.meta.url)` correctly

```typescript
private _findServerBinary(): string | null {
  try {
    const require = createRequire(import.meta.url);  // ✅ CORRECT
    const rfdbPkg = require.resolve('@grafema/rfdb');
    const rfdbDir = dirname(rfdbPkg);
    // ... manual path construction
  } catch {
    // @grafema/rfdb not installed
  }
  // ... fallback to monorepo paths
}
```

**Problem:** While this works, it's still duplicating logic that should come from @grafema/rfdb package.

### Location 3: @grafema/rfdb/index.js (CANONICAL)
**The package ALREADY provides the solution:**

```javascript
function getBinaryPath() {
  const platform = process.platform;
  const arch = process.arch;

  let platformDir;
  if (platform === 'darwin') {
    platformDir = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  } else if (platform === 'linux') {
    platformDir = arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  } else {
    return null;
  }

  const binaryPath = path.join(__dirname, 'prebuilt', platformDir, 'rfdb-server');
  return fs.existsSync(binaryPath) ? binaryPath : null;
}

module.exports = { getBinaryPath, ... };
```

**TypeScript definitions:**
```typescript
export function getBinaryPath(): string | null;
```

## Root Cause

**Violation of DRY principle and package encapsulation:**

1. @grafema/rfdb OWNS the knowledge of where its binaries are located
2. We duplicated this logic in TWO places in our codebase
3. When we need to update binary locations, we have to change THREE files
4. One of the duplicates is broken (uses bare require in ESM)

## Why The Current Code Fails

In `packages/cli/src/commands/server.ts`:
- File uses ESM syntax (`import`, not `require`)
- File correctly sets up `__dirname` via `fileURLToPath(import.meta.url)`
- BUT line 31 uses bare `require.resolve()` without importing `createRequire`
- In ESM context, `require` is not defined globally
- This throws: `ReferenceError: require is not defined`

## The Correct Solution

**Use @grafema/rfdb's exported `getBinaryPath()` function:**

```typescript
import { getBinaryPath } from '@grafema/rfdb';

function findServerBinary(): string | null {
  // 1. Check @grafema/rfdb npm package
  const npmBinary = getBinaryPath();  // ✅ Package knows where its binaries are
  if (npmBinary) {
    return npmBinary;
  }

  // 2. Fallback to monorepo development paths
  const projectRoot = join(__dirname, '../../../..');
  const releaseBinary = join(projectRoot, 'rust-engine/target/release/rfdb-server');
  if (existsSync(releaseBinary)) {
    return releaseBinary;
  }

  const debugBinary = join(projectRoot, 'rust-engine/target/debug/rfdb-server');
  if (existsSync(debugBinary)) {
    return debugBinary;
  }

  return null;
}
```

**Benefits:**
- No require.resolve() needed - package handles it internally
- No ESM/CJS interop issues
- Single source of truth for binary locations
- If @grafema/rfdb changes binary structure, only one place to update
- Works in ESM, CJS, bundled, or any context

## Files That Need Changes

### 1. packages/cli/src/commands/server.ts
**Change:** Replace manual require.resolve logic with `getBinaryPath()`

**Current (lines 28-67):**
```typescript
function findServerBinary(): string | null {
  try {
    const rfdbPkg = require.resolve('@grafema/rfdb');  // REMOVE
    const rfdbDir = dirname(rfdbPkg);
    // ... manual platform detection and path construction
  } catch {
    // @grafema/rfdb not installed
  }
  // ... monorepo fallbacks
}
```

**New:**
```typescript
import { getBinaryPath } from '@grafema/rfdb';

function findServerBinary(): string | null {
  // 1. Check @grafema/rfdb npm package
  const npmBinary = getBinaryPath();
  if (npmBinary) {
    return npmBinary;
  }

  // 2-3. Monorepo fallbacks (keep existing logic)
  const projectRoot = join(__dirname, '../../../..');
  const releaseBinary = join(projectRoot, 'rust-engine/target/release/rfdb-server');
  if (existsSync(releaseBinary)) {
    return releaseBinary;
  }

  const debugBinary = join(projectRoot, 'rust-engine/target/debug/rfdb-server');
  if (existsSync(debugBinary)) {
    return debugBinary;
  }

  return null;
}
```

### 2. packages/core/src/storage/backends/RFDBServerBackend.ts
**Change:** Replace manual require.resolve logic with `getBinaryPath()`

**Current (lines 172-215):**
```typescript
private _findServerBinary(): string | null {
  try {
    const require = createRequire(import.meta.url);  // REMOVE
    const rfdbPkg = require.resolve('@grafema/rfdb');
    const rfdbDir = dirname(rfdbPkg);
    // ... manual platform detection and path construction
  } catch {
    // @grafema/rfdb not installed
  }
  // ... monorepo fallbacks
}
```

**New:**
```typescript
import { getBinaryPath } from '@grafema/rfdb';  // Add to top of file

private _findServerBinary(): string | null {
  // 1. Check @grafema/rfdb npm package
  const npmBinary = getBinaryPath();
  if (npmBinary) {
    console.log(`[RFDBServerBackend] Found binary in @grafema/rfdb: ${npmBinary}`);
    return npmBinary;
  }

  // 2-3. Monorepo fallbacks (keep existing logic)
  const projectRoot = join(__dirname, '../../../../..');
  const releaseBinary = join(projectRoot, 'rust-engine/target/release/rfdb-server');
  if (existsSync(releaseBinary)) {
    console.log(`[RFDBServerBackend] Found release binary: ${releaseBinary}`);
    return releaseBinary;
  }

  const debugBinary = join(projectRoot, 'rust-engine/target/debug/rfdb-server');
  if (existsSync(debugBinary)) {
    console.log(`[RFDBServerBackend] Found debug binary: ${debugBinary}`);
    return debugBinary;
  }

  return null;
}
```

## Verification Plan

1. **Build the project:**
   ```bash
   pnpm build
   ```

2. **Test CLI command:**
   ```bash
   cd packages/cli
   node dist/cli.js server start
   ```
   Should find binary at: `node_modules/.pnpm/@grafema+rfdb@*/node_modules/@grafema/rfdb/prebuilt/darwin-x64/rfdb-server`

3. **Test backend integration:**
   ```bash
   npm test -- packages/core/test/integration/RFDBServerBackend.test.ts
   ```
   Should create and connect to server successfully

4. **Test monorepo fallback:**
   ```bash
   # Temporarily rename @grafema/rfdb
   mv node_modules/@grafema/rfdb node_modules/@grafema/rfdb.bak

   # Should fall back to rust-engine binary
   cd packages/cli
   node dist/cli.js server start

   # Restore
   mv node_modules/@grafema/rfdb.bak node_modules/@grafema/rfdb
   ```

## Why This Is The Right Fix

1. **Single Source of Truth:** @grafema/rfdb package owns binary location logic
2. **No ESM/CJS Issues:** Package handles module resolution internally
3. **DRY Compliance:** Zero duplication of binary lookup logic
4. **Encapsulation:** If rfdb changes binary structure, our code doesn't break
5. **Works Everywhere:** ESM, CJS, bundled, Docker, any context

## Impact Assessment

**Risk:** LOW
- Simple import change, no logic complexity
- Package already provides the function
- Fallback to monorepo paths unchanged

**Scope:**
- 2 files to change
- ~40 lines removed (duplicate logic)
- ~10 lines added (clean function calls)

**Testing:**
- Existing integration tests cover this
- Manual verification on macOS/Linux

## Alternative Considered (Why It's WRONG)

**Alternative:** "Just add createRequire to server.ts"

```typescript
// DON'T DO THIS
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const rfdbPkg = require.resolve('@grafema/rfdb');
```

**Why this is wrong:**
- Still duplicates logic from @grafema/rfdb package
- Still violates DRY
- Still violates encapsulation
- Still requires maintaining platform detection in multiple places
- "Works" but architecturally broken

## Conclusion

This is a **textbook DRY violation**. The @grafema/rfdb package already solved this problem correctly. We should use its solution instead of duplicating (and breaking) it.

Fix: Delete our duplicate implementations, call `getBinaryPath()`.

Time to implement: ~15 minutes
Time saved in future maintenance: hours
