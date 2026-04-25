# Don Plan: REG-349 - Fix esbuild CJS compatibility

## Problem Analysis

VS Code extension build fails when bundling `@grafema/core` because RustAnalyzer uses top-level await:

```
ERROR: Top-level await is currently not supported with the "cjs" output format
../core/dist/plugins/analysis/RustAnalyzer.js:14:26:
  14 │     const nativeBinding = await import('../../../../../packages/rf...
```

The current code loads the native binding at module load time (eagerly):

```typescript
// Top-level await - problematic for CJS bundling
try {
  const nativeBinding = await import('../../../../../packages/rfdb-server/grafema-graph-engine.node' as any);
  parseRustFile = nativeBinding.parseRustFile;
} catch {
  // fallback...
}
```

## Option Analysis

### Option 1: Exclude RustAnalyzer from VS Code bundle
- Workaround, not a fix
- Doesn't solve for MCP or other CJS bundling scenarios
- **Rejected**

### Option 2: Switch VS Code to ESM output
- VS Code supports ESM since 1.77
- Only fixes VS Code, not other consumers
- Changes esbuild config and potentially runtime behavior
- **Partial solution**

### Option 3: Refactor RustAnalyzer to avoid top-level await
- Converts eager loading to lazy loading
- Makes core CJS-compatible without changes to consumers
- Native binding only loaded when actually needed
- Cleaner architecture (no side effects on import)
- **Recommended**

## Chosen Approach: Option 3 (Lazy Loading)

Refactor RustAnalyzer to load the native binding lazily on first `execute()` call.

### Implementation

1. Remove top-level await from RustAnalyzer.ts
2. Add a private static method `loadNativeBinding()` that loads and caches the binding
3. Call `loadNativeBinding()` at the start of `execute()` method
4. Binding is cached so subsequent calls don't reload

### Changes

**File: `packages/core/src/plugins/analysis/RustAnalyzer.ts`**

Before (lines 140-158):
```typescript
let parseRustFile: ((code: string) => RustParseResult) | undefined;

try {
  const nativeBinding = await import('../../../../../packages/rfdb-server/grafema-graph-engine.node' as any);
  parseRustFile = nativeBinding.parseRustFile;
} catch {
  try {
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const nativeBinding = require('../../../../../packages/rfdb-server/grafema-graph-engine.node');
    parseRustFile = nativeBinding.parseRustFile;
  } catch {
    // Silent
  }
}
```

After:
```typescript
let parseRustFile: ((code: string) => RustParseResult) | undefined;
let bindingLoaded = false;

async function loadNativeBinding(): Promise<void> {
  if (bindingLoaded) return;
  bindingLoaded = true;

  try {
    const nativeBinding = await import('../../../../../packages/rfdb-server/grafema-graph-engine.node' as any);
    parseRustFile = nativeBinding.parseRustFile;
    return;
  } catch {
    // Dynamic import failed, try require
  }

  try {
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const nativeBinding = require('../../../../../packages/rfdb-server/grafema-graph-engine.node');
    parseRustFile = nativeBinding.parseRustFile;
  } catch {
    // Silent - will be reported during execute if needed
  }
}
```

**In execute() method:**
```typescript
async execute(context: PluginContext): Promise<PluginResult> {
  // Load binding lazily on first use
  await loadNativeBinding();

  // ... rest of execute
}
```

### Benefits

1. **CJS compatible**: No top-level await means esbuild can bundle for CJS
2. **No side effects on import**: Module can be imported without triggering native binding load
3. **Same behavior**: Binding is still loaded once and cached
4. **Graceful degradation**: If binding unavailable, discovered at execute time not import time

### Risks

- **None significant**: The binding loading is moved but behavior is identical
- Execute already handles missing binding case (returns `skipped: true`)

## Verification

1. Build VS Code extension with core dependency
2. Run existing RustAnalyzer tests
3. Verify build completes without top-level await errors

## Scope

- Single file change: `packages/core/src/plugins/analysis/RustAnalyzer.ts`
- No changes to consumers
- No API changes
