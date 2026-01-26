/**
 * Tests for BrokenImportValidator (REG-261)
 *
 * Tests cover:
 * - ERR_BROKEN_IMPORT: Named/default import with no matching export
 * - ERR_UNDEFINED_SYMBOL: Call to undefined symbol
 * - False positive prevention (globals, local definitions, etc.)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// NOTE: This import will fail until BrokenImportValidator is implemented.
// This is intentional TDD - tests first!
import { BrokenImportValidator } from '@grafema/core';

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
  importBinding?: string;
  object?: string;
  [key: string]: unknown;
}

interface MockEdge {
  type: string;
  src: string;
  dst: string;
}

/**
 * MockGraph simulates the graph backend for unit testing validators.
 * Provides minimal graph operations needed by BrokenImportValidator.
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
// TESTS: ERR_BROKEN_IMPORT
// =============================================================================

describe('BrokenImportValidator - ERR_BROKEN_IMPORT', () => {
  let graph: MockGraph;
  let validator: BrokenImportValidator;

  beforeEach(() => {
    graph = new MockGraph();
    validator = new BrokenImportValidator();
  });

  it('should detect broken named import (no IMPORTS_FROM edge)', async () => {
    // Setup: IMPORT node without IMPORTS_FROM edge
    graph.addNode({
      id: 'import-1',
      type: 'IMPORT',
      name: 'nonExistent',
      file: '/test/file.js',
      line: 3,
      source: './utils',
      importType: 'named',
      imported: 'nonExistent',
      local: 'nonExistent',
    });

    const result = await validator.execute(createContext(graph));

    assert.strictEqual(result.errors?.length, 1);
    assert.strictEqual(result.errors?.[0].code, 'ERR_BROKEN_IMPORT');
    assert.ok(result.errors?.[0].message.includes('nonExistent'));
    assert.ok(result.errors?.[0].message.includes('./utils'));
  });

  it('should detect broken default import (no IMPORTS_FROM edge)', async () => {
    graph.addNode({
      id: 'import-1',
      type: 'IMPORT',
      name: 'myDefault',
      file: '/test/file.js',
      line: 1,
      source: './missing',
      importType: 'default',
      local: 'myDefault',
    });

    const result = await validator.execute(createContext(graph));

    assert.strictEqual(result.errors?.length, 1);
    assert.strictEqual(result.errors?.[0].code, 'ERR_BROKEN_IMPORT');
  });

  it('should NOT report error for valid import (has IMPORTS_FROM edge)', async () => {
    graph.addNode({
      id: 'import-1',
      type: 'IMPORT',
      name: 'validFunc',
      file: '/test/file.js',
      line: 1,
      source: './utils',
      importType: 'named',
      imported: 'validFunc',
      local: 'validFunc',
    });
    graph.addNode({
      id: 'export-1',
      type: 'EXPORT',
      name: 'validFunc',
      file: '/test/utils.js',
    });
    graph.addEdge({
      type: 'IMPORTS_FROM',
      src: 'import-1',
      dst: 'export-1',
    });

    const result = await validator.execute(createContext(graph));

    const brokenImportErrors = result.errors?.filter(e => e.code === 'ERR_BROKEN_IMPORT') || [];
    assert.strictEqual(brokenImportErrors.length, 0);
  });

  it('should skip external (npm) imports', async () => {
    graph.addNode({
      id: 'import-1',
      type: 'IMPORT',
      name: 'lodash',
      file: '/test/file.js',
      line: 1,
      source: 'lodash', // No ./ or ../
      importType: 'namespace',
    });

    const result = await validator.execute(createContext(graph));

    const brokenImportErrors = result.errors?.filter(e => e.code === 'ERR_BROKEN_IMPORT') || [];
    assert.strictEqual(brokenImportErrors.length, 0);
  });

  it('should skip namespace imports', async () => {
    graph.addNode({
      id: 'import-1',
      type: 'IMPORT',
      name: 'utils',
      file: '/test/file.js',
      line: 1,
      source: './utils',
      importType: 'namespace', // import * as utils
    });

    const result = await validator.execute(createContext(graph));

    const brokenImportErrors = result.errors?.filter(e => e.code === 'ERR_BROKEN_IMPORT') || [];
    assert.strictEqual(brokenImportErrors.length, 0);
  });

  it('should skip type-only imports (TypeScript)', async () => {
    graph.addNode({
      id: 'import-1',
      type: 'IMPORT',
      name: 'MyType',
      file: '/test/file.ts',
      line: 1,
      source: './types',
      importType: 'named',
      importBinding: 'type', // import type { MyType }
    });

    const result = await validator.execute(createContext(graph));

    const brokenImportErrors = result.errors?.filter(e => e.code === 'ERR_BROKEN_IMPORT') || [];
    assert.strictEqual(brokenImportErrors.length, 0);
  });
});

// =============================================================================
// TESTS: ERR_UNDEFINED_SYMBOL
// =============================================================================

describe('BrokenImportValidator - ERR_UNDEFINED_SYMBOL', () => {
  let graph: MockGraph;
  let validator: BrokenImportValidator;

  beforeEach(() => {
    graph = new MockGraph();
    validator = new BrokenImportValidator();
  });

  it('should detect undefined symbol (not imported, not local, not global)', async () => {
    graph.addNode({
      id: 'call-1',
      type: 'CALL',
      name: 'unknownFunction',
      file: '/test/file.js',
      line: 10,
    });

    const result = await validator.execute(createContext(graph));

    const undefinedErrors = result.errors?.filter(e => e.code === 'ERR_UNDEFINED_SYMBOL') || [];
    assert.strictEqual(undefinedErrors.length, 1);
    assert.ok(undefinedErrors[0].message.includes('unknownFunction'));
  });

  it('should NOT report error for locally defined function', async () => {
    // Define function
    graph.addNode({
      id: 'func-1',
      type: 'FUNCTION',
      name: 'localFunc',
      file: '/test/file.js',
      line: 1,
    });
    // Call to local function
    graph.addNode({
      id: 'call-1',
      type: 'CALL',
      name: 'localFunc',
      file: '/test/file.js',
      line: 10,
    });

    const result = await validator.execute(createContext(graph));

    const undefinedErrors = result.errors?.filter(e => e.code === 'ERR_UNDEFINED_SYMBOL') || [];
    assert.strictEqual(undefinedErrors.length, 0);
  });

  it('should NOT report error for imported function (even if broken)', async () => {
    // Import (even without IMPORTS_FROM - that's ERR_BROKEN_IMPORT, not ERR_UNDEFINED_SYMBOL)
    graph.addNode({
      id: 'import-1',
      type: 'IMPORT',
      name: 'importedFunc',
      file: '/test/file.js',
      source: './utils',
      importType: 'named',
      local: 'importedFunc',
    });
    // Call to imported function
    graph.addNode({
      id: 'call-1',
      type: 'CALL',
      name: 'importedFunc',
      file: '/test/file.js',
      line: 10,
    });

    const result = await validator.execute(createContext(graph));

    const undefinedErrors = result.errors?.filter(e => e.code === 'ERR_UNDEFINED_SYMBOL') || [];
    assert.strictEqual(undefinedErrors.length, 0);
  });

  it('should NOT report error for global functions (console, setTimeout, etc.)', async () => {
    graph.addNode({
      id: 'call-1',
      type: 'CALL',
      name: 'console',
      file: '/test/file.js',
      line: 1,
    });
    graph.addNode({
      id: 'call-2',
      type: 'CALL',
      name: 'setTimeout',
      file: '/test/file.js',
      line: 2,
    });
    graph.addNode({
      id: 'call-3',
      type: 'CALL',
      name: 'Promise',
      file: '/test/file.js',
      line: 3,
    });
    graph.addNode({
      id: 'call-4',
      type: 'CALL',
      name: 'Array',
      file: '/test/file.js',
      line: 4,
    });

    const result = await validator.execute(createContext(graph));

    const undefinedErrors = result.errors?.filter(e => e.code === 'ERR_UNDEFINED_SYMBOL') || [];
    assert.strictEqual(undefinedErrors.length, 0);
  });

  it('should NOT report error for method calls (have object property)', async () => {
    graph.addNode({
      id: 'call-1',
      type: 'CALL',
      name: 'someMethod',
      file: '/test/file.js',
      line: 5,
      object: 'myObject', // Method call: myObject.someMethod()
    });

    const result = await validator.execute(createContext(graph));

    const undefinedErrors = result.errors?.filter(e => e.code === 'ERR_UNDEFINED_SYMBOL') || [];
    assert.strictEqual(undefinedErrors.length, 0);
  });

  it('should NOT report error for resolved calls (have CALLS edge)', async () => {
    graph.addNode({
      id: 'func-1',
      type: 'FUNCTION',
      name: 'targetFunc',
      file: '/test/utils.js',
    });
    graph.addNode({
      id: 'call-1',
      type: 'CALL',
      name: 'targetFunc',
      file: '/test/file.js',
      line: 10,
    });
    graph.addEdge({
      type: 'CALLS',
      src: 'call-1',
      dst: 'func-1',
    });

    const result = await validator.execute(createContext(graph));

    const undefinedErrors = result.errors?.filter(e => e.code === 'ERR_UNDEFINED_SYMBOL') || [];
    assert.strictEqual(undefinedErrors.length, 0);
  });
});

// =============================================================================
// TESTS: Custom Globals Configuration
// =============================================================================

describe('BrokenImportValidator - Custom Globals', () => {
  it('should accept custom globals from config', async () => {
    const graph = new MockGraph();
    const validator = new BrokenImportValidator({
      customGlobals: ['myCustomGlobal', 'anotherGlobal'],
    });

    graph.addNode({
      id: 'call-1',
      type: 'CALL',
      name: 'myCustomGlobal',
      file: '/test/file.js',
      line: 1,
    });

    const result = await validator.execute(createContext(graph));

    const undefinedErrors = result.errors?.filter(e => e.code === 'ERR_UNDEFINED_SYMBOL') || [];
    assert.strictEqual(undefinedErrors.length, 0);
  });
});

// =============================================================================
// TESTS: Metadata and Result Structure
// =============================================================================

describe('BrokenImportValidator - Metadata', () => {
  it('should have correct plugin metadata', () => {
    const validator = new BrokenImportValidator();
    const metadata = validator.metadata;

    assert.strictEqual(metadata.name, 'BrokenImportValidator');
    assert.strictEqual(metadata.phase, 'VALIDATION');
    assert.strictEqual(metadata.priority, 85);
    assert.ok(metadata.dependencies?.includes('ImportExportLinker'));
    assert.ok(metadata.dependencies?.includes('FunctionCallResolver'));
  });

  it('should return proper result structure', async () => {
    const graph = new MockGraph();
    const validator = new BrokenImportValidator();

    const result = await validator.execute(createContext(graph));

    assert.strictEqual(result.success, true);
    assert.ok(result.metadata);
    assert.ok('summary' in result.metadata);
    assert.ok(Array.isArray(result.errors));
  });
});
