# Joel Spolsky: Technical Specification for Clear-and-Rebuild

**Date:** 2025-01-22
**Task:** REG-118 Node Duplication Fix
**Based on:** Don's Clear-and-Rebuild Plan (009)

---

## Overview

This spec details the implementation of Clear-and-Rebuild in `GraphBuilder.build()`. The approach:

1. Before creating nodes for a file, delete all existing nodes belonging to that file
2. Exclude MODULE nodes from deletion (created by Indexer phase)
3. Proceed with normal build

---

## 1. File-by-file Changes

### 1.1 GraphBuilder.ts

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

#### 1.1.1 Add `clearFileNodes()` Method (New private method)

**Location:** After line 90 (after `_flushEdges` method), add new method:

```typescript
/**
 * Clear existing nodes for a file before rebuilding
 * This enables idempotent re-analysis: running twice produces identical results
 *
 * @param graph - The graph backend
 * @param file - The file path to clear nodes for
 * @returns Number of nodes deleted
 */
private async clearFileNodes(graph: GraphBackend, file: string): Promise<number> {
  // Skip if backend doesn't support deletion
  if (!graph.deleteNode) {
    return 0;
  }

  let deletedCount = 0;
  const nodesToDelete: string[] = [];

  // Collect node IDs for this file, excluding MODULE nodes
  // MODULE nodes are created by JSModuleIndexer in INDEXING phase
  for await (const node of graph.queryNodes({ file })) {
    // Preserve MODULE nodes - they belong to the indexing phase
    if (node.type === 'MODULE' || node.nodeType === 'MODULE') {
      continue;
    }
    nodesToDelete.push(node.id);
  }

  // Delete each collected node
  // RFDB handles edge cleanup via soft delete - edges to deleted nodes are invalidated
  for (const id of nodesToDelete) {
    try {
      await graph.deleteNode(id);
      deletedCount++;
    } catch (err) {
      // Log but don't fail - node might already be deleted
      console.warn(`[GraphBuilder] Failed to delete node ${id}:`, (err as Error).message);
    }
  }

  return deletedCount;
}
```

#### 1.1.2 Modify `build()` Method to Call Clear First

**Location:** Line 95-129, modify the beginning of `build()` method:

**Before (current code at lines 95-129):**
```typescript
async build(module: ModuleNode, graph: GraphBackend, projectPath: string, data: ASTCollections): Promise<BuildResult> {
  const {
    functions,
    parameters = [],
    // ... destructuring continues
  } = data;

  // Reset buffers for this build
  this._nodeBuffer = [];
  this._edgeBuffer = [];
```

**After (modified):**
```typescript
async build(module: ModuleNode, graph: GraphBackend, projectPath: string, data: ASTCollections): Promise<BuildResult> {
  // CLEAR EXISTING NODES FIRST - enables idempotent re-analysis
  // This must happen BEFORE we start buffering new nodes
  const deletedCount = await this.clearFileNodes(graph, module.file);
  if (deletedCount > 0) {
    // Minimal logging - only show when nodes were actually deleted
    console.log(`[GraphBuilder] Cleared ${deletedCount} existing nodes for ${module.file}`);
  }

  const {
    functions,
    parameters = [],
    // ... destructuring continues (unchanged)
  } = data;

  // Reset buffers for this build
  this._nodeBuffer = [];
  this._edgeBuffer = [];
```

The key changes:
1. Add `clearFileNodes()` call at the very beginning of `build()`
2. Pass `module.file` to identify which file's nodes to clear
3. Log only when nodes were deleted (not on fresh analysis)

---

### 1.2 RustAnalyzer.ts (Optional - for consistency)

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/RustAnalyzer.ts`

RustAnalyzer currently writes nodes directly without using GraphBuilder. For consistency, it should also clear before writing. However, this is **lower priority** since:
1. REG-118 is primarily a JS/TS issue
2. RustAnalyzer is less mature and less frequently used

**Recommendation:** Address in a follow-up task. Note as tech debt.

---

## 2. New Methods/Interfaces

### 2.1 Method Signature

```typescript
/**
 * Clear existing nodes for a file before rebuilding
 *
 * @param graph - The graph backend implementing GraphBackend interface
 * @param file - Absolute file path to clear nodes for
 * @returns Promise<number> - Count of deleted nodes
 *
 * @remarks
 * - Excludes MODULE nodes (owned by indexing phase)
 * - Uses queryNodes({ file }) to find nodes - O(N) scan
 * - Uses deleteNode() to remove each node - edges cascade via soft delete
 * - If deleteNode is not available on backend, returns 0 silently
 */
private async clearFileNodes(graph: GraphBackend, file: string): Promise<number>
```

### 2.2 GraphBackend Interface (No Changes Needed)

The `GraphBackend` interface in `/Users/vadimr/grafema/packages/types/src/plugins.ts` already has:

```typescript
// Line 137-138
deleteNode?(id: string): Promise<void>;
```

This is marked as optional (`?`), so our code checks for its existence before calling.

### 2.3 Error Handling

- If `graph.deleteNode` is undefined: return 0, no error
- If individual `deleteNode` call fails: log warning, continue with other deletions
- If `queryNodes` fails: exception propagates up (indicates backend issues)

---

## 3. Test Plan

### 3.1 Test File Location

Create new test file: `/Users/vadimr/grafema/test/unit/ReanalysisIdempotency.test.js`

### 3.2 Test Cases

#### Test 1: Re-analysis produces identical graph

```javascript
it('should produce identical graph on re-analysis', async () => {
  // Setup: Create test file
  const testDir = createTestDir();
  writeFileSync(join(testDir, 'index.js'), `
    function hello() { return "world"; }
    const x = 1;
  `);

  // First analysis
  await orchestrator.run(testDir);
  const state1 = await backend.export();
  const nodeCount1 = state1.nodes.length;
  const edgeCount1 = state1.edges.length;

  // Second analysis (same file, no changes)
  await orchestrator.run(testDir);
  const state2 = await backend.export();
  const nodeCount2 = state2.nodes.length;
  const edgeCount2 = state2.edges.length;

  // Counts should be identical
  assert.strictEqual(nodeCount1, nodeCount2,
    'Node count should not change on re-analysis');
  assert.strictEqual(edgeCount1, edgeCount2,
    'Edge count should not change on re-analysis');
});
```

#### Test 2: Node count doesn't grow on repeated analysis

```javascript
it('should not grow node count on repeated analysis', async () => {
  const testDir = createTestDir();
  writeFileSync(join(testDir, 'index.js'), `
    import fs from 'fs';
    function readFile() { return fs.readFileSync('x'); }
  `);

  // Analyze 3 times
  for (let i = 0; i < 3; i++) {
    await orchestrator.run(testDir);
  }

  // Count should match single analysis
  const nodeCount = await backend.nodeCount();

  // Fresh analysis baseline
  const freshBackend = createTestBackend();
  await freshBackend.connect();
  const freshOrch = createTestOrchestrator(freshBackend);
  await freshOrch.run(testDir);
  const freshCount = await freshBackend.nodeCount();
  await freshBackend.cleanup();

  assert.strictEqual(nodeCount, freshCount,
    'Node count should equal fresh analysis after 3 re-analyses');
});
```

#### Test 3: MODULE nodes are preserved

```javascript
it('should preserve MODULE nodes across re-analysis', async () => {
  const testDir = createTestDir();
  writeFileSync(join(testDir, 'index.js'), `const x = 1;`);

  // First analysis
  await orchestrator.run(testDir);
  const modules1 = await backend.getAllNodes({ type: 'MODULE' });
  const moduleIds = modules1.map(m => m.id);

  // Second analysis
  await orchestrator.run(testDir);
  const modules2 = await backend.getAllNodes({ type: 'MODULE' });
  const moduleIds2 = modules2.map(m => m.id);

  // Same MODULE nodes should exist
  assert.deepStrictEqual(moduleIds, moduleIds2,
    'MODULE node IDs should be preserved');

  // Count should be same
  assert.strictEqual(modules1.length, modules2.length,
    'MODULE count should not change');
});
```

#### Test 4: Cross-file edges are recreated correctly

```javascript
it('should recreate cross-file edges on re-analysis', async () => {
  const testDir = createTestDir();
  writeFileSync(join(testDir, 'utils.js'), `
    export function helper() { return 1; }
  `);
  writeFileSync(join(testDir, 'index.js'), `
    import { helper } from './utils';
    helper();
  `);

  // First analysis
  await orchestrator.run(testDir);
  const edges1 = await backend.getAllEdges();
  const importsEdges1 = edges1.filter(e => e.type === 'IMPORTS' || e.type === 'IMPORTS_FROM');

  // Re-analyze only index.js (simulate file change)
  // For now, re-analyze entire project
  await orchestrator.run(testDir);
  const edges2 = await backend.getAllEdges();
  const importsEdges2 = edges2.filter(e => e.type === 'IMPORTS' || e.type === 'IMPORTS_FROM');

  // Import edges should still exist
  assert.strictEqual(importsEdges1.length, importsEdges2.length,
    'Import edges should be preserved/recreated');
});
```

#### Test 5: Modified file updates graph correctly

```javascript
it('should update graph when file is modified', async () => {
  const testDir = createTestDir();
  const filePath = join(testDir, 'index.js');

  // Initial version
  writeFileSync(filePath, `
    function foo() { return 1; }
  `);
  await orchestrator.run(testDir);

  const fns1 = await backend.getAllNodes({ type: 'FUNCTION' });
  const fooNode = fns1.find(f => f.name === 'foo');
  assert.ok(fooNode, 'Should have foo function');

  // Modified version - add bar function
  writeFileSync(filePath, `
    function foo() { return 1; }
    function bar() { return 2; }
  `);
  await orchestrator.run(testDir);

  const fns2 = await backend.getAllNodes({ type: 'FUNCTION' });
  const barNode = fns2.find(f => f.name === 'bar');
  assert.ok(barNode, 'Should have bar function after update');

  // foo should still exist
  const fooNode2 = fns2.find(f => f.name === 'foo');
  assert.ok(fooNode2, 'foo function should still exist');
});
```

#### Test 6: Deleted code is removed from graph

```javascript
it('should remove nodes when code is deleted', async () => {
  const testDir = createTestDir();
  const filePath = join(testDir, 'index.js');

  // Initial version with two functions
  writeFileSync(filePath, `
    function foo() { return 1; }
    function bar() { return 2; }
  `);
  await orchestrator.run(testDir);

  const fns1 = await backend.getAllNodes({ type: 'FUNCTION' });
  assert.strictEqual(fns1.length, 2, 'Should have 2 functions initially');

  // Modified version - remove bar
  writeFileSync(filePath, `
    function foo() { return 1; }
  `);
  await orchestrator.run(testDir);

  const fns2 = await backend.getAllNodes({ type: 'FUNCTION' });
  assert.strictEqual(fns2.length, 1, 'Should have 1 function after deletion');
  assert.ok(fns2[0].name === 'foo', 'Remaining function should be foo');
});
```

---

## 4. Implementation Order

### Step 1: Write Tests First (TDD)

1. Create test file `test/unit/ReanalysisIdempotency.test.js`
2. Write all 6 test cases
3. Run tests - they should FAIL (proving the bug exists)

**Command:** `node --test test/unit/ReanalysisIdempotency.test.js`

### Step 2: Implement `clearFileNodes()`

1. Add the method to `GraphBuilder.ts` after line 90
2. Verify method compiles (no syntax errors)

### Step 3: Modify `build()` to Call Clear

1. Add call to `clearFileNodes()` at start of `build()` method
2. Add logging for debugging

### Step 4: Run Tests

1. Run new tests: `node --test test/unit/ReanalysisIdempotency.test.js`
2. All 6 tests should PASS

### Step 5: Run Full Test Suite

1. Run: `npm test`
2. Verify no regressions in existing tests

### Step 6: Manual Verification

1. Create a test project:
   ```bash
   mkdir /tmp/test-reanalysis
   cd /tmp/test-reanalysis
   echo '{"type":"module"}' > package.json
   echo 'function hello() { return 1; }' > index.js
   ```

2. Run analysis twice:
   ```bash
   grafema analyze /tmp/test-reanalysis
   grafema analyze /tmp/test-reanalysis
   ```

3. Check node count is stable:
   ```bash
   grafema query "SELECT COUNT(*) FROM nodes" /tmp/test-reanalysis
   ```

---

## 5. Definition of Done

### Code Complete Checklist

- [ ] `clearFileNodes()` method added to GraphBuilder.ts
- [ ] `build()` method calls `clearFileNodes()` at start
- [ ] MODULE nodes are excluded from deletion
- [ ] Error handling for missing `deleteNode` method
- [ ] Warning logs for failed deletions (not errors)

### Test Complete Checklist

- [ ] Test file `ReanalysisIdempotency.test.js` created
- [ ] Test 1: Identical graph on re-analysis - PASSES
- [ ] Test 2: Node count doesn't grow - PASSES
- [ ] Test 3: MODULE nodes preserved - PASSES
- [ ] Test 4: Cross-file edges recreated - PASSES
- [ ] Test 5: Modified file updates graph - PASSES
- [ ] Test 6: Deleted code removed from graph - PASSES

### Regression Checklist

- [ ] All existing tests pass (`npm test`)
- [ ] No new console errors during normal analysis
- [ ] Performance acceptable (no significant slowdown)

### Manual Verification Checklist

- [ ] `grafema analyze` twice produces identical graph
- [ ] Node count stable after 3+ re-analyses
- [ ] Cross-file imports work after re-analysis

### Documentation Checklist

- [ ] Code comments explain the clear-and-rebuild approach
- [ ] Any tech debt noted (RustAnalyzer consistency)

---

## 6. Tech Debt to Track

Create Linear issues for future optimization:

### 6.1 Performance Optimization

**Title:** Add server-side `deleteNodesByFile` for efficient clear
**Description:**
Current implementation uses O(N) scan via `queryNodes({ file })`. For large graphs (100k+ nodes), this could be slow. Add server-side operation in RFDB:
- Wire `FileIndex` through GraphEngine
- Add `deleteNodesByFile(file: string): string[]` to RFDB server
- Update RFDBServerBackend to use new operation

### 6.2 RustAnalyzer Consistency

**Title:** Add clear-before-write to RustAnalyzer
**Description:**
RustAnalyzer writes nodes directly without GraphBuilder. Should follow same clear-and-rebuild pattern for consistency.

### 6.3 Transaction Support

**Title:** Add transaction support for atomic clear-and-rebuild
**Description:**
Current implementation is non-atomic. If build crashes after clear, file's nodes are lost. Add transaction support:
- Begin transaction before clear
- Commit after successful build
- Rollback on error

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Performance regression | Low | Medium | O(N) is acceptable for typical codebases. Monitor in production. |
| Breaking existing tests | Low | High | Run full test suite before commit. |
| Race condition in parallel analysis | Low | Low | RFDB handles dangling edges gracefully. Document as known limitation. |
| MODULE nodes accidentally deleted | Low | High | Explicit type check in `clearFileNodes()`. Test case verifies. |

---

## 8. Estimated Time

| Task | Time |
|------|------|
| Write tests | 45 min |
| Implement `clearFileNodes()` | 20 min |
| Modify `build()` | 10 min |
| Run tests, fix issues | 30 min |
| Full test suite | 15 min |
| Manual verification | 15 min |
| Documentation | 15 min |
| **Total** | **~2.5 hours** |

---

**Ready for implementation by Kent (tests) and Rob (code).**
