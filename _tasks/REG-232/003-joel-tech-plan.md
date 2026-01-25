# REG-232: Joel Spolsky - Detailed Technical Specification

## Overview

This document specifies the exact implementation steps for adding re-export chain resolution to FunctionCallResolver. The goal is to transform the current v1 skip behavior into full chain traversal.

## Current State Analysis

### File: `/packages/core/src/plugins/enrichment/FunctionCallResolver.ts`

**Lines 148-153** (the skip location):
```typescript
// Step 4.3: Handle re-exports (EXPORT with source field)
// For v1: skip complex re-exports
if (exportNode.source) {
  skipped.reExports++;
  continue;
}
```

### Data Flow

Current resolution:
```
CALL_SITE (name: "foo", file: "/project/main.js")
    |
    v lookup in importIndex
IMPORT (local: "foo", file: "/project/main.js")
    |
    v follow IMPORTS_FROM edge
EXPORT (name: "foo", file: "/project/index.js", source: "./utils")
    |
    v CURRENTLY: skip if source exists
    |
FUNCTION (not reached)
```

Required resolution:
```
CALL_SITE -> IMPORT -> EXPORT[re-export] -> EXPORT[re-export] -> ... -> EXPORT[local] -> FUNCTION
```

## Implementation Plan

### Phase 1: Add Export Index (Lines 76-89)

**Location:** After `functionIndex` construction (line 89), add export index building.

**New TypeScript:**

```typescript
// Add to interfaces section (after line 36)
interface ExportIndexEntry {
  node: ExportNode;
  exportKey: string; // "default" | "named:functionName"
}

// Step 2.5: Build Export Index - Map<file, Map<exportKey, ExportNode>>
// This enables O(1) lookup when following re-export chains
const exportIndex = new Map<string, Map<string, ExportNode>>();
for await (const node of graph.queryNodes({ nodeType: 'EXPORT' })) {
  const exp = node as ExportNode;
  if (!exp.file) continue;

  if (!exportIndex.has(exp.file)) {
    exportIndex.set(exp.file, new Map());
  }

  const fileExports = exportIndex.get(exp.file)!;

  // Build export key based on type (same pattern as ImportExportLinker line 207-217)
  let exportKey: string;
  if (exp.exportType === 'default') {
    exportKey = 'default';
  } else if (exp.exportType === 'named') {
    exportKey = `named:${exp.name}`;
  } else {
    exportKey = `named:${exp.name || 'anonymous'}`;
  }

  fileExports.set(exportKey, exp);
}
logger.debug('Indexed exports', { files: exportIndex.size });
```

### Phase 2: Add Path Resolution Helper

**Location:** Add as private method after `execute()` (after line 193).

**New TypeScript:**

```typescript
/**
 * Resolve module specifier to actual file path using extension fallbacks.
 * Pattern reused from ImportExportLinker (lines 101-122).
 *
 * @param currentDir - Directory of the file containing the import/re-export
 * @param specifier - The module specifier (e.g., "./utils", "../lib/helpers")
 * @param fileIndex - Set or Map of known file paths for existence checking
 * @returns Resolved file path or null if not found
 */
private resolveModulePath(
  currentDir: string,
  specifier: string,
  fileIndex: Set<string>
): string | null {
  const basePath = resolve(currentDir, specifier);
  const extensions = ['', '.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts'];

  for (const ext of extensions) {
    const testPath = basePath + ext;
    if (fileIndex.has(testPath)) {
      return testPath;
    }
  }

  return null;
}
```

**Required import at top of file:**
```typescript
import { dirname, resolve } from 'path';
```

### Phase 3: Add Chain Resolution Method

**Location:** Add as private method after `resolveModulePath()`.

**New TypeScript:**

```typescript
/**
 * Follow re-export chain to find the final EXPORT node (without source field).
 *
 * Algorithm:
 * 1. If current export has no source -> return it (base case)
 * 2. Resolve source path to file
 * 3. Find matching export in that file
 * 4. Recurse (with cycle detection)
 *
 * @param exportNode - Starting export node (may be re-export)
 * @param exportIndex - Pre-built export index for O(1) lookups
 * @param knownFiles - Set of known file paths
 * @param visited - Set of visited export IDs for cycle detection
 * @param maxDepth - Maximum chain depth (safety limit)
 * @returns Final export node (without source) or null if chain broken/circular
 */
private resolveExportChain(
  exportNode: ExportNode,
  exportIndex: Map<string, Map<string, ExportNode>>,
  knownFiles: Set<string>,
  visited: Set<string> = new Set(),
  maxDepth: number = 10
): ExportNode | null {
  // Safety: max depth exceeded
  if (maxDepth <= 0) {
    return null;
  }

  // Cycle detection
  if (visited.has(exportNode.id)) {
    return null;
  }
  visited.add(exportNode.id);

  // Base case: not a re-export
  if (!exportNode.source) {
    return exportNode;
  }

  // Recursive case: follow re-export
  const currentDir = dirname(exportNode.file!);
  const targetFile = this.resolveModulePath(currentDir, exportNode.source, knownFiles);

  if (!targetFile) {
    return null; // Source file not found
  }

  const targetExports = exportIndex.get(targetFile);
  if (!targetExports) {
    return null; // No exports in target file
  }

  // Find matching export by name
  // Re-export: export { foo } from './other' - look for named:foo
  // Re-export default: export { default } from './other' - look for default
  const exportKey = exportNode.exportType === 'default'
    ? 'default'
    : `named:${exportNode.local || exportNode.name}`;

  const nextExport = targetExports.get(exportKey);
  if (!nextExport) {
    return null; // Export not found in target
  }

  return this.resolveExportChain(
    nextExport,
    exportIndex,
    knownFiles,
    visited,
    maxDepth - 1
  );
}
```

### Phase 4: Modify Skip Counters

**Location:** Lines 109-116 (skipped object).

**Change:**

```typescript
// Before
const skipped = {
  alreadyResolved: 0,
  methodCalls: 0,
  external: 0,
  missingImport: 0,
  missingImportsFrom: 0,
  reExports: 0
};

// After
const skipped = {
  alreadyResolved: 0,
  methodCalls: 0,
  external: 0,
  missingImport: 0,
  missingImportsFrom: 0,
  reExportsBroken: 0,    // Re-export chain broken (missing export, file not found)
  reExportsCircular: 0   // Circular re-export detected
};

let reExportsResolved = 0; // Counter for successfully resolved re-export chains
```

### Phase 5: Build Known Files Set

**Location:** After export index building, before resolution loop.

**New TypeScript:**

```typescript
// Step 2.6: Build set of known files for path resolution
const knownFiles = new Set<string>();
for (const file of exportIndex.keys()) {
  knownFiles.add(file);
}
for (const file of functionIndex.keys()) {
  knownFiles.add(file);
}
logger.debug('Indexed known files', { count: knownFiles.size });
```

### Phase 6: Replace Skip Logic with Chain Resolution

**Location:** Lines 148-165 (the main resolution block).

**Replace:**

```typescript
// BEFORE (lines 148-165):
// Step 4.3: Handle re-exports (EXPORT with source field)
// For v1: skip complex re-exports
if (exportNode.source) {
  skipped.reExports++;
  continue;
}

// Step 4.4: Find target FUNCTION via EXPORT.local
const targetFile = exportNode.file;
const targetFunctionName = exportNode.local || exportNode.name;
```

**With:**

```typescript
// Step 4.3: Resolve re-export chain (if applicable)
let finalExport = exportNode;

if (exportNode.source) {
  // This is a re-export - follow the chain
  const resolved = this.resolveExportChain(
    exportNode,
    exportIndex,
    knownFiles
  );

  if (!resolved) {
    // Chain broken or circular
    // Distinguish: if visited set would show cycle, it's circular
    // For simplicity, count as broken (can add nuance later)
    skipped.reExportsBroken++;
    continue;
  }

  finalExport = resolved;
  reExportsResolved++;
}

// Step 4.4: Find target FUNCTION via final export's local name
const targetFile = finalExport.file;
const targetFunctionName = finalExport.local || finalExport.name;
```

### Phase 7: Update Result Metadata

**Location:** Lines 184-192 (return statement).

**Change:**

```typescript
// Before
return createSuccessResult(
  { nodes: 0, edges: edgesCreated },
  {
    callSitesProcessed: callSitesToResolve.length,
    edgesCreated,
    skipped,
    timeMs: Date.now() - startTime
  }
);

// After
return createSuccessResult(
  { nodes: 0, edges: edgesCreated },
  {
    callSitesProcessed: callSitesToResolve.length,
    edgesCreated,
    reExportsResolved,
    skipped,
    timeMs: Date.now() - startTime
  }
);
```

## Test Specifications

### Test File: `test/unit/FunctionCallResolver.test.js`

Add new test cases in a new describe block after "Re-exports (skip for v1)" section (line 637).

#### Test 1: Single-Hop Re-export Resolution

**Graph setup:**
```
/project/other.js:
  FUNCTION(id: 'other-foo-func', name: 'foo')
  EXPORT(id: 'other-export-foo', name: 'foo', exportType: 'named', local: 'foo')

/project/index.js:
  EXPORT(id: 'index-reexport-foo', name: 'foo', exportType: 'named',
         local: 'foo', source: './other')  <-- RE-EXPORT

/project/main.js:
  IMPORT(id: 'main-import-foo', name: 'foo', source: './index',
         importType: 'named', imported: 'foo', local: 'foo')
  CALL(id: 'main-call-foo', name: 'foo')

Pre-existing edges:
  main-import-foo -> IMPORTS_FROM -> index-reexport-foo
```

**Expected result:**
- CALLS edge: `main-call-foo` -> `other-foo-func`
- `result.metadata.reExportsResolved` should be 1

**Test code:**

```javascript
describe('Re-export chain resolution', () => {
  it('should resolve single-hop re-export chain', async () => {
    const { backend } = await setupBackend();

    try {
      const resolver = new FunctionCallResolver();

      await backend.addNodes([
        // Function in other.js
        {
          id: 'other-foo-func',
          type: 'FUNCTION',
          name: 'foo',
          file: '/project/other.js',
          line: 1
        },
        // Export in other.js (local export)
        {
          id: 'other-export-foo',
          type: 'EXPORT',
          name: 'foo',
          file: '/project/other.js',
          line: 1,
          exportType: 'named',
          local: 'foo'
        },
        // Re-export in index.js (barrel file)
        {
          id: 'index-reexport-foo',
          type: 'EXPORT',
          name: 'foo',
          file: '/project/index.js',
          line: 1,
          exportType: 'named',
          local: 'foo',
          source: './other'  // <-- Re-export indicator
        },
        // Import in main.js
        {
          id: 'main-import-foo',
          type: 'IMPORT',
          name: 'foo',
          file: '/project/main.js',
          line: 1,
          source: './index',
          importType: 'named',
          imported: 'foo',
          local: 'foo'
        },
        // Call in main.js
        {
          id: 'main-call-foo',
          type: 'CALL',
          name: 'foo',
          file: '/project/main.js',
          line: 3
        }
      ]);

      // Pre-existing edge from ImportExportLinker
      await backend.addEdge({
        type: 'IMPORTS_FROM',
        src: 'main-import-foo',
        dst: 'index-reexport-foo'
      });

      await backend.flush();

      const result = await resolver.execute({ graph: backend });

      // Should create CALLS edge through re-export chain
      const edges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
      assert.strictEqual(edges.length, 1, 'Should create one CALLS edge');
      assert.strictEqual(edges[0].dst, 'other-foo-func',
        'Should resolve through re-export to actual function');

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.created.edges, 1);
      assert.strictEqual(result.metadata.reExportsResolved, 1,
        'Should report 1 re-export resolved');

      console.log('Single-hop re-export chain resolution works');
    } finally {
      await backend.close();
    }
  });
});
```

#### Test 2: Multi-Hop Re-export Chain (2 hops)

**Graph setup:**
```
/project/impl.js:
  FUNCTION(name: 'helper')
  EXPORT(name: 'helper', local: 'helper')

/project/internal.js:
  EXPORT(name: 'helper', local: 'helper', source: './impl')

/project/index.js:
  EXPORT(name: 'helper', local: 'helper', source: './internal')

/project/app.js:
  IMPORT(name: 'helper', source: './index')
  CALL(name: 'helper')
```

**Expected:** CALLS edge from CALL to FUNCTION in impl.js

**Test code:**

```javascript
it('should resolve multi-hop re-export chain (2 hops)', async () => {
  const { backend } = await setupBackend();

  try {
    const resolver = new FunctionCallResolver();

    await backend.addNodes([
      // Actual function in impl.js
      {
        id: 'impl-helper-func',
        type: 'FUNCTION',
        name: 'helper',
        file: '/project/impl.js',
        line: 1
      },
      // Export in impl.js
      {
        id: 'impl-export-helper',
        type: 'EXPORT',
        name: 'helper',
        file: '/project/impl.js',
        exportType: 'named',
        local: 'helper'
      },
      // Re-export in internal.js (hop 1)
      {
        id: 'internal-reexport-helper',
        type: 'EXPORT',
        name: 'helper',
        file: '/project/internal.js',
        exportType: 'named',
        local: 'helper',
        source: './impl'
      },
      // Re-export in index.js (hop 2)
      {
        id: 'index-reexport-helper',
        type: 'EXPORT',
        name: 'helper',
        file: '/project/index.js',
        exportType: 'named',
        local: 'helper',
        source: './internal'
      },
      // Import in app.js
      {
        id: 'app-import-helper',
        type: 'IMPORT',
        name: 'helper',
        file: '/project/app.js',
        source: './index',
        importType: 'named',
        imported: 'helper',
        local: 'helper'
      },
      // Call in app.js
      {
        id: 'app-call-helper',
        type: 'CALL',
        name: 'helper',
        file: '/project/app.js',
        line: 3
      }
    ]);

    await backend.addEdge({
      type: 'IMPORTS_FROM',
      src: 'app-import-helper',
      dst: 'index-reexport-helper'
    });

    await backend.flush();

    const result = await resolver.execute({ graph: backend });

    const edges = await backend.getOutgoingEdges('app-call-helper', ['CALLS']);
    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0].dst, 'impl-helper-func',
      'Should resolve through 2-hop re-export chain');

    console.log('Multi-hop re-export chain (2 hops) resolution works');
  } finally {
    await backend.close();
  }
});
```

#### Test 3: Circular Re-export Detection

**Graph setup:**
```
/project/a.js:
  EXPORT(name: 'foo', source: './b')  <-- Points to b.js

/project/b.js:
  EXPORT(name: 'foo', source: './a')  <-- Points back to a.js (CIRCULAR!)

/project/main.js:
  IMPORT(name: 'foo', source: './a')
  CALL(name: 'foo')
```

**Expected:** No CALLS edge created, graceful handling (no crash)

**Test code:**

```javascript
it('should handle circular re-export chains gracefully', async () => {
  const { backend } = await setupBackend();

  try {
    const resolver = new FunctionCallResolver();

    await backend.addNodes([
      // Circular re-export: a.js -> b.js -> a.js
      {
        id: 'a-reexport-foo',
        type: 'EXPORT',
        name: 'foo',
        file: '/project/a.js',
        exportType: 'named',
        local: 'foo',
        source: './b'
      },
      {
        id: 'b-reexport-foo',
        type: 'EXPORT',
        name: 'foo',
        file: '/project/b.js',
        exportType: 'named',
        local: 'foo',
        source: './a'
      },
      // Import and call
      {
        id: 'main-import-foo',
        type: 'IMPORT',
        name: 'foo',
        file: '/project/main.js',
        source: './a',
        importType: 'named',
        imported: 'foo',
        local: 'foo'
      },
      {
        id: 'main-call-foo',
        type: 'CALL',
        name: 'foo',
        file: '/project/main.js',
        line: 3
      }
    ]);

    await backend.addEdge({
      type: 'IMPORTS_FROM',
      src: 'main-import-foo',
      dst: 'a-reexport-foo'
    });

    await backend.flush();

    // Should not crash
    const result = await resolver.execute({ graph: backend });

    assert.strictEqual(result.success, true, 'Should succeed without crashing');

    // No edge should be created
    const edges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
    assert.strictEqual(edges.length, 0, 'Should not create edge for circular re-export');

    // Should report as broken/circular
    assert.ok(
      result.metadata.skipped.reExportsBroken > 0 ||
      result.metadata.skipped.reExportsCircular > 0,
      'Should report circular/broken chain in skipped counters'
    );

    console.log('Circular re-export chain handled gracefully');
  } finally {
    await backend.close();
  }
});
```

#### Test 4: Broken Chain (Missing Export in Chain)

**Graph setup:**
```
/project/other.js:
  (NO EXPORT for 'foo')  <-- Missing!

/project/index.js:
  EXPORT(name: 'foo', source: './other')

/project/main.js:
  IMPORT(name: 'foo', source: './index')
  CALL(name: 'foo')
```

**Expected:** No CALLS edge created (broken chain)

**Test code:**

```javascript
it('should handle broken re-export chain (missing export)', async () => {
  const { backend } = await setupBackend();

  try {
    const resolver = new FunctionCallResolver();

    await backend.addNodes([
      // Re-export in index.js pointing to missing export
      {
        id: 'index-reexport-foo',
        type: 'EXPORT',
        name: 'foo',
        file: '/project/index.js',
        exportType: 'named',
        local: 'foo',
        source: './other'  // other.js has no 'foo' export
      },
      // Need a placeholder for other.js to exist in knownFiles
      // But it won't have the 'foo' export
      {
        id: 'other-bar-export',
        type: 'EXPORT',
        name: 'bar',
        file: '/project/other.js',
        exportType: 'named',
        local: 'bar'
        // Note: No 'foo' export here!
      },
      // Import and call
      {
        id: 'main-import-foo',
        type: 'IMPORT',
        name: 'foo',
        file: '/project/main.js',
        source: './index',
        importType: 'named',
        imported: 'foo',
        local: 'foo'
      },
      {
        id: 'main-call-foo',
        type: 'CALL',
        name: 'foo',
        file: '/project/main.js',
        line: 3
      }
    ]);

    await backend.addEdge({
      type: 'IMPORTS_FROM',
      src: 'main-import-foo',
      dst: 'index-reexport-foo'
    });

    await backend.flush();

    const result = await resolver.execute({ graph: backend });

    assert.strictEqual(result.success, true, 'Should succeed without crashing');

    const edges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
    assert.strictEqual(edges.length, 0, 'Should not create edge for broken chain');

    assert.ok(result.metadata.skipped.reExportsBroken > 0,
      'Should report broken chain in skipped counters');

    console.log('Broken re-export chain handled gracefully');
  } finally {
    await backend.close();
  }
});
```

#### Test 5: Default Re-export

**Graph setup:**
```
/project/utils.js:
  FUNCTION(name: 'formatDate')
  EXPORT(name: 'default', exportType: 'default', local: 'formatDate')

/project/index.js:
  EXPORT(name: 'default', exportType: 'default', local: 'default', source: './utils')

/project/main.js:
  IMPORT(name: 'fmt', importType: 'default', source: './index')
  CALL(name: 'fmt')
```

**Expected:** CALLS edge from CALL to FUNCTION

**Test code:**

```javascript
it('should resolve default re-export chain', async () => {
  const { backend } = await setupBackend();

  try {
    const resolver = new FunctionCallResolver();

    await backend.addNodes([
      // Function in utils.js
      {
        id: 'utils-formatDate-func',
        type: 'FUNCTION',
        name: 'formatDate',
        file: '/project/utils.js',
        line: 1
      },
      // Default export in utils.js
      {
        id: 'utils-export-default',
        type: 'EXPORT',
        name: 'default',
        file: '/project/utils.js',
        exportType: 'default',
        local: 'formatDate'
      },
      // Re-export default in index.js
      {
        id: 'index-reexport-default',
        type: 'EXPORT',
        name: 'default',
        file: '/project/index.js',
        exportType: 'default',
        local: 'default',
        source: './utils'
      },
      // Import default in main.js as 'fmt'
      {
        id: 'main-import-fmt',
        type: 'IMPORT',
        name: 'fmt',
        file: '/project/main.js',
        source: './index',
        importType: 'default',
        imported: 'default',
        local: 'fmt'
      },
      // Call fmt()
      {
        id: 'main-call-fmt',
        type: 'CALL',
        name: 'fmt',
        file: '/project/main.js',
        line: 3
      }
    ]);

    await backend.addEdge({
      type: 'IMPORTS_FROM',
      src: 'main-import-fmt',
      dst: 'index-reexport-default'
    });

    await backend.flush();

    const result = await resolver.execute({ graph: backend });

    const edges = await backend.getOutgoingEdges('main-call-fmt', ['CALLS']);
    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0].dst, 'utils-formatDate-func',
      'Should resolve default re-export to actual function');

    console.log('Default re-export chain resolution works');
  } finally {
    await backend.close();
  }
});
```

#### Test 6: Existing Non-Re-export Tests Still Pass

No new test needed - existing tests in the file should continue to pass. Rob should verify this during implementation.

## Implementation Order

1. **Kent Beck** writes tests first:
   - Add all 5 new test cases to `test/unit/FunctionCallResolver.test.js`
   - Verify tests fail (no implementation yet)
   - Commit: `test(REG-232): Add re-export chain resolution tests`

2. **Rob Pike** implements in this order:
   a. Add `import { dirname, resolve } from 'path';` at file top
   b. Add export index building (Phase 1)
   c. Add known files set building (Phase 5)
   d. Add `resolveModulePath()` method (Phase 2)
   e. Add `resolveExportChain()` method (Phase 3)
   f. Update skip counters (Phase 4)
   g. Replace skip logic with chain resolution (Phase 6)
   h. Update result metadata (Phase 7)
   i. Run tests, verify all pass
   j. Commit: `feat(REG-232): Add re-export chain resolution to FunctionCallResolver`

3. **Verification:**
   - All new tests pass
   - All existing tests pass
   - Manual test on real barrel file scenario

## Edge Cases and Constraints

### Chain Depth Limit
- Default: 10 hops
- Rationale: Real-world barrel files rarely exceed 2-3 hops
- Safety net against pathological cases

### Extension Resolution Order
- `['', '.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts']`
- Same order as ImportExportLinker for consistency

### Performance Considerations
- Export index: O(n) build once, O(1) lookups
- Chain resolution: O(k) where k = chain length (typically 1-3)
- Total complexity: O(n) for index + O(m*k) for m calls with chains
- Acceptable for typical codebases

### Type Re-exports
- `export type { Foo } from './types';`
- These won't have CALL nodes (you don't call types)
- No special handling needed

### Star Re-exports
- `export * from './utils';`
- These have `exportType: 'all'`
- Current implementation won't resolve these (different pattern)
- Future enhancement (out of scope for REG-232)

## Success Criteria

1. Test: Single-hop re-export resolves correctly
2. Test: Multi-hop (2+) re-export chain resolves correctly
3. Test: Circular re-exports detected and skipped gracefully
4. Test: Broken chains (missing export) skipped gracefully
5. Test: Default re-exports work
6. Test: All existing tests continue to pass
7. Logging: Clear indication of resolved vs broken chains in output
8. Performance: No significant degradation on typical codebases
