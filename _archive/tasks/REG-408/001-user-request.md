# REG-408: Portable graphs — store relative paths for Docker/CI compatibility

## Problem

Grafema stores absolute host paths in `node.file` field. When a pre-built graph is copied to a different environment (Docker container, CI runner, another developer's machine), `getCodePreview()` can't find files → `grafema context` shows NO source code.

## Evidence (SWE-bench experiment)

* Host path stored: `/Users/vadimr/swe-bench-research/preact-testbed/hooks/src/index.js`
* Docker path needed: `/testbed/hooks/src/index.js`
* `formatLocation()` shows: `../Users/vadimr/swe-bench-research/preact-testbed/hooks/src/index.js`
* `getCodePreview()` returns null silently (file doesn't exist at stored path)

**Impact:** All `grafema context` experiments with pre-built graphs were invalid — agent got the same info as `grafema query` (no source code).

## Root Cause

`JSModuleIndexer.ts:376` deliberately stores absolute path:

```typescript
file: currentFile, // Keep absolute path for file reading in analyzers
```

## Proposed Solution

Store paths relative to the project root in graph nodes. Resolve to absolute paths at query time using the current working directory.

1. `node.file` stores relative path (e.g., `hooks/src/index.js`)
2. `getCodePreview()` resolves: `path.resolve(projectRoot, node.file)`
3. `formatLocation()` displays relative path (already better for humans too)

## Acceptance Criteria

- [ ] `node.file` stores paths relative to project root
- [ ] `grafema context` shows source code when graph is copied to another directory
- [ ] `formatLocation()` displays relative paths
- [ ] Existing commands (query, trace, impact) work with relative paths
- [ ] Migration or backward-compat for existing graphs
