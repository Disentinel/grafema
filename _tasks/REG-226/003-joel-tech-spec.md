# REG-226: ExternalCallResolver - Joel Spolsky Technical Specification

## Overview

This document provides detailed implementation specifications for the ExternalCallResolver enrichment plugin. The plugin handles CALL nodes that were not resolved by FunctionCallResolver, categorizing them as:
1. External package calls (lodash, react, etc.)
2. JavaScript built-in calls (parseInt, setTimeout)
3. Truly unresolved calls (dynamic, aliased, unknown)

## File Structure

```
packages/core/src/plugins/enrichment/ExternalCallResolver.ts  (NEW)
test/unit/ExternalCallResolver.test.js                        (NEW)
```

---

## 1. Implementation Details: ExternalCallResolver.ts

### 1.1 File Header and Imports

```typescript
/**
 * ExternalCallResolver - handles unresolved CALL nodes after FunctionCallResolver
 *
 * This enrichment plugin runs AFTER FunctionCallResolver (priority 70 vs 80) and:
 * 1. Finds CALL nodes without CALLS edges (excluding method calls)
 * 2. For each, checks if it's an external package import -> creates CALLS edge to EXTERNAL_MODULE
 * 3. If it's a JavaScript built-in -> adds resolutionType='builtin' metadata
 * 4. Otherwise marks as unresolved with reason metadata
 *
 * CREATES:
 * - Nodes: EXTERNAL_MODULE (if not exists)
 * - Edges: CALLS (to EXTERNAL_MODULE)
 * - Metadata: resolutionType, unresolvedReason on CALL nodes
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';
import { ExternalModuleNode } from '../../core/nodes/ExternalModuleNode.js';
```

### 1.2 Type Definitions

```typescript
// === INTERFACES ===

interface CallNode extends BaseNodeRecord {
  object?: string;      // If present, this is a method call - skip
  callee?: string;      // Alternative name property
}

interface ImportNode extends BaseNodeRecord {
  source?: string;      // Module source (e.g., 'lodash', '@tanstack/react-query')
  importType?: string;  // 'default' | 'named' | 'namespace'
  imported?: string;    // Original name in source file
  local?: string;       // Local binding name (what we look up)
}

interface ImportInfo {
  source: string;          // Module source
  importType: string;      // Import type
  imported: string;        // Original exported name
  importNodeId: string;    // ID of IMPORT node (for future use)
}

type UnresolvedReason = 'dynamic' | 'alias' | 'unknown';

interface ResolutionStats {
  external: number;
  builtin: number;
  unresolved: {
    dynamic: number;
    alias: number;
    unknown: number;
  };
}
```

### 1.3 JavaScript Built-ins Set

```typescript
/**
 * JavaScript built-in global functions.
 *
 * These are intrinsic to the JS runtime and don't need CALLS edges:
 * - They're available in all JS environments (browser, Node.js, etc.)
 * - They're not "callable definitions" in the code sense
 * - Similar to how we don't create CALLS edges to operators (+, -, etc.)
 *
 * Note: `require` is included because it's a CommonJS global, similar to `eval`.
 * Node.js-specific builtins (fs.readFile, etc.) are handled by NodejsBuiltinsResolver.
 */
const JS_BUILTINS = new Set([
  // Global functions
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',

  // Timers (browser & Node.js - part of core JS runtime)
  'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',

  // CommonJS (special case - global in CommonJS environments)
  'require',

  // Constructors that are sometimes called as functions
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Symbol', 'BigInt',

  // Error constructors (can be called without new)
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',

  // Structured data
  'JSON', 'Date', 'RegExp', 'Promise',

  // Control abstractions
  'Function', 'GeneratorFunction', 'AsyncFunction',
]);
```

### 1.4 Class Structure

```typescript
export class ExternalCallResolver extends Plugin {

  get metadata(): PluginMetadata {
    return {
      name: 'ExternalCallResolver',
      phase: 'ENRICHMENT',
      priority: 70,  // After FunctionCallResolver (80), before MethodCallResolver (50)
      creates: {
        nodes: ['EXTERNAL_MODULE'],
        edges: ['CALLS']
      },
      dependencies: ['FunctionCallResolver']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult>;

  // Private methods (see Section 1.5)
  private async buildImportIndex(graph: PluginContext['graph']): Promise<Map<string, ImportInfo>>;
  private isJsBuiltin(name: string): boolean;
  private detectUnresolvedReason(callNode: CallNode): UnresolvedReason;
  private async getOrCreateExternalModule(
    graph: PluginContext['graph'],
    source: string,
    existingModules: Set<string>
  ): Promise<string>;
}
```

### 1.5 Method Implementations

#### 1.5.1 execute() - Main Entry Point

```typescript
async execute(context: PluginContext): Promise<PluginResult> {
  const { graph, onProgress } = context;
  const logger = this.log(context);

  logger.info('Starting external call resolution');
  const startTime = Date.now();

  // Step 1: Build Import Index - Map<file:localName, ImportInfo>
  // Only external imports (non-relative source)
  const importIndex = await this.buildImportIndex(graph);
  logger.debug('Indexed external imports', { count: importIndex.size });

  // Step 2: Build existing EXTERNAL_MODULE index for idempotency
  const existingModules = new Set<string>();
  for await (const node of graph.queryNodes({ nodeType: 'EXTERNAL_MODULE' })) {
    existingModules.add(node.id);
  }
  logger.debug('Found existing EXTERNAL_MODULE nodes', { count: existingModules.size });

  // Step 3: Collect unresolved CALL nodes
  const unresolvedCalls: CallNode[] = [];
  for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
    const call = node as CallNode;

    // Skip method calls (have object attribute)
    if (call.object) continue;

    // Skip if already has CALLS edge
    const existingEdges = await graph.getOutgoingEdges(call.id, ['CALLS']);
    if (existingEdges.length > 0) continue;

    unresolvedCalls.push(call);
  }
  logger.info('Found unresolved CALL nodes', { count: unresolvedCalls.length });

  // Step 4: Process each unresolved call
  let nodesCreated = 0;
  let edgesCreated = 0;
  const stats: ResolutionStats = {
    external: 0,
    builtin: 0,
    unresolved: { dynamic: 0, alias: 0, unknown: 0 }
  };

  let processed = 0;
  for (const callNode of unresolvedCalls) {
    processed++;

    // Progress reporting
    if (onProgress && processed % 100 === 0) {
      onProgress({
        phase: 'enrichment',
        currentPlugin: 'ExternalCallResolver',
        message: `Processing calls ${processed}/${unresolvedCalls.length}`,
        totalFiles: unresolvedCalls.length,
        processedFiles: processed
      });
    }

    const calledName = callNode.name as string || callNode.callee;
    const file = callNode.file;

    if (!calledName || !file) continue;

    // Step 4.1: Check if call matches an external import
    const importKey = `${file}:${calledName}`;
    const importInfo = importIndex.get(importKey);

    if (importInfo) {
      // External package call - create CALLS edge to EXTERNAL_MODULE
      const moduleNodeId = await this.getOrCreateExternalModule(
        graph,
        importInfo.source,
        existingModules
      );

      if (!existingModules.has(moduleNodeId)) {
        nodesCreated++;
        existingModules.add(moduleNodeId);
      }

      // Create CALLS edge with exportedName metadata
      await graph.addEdge({
        type: 'CALLS',
        src: callNode.id,
        dst: moduleNodeId,
        metadata: {
          exportedName: importInfo.imported || calledName
        }
      });
      edgesCreated++;

      // Update node metadata (if graph supports it)
      // Note: This may require graph.updateNode() - check capability
      stats.external++;
      continue;
    }

    // Step 4.2: Check if it's a JavaScript built-in
    if (this.isJsBuiltin(calledName)) {
      // Built-in - no CALLS edge needed, just metadata
      // Note: Metadata update may require graph.updateNode()
      stats.builtin++;
      continue;
    }

    // Step 4.3: Truly unresolved - detect reason
    const reason = this.detectUnresolvedReason(callNode);
    stats.unresolved[reason]++;
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
  logger.info('Complete', {
    nodesCreated,
    edgesCreated,
    stats,
    time: `${totalTime}s`
  });

  return createSuccessResult(
    { nodes: nodesCreated, edges: edgesCreated },
    {
      callsProcessed: unresolvedCalls.length,
      externalResolved: stats.external,
      builtinResolved: stats.builtin,
      unresolvedByReason: stats.unresolved,
      timeMs: Date.now() - startTime
    }
  );
}
```

#### 1.5.2 buildImportIndex() - External Import Index

```typescript
/**
 * Build index of EXTERNAL imports only (non-relative sources).
 *
 * Key format: `file:localName`
 *
 * Note: FunctionCallResolver already handles relative imports (./utils),
 * so we only index external packages (lodash, @tanstack/react-query).
 */
private async buildImportIndex(
  graph: PluginContext['graph']
): Promise<Map<string, ImportInfo>> {
  const index = new Map<string, ImportInfo>();

  for await (const node of graph.queryNodes({ nodeType: 'IMPORT' })) {
    const imp = node as ImportNode;
    if (!imp.file || !imp.source) continue;

    // Only external imports (non-relative)
    const isRelative = imp.source.startsWith('./') || imp.source.startsWith('../');
    if (isRelative) continue;

    const localName = imp.local || imp.name as string;
    if (!localName) continue;

    const key = `${imp.file}:${localName}`;

    index.set(key, {
      source: imp.source,
      importType: imp.importType || 'named',
      imported: imp.imported || localName,
      importNodeId: imp.id
    });
  }

  return index;
}
```

#### 1.5.3 isJsBuiltin() - Built-in Check

```typescript
/**
 * Check if a name is a JavaScript built-in global function.
 */
private isJsBuiltin(name: string): boolean {
  return JS_BUILTINS.has(name);
}
```

#### 1.5.4 detectUnresolvedReason() - Unresolved Reason Detection

```typescript
/**
 * Detect why a call is unresolved.
 *
 * Categories:
 * - 'dynamic': Callee appears to be computed/dynamic
 * - 'alias': Callee matches a variable name (potential alias)
 * - 'unknown': Cannot determine reason
 *
 * Note: This is best-effort heuristic. More accurate detection would
 * require integration with ValueDomainAnalyzer in the future.
 */
private detectUnresolvedReason(callNode: CallNode): UnresolvedReason {
  const name = callNode.name as string || callNode.callee || '';

  // Heuristic 1: Names with brackets or dots suggest dynamic access
  // e.g., arr[0], obj[key]
  if (name.includes('[') || name === '<computed>') {
    return 'dynamic';
  }

  // Heuristic 2: Single letter names often indicate aliased functions
  // e.g., const f = someFunc; f();
  // This is a weak heuristic but better than 'unknown'
  if (name.length === 1 && name !== '_') {
    return 'alias';
  }

  // Default: unknown reason
  return 'unknown';
}
```

#### 1.5.5 getOrCreateExternalModule() - Module Node Management

```typescript
/**
 * Get existing or create new EXTERNAL_MODULE node.
 *
 * Uses ExternalModuleNode.create() for consistent ID format and normalization.
 * Checks existingModules set first to avoid duplicate creation.
 */
private async getOrCreateExternalModule(
  graph: PluginContext['graph'],
  source: string,
  existingModules: Set<string>
): Promise<string> {
  // Use ExternalModuleNode for consistent ID format
  const nodeData = ExternalModuleNode.create(source);
  const nodeId = nodeData.id;

  // Check if already exists (either pre-existing or created this run)
  if (existingModules.has(nodeId)) {
    return nodeId;
  }

  // Check if exists in graph (might have been created by GraphBuilder/NodejsBuiltinsResolver)
  const existingNode = await graph.getNode(nodeId);
  if (existingNode) {
    existingModules.add(nodeId);
    return nodeId;
  }

  // Create new node
  await graph.addNode(nodeData);
  existingModules.add(nodeId);

  return nodeId;
}
```

---

## 2. Test File: test/unit/ExternalCallResolver.test.js

### 2.1 Test Structure

```javascript
/**
 * ExternalCallResolver Unit Tests (REG-226)
 *
 * Tests for the enrichment plugin that handles unresolved CALL nodes:
 * - External package calls -> CALLS edge to EXTERNAL_MODULE
 * - JavaScript built-ins -> metadata annotation, no edge
 * - Truly unresolved -> metadata with reason
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RFDBServerBackend, ExternalCallResolver } from '@grafema/core';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ExternalCallResolver', () => {
  let testCounter = 0;

  async function setupBackend() {
    const testDir = join(tmpdir(), `grafema-test-externalcall-${Date.now()}-${testCounter++}`);
    const backend = new RFDBServerBackend({ dbPath: join(testDir, 'test.db') });
    await backend.connect();
    return { backend, testDir };
  }

  // Test sections follow...
});
```

### 2.2 Test Cases - External Package Calls

```javascript
describe('External Package Calls', () => {
  it('should create CALLS edge to EXTERNAL_MODULE for lodash import', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      // Setup: import _ from 'lodash'; _();
      await backend.addNodes([
        {
          id: 'main-import-lodash',
          type: 'IMPORT',
          name: '_',
          file: '/project/main.js',
          line: 1,
          source: 'lodash',
          importType: 'default',
          imported: 'default',
          local: '_'
        },
        {
          id: 'main-call-lodash',
          type: 'CALL',
          name: '_',
          file: '/project/main.js',
          line: 3
          // No object = CALL_SITE
        }
      ]);

      await backend.flush();
      const result = await resolver.execute({ graph: backend });

      // Should create EXTERNAL_MODULE:lodash
      const extModule = await backend.getNode('EXTERNAL_MODULE:lodash');
      assert.ok(extModule, 'Should create EXTERNAL_MODULE:lodash');

      // Should create CALLS edge
      const edges = await backend.getOutgoingEdges('main-call-lodash', ['CALLS']);
      assert.strictEqual(edges.length, 1, 'Should create one CALLS edge');
      assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:lodash');

      // Verify metadata on edge
      assert.strictEqual(edges[0].metadata?.exportedName, 'default');

      assert.strictEqual(result.success, true);
      assert.ok(result.created.edges >= 1);
    } finally {
      await backend.close();
    }
  });

  it('should create CALLS edge for scoped package import (@tanstack/react-query)', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      // Setup: import { useQuery } from '@tanstack/react-query'; useQuery();
      await backend.addNodes([
        {
          id: 'main-import-usequery',
          type: 'IMPORT',
          name: 'useQuery',
          file: '/project/main.js',
          line: 1,
          source: '@tanstack/react-query',
          importType: 'named',
          imported: 'useQuery',
          local: 'useQuery'
        },
        {
          id: 'main-call-usequery',
          type: 'CALL',
          name: 'useQuery',
          file: '/project/main.js',
          line: 5
        }
      ]);

      await backend.flush();
      await resolver.execute({ graph: backend });

      // Check EXTERNAL_MODULE created
      const extModule = await backend.getNode('EXTERNAL_MODULE:@tanstack/react-query');
      assert.ok(extModule, 'Should create EXTERNAL_MODULE for scoped package');

      // Check CALLS edge
      const edges = await backend.getOutgoingEdges('main-call-usequery', ['CALLS']);
      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:@tanstack/react-query');
      assert.strictEqual(edges[0].metadata?.exportedName, 'useQuery');
    } finally {
      await backend.close();
    }
  });

  it('should NOT create duplicate EXTERNAL_MODULE nodes', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      // Two files importing from lodash
      await backend.addNodes([
        {
          id: 'file1-import-lodash',
          type: 'IMPORT',
          name: 'map',
          file: '/project/file1.js',
          source: 'lodash',
          importType: 'named',
          imported: 'map',
          local: 'map'
        },
        {
          id: 'file1-call-map',
          type: 'CALL',
          name: 'map',
          file: '/project/file1.js',
          line: 3
        },
        {
          id: 'file2-import-lodash',
          type: 'IMPORT',
          name: 'filter',
          file: '/project/file2.js',
          source: 'lodash',
          importType: 'named',
          imported: 'filter',
          local: 'filter'
        },
        {
          id: 'file2-call-filter',
          type: 'CALL',
          name: 'filter',
          file: '/project/file2.js',
          line: 3
        }
      ]);

      await backend.flush();
      await resolver.execute({ graph: backend });

      // Should have only ONE EXTERNAL_MODULE:lodash
      const allExternalModules = [];
      for await (const n of backend.queryNodes({ nodeType: 'EXTERNAL_MODULE' })) {
        if (n.name === 'lodash') allExternalModules.push(n);
      }
      assert.strictEqual(allExternalModules.length, 1, 'Should have exactly one lodash module');
    } finally {
      await backend.close();
    }
  });

  it('should reuse existing EXTERNAL_MODULE node', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      // Pre-create EXTERNAL_MODULE (e.g., by NodejsBuiltinsResolver)
      await backend.addNodes([
        {
          id: 'EXTERNAL_MODULE:react',
          type: 'EXTERNAL_MODULE',
          name: 'react',
          file: '',
          line: 0
        },
        {
          id: 'main-import-react',
          type: 'IMPORT',
          name: 'useState',
          file: '/project/main.js',
          source: 'react',
          importType: 'named',
          imported: 'useState',
          local: 'useState'
        },
        {
          id: 'main-call-usestate',
          type: 'CALL',
          name: 'useState',
          file: '/project/main.js',
          line: 5
        }
      ]);

      await backend.flush();
      const result = await resolver.execute({ graph: backend });

      // Should NOT create new node
      assert.strictEqual(result.created.nodes, 0, 'Should not create new EXTERNAL_MODULE');

      // Should still create CALLS edge
      const edges = await backend.getOutgoingEdges('main-call-usestate', ['CALLS']);
      assert.strictEqual(edges.length, 1);
      assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:react');
    } finally {
      await backend.close();
    }
  });
});
```

### 2.3 Test Cases - JavaScript Built-ins

```javascript
describe('JavaScript Built-ins', () => {
  it('should NOT create CALLS edge for parseInt (builtin)', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      await backend.addNodes([
        {
          id: 'main-call-parseint',
          type: 'CALL',
          name: 'parseInt',
          file: '/project/main.js',
          line: 5
        }
      ]);

      await backend.flush();
      const result = await resolver.execute({ graph: backend });

      // Should NOT create any edges
      const edges = await backend.getOutgoingEdges('main-call-parseint', ['CALLS']);
      assert.strictEqual(edges.length, 0, 'Should not create CALLS edge for builtin');

      // Verify in metadata
      assert.ok(result.metadata.builtinResolved >= 1);
    } finally {
      await backend.close();
    }
  });

  it('should NOT create CALLS edge for setTimeout', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      await backend.addNodes([
        {
          id: 'main-call-settimeout',
          type: 'CALL',
          name: 'setTimeout',
          file: '/project/main.js',
          line: 10
        }
      ]);

      await backend.flush();
      await resolver.execute({ graph: backend });

      const edges = await backend.getOutgoingEdges('main-call-settimeout', ['CALLS']);
      assert.strictEqual(edges.length, 0);
    } finally {
      await backend.close();
    }
  });

  it('should NOT create CALLS edge for require (CommonJS builtin)', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      await backend.addNodes([
        {
          id: 'main-call-require',
          type: 'CALL',
          name: 'require',
          file: '/project/main.js',
          line: 1
        }
      ]);

      await backend.flush();
      await resolver.execute({ graph: backend });

      const edges = await backend.getOutgoingEdges('main-call-require', ['CALLS']);
      assert.strictEqual(edges.length, 0, 'require should be treated as builtin');
    } finally {
      await backend.close();
    }
  });

  it('should handle all documented builtins', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      const builtins = ['parseInt', 'parseFloat', 'isNaN', 'setTimeout', 'eval', 'encodeURI'];
      const nodes = builtins.map((name, i) => ({
        id: `call-${name}`,
        type: 'CALL',
        name,
        file: '/project/main.js',
        line: i + 1
      }));

      await backend.addNodes(nodes);
      await backend.flush();

      const result = await resolver.execute({ graph: backend });

      // None should have CALLS edges
      for (const name of builtins) {
        const edges = await backend.getOutgoingEdges(`call-${name}`, ['CALLS']);
        assert.strictEqual(edges.length, 0, `${name} should not have CALLS edge`);
      }

      assert.strictEqual(result.metadata.builtinResolved, builtins.length);
    } finally {
      await backend.close();
    }
  });
});
```

### 2.4 Test Cases - Unresolved Calls

```javascript
describe('Unresolved Calls', () => {
  it('should count unknown unresolved calls', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      // Call to undefined function (not imported, not builtin)
      await backend.addNodes([
        {
          id: 'main-call-unknown',
          type: 'CALL',
          name: 'someUndefinedFunction',
          file: '/project/main.js',
          line: 10
        }
      ]);

      await backend.flush();
      const result = await resolver.execute({ graph: backend });

      // Should be counted as unknown unresolved
      assert.ok(result.metadata.unresolvedByReason.unknown >= 1);
    } finally {
      await backend.close();
    }
  });

  it('should detect dynamic call pattern', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      // Dynamic call: arr[0]()
      await backend.addNodes([
        {
          id: 'main-call-dynamic',
          type: 'CALL',
          name: '<computed>',
          file: '/project/main.js',
          line: 10
        }
      ]);

      await backend.flush();
      const result = await resolver.execute({ graph: backend });

      assert.ok(result.metadata.unresolvedByReason.dynamic >= 1);
    } finally {
      await backend.close();
    }
  });
});
```

### 2.5 Test Cases - Skip Conditions

```javascript
describe('Skip Conditions', () => {
  it('should skip method calls (have object attribute)', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      await backend.addNodes([
        {
          id: 'main-method-call',
          type: 'CALL',
          name: 'console.log',
          file: '/project/main.js',
          line: 5,
          object: 'console',  // Has object = METHOD_CALL
          method: 'log'
        }
      ]);

      await backend.flush();
      const result = await resolver.execute({ graph: backend });

      // Should not process method calls
      assert.strictEqual(result.metadata.callsProcessed, 0);
    } finally {
      await backend.close();
    }
  });

  it('should skip already resolved calls', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      await backend.addNodes([
        {
          id: 'utils-foo-func',
          type: 'FUNCTION',
          name: 'foo',
          file: '/project/utils.js',
          line: 1
        },
        {
          id: 'main-call-foo',
          type: 'CALL',
          name: 'foo',
          file: '/project/main.js',
          line: 5
        }
      ]);

      // Pre-existing CALLS edge (from FunctionCallResolver)
      await backend.addEdge({
        type: 'CALLS',
        src: 'main-call-foo',
        dst: 'utils-foo-func'
      });

      await backend.flush();
      const result = await resolver.execute({ graph: backend });

      // Should not process already resolved calls
      assert.strictEqual(result.metadata.callsProcessed, 0);
    } finally {
      await backend.close();
    }
  });

  it('should skip relative imports (handled by FunctionCallResolver)', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      // This case should already be handled by FunctionCallResolver,
      // but if it reaches us, we should not index it
      await backend.addNodes([
        {
          id: 'main-import-utils',
          type: 'IMPORT',
          name: 'helper',
          file: '/project/main.js',
          source: './utils',  // Relative!
          importType: 'named',
          imported: 'helper',
          local: 'helper'
        },
        {
          id: 'main-call-helper',
          type: 'CALL',
          name: 'helper',
          file: '/project/main.js',
          line: 5
        }
      ]);

      await backend.flush();
      const result = await resolver.execute({ graph: backend });

      // Should NOT create EXTERNAL_MODULE for relative import
      const extModule = await backend.getNode('EXTERNAL_MODULE:./utils');
      assert.ok(!extModule, 'Should not create EXTERNAL_MODULE for relative import');
    } finally {
      await backend.close();
    }
  });
});
```

### 2.6 Test Cases - Idempotency

```javascript
describe('Idempotency', () => {
  it('should produce same result when run twice', async () => {
    const { backend } = await setupBackend();
    try {
      const resolver = new ExternalCallResolver();

      await backend.addNodes([
        {
          id: 'main-import-lodash',
          type: 'IMPORT',
          name: '_',
          file: '/project/main.js',
          source: 'lodash',
          importType: 'default',
          imported: 'default',
          local: '_'
        },
        {
          id: 'main-call-lodash',
          type: 'CALL',
          name: '_',
          file: '/project/main.js',
          line: 3
        }
      ]);

      await backend.flush();

      // First run
      const result1 = await resolver.execute({ graph: backend });

      // Second run
      const result2 = await resolver.execute({ graph: backend });

      // Second run should create nothing (already processed)
      assert.strictEqual(result2.created.nodes, 0);
      assert.strictEqual(result2.created.edges, 0);
      assert.strictEqual(result2.metadata.callsProcessed, 0,
        'Call should be skipped (already has CALLS edge)');
    } finally {
      await backend.close();
    }
  });
});
```

### 2.7 Test Cases - Plugin Metadata

```javascript
describe('Plugin Metadata', () => {
  it('should have correct metadata', async () => {
    const resolver = new ExternalCallResolver();
    const metadata = resolver.metadata;

    assert.strictEqual(metadata.name, 'ExternalCallResolver');
    assert.strictEqual(metadata.phase, 'ENRICHMENT');
    assert.strictEqual(metadata.priority, 70);
    assert.deepStrictEqual(metadata.creates.nodes, ['EXTERNAL_MODULE']);
    assert.deepStrictEqual(metadata.creates.edges, ['CALLS']);
    assert.ok(metadata.dependencies.includes('FunctionCallResolver'));
  });
});
```

---

## 3. Algorithm Summary

### 3.1 Execution Flow

```
1. Build Import Index (O(n) where n = IMPORT nodes)
   - Filter: only external imports (non-relative source)
   - Key: `${file}:${localName}`
   - Value: { source, importType, imported, importNodeId }

2. Build Existing EXTERNAL_MODULE Set (O(m) where m = EXTERNAL_MODULE nodes)
   - For idempotency checking

3. Collect Unresolved CALL Nodes (O(c) where c = CALL nodes)
   - Filter: no `object` attribute AND no CALLS edge

4. For Each Unresolved CALL (O(c) iterations)
   a. Lookup in import index by `${file}:${calledName}`
      - If found -> Get/create EXTERNAL_MODULE, create CALLS edge
   b. Check if JS builtin
      - If yes -> count as builtin, no edge
   c. Otherwise -> detect reason (dynamic/alias/unknown)

5. Return summary with counts
```

### 3.2 Complexity Analysis

- Time: O(n + m + c) where n=imports, m=external modules, c=calls
- Space: O(n + m) for indices
- All operations are single-pass, no nested loops on graph data

---

## 4. Integration Points

### 4.1 Plugin Pipeline Order

```
Priority | Plugin                | What it does
---------|----------------------|-------------------------------------------
90       | ImportExportLinker   | Creates IMPORTS_FROM edges
80       | FunctionCallResolver | Resolves internal function calls
70       | ExternalCallResolver | THIS - handles external + builtin + unresolved
50       | MethodCallResolver   | Resolves method calls (obj.method())
45       | NodejsBuiltinsResolver | Resolves Node.js builtin module calls
```

### 4.2 Node Reuse Pattern

ExternalCallResolver reuses EXTERNAL_MODULE nodes that may be created by:
- GraphBuilder (during analysis phase for imports)
- NodejsBuiltinsResolver (for Node.js builtin modules)

Always check `graph.getNode(id)` before creating.

### 4.3 Future Integration: CallResolverValidator (REG-227)

The validator needs to be updated to recognize new resolution types:
- `resolutionType='external'` -> valid, has CALLS edge to EXTERNAL_MODULE
- `resolutionType='builtin'` -> valid, no CALLS edge needed
- `resolutionType='unresolved'` -> informational warning

**Note:** The current spec does not modify CALL node metadata (would require `graph.updateNode()`). If this capability exists, add metadata fields. Otherwise, the validator can:
1. Check if CALL has CALLS edge to EXTERNAL_MODULE -> external
2. Check if CALL name is in JS_BUILTINS set -> builtin
3. Otherwise -> unresolved

---

## 5. Edge Cases Handled

| Case | Handling |
|------|----------|
| Method calls (obj.method()) | Skipped - has `object` attribute |
| Already resolved calls | Skipped - has CALLS edge |
| Relative imports | Not indexed - handled by FunctionCallResolver |
| Duplicate EXTERNAL_MODULE | Check before create, reuse existing |
| Scoped packages (@org/pkg) | Treated as single module source |
| node: prefix (node:fs) | Normalized by ExternalModuleNode.create() |
| Multiple calls to same external | Each gets CALLS edge to same EXTERNAL_MODULE |
| Run twice | Idempotent - skips already processed |

---

## 6. Open Questions for Implementation

1. **Node metadata updates**: Does the graph backend support `updateNode()` for adding `resolutionType` metadata to CALL nodes? If not, the metadata strategy needs adjustment.

2. **Edge metadata support**: Does `addEdge()` support metadata field? The spec assumes yes based on graph patterns, but verify.

3. **Progress callback frequency**: 100 calls between updates is a reasonable default, but may need tuning for very large codebases.

---

## 7. Acceptance Criteria Checklist

- [ ] Plugin creates CALLS edges from external package calls to EXTERNAL_MODULE
- [ ] EXTERNAL_MODULE nodes are created if they don't exist
- [ ] No duplicate EXTERNAL_MODULE nodes
- [ ] JavaScript built-ins (parseInt, setTimeout, etc.) are recognized, no edge created
- [ ] Truly unresolved calls are counted with reason
- [ ] Method calls (with `object` attribute) are skipped
- [ ] Already resolved calls (with CALLS edge) are skipped
- [ ] Plugin is idempotent (running twice produces same result)
- [ ] Plugin reports accurate counts in result metadata
- [ ] All tests pass

---

Ready for Kent Beck to implement tests and Rob Pike to implement the plugin.
