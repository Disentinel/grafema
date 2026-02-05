# REG-349: VS Code: Fix esbuild CJS compatibility with RustAnalyzer top-level await

## Problem

VS Code extension build fails:

```
ERROR: Top-level await is currently not supported with the "cjs" output format
../core/dist/plugins/analysis/RustAnalyzer.js:14:26
```

## Cause

RustAnalyzer uses top-level await for dynamic import of native bindings.
esbuild bundles to CJS format which doesn't support top-level await.

## Options

1. Exclude RustAnalyzer from VS Code bundle (it's not used there anyway)
2. Switch VS Code extension to ESM output format
3. Refactor RustAnalyzer to avoid top-level await
