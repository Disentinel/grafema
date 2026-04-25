# REG-426: Import resolution: .js → .ts redirects not followed in TS monorepos

## Problem

When analyzing a TypeScript monorepo (like Grafema itself), `JSModuleIndexer` does not follow `.js` extension imports that resolve to `.ts` files.

**Example:** `packages/core/src/index.ts` contains:

```ts
export { GrafemaError } from './errors/GrafemaError.js';
```

The `.js` extension is standard TypeScript ESM practice, but the actual file is `./errors/GrafemaError.ts`. The indexer does not resolve this redirect, so transitive imports are not followed.

## Impact

* Self-analysis of Grafema: only 5 entry point modules analyzed, 735 nodes total (should be thousands)
* Only 7 functions detected (all from `mcp/server.ts` which has non-`.js` imports)
* 0 classes detected despite dozens of classes in the codebase
* Graph is severely incomplete for any TypeScript project using ESM conventions

## Expected Behavior

`JSModuleIndexer` should resolve `.js` → `.ts` (and `.jsx` → `.tsx`) when the `.js` file doesn't exist but the `.ts` file does. This is how TypeScript itself resolves these imports.

## Lens

Mini-MLA (Don → Rob → Steve+Vadim). Clear requirements, localized scope.
