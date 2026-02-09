/**
 * JSModuleIndexer Error Handling Tests
 *
 * Tests for REG-147: JSModuleIndexer error handling with GrafemaError
 *
 * These tests verify that JSModuleIndexer reports parse failures as
 * LanguageError with ERR_PARSE_FAILURE code instead of silently logging.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { JSModuleIndexer, LanguageError } from '@grafema/core';
import type { GraphBackend, PluginContext } from '@grafema/types';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Mock GraphBackend for testing
 */
class MockGraphBackend implements Partial<GraphBackend> {
  nodes: Map<string, unknown> = new Map();
  edges: unknown[] = [];

  async addNode(node: { id: string }): Promise<void> {
    this.nodes.set(node.id, node);
  }

  async addEdge(edge: unknown): Promise<void> {
    this.edges.push(edge);
  }

  async addNodes(nodes: { id: string }[]): Promise<void> {
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }
  }

  async addEdges(edges: unknown[]): Promise<void> {
    this.edges.push(...edges);
  }

  async getNode(id: string): Promise<unknown> {
    return this.nodes.get(id) ?? null;
  }

  async nodeCount(): Promise<number> {
    return this.nodes.size;
  }

  async edgeCount(): Promise<number> {
    return this.edges.length;
  }

  async *queryNodes(): AsyncGenerator<unknown> {
    for (const node of this.nodes.values()) {
      yield node;
    }
  }

  async getAllNodes(): Promise<unknown[]> {
    return Array.from(this.nodes.values());
  }

  async getOutgoingEdges(): Promise<unknown[]> {
    return [];
  }

  async getIncomingEdges(): Promise<unknown[]> {
    return [];
  }

  async countNodesByType(): Promise<Record<string, number>> {
    return {};
  }

  async countEdgesByType(): Promise<Record<string, number>> {
    return {};
  }
}

/**
 * Create plugin context with mock graph
 */
function createContext(
  projectPath: string,
  entryPath: string,
  graph?: MockGraphBackend
): PluginContext {
  return {
    graph: (graph ?? new MockGraphBackend()) as unknown as GraphBackend,
    manifest: {
      projectPath,
      service: {
        id: 'test-service',
        name: 'TestService',
        path: entryPath,
      },
    },
    phase: 'INDEXING',
  };
}

// =============================================================================
// TESTS: Parse Error Collection
// =============================================================================

describe('JSModuleIndexer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Parse Error Handling (REG-147)', () => {
    it('should collect parse errors as LanguageError', async () => {
      // Setup: Create entry file that imports a bad file
      const entryFile = join(tempDir, 'entry.js');
      const badFile = join(tempDir, 'bad-syntax.js');

      writeFileSync(entryFile, 'import "./bad-syntax.js";');
      writeFileSync(badFile, 'const x = {'); // Incomplete object literal

      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(createContext(tempDir, 'entry.js'));

      // Verify: Plugin succeeded but reported parse error
      assert.strictEqual(result.success, true, 'Plugin should succeed even with parse errors');
      assert.strictEqual(result.errors.length, 1, 'Should have exactly one error');

      const error = result.errors[0];
      assert.ok(error instanceof LanguageError, 'Error should be LanguageError');
      assert.strictEqual(error.code, 'ERR_PARSE_FAILURE', 'Error code should be ERR_PARSE_FAILURE');
      assert.ok(error.context.filePath?.includes('bad-syntax.js'), 'Error should reference the file');
      assert.strictEqual(error.context.phase, 'INDEXING', 'Error should be in INDEXING phase');
      assert.strictEqual(error.context.plugin, 'JSModuleIndexer', 'Error should reference the plugin');
      assert.ok(error.suggestion, 'Error should have a suggestion');
    });

    it('should not report ENOENT as parse error', async () => {
      // Setup: Entry that imports non-existent file (unresolvable)
      const entryFile = join(tempDir, 'entry.js');
      writeFileSync(entryFile, 'import "./missing.js";');

      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(createContext(tempDir, 'entry.js'));

      // Verify: No errors reported for missing files (ENOENT is silent)
      assert.strictEqual(result.success, true, 'Plugin should succeed');
      assert.strictEqual(result.errors.length, 0, 'Should have no errors for missing files');
    });

    it('should collect multiple parse errors from different files', async () => {
      // Setup: Entry that imports multiple bad files
      const entryFile = join(tempDir, 'entry.js');
      const bad1 = join(tempDir, 'bad1.js');
      const bad2 = join(tempDir, 'bad2.js');

      writeFileSync(entryFile, 'import "./bad1.js";\nimport "./bad2.js";');
      writeFileSync(bad1, 'const x = {'); // Incomplete object
      writeFileSync(bad2, 'function('); // Invalid function

      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(createContext(tempDir, 'entry.js'));

      // Verify: Both errors collected
      assert.strictEqual(result.success, true, 'Plugin should succeed');
      assert.strictEqual(result.errors.length, 2, 'Should have two parse errors');

      for (const error of result.errors) {
        assert.ok(error instanceof LanguageError, 'Each error should be LanguageError');
        assert.strictEqual(error.code, 'ERR_PARSE_FAILURE', 'Each error should have ERR_PARSE_FAILURE code');
      }
    });

    it('should not report JSON files as parse errors', async () => {
      // Setup: Entry file that only exports
      const entryFile = join(tempDir, 'entry.js');
      const jsonFile = join(tempDir, 'data.json');

      writeFileSync(entryFile, 'import "./data.json";');
      writeFileSync(jsonFile, '{ invalid json }'); // Invalid JSON

      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(createContext(tempDir, 'entry.js'));

      // Verify: JSON files are handled specially (return empty deps, no error)
      assert.strictEqual(result.success, true, 'Plugin should succeed');
      assert.strictEqual(result.errors.length, 0, 'Should have no errors for JSON files');
    });

    it('should preserve created nodes/edges count when errors occur', async () => {
      // Setup: Entry file that can be parsed + bad file
      const entryFile = join(tempDir, 'entry.js');
      const badFile = join(tempDir, 'bad.js');

      writeFileSync(entryFile, 'import "./bad.js";\nexport const x = 1;');
      writeFileSync(badFile, 'const x = {');

      const mockGraph = new MockGraphBackend();
      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(createContext(tempDir, 'entry.js', mockGraph));

      // Verify: Entry node was created despite subsequent error
      assert.strictEqual(result.success, true);
      assert.ok(result.created.nodes >= 1, 'Should have created at least the entry node');
      assert.strictEqual(result.errors.length, 1, 'Should have one error');
    });

    it('should include relative path in error message', async () => {
      // Setup
      const entryFile = join(tempDir, 'entry.js');
      const badFile = join(tempDir, 'nested', 'bad.js');

      // Create nested directory
      const nestedDir = join(tempDir, 'nested');
      mkdirSync(nestedDir, { recursive: true });

      writeFileSync(entryFile, 'import "./nested/bad.js";');
      writeFileSync(badFile, 'const x = {');

      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(createContext(tempDir, 'entry.js'));

      // Verify: Error message contains relative path
      assert.strictEqual(result.errors.length, 1);
      const error = result.errors[0] as LanguageError;

      // The message should contain the relative path
      assert.ok(
        error.message.includes('nested/bad.js') || error.message.includes('nested\\bad.js'),
        `Error message should contain relative path: ${error.message}`
      );
    });
  });

  // ===========================================================================
  // TESTS: Directory Index Resolution (REG-393)
  // ===========================================================================

  describe('Directory Index Resolution (REG-393)', () => {
    it('should resolve require("./defaults") to defaults/index.js', async () => {
      // Setup: Create directory structure like axios
      // lib/
      //   index.js         → require('./defaults')
      //   defaults/
      //     index.js       → some content
      mkdirSync(join(tempDir, 'lib'), { recursive: true });
      mkdirSync(join(tempDir, 'lib', 'defaults'), { recursive: true });

      writeFileSync(join(tempDir, 'lib', 'index.js'), `
        const defaults = require('./defaults');
        module.exports = { defaults };
      `);
      writeFileSync(join(tempDir, 'lib', 'defaults', 'index.js'), `
        module.exports = { key: 'value' };
      `);

      const graph = new MockGraphBackend();
      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(createContext(tempDir, 'lib/index.js', graph));

      // Verify: Plugin succeeded
      assert.strictEqual(result.success, true, 'Plugin should succeed');

      // Get all nodes
      const nodes = await graph.getAllNodes();
      const nodeIds = nodes.map((n: any) => n.id);

      // Verify: defaults/index.js has a MODULE node
      const hasDefaultsIndex = nodeIds.some((id: string) =>
        id.includes('lib/defaults/index.js') || id.includes('lib\\defaults\\index.js')
      );
      assert.ok(hasDefaultsIndex, 'defaults/index.js should have a MODULE node');

      // Verify: lib/index.js DEPENDS_ON defaults/index.js
      const hasDependency = graph.edges.some((edge: any) =>
        (edge.src.includes('lib/index.js') || edge.src.includes('lib\\index.js')) &&
        (edge.dst.includes('lib/defaults/index.js') || edge.dst.includes('lib\\defaults\\index.js')) &&
        edge.type === 'DEPENDS_ON'
      );
      assert.ok(hasDependency, 'lib/index.js should DEPEND_ON defaults/index.js');
    });
  });

  // ===========================================================================
  // TESTS: Include/Exclude Pattern Filtering (REG-185)
  // ===========================================================================

  describe('Include/Exclude Pattern Filtering (REG-185)', () => {
    /**
     * Create context with include/exclude config
     */
    function createFilteringContext(
      projectPath: string,
      entryPath: string,
      include?: string[],
      exclude?: string[],
      graph?: MockGraphBackend
    ): PluginContext {
      return {
        graph: (graph ?? new MockGraphBackend()) as unknown as GraphBackend,
        manifest: {
          projectPath,
          service: {
            id: 'test-service',
            name: 'TestService',
            path: entryPath,
          },
        },
        config: { include, exclude },
        phase: 'INDEXING',
      };
    }

    // -------------------------------------------------------------------------
    // Exclude patterns
    // -------------------------------------------------------------------------

    it('should skip files matching exclude patterns', async () => {
      // Setup: entry.js imports test.js and util.js
      writeFileSync(join(tempDir, 'entry.js'), `
        import './test.js';
        import './util.js';
      `);
      writeFileSync(join(tempDir, 'test.js'), 'export const test = 1;');
      writeFileSync(join(tempDir, 'util.js'), 'export const util = 2;');

      const graph = new MockGraphBackend();
      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(
        createFilteringContext(tempDir, 'entry.js', undefined, ['**/*.test.js', '**/test.js'], graph)
      );

      // Verify: test.js skipped, util.js processed
      assert.strictEqual(result.success, true);
      const nodeIds = Array.from(graph.nodes.keys());

      assert.ok(
        nodeIds.some(id => id.includes('entry.js')),
        'entry.js should be indexed'
      );
      assert.ok(
        nodeIds.some(id => id.includes('util.js')),
        'util.js should be indexed'
      );
      assert.ok(
        !nodeIds.some(id => id.includes('test.js')),
        'test.js should NOT be indexed (excluded)'
      );
    });

    it('should skip entire directory with exclude pattern', async () => {
      // Setup: entry.js imports from fixtures/
      mkdirSync(join(tempDir, 'fixtures'), { recursive: true });

      writeFileSync(join(tempDir, 'entry.js'), `
        import './fixtures/data.js';
        import './util.js';
      `);
      writeFileSync(join(tempDir, 'fixtures', 'data.js'), 'export const data = 1;');
      writeFileSync(join(tempDir, 'util.js'), 'export const util = 2;');

      const graph = new MockGraphBackend();
      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(
        createFilteringContext(tempDir, 'entry.js', undefined, ['**/fixtures/**'], graph)
      );

      // Verify: fixtures/data.js skipped
      assert.strictEqual(result.success, true);
      const nodeIds = Array.from(graph.nodes.keys());

      assert.ok(!nodeIds.some(id => id.includes('fixtures')), 'fixtures/ should be excluded');
      assert.ok(nodeIds.some(id => id.includes('util.js')), 'util.js should be indexed');
    });

    // -------------------------------------------------------------------------
    // Include patterns
    // -------------------------------------------------------------------------

    it('should only process files matching include patterns', async () => {
      // Setup: entry.js imports from src/ and lib/
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      mkdirSync(join(tempDir, 'lib'), { recursive: true });

      writeFileSync(join(tempDir, 'entry.js'), `
        import './src/util.js';
        import './lib/helper.js';
      `);
      writeFileSync(join(tempDir, 'src', 'util.js'), 'export const util = 1;');
      writeFileSync(join(tempDir, 'lib', 'helper.js'), 'export const helper = 2;');

      const graph = new MockGraphBackend();
      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(
        createFilteringContext(tempDir, 'entry.js', ['entry.js', 'src/**/*.js'], undefined, graph)
      );

      // Verify: only entry.js and src/util.js processed
      assert.strictEqual(result.success, true);
      const nodeIds = Array.from(graph.nodes.keys());

      assert.ok(nodeIds.some(id => id.includes('entry.js')), 'entry.js should be indexed');
      assert.ok(nodeIds.some(id => id.includes('src/util.js') || id.includes('src\\util.js')), 'src/util.js should be indexed');
      assert.ok(!nodeIds.some(id => id.includes('lib/helper.js') || id.includes('lib\\helper.js')), 'lib/helper.js should NOT be indexed');
    });

    // -------------------------------------------------------------------------
    // Combined include + exclude
    // -------------------------------------------------------------------------

    it('should apply exclude after include (exclude wins when both match)', async () => {
      // Setup: Include src/, but exclude test files within src/
      mkdirSync(join(tempDir, 'src'), { recursive: true });

      writeFileSync(join(tempDir, 'entry.js'), `
        import './src/util.js';
        import './src/util.test.js';
      `);
      writeFileSync(join(tempDir, 'src', 'util.js'), 'export const util = 1;');
      writeFileSync(join(tempDir, 'src', 'util.test.js'), 'export const test = 2;');

      const graph = new MockGraphBackend();
      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(
        createFilteringContext(
          tempDir,
          'entry.js',
          ['entry.js', 'src/**/*.js'],  // include src/
          ['**/*.test.js'],              // but exclude .test.js
          graph
        )
      );

      // Verify: util.js included, util.test.js excluded
      assert.strictEqual(result.success, true);
      const nodeIds = Array.from(graph.nodes.keys());

      assert.ok(nodeIds.some(id => id.includes('util.js') && !id.includes('.test')), 'util.js should be indexed');
      assert.ok(!nodeIds.some(id => id.includes('util.test.js')), 'util.test.js should NOT be indexed');
    });

    // -------------------------------------------------------------------------
    // No filtering (default behavior)
    // -------------------------------------------------------------------------

    it('should process all reachable files when no patterns specified', async () => {
      writeFileSync(join(tempDir, 'entry.js'), `
        import './a.js';
        import './b.js';
      `);
      writeFileSync(join(tempDir, 'a.js'), 'export const a = 1;');
      writeFileSync(join(tempDir, 'b.js'), 'export const b = 2;');

      const graph = new MockGraphBackend();
      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(
        createFilteringContext(tempDir, 'entry.js', undefined, undefined, graph)
      );

      // Verify: all files processed
      assert.strictEqual(result.success, true);
      const nodeIds = Array.from(graph.nodes.keys());

      assert.ok(nodeIds.length >= 3, 'should have at least 3 nodes');
      assert.ok(nodeIds.some(id => id.includes('entry.js')));
      assert.ok(nodeIds.some(id => id.includes('a.js')));
      assert.ok(nodeIds.some(id => id.includes('b.js')));
    });

    // -------------------------------------------------------------------------
    // Edge cases
    // -------------------------------------------------------------------------

    it('should handle brace expansion in patterns', async () => {
      // Pattern: **/*.{ts,js}
      writeFileSync(join(tempDir, 'entry.js'), `
        import './util.ts';
        import './helper.jsx';
      `);
      writeFileSync(join(tempDir, 'util.ts'), 'export const util = 1;');
      writeFileSync(join(tempDir, 'helper.jsx'), 'export const helper = 2;');

      const graph = new MockGraphBackend();
      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(
        createFilteringContext(tempDir, 'entry.js', ['**/*.{js,ts}'], undefined, graph)
      );

      // Verify: .js and .ts included, .jsx excluded
      const nodeIds = Array.from(graph.nodes.keys());

      assert.ok(nodeIds.some(id => id.includes('entry.js')));
      assert.ok(nodeIds.some(id => id.includes('util.ts')));
      assert.ok(!nodeIds.some(id => id.includes('helper.jsx')), '.jsx should not match {js,ts}');
    });

    it('should skip entrypoint itself if excluded', async () => {
      // Edge case: what if entrypoint matches exclude?
      // Behavior: entry should be skipped (it's filtered like any other file)
      writeFileSync(join(tempDir, 'entry.test.js'), 'export const x = 1;');

      const graph = new MockGraphBackend();
      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(
        createFilteringContext(tempDir, 'entry.test.js', undefined, ['**/*.test.js'], graph)
      );

      // The entrypoint IS skipped if it matches exclude - this is the documented behavior
      const nodeIds = Array.from(graph.nodes.keys());

      assert.strictEqual(nodeIds.length, 0, 'entrypoint matching exclude should be skipped');
    });

    it('should normalize Windows paths for pattern matching', async () => {
      // This test ensures cross-platform compatibility
      mkdirSync(join(tempDir, 'src'), { recursive: true });

      writeFileSync(join(tempDir, 'entry.js'), 'import "./src/util.js";');
      writeFileSync(join(tempDir, 'src', 'util.js'), 'export const util = 1;');

      const graph = new MockGraphBackend();
      const indexer = new JSModuleIndexer();

      // Pattern uses forward slashes (standard glob syntax)
      const result = await indexer.execute(
        createFilteringContext(tempDir, 'entry.js', ['**/*.js'], undefined, graph)
      );

      assert.strictEqual(result.success, true);
      const nodeIds = Array.from(graph.nodes.keys());
      assert.ok(nodeIds.length >= 2, 'should process files regardless of OS path separators');
    });

    it('should match deeply nested paths correctly', async () => {
      // Setup deeply nested structure
      mkdirSync(join(tempDir, 'src', 'components', 'forms'), { recursive: true });

      writeFileSync(join(tempDir, 'entry.js'), `
        import './src/components/forms/input.js';
        import './src/components/button.js';
      `);
      writeFileSync(join(tempDir, 'src', 'components', 'forms', 'input.js'), 'export const input = 1;');
      writeFileSync(join(tempDir, 'src', 'components', 'button.js'), 'export const button = 2;');

      const graph = new MockGraphBackend();
      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(
        createFilteringContext(tempDir, 'entry.js', undefined, ['**/forms/**'], graph)
      );

      // Verify: forms/ directory excluded, button.js included
      assert.strictEqual(result.success, true);
      const nodeIds = Array.from(graph.nodes.keys());

      assert.ok(!nodeIds.some(id => id.includes('input.js')), 'forms/input.js should be excluded');
      assert.ok(nodeIds.some(id => id.includes('button.js')), 'button.js should be indexed');
    });

    it('should work with dotfiles when dot option is enabled', async () => {
      // Test matching dotfiles (e.g., .eslintrc.js)
      writeFileSync(join(tempDir, 'entry.js'), `
        import './.config.js';
        import './util.js';
      `);
      writeFileSync(join(tempDir, '.config.js'), 'export const config = 1;');
      writeFileSync(join(tempDir, 'util.js'), 'export const util = 2;');

      const graph = new MockGraphBackend();
      const indexer = new JSModuleIndexer();
      const result = await indexer.execute(
        createFilteringContext(tempDir, 'entry.js', undefined, ['**/.*'], graph)
      );

      // Verify: dotfiles excluded
      assert.strictEqual(result.success, true);
      const nodeIds = Array.from(graph.nodes.keys());

      assert.ok(!nodeIds.some(id => id.includes('.config.js')), '.config.js should be excluded');
      assert.ok(nodeIds.some(id => id.includes('util.js')), 'util.js should be indexed');
    });
  });
});
