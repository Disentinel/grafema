## Rob Pike — Phase 2 Implementation Report: REG-498

### Summary

Removed all `getAllEdges` and `getAllNodes` calls from 4 plugins (not DataFlowValidator — that's Phase 1). Each plugin now uses `queryNodes`, `getIncomingEdges`, or `getOutgoingEdges` from the `GraphBackend` interface.

### Changes

#### 2A: TypeScriptDeadCodeValidator
**File:** `packages/core/src/plugins/validation/TypeScriptDeadCodeValidator.ts`

- Removed `getAllEdges?.()` call and the `implementedInterfaces` Map
- Moved implementation counting inline: for each interface, call `graph.getIncomingEdges(id, ['IMPLEMENTS', 'EXTENDS'])` and use `.length`
- Removed stale comment "no queryEdges in GraphBackend yet"
- Net: ~10 lines removed, ~2 lines added

#### 2B: ShadowingDetector
**File:** `packages/core/src/plugins/validation/ShadowingDetector.ts`

- Replaced 4x `graph.getAllNodes({ type: ... })` with `for await` + `push` over `graph.queryNodes({ nodeType: ... })`
- Types: CLASS, VARIABLE, CONSTANT, IMPORT
- Updated file header comment from "use getAllNodes for arrays" to "queryNodes returns an async generator, collected into arrays below"
- Net: ~4 lines removed, ~12 lines added

#### 2C: SocketIOAnalyzer
**File:** `packages/core/src/plugins/analysis/SocketIOAnalyzer.ts`

- Replaced 3x `graph.getAllNodes(...)` with `for await` + `push` over `graph.queryNodes(...)`
- In `createEventChannels`: `socketio:emit` and `socketio:on` node collection
- In `analyzeModule`: `FUNCTION` node lookup by name+file
- Net: ~3 lines removed, ~12 lines added

#### 2D: GraphConnectivityValidator
**File:** `packages/core/src/plugins/validation/GraphConnectivityValidator.ts`

- Replaced `graph.getAllNodes()` with `for await (const node of graph.queryNodes({}))` + push
- Removed `getAllEdges` guard block (`if (!graph.getAllEdges)`)
- Removed `getAllEdges()` call and full adjacency map construction (`adjacencyOut`, `adjacencyIn`)
- BFS now queries edges per-node: `graph.getOutgoingEdges(nodeId)` and `graph.getIncomingEdges(nodeId)`
- Diagnostic logging for unreachable nodes: replaced `adjacencyOut.get()`/`adjacencyIn.get()` with `graph.getOutgoingEdges(node.id)`/`graph.getIncomingEdges(node.id)`
- Net: ~20 lines removed, ~15 lines added

### Verification

- `pnpm build` — all packages compile cleanly (no TypeScript errors)
- `node --test test/unit/ShadowingDetector.test.js` — all 8 tests pass
- No remaining `getAllEdges` or `getAllNodes` references in any of the 4 modified files (confirmed by grep)

### Files NOT touched

- `DataFlowValidator.ts` — Phase 1 scope
- `packages/types/src/plugins.ts` — Phase 3 scope
- `packages/core/src/core/GraphBackend.ts` — internal backend contract, keep `getAllEdges`
