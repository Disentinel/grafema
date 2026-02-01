/**
 * WorkspaceDiscovery Tests
 *
 * Tests for REG-247: WorkspaceDiscovery should pass absolute entrypoints
 * to JSModuleIndexer.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { WorkspaceDiscovery } from '@grafema/core';
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
 * Create plugin context for discovery
 */
function createContext(
  projectPath: string,
  graph?: MockGraphBackend
): PluginContext {
  return {
    graph: (graph ?? new MockGraphBackend()) as unknown as GraphBackend,
    projectPath,
    phase: 'DISCOVERY',
  };
}

/**
 * Create a minimal pnpm workspace structure
 */
function createPnpmWorkspace(
  rootDir: string,
  packages: Array<{ name: string; relativePath: string; hasEntrypoint?: boolean }>
): void {
  // Create pnpm-workspace.yaml
  writeFileSync(
    join(rootDir, 'pnpm-workspace.yaml'),
    'packages:\n  - "packages/*"\n'
  );

  // Create root package.json
  writeFileSync(
    join(rootDir, 'package.json'),
    JSON.stringify({ name: 'test-workspace', private: true }, null, 2)
  );

  // Create packages
  for (const pkg of packages) {
    const pkgDir = join(rootDir, pkg.relativePath);
    mkdirSync(pkgDir, { recursive: true });

    // Create package.json
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: pkg.name, version: '1.0.0' }, null, 2)
    );

    if (pkg.hasEntrypoint !== false) {
      // Create tsconfig.json (required for resolveSourceEntrypoint)
      writeFileSync(
        join(pkgDir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: {} }, null, 2)
      );

      // Create src/index.ts
      mkdirSync(join(pkgDir, 'src'), { recursive: true });
      writeFileSync(
        join(pkgDir, 'src', 'index.ts'),
        'export const x = 1;\n'
      );
    }
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('WorkspaceDiscovery', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-ws-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Entrypoint Resolution (REG-247)', () => {
    it('should return absolute entrypoint paths in metadata', async () => {
      // Setup: Create a pnpm workspace with a package
      createPnpmWorkspace(tempDir, [
        { name: '@test/core', relativePath: 'packages/core' }
      ]);

      const discovery = new WorkspaceDiscovery();
      const mockGraph = new MockGraphBackend();
      const result = await discovery.execute(createContext(tempDir, mockGraph));

      // Verify: Plugin succeeded
      assert.strictEqual(result.success, true, 'Plugin should succeed');

      // Verify: Services returned
      const services = result.metadata?.services as Array<{
        name: string;
        path: string;
        metadata: { entrypoint: string | null };
      }>;
      assert.ok(services, 'Should return services in metadata');
      assert.strictEqual(services.length, 1, 'Should find one package');

      // Verify: Entrypoint is absolute
      const service = services[0];
      assert.ok(service.metadata.entrypoint, 'Should have entrypoint');
      assert.ok(
        service.metadata.entrypoint.startsWith('/'),
        `Entrypoint should be absolute path, got: ${service.metadata.entrypoint}`
      );

      // Verify: Entrypoint is correct full path
      const expectedPath = join(tempDir, 'packages/core/src/index.ts');
      assert.strictEqual(
        service.metadata.entrypoint,
        expectedPath,
        'Entrypoint should be full absolute path'
      );
    });

    it('should handle multiple packages with different entrypoints', async () => {
      // Setup: Create workspace with multiple packages
      createPnpmWorkspace(tempDir, [
        { name: '@test/core', relativePath: 'packages/core' },
        { name: '@test/utils', relativePath: 'packages/utils' }
      ]);

      const discovery = new WorkspaceDiscovery();
      const result = await discovery.execute(createContext(tempDir));

      // Verify
      assert.strictEqual(result.success, true);
      const services = result.metadata?.services as Array<{
        name: string;
        metadata: { entrypoint: string | null };
      }>;
      assert.strictEqual(services.length, 2, 'Should find both packages');

      // All entrypoints should be absolute
      for (const service of services) {
        assert.ok(
          service.metadata.entrypoint?.startsWith('/'),
          `Entrypoint for ${service.name} should be absolute`
        );
      }
    });

    it('should handle package without TypeScript entrypoint', async () => {
      // Setup: Create package without tsconfig.json
      createPnpmWorkspace(tempDir, [
        { name: '@test/js-only', relativePath: 'packages/js-only', hasEntrypoint: false }
      ]);

      const discovery = new WorkspaceDiscovery();
      const result = await discovery.execute(createContext(tempDir));

      // Verify: Plugin succeeded
      assert.strictEqual(result.success, true);
      const services = result.metadata?.services as Array<{
        metadata: { entrypoint: string | null };
      }>;
      assert.strictEqual(services.length, 1);

      // Entrypoint should be null (no TypeScript source found)
      assert.strictEqual(services[0].metadata.entrypoint, null);
    });
  });
});
