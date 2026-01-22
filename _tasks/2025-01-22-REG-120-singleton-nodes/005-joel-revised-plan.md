# Joel Spolsky Revised Technical Plan: REG-120 Singleton Nodes Fix

## Addressing Linus's Rejection

This revision addresses three critical issues identified by Linus:

1. **Type Mismatch**: Tests query `HTTP_REQUEST` but FetchAnalyzer creates `http:request`
2. **FetchAnalyzer Not in Test Orchestrator**: Must be explicitly added
3. **Misleading Node Count**: Singleton counted per-module iteration

---

## Investigation Summary

### Type Convention Analysis

The codebase has TWO type conventions:

| Convention | Example | Where Used |
|------------|---------|------------|
| OLD (uppercase) | `HTTP_REQUEST` | HttpRequestNode factory, GraphBuilder |
| NEW (namespaced) | `http:request` | FetchAnalyzer, ast/types.ts |

**Evidence:**
- `packages/core/src/core/nodes/HttpRequestNode.ts` line 8: `type: 'HTTP_REQUEST'`
- `packages/core/src/plugins/analysis/FetchAnalyzer.ts` line 29: `type: 'http:request'`
- `packages/core/src/plugins/analysis/ast/types.ts` line 272: `type: 'http:request'`
- `packages/types/src/nodes.ts` line 45: `HTTP_REQUEST: 'http:request'`

**The mapping exists:** `NodeKind.HTTP_REQUEST = 'http:request'` (line 59 of NodeKind.ts)

**Decision:** The NEW namespaced convention (`http:request`) is the canonical form. The tests incorrectly use `HTTP_REQUEST` and must be fixed.

Test file header (line 7) confirms this:
> "CRITICAL: Verifies type is 'net:request' (namespaced string), NOT 'NET_REQUEST'."

The same principle applies to `http:request` vs `HTTP_REQUEST`.

---

## Implementation Plan

### Part A: FetchAnalyzer Changes (from original plan)

#### Step A1: Import NetworkRequestNode

**File:** `/packages/core/src/plugins/analysis/FetchAnalyzer.ts`

**Location:** After line 19 (after existing imports)

**Add:**
```typescript
import { NetworkRequestNode } from '../../core/nodes/NetworkRequestNode.js';
```

---

#### Step A2: Add instance variable for singleton tracking

**File:** `/packages/core/src/plugins/analysis/FetchAnalyzer.ts`

**Location:** After line 46 (inside class, before `get metadata()`)

**Add:**
```typescript
private networkNodeCreated = false;
```

This tracks whether the singleton was created in this run to avoid misleading counts.

---

#### Step A3: Create net:request singleton in execute()

**File:** `/packages/core/src/plugins/analysis/FetchAnalyzer.ts`

**Location:** Inside `execute()`, after line 62 (`const { graph } = context;`) and before line 65 (`const modules = await this.getModules(graph);`)

**Add:**
```typescript
// Create net:request singleton (GraphBackend handles deduplication)
const networkNode = NetworkRequestNode.create();
await graph.addNode(networkNode);
this.networkNodeCreated = true;
```

---

#### Step A4: Update analyzeModule signature

**File:** `/packages/core/src/plugins/analysis/FetchAnalyzer.ts`

**Current signature (line 106-108):**
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

---

#### Step A5: Update call site in execute()

**File:** `/packages/core/src/plugins/analysis/FetchAnalyzer.ts`

**Location:** Line 74

**Change from:**
```typescript
const result = await this.analyzeModule(module, graph);
```

**Change to:**
```typescript
const result = await this.analyzeModule(module, graph, networkNode.id);
```

---

#### Step A6: Add CALLS edge from http:request to net:request

**File:** `/packages/core/src/plugins/analysis/FetchAnalyzer.ts`

**Location:** Inside the loop that creates http:request nodes, after line 280 (after the CONTAINS edge creation)

**Current code (lines 275-280):**
```typescript
// Создаём ребро от модуля к request
await graph.addEdge({
  type: 'CONTAINS',
  src: module.id,
  dst: request.id
});
```

**Add after this block:**
```typescript
// http:request --CALLS--> net:request singleton
await graph.addEdge({
  type: 'CALLS',
  src: request.id,
  dst: networkId
});
```

---

#### Step A7: Fix node/edge count in createSuccessResult

**File:** `/packages/core/src/plugins/analysis/FetchAnalyzer.ts`

**Location:** Lines 90-99

**Current code:**
```typescript
return createSuccessResult(
  {
    nodes: requestsCount + apisCount,
    edges: 0
  },
  {
    requestsCount,
    apisCount
  }
);
```

**Change to:**
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

This fixes Linus's concern: the singleton is counted ONCE (via boolean flag), not per-module.

---

### Part B: Test Orchestrator Fix (NEW)

#### Step B1: Add FetchAnalyzer to createTestOrchestrator.js

**File:** `/test/helpers/createTestOrchestrator.js`

**Location:** Line 14 (add import)

**Add import:**
```javascript
import { FetchAnalyzer } from '@grafema/core';
```

**Location:** After line 42 (after InstanceOfResolver is added, before extraPlugins)

**Add:**
```javascript
// HTTP request analysis
plugins.push(new FetchAnalyzer());
```

**Full updated createTestOrchestrator function:**
```javascript
export function createTestOrchestrator(backend, options = {}) {
  const plugins = [];

  // Базовые плагины (SimpleProjectDiscovery добавляется Orchestrator'ом автоматически)
  if (!options.skipIndexer) {
    plugins.push(new JSModuleIndexer());
  }

  if (!options.skipAnalyzer) {
    plugins.push(new JSASTAnalyzer());
  }

  // Enrichment плагины
  if (!options.skipEnrichment) {
    plugins.push(new InstanceOfResolver());
  }

  // HTTP request analysis (needed for net:request singleton tests)
  plugins.push(new FetchAnalyzer());

  // Дополнительные плагины
  if (options.extraPlugins) {
    plugins.push(...options.extraPlugins);
  }

  return new Orchestrator({
    graph: backend,
    plugins,
    onProgress: options.onProgress,
    forceAnalysis: options.forceAnalysis
  });
}
```

---

### Part C: Test File Fixes (NEW)

#### Step C1: Fix type queries in NetworkRequestNodeMigration.test.js

**File:** `/test/unit/NetworkRequestNodeMigration.test.js`

The tests query for `type: 'HTTP_REQUEST'` but FetchAnalyzer creates `type: 'http:request'`.

**Changes needed:**

| Line | Current | Change To |
|------|---------|-----------|
| 237 | `type: 'HTTP_REQUEST'` | `type: 'http:request'` |
| 277 | `type: 'HTTP_REQUEST'` | `type: 'http:request'` |
| 358 | `type: 'HTTP_REQUEST'` | `type: 'http:request'` |
| 511 | `type: 'HTTP_REQUEST'` | `type: 'http:request'` |
| 537 | `type: 'HTTP_REQUEST'` | `type: 'http:request'` |
| 575 | `type: 'HTTP_REQUEST'` | `type: 'http:request'` |

**Detailed changes:**

**Line 237:**
```javascript
// BEFORE:
const httpNodes = await graph.queryNodes({ type: 'HTTP_REQUEST' });

// AFTER:
const httpNodes = await graph.queryNodes({ type: 'http:request' });
```

**Line 277:**
```javascript
// BEFORE:
const httpNodes = await graph.queryNodes({ type: 'HTTP_REQUEST' });

// AFTER:
const httpNodes = await graph.queryNodes({ type: 'http:request' });
```

**Line 358:**
```javascript
// BEFORE:
const httpNodes = await graph.queryNodes({ type: 'HTTP_REQUEST' });

// AFTER:
const httpNodes = await graph.queryNodes({ type: 'http:request' });
```

**Line 511:**
```javascript
// BEFORE:
const httpNodes = await graph.queryNodes({ type: 'HTTP_REQUEST' });

// AFTER:
const httpNodes = await graph.queryNodes({ type: 'http:request' });
```

**Line 537:**
```javascript
// BEFORE:
const httpNodes = await graph.queryNodes({ type: 'HTTP_REQUEST' });

// AFTER:
const httpNodes = await graph.queryNodes({ type: 'http:request' });
```

**Line 575:**
```javascript
// BEFORE:
const httpNodes = await graph.queryNodes({ type: 'HTTP_REQUEST' });

// AFTER:
const httpNodes = await graph.queryNodes({ type: 'http:request' });
```

#### Step C2: Update test assertions and comments

Also update assertion messages and comments that reference `HTTP_REQUEST`:

**Line 238:**
```javascript
// BEFORE:
assert.ok(httpNodes.length > 0, 'Should have HTTP_REQUEST node');

// AFTER:
assert.ok(httpNodes.length > 0, 'Should have http:request node');
```

**Line 278-281:**
```javascript
// BEFORE:
assert.ok(
  httpNodes.length >= 3,
  'Should have at least 3 HTTP_REQUEST nodes'
);

// AFTER:
assert.ok(
  httpNodes.length >= 3,
  'Should have at least 3 http:request nodes'
);
```

**Line 284:**
```javascript
// BEFORE:
// Verify each HTTP_REQUEST connects to net:request singleton

// AFTER:
// Verify each http:request connects to net:request singleton
```

**Line 291-294:**
```javascript
// BEFORE:
assert.ok(
  edges.length > 0,
  `HTTP_REQUEST ${httpNode.id} should connect to net:request singleton`
);

// AFTER:
assert.ok(
  edges.length > 0,
  `http:request ${httpNode.id} should connect to net:request singleton`
);
```

**Lines 359-362:**
```javascript
// BEFORE:
assert.ok(
  httpNodes.length >= 2,
  'Should have HTTP_REQUEST nodes from multiple files'
);

// AFTER:
assert.ok(
  httpNodes.length >= 2,
  'Should have http:request nodes from multiple files'
);
```

**Section header line 224:**
```javascript
// BEFORE:
// 2. HTTP_REQUEST connects to net:request singleton

// AFTER:
// 2. http:request connects to net:request singleton
```

**Test name line 225:**
```javascript
// BEFORE:
it('should create CALLS edge from HTTP_REQUEST to net:request', ...

// AFTER:
it('should create CALLS edge from http:request to net:request', ...
```

**Line 248:**
```javascript
// BEFORE:
assert.ok(edges.length > 0, 'Should have CALLS edge from HTTP_REQUEST');

// AFTER:
assert.ok(edges.length > 0, 'Should have CALLS edge from http:request');
```

**Line 251-254:**
```javascript
// BEFORE:
assert.ok(
  callsEdge,
  'HTTP_REQUEST should have CALLS edge to net:request singleton'
);

// AFTER:
assert.ok(
  callsEdge,
  'http:request should have CALLS edge to net:request singleton'
);
```

**Line 257:**
```javascript
// BEFORE:
it('should connect multiple HTTP_REQUEST nodes to same singleton', ...

// AFTER:
it('should connect multiple http:request nodes to same singleton', ...
```

**Describe block line 224:**
```javascript
// BEFORE:
describe('HTTP_REQUEST connects to net:request singleton', () => {

// AFTER:
describe('http:request connects to net:request singleton', () => {
```

**Section 5 (lines 490-586):**

All references to `HTTP_REQUEST` in test names and assertions should be changed to `http:request`:

- Line 491: `'should create both net:request singleton and HTTP_REQUEST nodes'` -> `'should create both net:request singleton and http:request nodes'`
- Line 510: `'Should have HTTP_REQUEST nodes for call sites'` -> `'Should have http:request nodes for call sites'`
- Line 518-519: `'net:request and HTTP_REQUEST should have different types'` -> `'net:request and http:request should have different types'`
- Line 525: `'should have net:request as built-in, HTTP_REQUEST as source code'` -> `'should have net:request as built-in, http:request as source code'`
- Line 540: `'Should have HTTP_REQUEST'` -> `'Should have http:request'`
- Line 553-554: `'HTTP_REQUEST should reference source file'` -> `'http:request should reference source file'`
- Line 557-558: `'HTTP_REQUEST should have real line number'` -> `'http:request should have real line number'`
- Line 563: `'should have net:request as singleton, HTTP_REQUEST as many'` -> `'should have net:request as singleton, http:request as many'`
- Line 582-584: `'Should have multiple HTTP_REQUEST nodes (one per call site)'` -> `'Should have multiple http:request nodes (one per call site)'`

---

## Complete Diff Summary

### FetchAnalyzer.ts

```diff
--- a/packages/core/src/plugins/analysis/FetchAnalyzer.ts
+++ b/packages/core/src/plugins/analysis/FetchAnalyzer.ts
@@ -16,6 +16,7 @@ import type { CallExpression, Identifier, MemberExpression, ObjectExpression, No
 import type { NodePath } from '@babel/traverse';
 import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
 import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
 import type { NodeRecord } from '@grafema/types';
+import { NetworkRequestNode } from '../../core/nodes/NetworkRequestNode.js';

 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const traverse = (traverseModule as any).default || traverseModule;
@@ -44,6 +45,8 @@ interface AnalysisResult {
 }

 export class FetchAnalyzer extends Plugin {
+  private networkNodeCreated = false;
+
   get metadata(): PluginMetadata {
     return {
       name: 'FetchAnalyzer',
@@ -60,6 +63,11 @@ export class FetchAnalyzer extends Plugin {
     try {
       const { graph } = context;

+      // Create net:request singleton (GraphBackend handles deduplication)
+      const networkNode = NetworkRequestNode.create();
+      await graph.addNode(networkNode);
+      this.networkNodeCreated = true;
+
       // Получаем все модули
       const modules = await this.getModules(graph);
       console.log(`[FetchAnalyzer] Processing ${modules.length} modules...`);
@@ -71,7 +79,7 @@ export class FetchAnalyzer extends Plugin {

       for (let i = 0; i < modules.length; i++) {
         const module = modules[i];
-        const result = await this.analyzeModule(module, graph);
+        const result = await this.analyzeModule(module, graph, networkNode.id);
         requestsCount += result.requests;
         apisCount += result.apis;

@@ -88,13 +96,14 @@ export class FetchAnalyzer extends Plugin {

       return createSuccessResult(
         {
-          nodes: requestsCount + apisCount,
-          edges: 0
+          nodes: requestsCount + apisCount + (this.networkNodeCreated ? 1 : 0),
+          edges: requestsCount
         },
         {
           requestsCount,
-          apisCount
+          apisCount,
+          networkSingletonCreated: this.networkNodeCreated
         }
       );
     } catch (error) {
@@ -105,7 +114,8 @@ export class FetchAnalyzer extends Plugin {

   private async analyzeModule(
     module: NodeRecord,
-    graph: PluginContext['graph']
+    graph: PluginContext['graph'],
+    networkId: string
   ): Promise<AnalysisResult> {
     try {
       const code = readFileSync(module.file!, 'utf-8');
@@ -277,6 +287,13 @@ export class FetchAnalyzer extends Plugin {
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

### createTestOrchestrator.js

```diff
--- a/test/helpers/createTestOrchestrator.js
+++ b/test/helpers/createTestOrchestrator.js
@@ -11,6 +11,7 @@ import { Orchestrator } from '@grafema/core';
 import { JSModuleIndexer } from '@grafema/core';
 import { JSASTAnalyzer } from '@grafema/core';
 import { InstanceOfResolver } from '@grafema/core';
+import { FetchAnalyzer } from '@grafema/core';

 /**
  * Создать Orchestrator для тестов
@@ -40,6 +41,9 @@ export function createTestOrchestrator(backend, options = {}) {
     plugins.push(new InstanceOfResolver());
   }

+  // HTTP request analysis (needed for net:request singleton tests)
+  plugins.push(new FetchAnalyzer());
+
   // Дополнительные плагины
   if (options.extraPlugins) {
     plugins.push(...options.extraPlugins);
```

### NetworkRequestNodeMigration.test.js

All `type: 'HTTP_REQUEST'` queries changed to `type: 'http:request'`:
- Line 237, 277, 358, 511, 537, 575

All assertion messages and comments updated accordingly.

---

## Implementation Order

1. **FetchAnalyzer.ts** - All changes (Steps A1-A7)
2. **createTestOrchestrator.js** - Add FetchAnalyzer (Step B1)
3. **NetworkRequestNodeMigration.test.js** - Fix type queries (Steps C1-C2)
4. Run tests: `node --test test/unit/NetworkRequestNodeMigration.test.js`
5. Run full suite: `npm test`

---

## Risk Mitigation

### Type Convention Consistency
The test file explicitly states in its header that namespaced types are the target. The `http:request` type is already used in:
- FetchAnalyzer (line 145)
- ast/types.ts (line 272)
- NodeKind mapping (line 59)

This is not a new convention - it's the existing convention that the tests were incorrectly not following.

### Test Orchestrator Impact
Adding FetchAnalyzer to the default test orchestrator may affect other tests that don't expect http:request nodes. However:
- FetchAnalyzer only creates nodes for files with fetch/axios calls
- Most test fixtures don't have HTTP requests
- Tests that need a clean graph can use `skipAnalyzer: true` option

### Backward Compatibility
GraphAsserter already has the legacy mapping `'HTTP_REQUEST': 'http:request'`. Tests using GraphAsserter will continue to work. Only tests using direct `graph.queryNodes()` with legacy types need updating.

---

## Verification Checklist

- [ ] FetchAnalyzer creates net:request singleton
- [ ] FetchAnalyzer creates CALLS edges from http:request to net:request
- [ ] Node count includes singleton once (not per-module)
- [ ] Edge count includes CALLS edges
- [ ] Test orchestrator includes FetchAnalyzer
- [ ] Tests query for `type: 'http:request'` (not `HTTP_REQUEST`)
- [ ] All 13 tests in NetworkRequestNodeMigration.test.js pass
- [ ] No regressions in other tests
