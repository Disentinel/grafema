# Investigation: IncrementalAnalysisPlugin Dead Code

## Linus's Finding Confirmed

The `IncrementalAnalysisPlugin.ts` defines a local interface `VersionAwareGraph` that extends `GraphBackend`:

```typescript
// Lines 66-72
interface VersionAwareGraph extends GraphBackend {
  getNodesByVersion(
    version: string,
    filter: { file: string }
  ): Promise<VersionedNode[]>;
  getNodesByStableId(stableId: string): Promise<VersionedNode[]>;
}
```

This interface is then used via an unsafe cast:
```typescript
// Line 170
graph as unknown as VersionAwareGraph
```

## The Problem

**Neither method exists on GraphBackend.**

Looking at `packages/types/src/plugins.ts:145-165`, the `GraphBackend` interface has:
- `addNode`, `addEdge`, `addNodes`, `addEdges`
- `getNode`, `queryNodes`, `getAllNodes`
- `getOutgoingEdges`, `getIncomingEdges`
- `nodeCount`, `edgeCount`, `getAllEdges?`
- `countNodesByType`, etc.

**NO `getNodesByVersion` or `getNodesByStableId` methods.**

## Call Sites

1. **Line 246** - `graph.getNodesByVersion('main', { file: filePath })`
   - Called in `finegrainedMerge()` to get existing main nodes for a file

2. **Line 643** - `graph.getNodesByStableId(calleeStableId)`
   - Called in `findCalleeAndCreateEdge()` to find callee nodes

## Runtime Behavior

If `IncrementalAnalysisPlugin` is ever executed, it will throw:
```
TypeError: graph.getNodesByVersion is not a function
```

This code is **dead** - either never executed, or always fails when it is.

## Root Cause

This appears to be **aspirational code** - the interface was designed but never implemented on the backend. The plugin was written expecting these methods to exist, but they don't.

## Options

### Option A: Remove Dead Code (Recommended)

1. Remove `getNodesByStableId` call entirely
2. Refactor `finegrainedMerge()` to use existing methods:
   - Replace `getNodesByVersion()` with `queryNodes({ file, version: 'main' })`
   - Use `getAllNodes({ file })` filtered by version
3. Remove `findCalleeAndCreateEdge()` since it can't work
4. Simplify IncrementalAnalysisPlugin to what's actually implementable

### Option B: Implement Missing Methods

1. Add `getNodesByVersion()` to GraphBackend interface
2. Add `getNodesByStableId()` to GraphBackend interface
3. Implement in all backends (RFDBClient, RFDBServerBackend, etc.)
4. Then proceed with stableId removal

## Recommendation

**Option A is correct for this task.**

The `getNodesByStableId` method makes no sense if we're removing stableId. And `getNodesByVersion` is a separate feature that should be its own issue (REG-XXX).

For REG-140:
1. Remove the `getNodesByStableId` call from the interface and code
2. Either:
   - Mark IncrementalAnalysisPlugin as non-functional (TODO)
   - OR refactor to use existing queryNodes methods

## Decision Required

Before proceeding with implementation:
1. Do we fix IncrementalAnalysisPlugin as part of REG-140?
2. Or create a separate issue and just remove the stableId reference?

The second option is cleaner - REG-140 is about stableId, not about fixing IncrementalAnalysisPlugin.
