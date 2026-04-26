# Rob Pike Implementation Report: FetchAnalyzer Changes

## Summary

Implemented Part A of Joel's approved plan (Steps A1-A7) for FetchAnalyzer.ts.

## Changes Made

### File: `/packages/core/src/plugins/analysis/FetchAnalyzer.ts`

#### A1: Added import for NetworkRequestNode

```typescript
import { NetworkRequestNode } from '../../core/nodes/NetworkRequestNode.js';
```

Location: Line 20 (after existing imports)

---

#### A2: Added instance variable for singleton tracking

```typescript
private networkNodeCreated = false;
```

Location: Line 48 (inside class, before `get metadata()`)

---

#### A3: Create net:request singleton in execute()

```typescript
// Create net:request singleton (GraphBackend handles deduplication)
const networkNode = NetworkRequestNode.create();
await graph.addNode(networkNode);
this.networkNodeCreated = true;
```

Location: Lines 67-70 (after `const { graph } = context;`, before getting modules)

---

#### A4: Updated analyzeModule signature

```typescript
private async analyzeModule(
  module: NodeRecord,
  graph: PluginContext['graph'],
  networkId: string  // NEW parameter
): Promise<AnalysisResult> {
```

Location: Lines 115-118

---

#### A5: Updated call site to pass networkNode.id

```typescript
const result = await this.analyzeModule(module, graph, networkNode.id);
```

Location: Line 82

---

#### A6: Added CALLS edge from http:request to net:request

```typescript
// http:request --CALLS--> net:request singleton
await graph.addEdge({
  type: 'CALLS',
  src: request.id,
  dst: networkId
});
```

Location: Lines 292-297 (after CONTAINS edge creation)

---

#### A7: Fixed node/edge count in createSuccessResult

```typescript
return createSuccessResult(
  {
    nodes: requestsCount + apisCount + (this.networkNodeCreated ? 1 : 0),
    edges: requestsCount  // CALLS edges from http:request to net:request
  },
  {
    requestsCount,
    apisCount,
    networkSingletonCreated: this.networkNodeCreated
  }
);
```

Location: Lines 98-108

Changes:
- `nodes` now includes `+1` for the singleton (using boolean flag to count once)
- `edges` changed from `0` to `requestsCount` (one CALLS edge per http:request)
- Added `networkSingletonCreated` to metadata

---

## Issues Encountered

None. All changes were straightforward and followed the existing code patterns.

## Code Style Notes

- Matched existing indentation (2 spaces)
- Followed existing comment style (English comments for new code, preserved Russian comments in existing code)
- Used the same edge creation pattern already present in the file

## Verification

The implementation follows Joel's plan exactly. The key design decisions:

1. **Singleton creation**: Done once at the start of `execute()`, not per-module
2. **Boolean tracking**: `networkNodeCreated` flag ensures accurate counting
3. **Edge creation**: One CALLS edge per http:request node
4. **networkId parameter**: Passed through to `analyzeModule()` to avoid instance variable for the ID

## Next Steps

Parts B and C of Joel's plan still need implementation:
- B1: Add FetchAnalyzer to createTestOrchestrator.js
- C1-C2: Fix type queries in NetworkRequestNodeMigration.test.js
