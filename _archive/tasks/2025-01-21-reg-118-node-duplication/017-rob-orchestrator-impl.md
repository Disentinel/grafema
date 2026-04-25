# Rob Pike: Implementation Report - Clear on First Touch

**Date:** 2025-01-22
**Task:** REG-118 Node Duplication Fix
**Status:** Implementation Complete

---

## Summary

Implemented the "Clear on First Touch" approach as specified in Joel's technical spec. The core mechanism tracks touched files across all analysis phases, clearing nodes on first touch and skipping on subsequent touches.

---

## Changes Made

### 1. `packages/types/src/plugins.ts`

Added `touchedFiles?: Set<string>` to PluginContext interface:

```typescript
export interface PluginContext {
  // ... existing fields ...
  /**
   * Set of file paths already processed ("touched") in this analysis run.
   * Used for idempotent re-analysis: first touch clears all nodes for that file,
   * subsequent touches are no-ops. Only populated when forceAnalysis=true.
   */
  touchedFiles?: Set<string>;
}
```

### 2. NEW: `packages/core/src/core/FileNodeManager.ts`

Created utility module with two functions:

- **`clearFileNodesIfNeeded(graph, file, touchedFiles)`**: Clears all nodes for a file if not yet touched. Returns count of deleted nodes.
- **`clearServiceNodeIfExists(graph, serviceId)`**: Clears a SERVICE node by ID.

Key implementation details:
- Mark file as touched BEFORE async deletion (sync Set.add)
- Query nodes by file property, delete all found
- Graceful error handling (continue on delete failure)
- Logging for visibility

### 3. `packages/core/src/plugins/indexing/JSModuleIndexer.ts`

- Added import: `clearFileNodesIfNeeded`
- Before creating MODULE node, call clearing if touchedFiles present:

```typescript
const touchedFiles = (context as { touchedFiles?: Set<string> }).touchedFiles;
if (touchedFiles) {
  await clearFileNodesIfNeeded(graph, currentFile, touchedFiles);
}
```

### 4. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

- Added import: `clearFileNodesIfNeeded`
- Updated AnalyzeContext interface to include `touchedFiles?: Set<string>`
- Extracted touchedFiles from context in execute()
- Before adding module to analysis queue, call clearing:

```typescript
if (touchedFiles && module.file) {
  await clearFileNodesIfNeeded(graph, module.file, touchedFiles);
}
```

### 5. `packages/core/src/Orchestrator.ts`

- Added import: `clearServiceNodeIfExists`
- Create touchedFiles Set when forceAnalysis is enabled:

```typescript
const touchedFiles = this.forceAnalysis ? new Set<string>() : undefined;
```

- Before INDEXING each unit, clear SERVICE node:

```typescript
if (this.forceAnalysis && touchedFiles) {
  await clearServiceNodeIfExists(this.graph, unit.id);
}
```

- Pass touchedFiles through context to INDEXING and ANALYSIS phases:

```typescript
await this.runPhase('INDEXING', {
  manifest: unitManifest,
  graph: this.graph,
  workerCount: 1,
  touchedFiles,
});
```

### 6. `packages/core/src/index.ts`

Added export:

```typescript
export { clearFileNodesIfNeeded, clearServiceNodeIfExists } from './core/FileNodeManager.js';
```

---

## Build Verification

```
npm run build
```

All packages compile successfully:
- packages/types: Done
- packages/rfdb: Done
- packages/core: Done
- packages/cli: Done
- packages/mcp: Done

---

## How It Works

1. **Fresh analysis (forceAnalysis=false)**: touchedFiles is undefined, no clearing happens
2. **Re-analysis (forceAnalysis=true)**:
   - Orchestrator creates empty `touchedFiles: Set<string>`
   - Before INDEXING each service, SERVICE node is cleared explicitly
   - INDEXING phase: JSModuleIndexer touches files first, clears all nodes
   - ANALYSIS phase: JSASTAnalyzer checks touchedFiles, finds files already touched, skips clearing
   - Result: Each file's nodes cleared exactly once, then recreated

---

## Edge Cases Handled

1. **SERVICE nodes**: Cleared explicitly by Orchestrator (have directory path, not file path)
2. **EXTERNAL_MODULE nodes**: No file property, won't match queryNodes({file}), remain as singletons
3. **Concurrent batch processing**: Set.add() is sync, prevents race conditions
4. **Backend without deleteNode**: Returns 0 gracefully
5. **Delete failures**: Logged but don't stop processing

---

## Files Changed

| File | Change Type |
|------|-------------|
| `packages/types/src/plugins.ts` | Modified (added touchedFiles) |
| `packages/core/src/core/FileNodeManager.ts` | **New file** |
| `packages/core/src/index.ts` | Modified (added export) |
| `packages/core/src/plugins/indexing/JSModuleIndexer.ts` | Modified |
| `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` | Modified |
| `packages/core/src/Orchestrator.ts` | Modified |

---

## Next Steps

1. Run existing tests: `node --test test/unit/ClearAndRebuild.test.js`
2. Manual verification: `grafema analyze --force` twice should produce identical counts
3. Kevlin and Linus review

---

## Notes

- Followed existing code patterns
- No new dependencies introduced
- Clean, minimal changes focused on the specific problem
- TypeScript compiles without errors
