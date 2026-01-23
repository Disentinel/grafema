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
});
