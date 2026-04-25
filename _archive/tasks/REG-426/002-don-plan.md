# Don Melton — Plan for REG-426

## Analysis

**Root cause:** `resolveModulePath()` in `moduleResolution.ts` appends extensions to the end of `basePath`. When basePath already has `.js` (e.g., `/path/utils.js` from `import './utils.js'`), it tries `/path/utils.js.js`, `/path/utils.js.ts`, etc. — all wrong. It never strips `.js` to try `.ts`.

**Affected callers:** All 4 plugins use the same utility, so the fix is systemic:
- `JSModuleIndexer` (filesystem mode)
- `MountPointResolver` (filesystem mode)
- `FunctionCallResolver` (in-memory fileIndex mode)
- `IncrementalModuleIndexer` (filesystem mode)

## Approach

Add a TypeScript extension redirect step to `resolveModulePath()` between the extension loop and the index files loop.

**Redirect map (matches TypeScript's own behavior):**
```
.js  → [.ts, .tsx]
.jsx → [.tsx]
.mjs → [.mts]
.cjs → [.cts]
```

**Resolution order:**
1. Try exact path + extensions (existing) — handles extensionless imports
2. **NEW: Try TS extension redirect** — handles `.js` imports in TS projects
3. Try index files (existing) — handles directory imports

## Scope

- **1 file changed:** `packages/core/src/utils/moduleResolution.ts`
- **1 test file updated:** `test/unit/utils/moduleResolution.test.js`
- **~20 LOC implementation**, ~80 LOC tests
- No API changes, no new exports needed

## Risks

- **None significant.** The redirect only fires when:
  1. The path already has a JS extension
  2. The exact path was not found
  3. A TS equivalent exists
- If the `.js` file exists, it's already returned in step 1 (exact match)
- Non-TS projects are unaffected (no `.ts` files to find)
