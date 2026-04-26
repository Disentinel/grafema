# REG-225: Joel Spolsky - Technical Specification

## Summary

FunctionCallResolver is an enrichment plugin that resolves CALLS edges for imported function calls. When code imports a function from another file and calls it, this plugin creates the missing CALLS edge from CALL_SITE to the target FUNCTION.

---

## 1. File Structure

### Files to Create

```
packages/core/src/plugins/enrichment/FunctionCallResolver.ts   # Main plugin
test/unit/FunctionCallResolver.test.js                          # Unit tests
```

### Files to Modify

```
packages/core/src/index.ts                                      # Export plugin
packages/cli/src/commands/analyze.ts                            # Register in BUILTIN_PLUGINS
```

---

## 2. Class Design

### FunctionCallResolver.ts

```typescript
/**
 * FunctionCallResolver - creates CALLS edges for imported function calls
 *
 * This enrichment plugin runs AFTER ImportExportLinker (priority 80 vs 90) and:
 * 1. Finds CALL_SITE nodes without CALLS edges (excluding method calls)
 * 2. For each, looks for IMPORT with matching local name in same file
 * 3. Follows IMPORTS_FROM -> EXPORT -> FUNCTION chain
 * 4. Creates CALLS edge to target FUNCTION
 *
 * CREATES EDGES:
 * - CALL_SITE -> CALLS -> FUNCTION (for imported functions)
 */

import { dirname, resolve } from 'path';
import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';

// === INTERFACES ===

interface CallNode extends BaseNodeRecord {
  name?: string;
  object?: string;     // If present, this is a method call - skip
}

interface ImportNode extends BaseNodeRecord {
  source?: string;
  importType?: string;  // 'default' | 'named' | 'namespace'
  imported?: string;    // Original name in source file
  local?: string;       // Local binding name
}

interface ExportNode extends BaseNodeRecord {
  exportType?: string;  // 'default' | 'named' | 'all'
  local?: string;       // Local name in exporting file
  source?: string;      // Re-export source (if re-exporting)
}

interface FunctionNode extends BaseNodeRecord {
  name?: string;
}

// === PLUGIN CLASS ===

export class FunctionCallResolver extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'FunctionCallResolver',
      phase: 'ENRICHMENT',
      priority: 80,  // After ImportExportLinker (90)
      creates: {
        nodes: [],
        edges: ['CALLS']
      },
      dependencies: ['ImportExportLinker']  // Requires IMPORTS_FROM edges
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    // Implementation details below
  }
}
```

---

## 3. Algorithm Steps

### Phase 1: Build Indices

```typescript
// 1. Import Index: Map<fileAndLocalName, ImportNode>
//    Key: `${file}:${local}`
//    For quick lookup: "does this file have an import named X?"
const importIndex = new Map<string, ImportNode>();
for await (const node of graph.queryNodes({ nodeType: 'IMPORT' })) {
  const imp = node as ImportNode;
  if (!imp.file || !imp.local) continue;

  // Skip external imports (non-relative)
  const isRelative = imp.source && (imp.source.startsWith('./') || imp.source.startsWith('../'));
  if (!isRelative) continue;

  const key = `${imp.file}:${imp.local}`;
  importIndex.set(key, imp);
}

// 2. Function Index: Map<file, Map<name, FunctionNode>>
//    For looking up function definitions by name in a specific file
const functionIndex = new Map<string, Map<string, FunctionNode>>();
for await (const node of graph.queryNodes({ nodeType: 'FUNCTION' })) {
  const func = node as FunctionNode;
  if (!func.file || !func.name) continue;

  if (!functionIndex.has(func.file)) {
    functionIndex.set(func.file, new Map());
  }
  functionIndex.get(func.file)!.set(func.name, func);
}
```

### Phase 2: Collect Unresolved CALL_SITE Nodes

```typescript
// Collect CALL nodes that:
// 1. Have no 'object' attribute (not method calls)
// 2. Have no existing CALLS edge
const callSitesToResolve: CallNode[] = [];

for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
  const call = node as CallNode;

  // Skip method calls (have object attribute)
  if (call.object) continue;

  // Skip if already has CALLS edge
  const existingEdges = await graph.getOutgoingEdges(call.id, ['CALLS']);
  if (existingEdges.length > 0) continue;

  callSitesToResolve.push(call);
}
```

### Phase 3: Resolution Algorithm

```typescript
for (const callSite of callSitesToResolve) {
  const calledName = callSite.name;  // e.g., "formatDate"
  const file = callSite.file;

  if (!calledName || !file) continue;

  // Step 1: Find matching import in same file
  const importKey = `${file}:${calledName}`;
  const imp = importIndex.get(importKey);

  if (!imp) continue;  // Not an imported function call

  // Step 2: Follow IMPORTS_FROM edge to find EXPORT
  const importsFromEdges = await graph.getOutgoingEdges(imp.id, ['IMPORTS_FROM']);
  if (importsFromEdges.length === 0) continue;  // ImportExportLinker didn't create edge

  const exportNodeId = importsFromEdges[0].dst;
  const exportNode = await graph.getNode(exportNodeId) as ExportNode | null;

  if (!exportNode) continue;

  // Step 3: Handle re-exports (EXPORT with source field)
  // For v1: single hop only. If exportNode.source exists, skip complex re-exports
  if (exportNode.source) {
    // TODO: Deep re-export resolution in future task
    continue;
  }

  // Step 4: Find target FUNCTION via EXPORT.local
  const targetFile = exportNode.file;
  const targetFunctionName = exportNode.local || exportNode.name;

  if (!targetFile || !targetFunctionName) continue;

  const fileFunctions = functionIndex.get(targetFile);
  if (!fileFunctions) continue;

  const targetFunction = fileFunctions.get(targetFunctionName);
  if (!targetFunction) continue;

  // Step 5: Create CALLS edge
  await graph.addEdge({
    type: 'CALLS',
    src: callSite.id,
    dst: targetFunction.id
  });

  edgesCreated++;
}
```

### Default Import Special Case

```typescript
// For default imports, the IMPORT node has:
// - importType: 'default'
// - local: the local binding name (e.g., 'formatDate')
// - imported: 'default'
//
// The EXPORT node has:
// - exportType: 'default'
// - local: the actual function name in the file (e.g., 'formatDate')
//
// The resolution works the same because we use EXPORT.local
// to find the FUNCTION in the source file.
```

### Namespace Import Special Case

```typescript
// Namespace imports: import * as utils from './utils'; utils.foo();
//
// These create CALL nodes with:
// - object: 'utils' (the namespace)
// - method: 'foo'
//
// Since they have 'object' attribute, they're METHOD_CALLS.
// FunctionCallResolver SKIPS these - leave to MethodCallResolver
// (or create a separate NamespaceCallResolver in the future).
```

---

## 4. Test Plan

### Test File: `test/unit/FunctionCallResolver.test.js`

Follow the pattern from `test/unit/MethodCallResolver.test.js`:
- Use `RFDBServerBackend` with temp directory
- Create nodes and edges manually
- Execute plugin
- Assert edges created

### Test Cases

#### 4.1 Named Imports

**Scenario**: `import { foo } from './utils'; foo();`

```javascript
it('should resolve named import function call', async () => {
  // Setup: utils.js exports foo, main.js imports and calls it

  // Nodes:
  // - FUNCTION(id='utils-foo', name='foo', file='utils.js')
  // - EXPORT(id='utils-export-foo', name='foo', local='foo', file='utils.js', exportType='named')
  // - IMPORT(id='main-import-foo', name='foo', local='foo', imported='foo', file='main.js', source='./utils')
  // - CALL(id='main-call-foo', name='foo', file='main.js') -- NO object!

  // Pre-existing edge (from ImportExportLinker):
  // - IMPORT -> IMPORTS_FROM -> EXPORT

  // Run FunctionCallResolver
  const result = await resolver.execute({ graph: backend });

  // Assert: CALLS edge created
  const edges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].dst, 'utils-foo');
});
```

#### 4.2 Default Imports

**Scenario**: `import foo from './utils'; foo();`

```javascript
it('should resolve default import function call', async () => {
  // Setup: utils.js has default export, main.js imports and calls it

  // Nodes:
  // - FUNCTION(id='utils-foo', name='formatDate', file='utils.js')
  // - EXPORT(id='utils-export-default', name='default', local='formatDate', file='utils.js', exportType='default')
  // - IMPORT(id='main-import-fmt', name='fmt', local='fmt', imported='default', file='main.js', source='./utils', importType='default')
  // - CALL(id='main-call-fmt', name='fmt', file='main.js')

  // Pre-existing edge:
  // - IMPORT -> IMPORTS_FROM -> EXPORT

  // Run and assert
  const result = await resolver.execute({ graph: backend });
  const edges = await backend.getOutgoingEdges('main-call-fmt', ['CALLS']);
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].dst, 'utils-foo');
});
```

#### 4.3 Namespace Imports (Skip Case)

**Scenario**: `import * as utils from './utils'; utils.foo();`

```javascript
it('should skip namespace import method calls', async () => {
  // Setup: namespace import with method call

  // Nodes:
  // - CALL(id='main-call-utils-foo', name='utils.foo', object='utils', method='foo', file='main.js')

  // Run and assert: NO CALLS edge (has object attribute = method call)
  const result = await resolver.execute({ graph: backend });
  const edges = await backend.getOutgoingEdges('main-call-utils-foo', ['CALLS']);
  assert.strictEqual(edges.length, 0);
});
```

#### 4.4 Already Resolved (Skip Case)

```javascript
it('should not create duplicate CALLS edges', async () => {
  // Setup: CALL already has CALLS edge

  // Pre-create CALLS edge
  await backend.addEdge({ type: 'CALLS', src: 'main-call-foo', dst: 'utils-foo' });

  // Run
  const result = await resolver.execute({ graph: backend });

  // Assert: still only one edge
  const edges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(result.created.edges, 0);
});
```

#### 4.5 External Imports (Skip Case)

```javascript
it('should skip external module imports', async () => {
  // Setup: import from node_modules

  // Nodes:
  // - IMPORT(source='lodash', local='_', file='main.js')  // Non-relative!
  // - CALL(name='_', file='main.js')

  // Run and assert: NO edge created (external import)
  const result = await resolver.execute({ graph: backend });
  const edges = await backend.getOutgoingEdges('main-call-lodash', ['CALLS']);
  assert.strictEqual(edges.length, 0);
});
```

#### 4.6 Missing IMPORTS_FROM Edge (Skip Case)

```javascript
it('should handle missing IMPORTS_FROM edge gracefully', async () => {
  // Setup: IMPORT exists but no IMPORTS_FROM edge (file not analyzed)

  // Run and assert: no crash, no edge
  const result = await resolver.execute({ graph: backend });
  assert.strictEqual(result.success, true);
});
```

#### 4.7 Re-exports (v1: Skip Complex Cases)

```javascript
it('should skip re-export chains for v1', async () => {
  // Setup: export { foo } from './other';

  // EXPORT node has 'source' field pointing to './other'
  // For v1, we skip these complex cases

  // Run and assert: no edge (re-export skipped)
  const result = await resolver.execute({ graph: backend });
  // Log warning about skipped re-exports
});
```

#### 4.8 Aliased Named Import

**Scenario**: `import { foo as bar } from './utils'; bar();`

```javascript
it('should resolve aliased named import', async () => {
  // Nodes:
  // - FUNCTION(name='foo', file='utils.js')
  // - EXPORT(name='foo', local='foo', file='utils.js')
  // - IMPORT(name='bar', local='bar', imported='foo', file='main.js')  // Note: local=bar, imported=foo
  // - CALL(name='bar', file='main.js')

  // Key: IMPORT.local matches CALL.name, IMPORT.imported matches EXPORT.name
  // IMPORTS_FROM edge connects them correctly

  // Run and assert
  const result = await resolver.execute({ graph: backend });
  const edges = await backend.getOutgoingEdges('main-call-bar', ['CALLS']);
  assert.strictEqual(edges.length, 1);
});
```

---

## 5. Integration

### 5.1 Export from `packages/core/src/index.ts`

Add after line 191 (after ImportExportLinker):

```typescript
export { FunctionCallResolver } from './plugins/enrichment/FunctionCallResolver.js';
```

### 5.2 Register in CLI `packages/cli/src/commands/analyze.ts`

Add to imports (around line 41):

```typescript
  FunctionCallResolver,
```

Add to BUILTIN_PLUGINS (around line 79):

```typescript
  FunctionCallResolver: () => new FunctionCallResolver() as Plugin,
```

### 5.3 Plugin Execution Order

Plugins run in priority order within ENRICHMENT phase:
1. ImportExportLinker (priority 90) - creates IMPORTS_FROM edges
2. **FunctionCallResolver (priority 80)** - uses IMPORTS_FROM to create CALLS
3. MethodCallResolver (priority 50) - creates CALLS for method calls
4. Other enrichment plugins...

---

## 6. Performance Requirements

- **Target**: <100ms for 1000 imports on typical codebase
- **Strategy**: Build indices once (O(n)), then O(1) lookups per call site
- **Avoid**: O(n) array.find() in hot paths
- **Memory**: Maps for import/function indices are transient (not stored in graph)

---

## 7. Logging

Follow established pattern from ImportExportLinker:

```typescript
const logger = this.log(context);

logger.info('Starting function call resolution');
logger.debug('Indexed imports', { count: importIndex.size });
logger.debug('Indexed functions', { files: functionIndex.size });
logger.info('Found call sites to resolve', { count: callSitesToResolve.length });
logger.info('Complete', {
  edgesCreated,
  skipped: { alreadyResolved, methodCalls, external, reExports },
  timeMs: Date.now() - startTime
});
```

---

## 8. Return Value

```typescript
return createSuccessResult(
  { nodes: 0, edges: edgesCreated },
  {
    callSitesProcessed: totalProcessed,
    edgesCreated,
    skipped: {
      alreadyResolved,
      methodCalls,
      external,
      missingImport,
      missingImportsFrom,
      reExports
    },
    timeMs: Date.now() - startTime
  }
);
```

---

## 9. Out of Scope (Document for Future)

1. **Re-export chains**: `export { foo } from './other'` - needs recursive resolution
2. **Namespace imports**: `import * as utils from './utils'; utils.foo()` - leave to MethodCallResolver or create NamespaceCallResolver
3. **CommonJS**: `const foo = require('./utils')` - different import model
4. **Dynamic imports**: `const { foo } = await import('./utils')` - runtime resolution

---

## 10. Checklist for Kent (Tests First)

- [ ] Create test file structure matching MethodCallResolver.test.js pattern
- [ ] Test: Named import resolution
- [ ] Test: Default import resolution
- [ ] Test: Aliased import resolution
- [ ] Test: Skip method calls (has object attribute)
- [ ] Test: Skip already resolved calls
- [ ] Test: Skip external imports
- [ ] Test: Handle missing IMPORTS_FROM gracefully
- [ ] Test: Skip re-exports for v1

## 11. Checklist for Rob (Implementation)

- [ ] Create FunctionCallResolver class matching Plugin pattern
- [ ] Implement metadata getter (priority 80, phase ENRICHMENT)
- [ ] Build import index (Map<file:local, ImportNode>)
- [ ] Build function index (Map<file, Map<name, FunctionNode>>)
- [ ] Collect unresolved CALL_SITE nodes
- [ ] Implement resolution algorithm
- [ ] Add logging at each step
- [ ] Return proper result with counts
- [ ] Export from index.ts
- [ ] Register in CLI BUILTIN_PLUGINS
