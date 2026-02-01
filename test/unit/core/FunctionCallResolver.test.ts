/**
 * Tests for FunctionCallResolver - Re-exported External Module Call Resolution (REG-277)
 *
 * Tests cover:
 * - Simple re-export from external modules (utils.js -> lodash)
 * - Aliased re-export from external modules
 * - Nested re-exports (local -> local -> external)
 * - Default re-export from external
 * - Scoped package re-export (@tanstack/react-query)
 * - Mixed: local functions + external re-exports
 *
 * Pattern:
 *   // utils.js
 *   export { map } from 'lodash';
 *
 *   // main.js
 *   import { map } from './utils';
 *   map(); // Should resolve to EXTERNAL_MODULE:lodash
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// NOTE: This import will fail until FunctionCallResolver is updated for REG-277.
// This is intentional TDD - tests first!
import { FunctionCallResolver } from '@grafema/core';

// =============================================================================
// Mock Graph Implementation
// =============================================================================

interface MockNode {
  id: string;
  type: string;
  name?: string;
  file?: string;
  line?: number;
  source?: string;
  importType?: string;
  imported?: string;
  local?: string;
  exportType?: string;
  object?: string;
  packageName?: string;
  exportedName?: string;
  [key: string]: unknown;
}

interface MockEdge {
  type: string;
  src: string;
  dst: string;
  metadata?: Record<string, unknown>;
}

/**
 * MockGraph simulates the graph backend for unit testing FunctionCallResolver.
 * Provides minimal graph operations needed by the plugin.
 */
class MockGraph {
  private nodes: Map<string, MockNode> = new Map();
  private edges: MockEdge[] = [];

  addNode(node: MockNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(edge: MockEdge): void {
    this.edges.push(edge);
  }

  async *queryNodes(filter: { nodeType?: string }): AsyncIterableIterator<MockNode> {
    for (const node of this.nodes.values()) {
      if (!filter.nodeType || node.type === filter.nodeType) {
        yield node;
      }
    }
  }

  async getNode(id: string): Promise<MockNode | null> {
    return this.nodes.get(id) || null;
  }

  async getOutgoingEdges(nodeId: string, edgeTypes: string[]): Promise<MockEdge[]> {
    return this.edges.filter(
      e => e.src === nodeId && edgeTypes.includes(e.type)
    );
  }

  async getAllNodes(): Promise<MockNode[]> {
    return Array.from(this.nodes.values());
  }

  async getAllEdges(): Promise<MockEdge[]> {
    return this.edges;
  }

  // Helper for tests - not part of actual GraphBackend interface
  getEdge(src: string, type: string, dst: string): MockEdge | undefined {
    return this.edges.find(e => e.src === src && e.type === type && e.dst === dst);
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

function createContext(graph: MockGraph) {
  return {
    graph: graph as unknown,
    manifest: {},
    projectPath: '/test/project',
    logger: {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
    },
  };
}

// =============================================================================
// TESTS: Simple Re-export from External Module
// =============================================================================

describe('FunctionCallResolver - Re-exported External Modules', () => {
  let graph: MockGraph;
  let resolver: FunctionCallResolver;

  beforeEach(() => {
    graph = new MockGraph();
    resolver = new FunctionCallResolver();
  });

  it('should resolve call to simple re-export from external module', async () => {
    // Setup: utils.js: export { map } from 'lodash'
    //        main.js: import { map } from './utils'; map();
    // Expected: CALLS edge to EXTERNAL_MODULE:lodash with metadata { exportedName: 'map' }

    // EXTERNAL_MODULE node for lodash (matches pattern from ExternalCallResolver)
    graph.addNode({
      id: 'EXTERNAL_MODULE:lodash',
      type: 'EXTERNAL_MODULE',
      name: 'lodash',
      packageName: 'lodash'
    });

    // EXPORT in utils.js (re-export from lodash)
    graph.addNode({
      id: 'utils-reexport-map',
      type: 'EXPORT',
      name: 'map',
      file: '/project/utils.js',
      line: 1,
      exportType: 'named',
      local: 'map',
      source: 'lodash'  // External module re-export
    });

    // IMPORT in main.js
    graph.addNode({
      id: 'main-import-map',
      type: 'IMPORT',
      name: 'map',
      file: '/project/main.js',
      line: 1,
      source: './utils',
      importType: 'named',
      imported: 'map',
      local: 'map'
    });

    // CALL in main.js
    graph.addNode({
      id: 'main-call-map',
      type: 'CALL',
      name: 'map',
      file: '/project/main.js',
      line: 3
    });

    // IMPORTS_FROM edge (created by ImportExportLinker)
    graph.addEdge({
      type: 'IMPORTS_FROM',
      src: 'main-import-map',
      dst: 'utils-reexport-map'
    });

    const result = await resolver.execute(createContext(graph));

    // Assert: CALLS edge created to EXTERNAL_MODULE with metadata
    const edges = await graph.getOutgoingEdges('main-call-map', ['CALLS']);
    assert.strictEqual(edges.length, 1, 'Should create one CALLS edge');
    assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:lodash', 'Should point to EXTERNAL_MODULE:lodash');
    assert.ok(edges[0].metadata, 'Should have metadata');
    assert.strictEqual(edges[0].metadata?.exportedName, 'map', 'Should track exported name');

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.created.edges, 1, 'Should report 1 edge created');
  });

  it('should resolve call to aliased re-export from external module', async () => {
    // Setup: utils.js: export { map as mapping } from 'lodash'
    //        main.js: import { mapping } from './utils'; mapping();
    // Expected: CALLS edge with exportedName: 'map' (original name, not alias)

    graph.addNode({
      id: 'EXTERNAL_MODULE:lodash',
      type: 'EXTERNAL_MODULE',
      name: 'lodash',
      packageName: 'lodash'
    });

    // Re-export with alias: export { map as mapping }
    graph.addNode({
      id: 'utils-reexport-mapping',
      type: 'EXPORT',
      name: 'mapping',  // Aliased name
      file: '/project/utils.js',
      line: 1,
      exportType: 'named',
      local: 'map',     // Original name from lodash
      source: 'lodash'
    });

    graph.addNode({
      id: 'main-import-mapping',
      type: 'IMPORT',
      name: 'mapping',
      file: '/project/main.js',
      line: 1,
      source: './utils',
      importType: 'named',
      imported: 'mapping',
      local: 'mapping'
    });

    graph.addNode({
      id: 'main-call-mapping',
      type: 'CALL',
      name: 'mapping',
      file: '/project/main.js',
      line: 3
    });

    graph.addEdge({
      type: 'IMPORTS_FROM',
      src: 'main-import-mapping',
      dst: 'utils-reexport-mapping'
    });

    const result = await resolver.execute(createContext(graph));

    const edges = await graph.getOutgoingEdges('main-call-mapping', ['CALLS']);
    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:lodash');
    assert.strictEqual(edges[0].metadata?.exportedName, 'map',
      'Should use original name (map), not alias (mapping)');
  });

  it('should resolve nested re-exports (local -> local -> external)', async () => {
    // Setup: a.js: export { map } from './b'
    //        b.js: export { map } from 'lodash'
    //        main.js: import { map } from './a'; map();
    // Expected: CALLS edge to EXTERNAL_MODULE:lodash

    graph.addNode({
      id: 'EXTERNAL_MODULE:lodash',
      type: 'EXTERNAL_MODULE',
      name: 'lodash',
      packageName: 'lodash'
    });

    // b.js re-exports from external
    graph.addNode({
      id: 'b-reexport-map',
      type: 'EXPORT',
      name: 'map',
      file: '/project/b.js',
      exportType: 'named',
      local: 'map',
      source: 'lodash'  // External
    });

    // a.js re-exports from b.js (local)
    graph.addNode({
      id: 'a-reexport-map',
      type: 'EXPORT',
      name: 'map',
      file: '/project/a.js',
      exportType: 'named',
      local: 'map',
      source: './b'  // Local re-export
    });

    graph.addNode({
      id: 'main-import-map',
      type: 'IMPORT',
      name: 'map',
      file: '/project/main.js',
      source: './a',
      importType: 'named',
      imported: 'map',
      local: 'map'
    });

    graph.addNode({
      id: 'main-call-map',
      type: 'CALL',
      name: 'map',
      file: '/project/main.js',
      line: 3
    });

    graph.addEdge({
      type: 'IMPORTS_FROM',
      src: 'main-import-map',
      dst: 'a-reexport-map'
    });

    const result = await resolver.execute(createContext(graph));

    const edges = await graph.getOutgoingEdges('main-call-map', ['CALLS']);
    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:lodash',
      'Should resolve through nested re-export chain to external module');
    assert.strictEqual(edges[0].metadata?.exportedName, 'map');
  });

  it('should resolve default re-export from external module', async () => {
    // Setup: utils.js: export { default as lodash } from 'lodash'
    //        main.js: import { lodash } from './utils'; lodash();
    // Expected: CALLS edge with exportedName: 'default'

    graph.addNode({
      id: 'EXTERNAL_MODULE:lodash',
      type: 'EXTERNAL_MODULE',
      name: 'lodash',
      packageName: 'lodash'
    });

    // Re-export default: export { default as lodash } from 'lodash'
    graph.addNode({
      id: 'utils-reexport-default',
      type: 'EXPORT',
      name: 'lodash',   // Local name
      file: '/project/utils.js',
      line: 1,
      exportType: 'named',  // It's a named export locally
      local: 'default',     // But it's 'default' from external module
      source: 'lodash'
    });

    graph.addNode({
      id: 'main-import-lodash',
      type: 'IMPORT',
      name: 'lodash',
      file: '/project/main.js',
      line: 1,
      source: './utils',
      importType: 'named',
      imported: 'lodash',
      local: 'lodash'
    });

    graph.addNode({
      id: 'main-call-lodash',
      type: 'CALL',
      name: 'lodash',
      file: '/project/main.js',
      line: 3
    });

    graph.addEdge({
      type: 'IMPORTS_FROM',
      src: 'main-import-lodash',
      dst: 'utils-reexport-default'
    });

    const result = await resolver.execute(createContext(graph));

    const edges = await graph.getOutgoingEdges('main-call-lodash', ['CALLS']);
    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:lodash');
    assert.strictEqual(edges[0].metadata?.exportedName, 'default',
      'Should track that default export was used');
  });

  it('should resolve scoped package re-export', async () => {
    // Setup: utils.js: export { useQuery } from '@tanstack/react-query'
    //        main.js: import { useQuery } from './utils'; useQuery();
    // Expected: CALLS edge to EXTERNAL_MODULE:@tanstack/react-query

    graph.addNode({
      id: 'EXTERNAL_MODULE:@tanstack/react-query',
      type: 'EXTERNAL_MODULE',
      name: '@tanstack/react-query',
      packageName: '@tanstack/react-query'
    });

    graph.addNode({
      id: 'utils-reexport-useQuery',
      type: 'EXPORT',
      name: 'useQuery',
      file: '/project/utils.js',
      line: 1,
      exportType: 'named',
      local: 'useQuery',
      source: '@tanstack/react-query'  // Scoped package
    });

    graph.addNode({
      id: 'main-import-useQuery',
      type: 'IMPORT',
      name: 'useQuery',
      file: '/project/main.js',
      line: 1,
      source: './utils',
      importType: 'named',
      imported: 'useQuery',
      local: 'useQuery'
    });

    graph.addNode({
      id: 'main-call-useQuery',
      type: 'CALL',
      name: 'useQuery',
      file: '/project/main.js',
      line: 3
    });

    graph.addEdge({
      type: 'IMPORTS_FROM',
      src: 'main-import-useQuery',
      dst: 'utils-reexport-useQuery'
    });

    const result = await resolver.execute(createContext(graph));

    const edges = await graph.getOutgoingEdges('main-call-useQuery', ['CALLS']);
    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:@tanstack/react-query',
      'Should resolve to scoped package external module');
    assert.strictEqual(edges[0].metadata?.exportedName, 'useQuery');
  });

  it('should handle mixed: local functions + external re-exports', async () => {
    // Setup: utils.js has both:
    //   - Local function: function helper() {}; export { helper };
    //   - External re-export: export { map } from 'lodash';
    // main.js: import { helper, map } from './utils'; helper(); map();
    // Expected: helper() -> FUNCTION, map() -> EXTERNAL_MODULE

    // Local function
    graph.addNode({
      id: 'utils-helper-func',
      type: 'FUNCTION',
      name: 'helper',
      file: '/project/utils.js',
      line: 1
    });

    graph.addNode({
      id: 'utils-export-helper',
      type: 'EXPORT',
      name: 'helper',
      file: '/project/utils.js',
      line: 2,
      exportType: 'named',
      local: 'helper'
      // No source - local export
    });

    // External re-export
    graph.addNode({
      id: 'EXTERNAL_MODULE:lodash',
      type: 'EXTERNAL_MODULE',
      name: 'lodash',
      packageName: 'lodash'
    });

    graph.addNode({
      id: 'utils-reexport-map',
      type: 'EXPORT',
      name: 'map',
      file: '/project/utils.js',
      line: 3,
      exportType: 'named',
      local: 'map',
      source: 'lodash'
    });

    // Imports
    graph.addNode({
      id: 'main-import-helper',
      type: 'IMPORT',
      name: 'helper',
      file: '/project/main.js',
      line: 1,
      source: './utils',
      importType: 'named',
      imported: 'helper',
      local: 'helper'
    });

    graph.addNode({
      id: 'main-import-map',
      type: 'IMPORT',
      name: 'map',
      file: '/project/main.js',
      line: 1,
      source: './utils',
      importType: 'named',
      imported: 'map',
      local: 'map'
    });

    // Calls
    graph.addNode({
      id: 'main-call-helper',
      type: 'CALL',
      name: 'helper',
      file: '/project/main.js',
      line: 3
    });

    graph.addNode({
      id: 'main-call-map',
      type: 'CALL',
      name: 'map',
      file: '/project/main.js',
      line: 4
    });

    // IMPORTS_FROM edges
    graph.addEdge({
      type: 'IMPORTS_FROM',
      src: 'main-import-helper',
      dst: 'utils-export-helper'
    });

    graph.addEdge({
      type: 'IMPORTS_FROM',
      src: 'main-import-map',
      dst: 'utils-reexport-map'
    });

    const result = await resolver.execute(createContext(graph));

    // Assert: helper() resolves to FUNCTION
    const helperEdges = await graph.getOutgoingEdges('main-call-helper', ['CALLS']);
    assert.strictEqual(helperEdges.length, 1);
    assert.strictEqual(helperEdges[0].dst, 'utils-helper-func',
      'helper() should resolve to local FUNCTION');

    // Assert: map() resolves to EXTERNAL_MODULE
    const mapEdges = await graph.getOutgoingEdges('main-call-map', ['CALLS']);
    assert.strictEqual(mapEdges.length, 1);
    assert.strictEqual(mapEdges[0].dst, 'EXTERNAL_MODULE:lodash',
      'map() should resolve to EXTERNAL_MODULE');
    assert.strictEqual(mapEdges[0].metadata?.exportedName, 'map');

    assert.strictEqual(result.created.edges, 2, 'Should create 2 edges total');
  });
});

// =============================================================================
// TESTS: Edge Cases and Error Handling
// =============================================================================

describe('FunctionCallResolver - Re-export Edge Cases', () => {
  let graph: MockGraph;
  let resolver: FunctionCallResolver;

  beforeEach(() => {
    graph = new MockGraph();
    resolver = new FunctionCallResolver();
  });

  it('should handle missing EXTERNAL_MODULE node gracefully', async () => {
    // Setup: Re-export from 'lodash' but EXTERNAL_MODULE node doesn't exist initially
    // Expected: Create EXTERNAL_MODULE node and create edge (matches ExternalCallResolver behavior)

    graph.addNode({
      id: 'utils-reexport-map',
      type: 'EXPORT',
      name: 'map',
      file: '/project/utils.js',
      exportType: 'named',
      local: 'map',
      source: 'lodash'  // EXTERNAL_MODULE:lodash doesn't exist initially
    });

    graph.addNode({
      id: 'main-import-map',
      type: 'IMPORT',
      name: 'map',
      file: '/project/main.js',
      source: './utils',
      importType: 'named',
      imported: 'map',
      local: 'map'
    });

    graph.addNode({
      id: 'main-call-map',
      type: 'CALL',
      name: 'map',
      file: '/project/main.js',
      line: 3
    });

    graph.addEdge({
      type: 'IMPORTS_FROM',
      src: 'main-import-map',
      dst: 'utils-reexport-map'
    });

    const result = await resolver.execute(createContext(graph));

    // Should not crash
    assert.strictEqual(result.success, true);

    // Should create EXTERNAL_MODULE node
    const externalModule = await graph.getNode('EXTERNAL_MODULE:lodash');
    assert.ok(externalModule, 'Should create EXTERNAL_MODULE node');
    assert.strictEqual(externalModule.type, 'EXTERNAL_MODULE');
    assert.strictEqual(externalModule.name, 'lodash');

    // Should create CALLS edge
    const edges = await graph.getOutgoingEdges('main-call-map', ['CALLS']);
    assert.strictEqual(edges.length, 1, 'Should create CALLS edge');
    assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:lodash');
  });

  it('should not create edge for external import (not re-export)', async () => {
    // Setup: Direct import from external module (not re-export)
    //        main.js: import { map } from 'lodash'; map();
    // Expected: No edge created (FunctionCallResolver skips external imports)

    graph.addNode({
      id: 'EXTERNAL_MODULE:lodash',
      type: 'EXTERNAL_MODULE',
      name: 'lodash',
      packageName: 'lodash'
    });

    // Direct import from external (non-relative source)
    graph.addNode({
      id: 'main-import-map',
      type: 'IMPORT',
      name: 'map',
      file: '/project/main.js',
      line: 1,
      source: 'lodash',  // Non-relative! Direct external import
      importType: 'named',
      imported: 'map',
      local: 'map'
    });

    graph.addNode({
      id: 'main-call-map',
      type: 'CALL',
      name: 'map',
      file: '/project/main.js',
      line: 3
    });

    // No IMPORTS_FROM edge needed (external imports are skipped)

    const result = await resolver.execute(createContext(graph));

    // Should not create edge (external imports are filtered in Step 1)
    const edges = await graph.getOutgoingEdges('main-call-map', ['CALLS']);
    assert.strictEqual(edges.length, 0,
      'Should not create edge for direct external imports');
  });

  it('should preserve existing behavior for local function re-exports', async () => {
    // Regression test: Ensure we didn't break existing re-export chain resolution
    // Setup: a.js -> b.js (both local), b.js has actual function
    // This was already working, should continue to work

    graph.addNode({
      id: 'b-helper-func',
      type: 'FUNCTION',
      name: 'helper',
      file: '/project/b.js',
      line: 1
    });

    graph.addNode({
      id: 'b-export-helper',
      type: 'EXPORT',
      name: 'helper',
      file: '/project/b.js',
      exportType: 'named',
      local: 'helper'
      // No source - local export
    });

    graph.addNode({
      id: 'a-reexport-helper',
      type: 'EXPORT',
      name: 'helper',
      file: '/project/a.js',
      exportType: 'named',
      local: 'helper',
      source: './b'  // Local re-export
    });

    graph.addNode({
      id: 'main-import-helper',
      type: 'IMPORT',
      name: 'helper',
      file: '/project/main.js',
      source: './a',
      importType: 'named',
      imported: 'helper',
      local: 'helper'
    });

    graph.addNode({
      id: 'main-call-helper',
      type: 'CALL',
      name: 'helper',
      file: '/project/main.js',
      line: 3
    });

    graph.addEdge({
      type: 'IMPORTS_FROM',
      src: 'main-import-helper',
      dst: 'a-reexport-helper'
    });

    const result = await resolver.execute(createContext(graph));

    const edges = await graph.getOutgoingEdges('main-call-helper', ['CALLS']);
    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0].dst, 'b-helper-func',
      'Should still resolve local re-export chains to FUNCTION nodes');
  });
});

// =============================================================================
// TESTS: Metadata
// =============================================================================

describe('FunctionCallResolver - Metadata', () => {
  it('should have correct plugin metadata', () => {
    const resolver = new FunctionCallResolver();
    const metadata = resolver.metadata;

    assert.strictEqual(metadata.name, 'FunctionCallResolver');
    assert.strictEqual(metadata.phase, 'ENRICHMENT');
    assert.strictEqual(metadata.priority, 80);
    assert.deepStrictEqual(metadata.creates.edges, ['CALLS']);
    assert.ok(metadata.dependencies.includes('ImportExportLinker'));
  });
});
