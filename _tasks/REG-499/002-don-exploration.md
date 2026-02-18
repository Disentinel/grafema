# REG-499: Don's Codebase Exploration

## Current State Summary

### Extension Setup
- **Location**: `/packages/vscode/`
- **Version**: 0.2.0
- **Entry point**: `src/extension.ts`
- **Key components**:
  - `GrafemaClientManager` (grafemaClient.ts) - RFDB connection lifecycle
  - `EdgesProvider` (edgesProvider.ts) - TreeDataProvider for VS Code UI
  - `findNodeAtCursor()` (nodeLocator.ts) - Node lookup by cursor position
  - Various command handlers in extension.ts

### Dependencies
- `@grafema/rfdb-client`: workspace:* (v0.2.12-beta)
- `@grafema/types`: workspace:*
- `@types/vscode`: ^1.74.0
- `esbuild` for bundling

### Server Version Timeline
- **v0.2.6-beta** (Feb 8) ← Extension hasn't been updated since this
- **v0.2.7 → v0.2.12-beta** (Feb 8-18) → Major changes made

### Key Changes in Recent Server Releases

1. **RFD-40** (Feb 18): 
   - Removed dead `startServer()` function from @grafema/rfdb
   - Version printing on startup
   - Extension uses its own spawn logic (good - not affected)

2. **REG-487** (Feb 16): 
   - Deferred RFDB indexing (O(n²) fix)
   - Server still accepts same API calls

3. **REG-489** (Feb 17): 
   - `commitBatch()` MODULE node protection
   - Server API change

4. **RFD-39** (Feb 16): 
   - Deduplicate node_count/edge_count after flush
   - Server API behavioral change (counts now correct)

## Hardcoded Developer Path Issue

**File**: `packages/vscode/src/grafemaClient.ts`, line 180 (in `findServerBinary()`)

```typescript
// Known grafema monorepo location (development convenience)
'/Users/vadimr/grafema',
```

This MUST be removed before publishing the extension. It:
- Only works on Vadim's machine
- Will fail for all other users
- Should rely on environment discovery only

## API Compatibility Status

### Extension Uses These Methods:
1. **ping()** - ✓ Still available, works
2. **getNode(id)** - ✓ Available, returns WireNode
3. **getOutgoingEdges(id)** - ✓ Available, returns WireEdge[]
4. **getIncomingEdges(id)** - ✓ Available, returns WireEdge[]
5. **getAllNodes({file})** - ✓ Available (wrapper around queryNodes)
6. **nodeCount()** - ✓ Available (now deduplicated)
7. **edgeCount()** - ✓ Available (now deduplicated)
8. **connect()** - ✓ Available

### What Changed in RFDBClient:
- Old method: `getAllNodes({ file: string })` - supported
- Current: `getAllNodes(query?: AttrQuery)` - query is object with optional properties
- Query format: `{ nodeType?, type?, name?, file? }`
- Method still works with `{ file }` parameter

### Potential Issues

1. **Path format mismatch**: Extension may use different path formats (full vs relative) than server expects
2. **Semantic IDs**: Extension code seems prepared for semantic IDs (graph node IDs)
3. **Binary discovery**: Hardcoded dev path will fail for published extension
4. **Error handling**: Need to verify reconnection logic after server changes

## Code Quality Observations

### grafemaClient.ts
- **Size**: 341 lines (reasonable)
- **Concerns**:
  - Binary search has hardcoded `/Users/vadimr/grafema` fallback (line 180)
  - Good error handling and reconnection logic
  - Socket watching for reanalysis detection (good)
  - Proper cleanup in disconnect()

### nodeLocator.ts
- **Size**: 68 lines (good)
- **Issues**:
  - Uses `getAllNodes({ file })` to fetch ALL nodes then filters in JS
  - Could use `queryNodes` more efficiently
  - Line/column matching is simplistic (only exact line matches, fallback to closest)
  - Should probably use line ranges if available

### extension.ts
- **Size**: 400+ lines
- **Structure**: Good separation of concerns
- **Commands**: Well-organized
- **Issues**:
  - Heavy use of `getAllNodes` in findNodeAtCursor → performance
  - Cursor following polling at 150ms debounce (reasonable)

### edgesProvider.ts
- **Size**: 250+ lines
- **Structure**: Good TreeDataProvider pattern
- **No obvious issues**: Seems well-written

## Assessment

### What's Working
- Basic connection logic appears sound
- Client manager reconnection logic is solid
- Extension UI structure is clean

### What Needs Fixing

1. **CRITICAL**: Remove hardcoded developer path (`/Users/vadimr/grafema`)
2. **IMPORTANT**: Test with actual v0.2.12 server to verify API compatibility
3. **IMPORTANT**: Verify node querying works with semantic IDs (new format)
4. **GOOD**: Re-test all features:
   - Auto-start logic (should work - uses spawn, not startServer())
   - Node finding at cursor
   - Edge navigation
   - Follow cursor mode
   - Reconnection after server restart

### Architectural Assessment

- Extension design is sound: connection manager → tree provider → UI
- No architectural mismatches with project vision
- Good separation: connection logic, UI logic, node lookup

## Next Steps (For Planning)

1. Remove hardcoded `/Users/vadimr/grafema` fallback
2. Test extension build: `pnpm build -C packages/vscode`
3. Test with real Grafema project:
   - Start server: `grafema server start`
   - Load project with graph
   - Test node finding at cursor
   - Test edge navigation
   - Test server reconnection
4. Verify semantic ID format handling
5. Check if bundled rfdb-server binary is up to date
