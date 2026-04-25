# REG-393: Directory index resolution for CommonJS require

## Problem

`require('./defaults')` should resolve to `./defaults/index.js` per Node.js CommonJS module resolution rules. Grafema's JSModuleIndexer does not follow this convention, causing the entire dependency subtree to be unreachable.

## Impact

On axios (43-file library), this single gap causes **79% of files to be unreachable** from the entrypoint. The critical files `lib/adapters/http.js` and `lib/defaults/index.js` are never analyzed.

Discovered during SWE-bench gap analysis (`_tasks/swe-bench-research/005-grafema-gap-analysis.md`).

## Expected behavior

When resolving `require('./defaults')`:

1. Try `./defaults.js` (existing behavior)
2. Try `./defaults/index.js` (MISSING)
3. Try `./defaults/index.node` (optional)

## Acceptance criteria

- [ ] `require('./foo')` resolves to `./foo/index.js` when `./foo.js` doesn't exist
- [ ] `require('./foo')` resolves to `./foo/index.ts` for TypeScript projects
- [ ] Coverage on axios repo goes from 21% to 60%+
- [ ] Test with real CJS projects: axios, express, lodash

## Complexity

LOW — module resolution logic change in JSModuleIndexer, likely a few lines.
