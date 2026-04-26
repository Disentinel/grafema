# Joel Spolsky Tech Plan - REG-233

## Technical Implementation

### File: `packages/core/src/plugins/analysis/FetchAnalyzer.ts`

#### Change 1: Track singleton state

```typescript
// Existing property (line 49)
private networkNodeCreated = false;

// Add new property to store node reference
private networkNodeId: string | null = null;
```

#### Change 2: Remove unconditional creation from execute()

**Delete lines 70-73:**
```typescript
// Create net:request singleton (GraphBackend handles deduplication)
const networkNode = NetworkRequestNode.create();
await graph.addNode(networkNode);
this.networkNodeCreated = true;
```

**Replace with:**
```typescript
// net:request singleton created lazily in analyzeModule when first request found
```

#### Change 3: Create singleton lazily in analyzeModule()

Before creating first `http:request` node, ensure `net:request` exists.

**Add helper method:**
```typescript
private async ensureNetworkNode(graph: PluginContext['graph']): Promise<string> {
  if (!this.networkNodeId) {
    const networkNode = NetworkRequestNode.create();
    await graph.addNode(networkNode);
    this.networkNodeCreated = true;
    this.networkNodeId = networkNode.id;
  }
  return this.networkNodeId;
}
```

**Modify analyzeModule signature:**
- Remove `networkId` parameter
- Call `ensureNetworkNode()` when creating CALLS edge

#### Change 4: Update call site

**Line 85 change:**
```typescript
// Before
const result = await this.analyzeModule(module, graph, networkNode.id);

// After
const result = await this.analyzeModule(module, graph);
```

#### Change 5: Update CALLS edge creation (line 298-303)

```typescript
// Before
await graph.addEdge({
  type: 'CALLS',
  src: request.id,
  dst: networkId
});

// After
const networkId = await this.ensureNetworkNode(graph);
await graph.addEdge({
  type: 'CALLS',
  src: request.id,
  dst: networkId
});
```

### Test Plan

**File: `packages/core/test/plugins/FetchAnalyzer.test.ts`**

Add test case:
```typescript
test('should not create net:request node when no HTTP requests exist', async () => {
  // Fixture: code with console.log but no HTTP requests
  // Assert: no net:request node in graph
});
```

### Doctor Test Fix

**File: `packages/cli/test/doctor.test.ts`**

Remove workaround at line 769-781 that excludes `GraphConnectivityValidator`.

## Execution Order

1. Kent: Write failing test for "no net:request when no HTTP requests"
2. Rob: Implement lazy singleton creation
3. Rob: Verify existing FetchAnalyzer tests still pass
4. Rob: Remove doctor test workaround
5. Verify doctor integration test passes

## Risk Assessment

- **Breaking change**: None - behavior unchanged when HTTP requests exist
- **Edge case**: Concurrent module analysis could create duplicate singletons → Graph handles deduplication, safe
