# Joel Spolsky Technical Plan: REG-120 Singleton Nodes Fix

## Executive Summary

The `net:request` singleton node is not being created for projects without Express.js, while `net:stdio` works correctly. The root cause is that FetchAnalyzer creates `http:request` call site nodes but never creates the `net:request` singleton. The fix follows ExpressAnalyzer's pattern.

## Implementation Strategy: Fix FetchAnalyzer (Option B)

Per Don's analysis, we'll modify FetchAnalyzer to:
1. Create the `net:request` singleton at the start of analysis
2. Connect each detected `http:request` node to the singleton via CALLS edges

This matches ExpressAnalyzer's implementation (lines 84-86, 308-314).

---

## Step-by-Step Implementation

### Step 1: Import NetworkRequestNode in FetchAnalyzer

**File:** `/packages/core/src/plugins/analysis/FetchAnalyzer.ts`

**Location:** After line 19 (after other imports)

**Add:**
```typescript
import { NetworkRequestNode } from '../../core/nodes/NetworkRequestNode.js';
```

**Verification:** Check that NetworkRequestNode is already exported from the correct path. Looking at ExpressAnalyzer (line 15), it imports from `'../../core/nodes/NetworkRequestNode.js'`.

---

### Step 2: Create net:request singleton in execute() method

**File:** `/packages/core/src/plugins/analysis/FetchAnalyzer.ts`

**Location:** Inside `execute()` method, after line 62 (`const { graph } = context;`) and before line 65 (`const modules = await this.getModules(graph);`)

**Add:**
```typescript
// Create net:request singleton (GraphBackend handles deduplication)
const networkNode = NetworkRequestNode.create();
await graph.addNode(networkNode);
```

**Why this location:**
- Must be created BEFORE iterating through modules
- Must be created AFTER we have access to `graph`
- Matches ExpressAnalyzer's pattern (lines 84-86)

---

### Step 3: Pass networkNode.id to analyzeModule

**File:** `/packages/core/src/plugins/analysis/FetchAnalyzer.ts`

**Current signature (line 106-109):**
```typescript
private async analyzeModule(
  module: NodeRecord,
  graph: PluginContext['graph']
): Promise<AnalysisResult> {
```

**Change to:**
```typescript
private async analyzeModule(
  module: NodeRecord,
  graph: PluginContext['graph'],
  networkId: string
): Promise<AnalysisResult> {
```

**Update call site (line 74):**
```typescript
// BEFORE:
const result = await this.analyzeModule(module, graph);

// AFTER:
const result = await this.analyzeModule(module, graph, networkNode.id);
```

---

### Step 4: Create CALLS edges from http:request to net:request

**File:** `/packages/core/src/plugins/analysis/FetchAnalyzer.ts`

**Location:** Inside the loop that creates HTTP_REQUEST nodes (after line 280, inside the `for (const request of httpRequests)` loop)

**Current code creates:**
1. The http:request node (line 273)
2. CONTAINS edge from module to request (lines 276-280)
3. MAKES_REQUEST edge from function to request (lines 302-306)

**Add after line 280 (after the CONTAINS edge creation):**
```typescript
// http:request --CALLS--> net:request singleton
await graph.addEdge({
  type: 'CALLS',
  src: request.id,
  dst: networkId
});
```

**Why CALLS edge type:**
- Matches the pattern used by GraphBuilder.bufferHttpRequests() (line 660-664)
- Matches the pattern used by ExpressAnalyzer for endpoints (lines 309-314, though it uses INTERACTS_WITH)
- The test file expects CALLS edges from HTTP_REQUEST to net:request (test line 243-254)

**Note on edge type:** The tests expect `CALLS` edge type (line 250: `const callsEdge = edges.find(e => e.dst === 'net:request#__network__')`). ExpressAnalyzer uses `INTERACTS_WITH` for http:route -> net:request. We should use `CALLS` to match what GraphBuilder.bufferHttpRequests() uses and what the tests expect.

---

### Step 5: Update PluginResult node count

**File:** `/packages/core/src/plugins/analysis/FetchAnalyzer.ts`

**Location:** Line 91-99 (createSuccessResult)

**Current code:**
```typescript
return createSuccessResult(
  {
    nodes: requestsCount + apisCount,
    edges: 0
  },
  ...
);
```

**Change to:**
```typescript
return createSuccessResult(
  {
    nodes: requestsCount + apisCount + 1,  // +1 for net:request singleton
    edges: requestsCount  // Each http:request has CALLS edge to net:request
  },
  ...
);
```

**Note:** The edge count should also include CONTAINS and MAKES_REQUEST edges created, but since the current code returns 0, we're only adding the new CALLS edges for now. A proper fix would count all edges, but that's outside scope.

---

## Complete Code Changes

### FetchAnalyzer.ts - Final Diff

```diff
--- a/packages/core/src/plugins/analysis/FetchAnalyzer.ts
+++ b/packages/core/src/plugins/analysis/FetchAnalyzer.ts
@@ -16,6 +16,7 @@ import type { NodePath } from '@babel/traverse';
 import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
 import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
 import type { NodeRecord } from '@grafema/types';
+import { NetworkRequestNode } from '../../core/nodes/NetworkRequestNode.js';

 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const traverse = (traverseModule as any).default || traverseModule;
@@ -60,6 +61,10 @@ export class FetchAnalyzer extends Plugin {
     try {
       const { graph } = context;

+      // Create net:request singleton (GraphBackend handles deduplication)
+      const networkNode = NetworkRequestNode.create();
+      await graph.addNode(networkNode);
+
       // Получаем все модули
       const modules = await this.getModules(graph);
       console.log(`[FetchAnalyzer] Processing ${modules.length} modules...`);
@@ -71,7 +76,7 @@ export class FetchAnalyzer extends Plugin {

       for (let i = 0; i < modules.length; i++) {
         const module = modules[i];
-        const result = await this.analyzeModule(module, graph);
+        const result = await this.analyzeModule(module, graph, networkNode.id);
         requestsCount += result.requests;
         apisCount += result.apis;

@@ -88,9 +93,9 @@ export class FetchAnalyzer extends Plugin {

       return createSuccessResult(
         {
-          nodes: requestsCount + apisCount,
-          edges: 0
+          nodes: requestsCount + apisCount + 1,  // +1 for net:request singleton
+          edges: requestsCount  // CALLS edges from http:request to net:request
         },
         {
           requestsCount,
           apisCount
@@ -104,7 +109,8 @@ export class FetchAnalyzer extends Plugin {

   private async analyzeModule(
     module: NodeRecord,
-    graph: PluginContext['graph']
+    graph: PluginContext['graph'],
+    networkId: string
   ): Promise<AnalysisResult> {
     try {
       const code = readFileSync(module.file!, 'utf-8');
@@ -277,6 +283,13 @@ export class FetchAnalyzer extends Plugin {
           dst: request.id
         });

+        // http:request --CALLS--> net:request singleton
+        await graph.addEdge({
+          type: 'CALLS',
+          src: request.id,
+          dst: networkId
+        });
+
         // Ищем FUNCTION node которая делает запрос
         const functions: NodeRecord[] = [];
         for await (const fn of graph.queryNodes({ type: 'FUNCTION' })) {
```

---

## Edge Cases and Concerns

### 1. GraphBackend Deduplication

The GraphBackend already handles node deduplication. If both FetchAnalyzer and ExpressAnalyzer run on an Express project, two attempts to create `net:request#__network__` will occur. The backend should handle this gracefully by ignoring the duplicate.

**Verification needed:** Ensure tests cover projects with BOTH Express endpoints AND fetch calls.

### 2. Module Analysis Order

FetchAnalyzer runs AFTER JSASTAnalyzer (priority 75 vs 80). This is correct - it needs MODULE nodes to exist before it can iterate them.

### 3. Empty Project Handling

If `modules.length === 0`, the singleton is still created but no edges are made. This is acceptable - having the singleton exist is harmless.

### 4. Test Orchestrator Registration

The test uses `createTestOrchestrator` which should have FetchAnalyzer registered. Verify that `createTestOrchestrator.ts` includes FetchAnalyzer in its plugin list.

**Check file:** `/test/helpers/createTestOrchestrator.ts`

---

## Test Verification Strategy

### Existing Tests

The tests in `/test/unit/NetworkRequestNodeMigration.test.js` already define expected behavior:

1. **Line 88-107:** `net:request` node should be created when analyzing fetch call
2. **Line 109-129:** Singleton ID should be `net:request#__network__`
3. **Line 131-151:** Type should be `net:request`
4. **Line 153-173:** Name should be `__network__`
5. **Line 175-195:** File should be `__builtin__`
6. **Line 225-255:** CALLS edge from HTTP_REQUEST to net:request

### Test Execution

```bash
node --test test/unit/NetworkRequestNodeMigration.test.js
```

### Expected Results After Fix

All 13 tests should pass:
- `GraphBuilder creates net:request singleton` (6 tests)
- `HTTP_REQUEST connects to net:request singleton` (2 tests)
- `Singleton deduplication` (3 tests)
- `Node structure verification` (3 tests)
- `Distinction from HTTP_REQUEST nodes` (3 tests)

---

## Test Orchestrator Verification

Before implementation, verify FetchAnalyzer is registered in test helpers:

```bash
grep -r "FetchAnalyzer" test/helpers/
```

If not found, add to `createTestOrchestrator.ts`:

```typescript
import { FetchAnalyzer } from '@grafema/core';
// ... in plugin registration ...
orchestrator.registerPlugin(new FetchAnalyzer());
```

---

## Implementation Checklist

1. [ ] Add `import { NetworkRequestNode }` to FetchAnalyzer.ts
2. [ ] Create singleton in `execute()` after getting graph
3. [ ] Update `analyzeModule` signature to accept `networkId`
4. [ ] Update call to `analyzeModule` to pass `networkNode.id`
5. [ ] Add CALLS edge creation after http:request node creation
6. [ ] Update node/edge counts in `createSuccessResult`
7. [ ] Verify FetchAnalyzer is registered in test orchestrator
8. [ ] Run tests: `node --test test/unit/NetworkRequestNodeMigration.test.js`
9. [ ] Run full test suite: `npm test`

---

## Risk Assessment

**Low Risk:**
- FetchAnalyzer already has similar patterns (graph.addNode, graph.addEdge)
- NetworkRequestNode factory is already used by ExpressAnalyzer
- GraphBackend handles duplicates

**Medium Risk:**
- Test orchestrator may not have FetchAnalyzer registered
- Some test projects may not trigger FetchAnalyzer

**Mitigation:**
- Verify test orchestrator before implementation
- If needed, update createTestOrchestrator.ts to include FetchAnalyzer
