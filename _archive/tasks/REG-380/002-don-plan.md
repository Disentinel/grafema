# Don Melton — Plan: REG-380

## Problem Analysis

Custom plugins in `.grafema/plugins/` use `import { Plugin } from '@grafema/core'`, but Node.js ESM resolution starts from the plugin file's directory. Since `@grafema/core` exists only in the CLI's dependency tree (not in the target project's `node_modules/`), the import fails with `ERR_MODULE_NOT_FOUND`.

This affects all installation modes: global install, npx, workspace.

## Root Cause

`loadCustomPlugins()` in `analyze.ts:146` uses `await import(pluginUrl)` where `pluginUrl` points to `.grafema/plugins/MyPlugin.mjs`. When Node.js encounters `import { Plugin } from '@grafema/core'` inside that module, it searches `node_modules/` directories starting from `.grafema/plugins/` up to filesystem root. `@grafema/core` is never found because it only exists in the CLI package's dependency tree.

## Solution: `module.register()` Custom Loader Hook

Use Node.js `module.register()` API (stable since v20.6) to register a custom ESM resolve hook that maps `@grafema/core` and `@grafema/types` bare specifiers to the actual package URLs within the CLI's dependency tree.

### Why This Approach

| Approach | Pros | Cons |
|----------|------|------|
| **`module.register()` hook** | Clean, stable API, no FS side effects, preserves documented plugin API | Requires separate JS file for hook |
| Symlink `node_modules` | Simple | FS side effects, cleanup needed, platform differences |
| Inject via context | No import needed | Breaks documented API, less ergonomic |
| Require users install `@grafema/core` | Zero code changes | Poor UX, breaks "just write a plugin" promise |
| `NODE_PATH` env var | Simple | Only works for CJS, must be set before process starts |

`module.register()` is the standard Node.js mechanism for exactly this use case — customizing bare specifier resolution for dynamically loaded modules.

### Prior Art

- ESLint uses `createRequire()` for CJS plugins — ESM resolution is an open problem there
- Vite rewrites bare specifiers to resolved paths during pre-bundling
- TypeScript/tsx uses `module.register()` for `.ts` file resolution
- MDX uses custom Node.js loaders for `.mdx` file support

### Implementation

**1. Create `packages/cli/src/plugins/pluginResolver.js`** (plain JS — loader hooks run in separate thread)

```javascript
// Resolver hook: maps @grafema/* bare specifiers to actual locations
let grafemaPackages = {};

export function initialize(data) {
  grafemaPackages = data.grafemaPackages; // { '@grafema/core': 'file:///...', '@grafema/types': 'file:///...' }
}

export function resolve(specifier, context, next) {
  // Exact match: @grafema/core, @grafema/types
  if (grafemaPackages[specifier]) {
    return { url: grafemaPackages[specifier], shortCircuit: true };
  }

  // Subpath: @grafema/core/something
  for (const [pkg, url] of Object.entries(grafemaPackages)) {
    if (specifier.startsWith(pkg + '/')) {
      const subpath = specifier.slice(pkg.length + 1);
      return { url: new URL('./' + subpath, url).href, shortCircuit: true };
    }
  }

  return next(specifier, context);
}
```

**2. Modify `packages/cli/src/commands/analyze.ts`** — register hook before loading plugins

```typescript
import { register } from 'node:module';

// Before loadCustomPlugins():
register(
  new URL('../plugins/pluginResolver.js', import.meta.url).href,
  {
    data: {
      grafemaPackages: {
        '@grafema/core': import.meta.resolve('@grafema/core'),
        '@grafema/types': import.meta.resolve('@grafema/types'),
      }
    }
  }
);
```

**3. Tests** — verify that a mock custom plugin can import from `@grafema/core`

### Scope

- 2 files modified: `analyze.ts`, new `pluginResolver.js`
- 1 test file added
- No changes to plugin API or documentation (already correct)
- No changes to `@grafema/core` package

### Risks

- `module.register()` is global — once registered, affects all subsequent dynamic imports. But we only intercept `@grafema/*` specifiers, passing everything else through. Risk: LOW.
- Loader hook runs in a separate thread (Node.js isolate). Data must be serializable. Our data is just string URLs. Risk: NONE.
- Node.js 20.6+ required. We already require v20.20. Risk: NONE.

### Complexity

- O(1) per module resolution — hash lookup for known packages
- No extra iterations, no graph operations
- Forward registration pattern (CLI registers once, plugins benefit)

## Recommendation

Mini-MLA. Single implementation cycle: Kent (test) → Rob (implement) → Steve → Vadim.
