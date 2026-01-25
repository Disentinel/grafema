/**
 * CoverageAnalyzer Tests
 *
 * Tests for the CoverageAnalyzer that calculates analysis coverage.
 * Based on specification: _tasks/2025-01-24-REG-169-coverage-command/005-don-plan-v2.md
 *
 * Tests:
 * - Categorizes analyzed files correctly (MODULE nodes in graph)
 * - Categorizes unsupported extensions (.go, .kt, .sql)
 * - Categorizes unreachable files (.ts/.js not in graph)
 * - Handles empty project gracefully
 * - Calculates percentages correctly
 * - Returns structured result with all fields
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

// Import will fail initially (TDD - implementation doesn't exist yet)
import { CoverageAnalyzer, type CoverageResult } from '@grafema/core';
import type { GraphBackend, NodeRecord, NodeFilter, EdgeRecord, EdgeType } from '@grafema/types';

// =============================================================================
// Mock GraphBackend for Testing
// =============================================================================

/**
 * Mock GraphBackend that simulates MODULE nodes in graph
 */
class MockGraphBackend implements Partial<GraphBackend> {
  private nodes: Map<string, NodeRecord> = new Map();

  constructor(moduleFiles: string[] = []) {
    // Create MODULE nodes for each file
    for (const file of moduleFiles) {
      const id = `module:${file}`;
      this.nodes.set(id, {
        id,
        type: 'MODULE',
        nodeType: 'MODULE',
        name: file.split('/').pop() || file,
        file,
        line: 1,
        column: 0,
        metadata: '{}',
      });
    }
  }

  async *queryNodes(filter: NodeFilter): AsyncGenerator<NodeRecord> {
    for (const node of this.nodes.values()) {
      if (filter.type && node.type !== filter.type) continue;
      if (filter.nodeType && node.nodeType !== filter.nodeType) continue;
      yield node;
    }
  }

  async getAllNodes(filter?: NodeFilter): Promise<NodeRecord[]> {
    const result: NodeRecord[] = [];
    for await (const node of this.queryNodes(filter || {})) {
      result.push(node);
    }
    return result;
  }

  async getNode(id: string): Promise<NodeRecord | null> {
    return this.nodes.get(id) || null;
  }

  async addNode(node: { id: string }): Promise<void> {
    this.nodes.set(node.id, node as NodeRecord);
  }

  async addNodes(nodes: { id: string }[]): Promise<void> {
    for (const node of nodes) {
      this.nodes.set(node.id, node as NodeRecord);
    }
  }

  async addEdge(): Promise<void> {}
  async addEdges(): Promise<void> {}

  async getOutgoingEdges(): Promise<EdgeRecord[]> {
    return [];
  }

  async getIncomingEdges(): Promise<EdgeRecord[]> {
    return [];
  }

  async nodeCount(): Promise<number> {
    return this.nodes.size;
  }

  async edgeCount(): Promise<number> {
    return 0;
  }

  async countNodesByType(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const node of this.nodes.values()) {
      const type = node.type || 'UNKNOWN';
      counts[type] = (counts[type] || 0) + 1;
    }
    return counts;
  }

  async countEdgesByType(): Promise<Record<string, number>> {
    return {};
  }
}

// =============================================================================
// TESTS: CoverageAnalyzer
// =============================================================================

describe('CoverageAnalyzer', () => {
  const testDir = join(process.cwd(), 'test-fixtures', 'coverage-analyzer');

  beforeEach(() => {
    // Clean slate for each test
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  // ===========================================================================
  // TESTS: Categorizes analyzed files correctly
  // ===========================================================================

  describe('Categorizes analyzed files correctly', () => {
    it('should identify files that are MODULE nodes in graph as analyzed', async () => {
      // Create project files
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export const x = 1;');
      writeFileSync(join(testDir, 'src', 'utils.ts'), 'export function helper() {}');

      // Mock graph has both files as MODULE nodes
      const graph = new MockGraphBackend([
        'src/index.ts',
        'src/utils.ts',
      ]) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.analyzed.count, 2);
      assert.ok(result.analyzed.files.includes('src/index.ts'));
      assert.ok(result.analyzed.files.includes('src/utils.ts'));
    });

    it('should count only MODULE type nodes for analyzed files', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'const x = 1;');

      // Graph has MODULE and other node types
      const graph = new MockGraphBackend(['src/index.ts']) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      // Only MODULE nodes should be counted as analyzed
      assert.strictEqual(result.analyzed.count, 1);
    });
  });

  // ===========================================================================
  // TESTS: Categorizes unsupported extensions
  // ===========================================================================

  describe('Categorizes unsupported extensions', () => {
    it('should identify .go files as unsupported', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'main.go'), 'package main');

      const graph = new MockGraphBackend([]) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.unsupported.count, 1);
      assert.ok(result.unsupported.byExtension['.go']);
      assert.strictEqual(result.unsupported.byExtension['.go'].length, 1);
    });

    it('should identify .kt files as unsupported', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'Main.kt'), 'fun main() {}');

      const graph = new MockGraphBackend([]) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.unsupported.count, 1);
      assert.ok(result.unsupported.byExtension['.kt']);
    });

    it('should identify .sql files as unsupported', async () => {
      mkdirSync(join(testDir, 'db'), { recursive: true });
      writeFileSync(join(testDir, 'db', 'schema.sql'), 'CREATE TABLE users;');

      const graph = new MockGraphBackend([]) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.unsupported.count, 1);
      assert.ok(result.unsupported.byExtension['.sql']);
    });

    it('should group multiple unsupported files by extension', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'main.go'), 'package main');
      writeFileSync(join(testDir, 'src', 'util.go'), 'package main');
      writeFileSync(join(testDir, 'src', 'Main.kt'), 'fun main() {}');

      const graph = new MockGraphBackend([]) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.unsupported.count, 3);
      assert.strictEqual(result.unsupported.byExtension['.go'].length, 2);
      assert.strictEqual(result.unsupported.byExtension['.kt'].length, 1);
    });
  });

  // ===========================================================================
  // TESTS: Categorizes unreachable files
  // ===========================================================================

  describe('Categorizes unreachable files', () => {
    it('should identify .ts files not in graph as unreachable', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'export const x = 1;');
      writeFileSync(join(testDir, 'src', 'orphan.ts'), 'const dead = true;');

      // Graph only has index.ts
      const graph = new MockGraphBackend(['src/index.ts']) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.unreachable.count, 1);
      assert.ok(result.unreachable.byExtension['.ts']);
      assert.ok(result.unreachable.files.includes('src/orphan.ts'));
    });

    it('should identify .js files not in graph as unreachable', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.js'), 'module.exports = {};');
      writeFileSync(join(testDir, 'src', 'unused.js'), '// dead code');

      // Graph only has index.js
      const graph = new MockGraphBackend(['src/index.js']) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.unreachable.count, 1);
      assert.ok(result.unreachable.byExtension['.js']);
    });

    it('should handle mix of supported file types', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), '');
      writeFileSync(join(testDir, 'src', 'helper.tsx'), '');
      writeFileSync(join(testDir, 'src', 'old.js'), '');
      writeFileSync(join(testDir, 'src', 'legacy.jsx'), '');
      writeFileSync(join(testDir, 'src', 'module.mjs'), '');
      writeFileSync(join(testDir, 'src', 'common.cjs'), '');

      // Only some files in graph
      const graph = new MockGraphBackend(['src/index.ts', 'src/helper.tsx']) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      // 6 files total, 2 analyzed, 4 unreachable
      assert.strictEqual(result.analyzed.count, 2);
      assert.strictEqual(result.unreachable.count, 4);
    });
  });

  // ===========================================================================
  // TESTS: Handles empty project
  // ===========================================================================

  describe('Handles empty project', () => {
    it('should handle empty directory gracefully', async () => {
      // testDir is already created but empty
      const graph = new MockGraphBackend([]) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.total, 0);
      assert.strictEqual(result.analyzed.count, 0);
      assert.strictEqual(result.unsupported.count, 0);
      assert.strictEqual(result.unreachable.count, 0);
    });

    it('should handle project with only non-code files', async () => {
      writeFileSync(join(testDir, 'README.md'), '# Project');
      writeFileSync(join(testDir, 'package.json'), '{}');
      writeFileSync(join(testDir, '.gitignore'), 'node_modules');

      const graph = new MockGraphBackend([]) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      // Non-code files should not be counted
      assert.strictEqual(result.total, 0);
    });

    it('should handle graph with no MODULE nodes', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), 'const x = 1;');

      // Empty graph (no MODULE nodes)
      const graph = new MockGraphBackend([]) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.analyzed.count, 0);
      assert.strictEqual(result.unreachable.count, 1);
    });
  });

  // ===========================================================================
  // TESTS: Calculates percentages correctly
  // ===========================================================================

  describe('Calculates percentages correctly', () => {
    it('should calculate analyzed percentage correctly', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      // 10 files total
      for (let i = 0; i < 10; i++) {
        writeFileSync(join(testDir, 'src', `file${i}.ts`), '');
      }

      // 6 files analyzed (60%)
      const analyzedFiles = [0, 1, 2, 3, 4, 5].map(i => `src/file${i}.ts`);
      const graph = new MockGraphBackend(analyzedFiles) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.percentages.analyzed, 60);
    });

    it('should calculate unsupported percentage correctly', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      // 5 supported, 5 unsupported (50% each of different categories)
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(testDir, 'src', `file${i}.ts`), '');
        writeFileSync(join(testDir, 'src', `file${i}.go`), '');
      }

      const graph = new MockGraphBackend([]) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.total, 10);
      assert.strictEqual(result.percentages.unsupported, 50);
    });

    it('should calculate unreachable percentage correctly', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      // 4 files, 1 analyzed, 3 unreachable
      writeFileSync(join(testDir, 'src', 'index.ts'), '');
      writeFileSync(join(testDir, 'src', 'a.ts'), '');
      writeFileSync(join(testDir, 'src', 'b.ts'), '');
      writeFileSync(join(testDir, 'src', 'c.ts'), '');

      const graph = new MockGraphBackend(['src/index.ts']) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.percentages.analyzed, 25);
      assert.strictEqual(result.percentages.unreachable, 75);
    });

    it('should handle 100% coverage', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), '');
      writeFileSync(join(testDir, 'src', 'utils.ts'), '');

      const graph = new MockGraphBackend(['src/index.ts', 'src/utils.ts']) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.percentages.analyzed, 100);
      assert.strictEqual(result.percentages.unreachable, 0);
    });

    it('should handle 0% coverage (empty graph)', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), '');

      const graph = new MockGraphBackend([]) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.percentages.analyzed, 0);
      assert.strictEqual(result.percentages.unreachable, 100);
    });
  });

  // ===========================================================================
  // TESTS: Returns structured result
  // ===========================================================================

  describe('Returns structured result with all fields', () => {
    it('should return complete CoverageResult structure', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), '');
      writeFileSync(join(testDir, 'src', 'orphan.ts'), '');
      writeFileSync(join(testDir, 'src', 'main.go'), '');

      const graph = new MockGraphBackend(['src/index.ts']) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      // Verify structure
      assert.ok(typeof result.total === 'number');

      assert.ok(typeof result.analyzed === 'object');
      assert.ok(typeof result.analyzed.count === 'number');
      assert.ok(Array.isArray(result.analyzed.files));

      assert.ok(typeof result.unsupported === 'object');
      assert.ok(typeof result.unsupported.count === 'number');
      assert.ok(typeof result.unsupported.byExtension === 'object');

      assert.ok(typeof result.unreachable === 'object');
      assert.ok(typeof result.unreachable.count === 'number');
      assert.ok(typeof result.unreachable.byExtension === 'object');
      assert.ok(Array.isArray(result.unreachable.files));

      assert.ok(typeof result.percentages === 'object');
      assert.ok(typeof result.percentages.analyzed === 'number');
      assert.ok(typeof result.percentages.unsupported === 'number');
      assert.ok(typeof result.percentages.unreachable === 'number');
    });

    it('should include projectPath in result', async () => {
      const graph = new MockGraphBackend([]) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.projectPath, testDir);
    });
  });

  // ===========================================================================
  // TESTS: Edge cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should respect .gitignore (skip node_modules)', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      mkdirSync(join(testDir, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'index.ts'), '');
      writeFileSync(join(testDir, 'node_modules', 'dep', 'index.js'), '');

      const graph = new MockGraphBackend(['src/index.ts']) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      // node_modules should be ignored
      assert.strictEqual(result.total, 1);
      assert.strictEqual(result.analyzed.count, 1);
    });

    it('should handle deeply nested files', async () => {
      mkdirSync(join(testDir, 'src', 'deep', 'nested', 'path'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'deep', 'nested', 'path', 'file.ts'), '');

      const graph = new MockGraphBackend(['src/deep/nested/path/file.ts']) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.analyzed.count, 1);
    });

    it('should handle Rust files (.rs) as supported', async () => {
      mkdirSync(join(testDir, 'src'), { recursive: true });
      writeFileSync(join(testDir, 'src', 'main.rs'), 'fn main() {}');

      // Rust file not in graph = unreachable, not unsupported
      const graph = new MockGraphBackend([]) as unknown as GraphBackend;

      const analyzer = new CoverageAnalyzer(graph, testDir);
      const result = await analyzer.analyze();

      assert.strictEqual(result.unreachable.count, 1);
      assert.strictEqual(result.unsupported.count, 0);
      assert.ok(result.unreachable.byExtension['.rs']);
    });
  });
});
