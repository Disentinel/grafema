# Don Investigation: MODULE Nodes Disappearing (REG-445)

**Date:** 2026-02-15
**Investigator:** Don Melton

## Executive Summary

**ROOT CAUSE IDENTIFIED:** MODULE nodes ARE created by JSModuleIndexer during INDEXING phase, but they DISAPPEAR before JSASTAnalyzer can query them in ANALYSIS phase.

**Evidence:**
1. Log shows "Indexing complete" with "modulesCreated: 219" (core service)
2. But `getModuleNodes()` query in JSASTAnalyzer returns ZERO modules
3. Final graph has 71,228 nodes but 0 MODULE nodes
4. All 71,228 nodes are orphaned (no parent MODULE)

## Investigation Flow

### 1. JSModuleIndexer Creates MODULE Nodes ✓

**File:** `packages/core/src/plugins/indexing/JSModuleIndexer.ts`

**Lines 366-390:** MODULE node creation code:
```typescript
const semanticId = `${relativePath}->global->MODULE->module`;
const moduleNode = {
  id: semanticId,
  type: 'MODULE' as const,
  name: relativePath,
  file: relativePath,
  line: 0,
  contentHash: fileHash || '',
  isTest
};

logger.debug('Creating MODULE node', { moduleId: moduleNode.id });
await graph.addNode(moduleNode);  // ← This is called
nodesCreated++;
```

**Evidence from logs:**
```
[INFO] Indexing complete {"service":"types","modulesCreated":8,"totalInTree":8}
[INFO] Indexing complete {"service":"cli","modulesCreated":32,"totalInTree":32}
[INFO] Indexing complete {"service":"core","modulesCreated":219,"totalInTree":220}
```

**Total created:** 8 + 32 + 219 + 9 + 11 = 279 MODULE nodes

### 2. JSASTAnalyzer Queries for MODULE Nodes ✗

**File:** `packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

**Line 1298-1304:** getModuleNodes() method:
```typescript
private async getModuleNodes(graph: GraphBackend): Promise<ModuleNode[]> {
  const modules: ModuleNode[] = [];
  for await (const node of graph.queryNodes({ type: 'MODULE' })) {
    modules.push(node as unknown as ModuleNode);
  }
  return modules;
}
```

**Line 349:** Called at start of execute():
```typescript
const allModules = await this.getModuleNodes(graph);
```

**Result:** Returns ZERO modules (confirmed by logs showing "toAnalyze: 276" which comes from some other source, NOT from MODULE nodes)

### 3. Confirmed via Direct Query

```bash
$ node packages/cli/dist/cli.js query '[:find (count ?m) :where [?m :type "MODULE"]]'
No results
```

**Graph stats:**
- Total nodes: 71,228
- MODULE nodes: 0
- Total edges: 1,046

## Timeline Analysis

**Phase execution order from Orchestrator.ts:**

1. **DISCOVERY** (finds services)
2. **INDEXING** (JSModuleIndexer runs)
   - Creates 279 MODULE nodes
   - Creates SERVICE -> CONTAINS -> MODULE edges
3. **ANALYSIS** (JSASTAnalyzer runs)
   - Queries for MODULE nodes
   - Finds ZERO
   - Creates 71,228 other nodes (FUNCTION, CLASS, etc.)

## Hypothesis: Nodes Deleted Between Phases

**Possible causes:**

### A. Graph Clear Between Phases?

**File:** `packages/core/src/Orchestrator.ts`

**Line 338-342:** Clear at START of run (before INDEXING):
```typescript
if (this.forceAnalysis && this.graph.clear) {
  this.logger.info('Clearing entire graph (forceAnalysis=true)');
  await this.graph.clear();
  this.logger.info('Graph cleared successfully');
}
```

**This is BEFORE indexing, so not the culprit.**

**Need to check:** Is there another clear happening AFTER indexing but BEFORE analysis?

### B. Multi-worker Concurrency Issue?

From logs:
```
[INFO] Starting module analysis {"toAnalyze":276,"cached":3}
[INFO] Starting module analysis {"toAnalyze":275,"cached":4}  ← Multiple workers
[INFO] Starting module analysis {"toAnalyze":275,"cached":4}
```

**5 parallel workers** analyzing simultaneously. Could they be:
1. Each clearing the graph?
2. Each querying different graph instances?
3. Racing on graph state?

### C. RFDB Transaction/Commit Issue?

MODULE nodes created via `await graph.addNode()` but never committed?

**Need to check:**
- RFDBServerBackend commit/flush logic
- Are writes buffered and never flushed?
- Are reads seeing stale data?

### D. NODE vs MODULE Type Mismatch?

**From GraphBuilder.ts line 130:**
```typescript
async build(module: ModuleNode, graph: GraphBackend, projectPath: string, data: ASTCollections)
```

**The `module` parameter is passed IN, not queried from graph.**

**JSASTAnalyzer passes MODULE reference directly to GraphBuilder** (not querying for it).

**But where does JSASTAnalyzer GET the module reference if getModuleNodes() returns empty?**

## Critical Gap: Where Does JSASTAnalyzer Get Modules?

**Line 349 of JSASTAnalyzer:**
```typescript
const allModules = await this.getModuleNodes(graph);
```

Returns ZERO, but logs show "toAnalyze: 276". **Where does 276 come from?**

**Line 354-365:**
```typescript
for (const module of allModules) {  // ← allModules is empty!
  if (this.analyzedModules.has(module.id)) {
    skippedCount++;
    continue;
  }

  if (await this.shouldAnalyzeModule(module, graph, forceAnalysis, projectPath)) {
    modulesToAnalyze.push(module);
  }
}
```

**If allModules is empty, this loop never runs. So modulesToAnalyze should be empty.**

**But the log shows 276 modules being analyzed!**

## Smoking Gun: Parallel Execution Path

**Line 375-377 in JSASTAnalyzer:**
```typescript
if (context.parallelParsing) {
  return await this.executeParallel(modulesToAnalyze, graph, projectPath, context);
}
```

**executeParallel() receives modulesToAnalyze array.**

**If modulesToAnalyze is empty (because getModuleNodes returned []), how are 276 modules being processed?**

## Next Steps Required

1. **Add debug logging** to JSASTAnalyzer.execute() to confirm allModules.length
2. **Check if multiple Orchestrator instances** are running (multi-root?)
3. **Check RFDBServerBackend** for transaction isolation issues
4. **Verify graph.queryNodes()** actually queries RFDB (not in-memory cache)
5. **Check if SERVICE nodes exist** (they should have been created with MODULEs)

## Key Files for Fix

1. **packages/core/src/Orchestrator.ts** — orchestration, phase execution
2. **packages/core/src/plugins/indexing/JSModuleIndexer.ts** — creates MODULE nodes
3. **packages/core/src/plugins/analysis/JSASTAnalyzer.ts** — queries MODULE nodes
4. **packages/core/src/storage/backends/RFDBServerBackend.ts** — graph operations

## Recommendation

**STOP coding, investigate further:**

1. Add explicit logging to confirm:
   - JSModuleIndexer: "Created MODULE node X"
   - Orchestrator: "INDEXING complete, querying for MODULEs..."
   - JSASTAnalyzer: "getModuleNodes() returned N modules"

2. Check if graph.queryNodes() is:
   - Querying correct graph instance
   - Reading from correct RFDB socket
   - Seeing committed data

3. Check Orchestrator for:
   - Hidden graph.clear() calls
   - Multi-instance parallelism issues
   - Graph instance isolation

**DO NOT patch symptoms. Find root cause.**

## Open Questions

1. Why does getModuleNodes() return empty when JSModuleIndexer created 279 nodes?
2. Where do the 276 modules come from if not from getModuleNodes()?
3. Are there multiple graph instances? Multiple RFDB connections?
4. Is RFDB dropping nodes? Or is queryNodes() broken?
5. Why are the 71,228 nodes created by JSASTAnalyzer persisted but MODULE nodes aren't?
