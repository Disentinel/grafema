# REG-495: onProgress for 5 Enrichment Plugins -- Implementation Report

## Summary

Added `onProgress` callbacks to 5 enrichment plugins following the established pattern from REG-497 (ImportExportLinker, etc.).

## Changes

### 1. ServiceConnectionEnricher.ts

- Extracted `onProgress` from context alongside `graph`
- Added progress reporting during route collection (every 100 nodes)
- Added progress reporting during request collection (every 100 nodes)
- Converted matching loop from `for...of` to indexed `for` loop with progress every 50 iterations

### 2. HTTPConnectionEnricher.ts

- Extracted `onProgress` from context alongside `graph`
- Added progress reporting during route collection (every 100 nodes)
- Added progress reporting during request collection (every 100 nodes)
- Converted matching loop from `for...of` to indexed `for` loop with progress every 50 iterations

### 3. SocketConnectionEnricher.ts

- Extracted `onProgress` from context alongside `graph`
- Added progress reporting around each of the 4 `collectNodes` calls (unix clients, unix servers, TCP clients, TCP servers)
- Added progress reporting before each match phase (unix matching, TCP matching)
- Kept match methods unchanged since socket node counts are typically very small (1-5 each)

### 4. ConfigRoutingMapBuilder.ts

- Extracted `onProgress` from context
- Added single progress report after loading routing rules (since rule counts are typically 0-10)

### 5. RustFFIEnricher.ts

- Extracted `onProgress` from context alongside `graph`
- Added `onProgress` parameter to `buildNapiIndex` method, with progress every 100 nodes for both RUST_FUNCTION and RUST_METHOD loops
- Added `onProgress` parameter to `findRustCallingJsCalls` method, with progress every 500 CALL nodes
- Converted FFI matching loop from `for...of` to indexed `for` loop with progress every 100 iterations

## Pattern Used

All plugins follow the same established pattern:

```typescript
const { graph, onProgress } = context;

// In collection loops:
if (onProgress && counter % N === 0) {
  onProgress({
    phase: 'enrichment',
    currentPlugin: 'PluginName',
    message: `Description ${counter}/${total}`,
    totalFiles: total,
    processedFiles: counter,
  });
}
```

Modulo values chosen based on expected node counts:
- Collection loops: `% 100` (moderate volume)
- Matching loops: `% 50` (fewer iterations, each more expensive)
- CALL node scanning: `% 500` (high volume)

## Verification

- `pnpm build` -- TypeScript compilation succeeds with zero errors
- No refactoring or behavioral changes -- only `onProgress` additions
