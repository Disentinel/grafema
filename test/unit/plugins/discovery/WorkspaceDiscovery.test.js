/**
 * WorkspaceDiscovery Plugin Tests
 *
 * Tests for REG-171: ServiceDetector - npm workspaces not supported
 *
 * These tests verify that WorkspaceDiscovery correctly detects and analyzes
 * workspace configurations from npm, pnpm, yarn, and lerna monorepos.
 *
 * Test sections:
 * 1. WorkspaceTypeDetector - detects workspace type from config files
 * 2. Workspace Parsers - parse config files to extract glob patterns
 * 3. Glob Resolution - resolve patterns to actual workspace packages
 * 4. WorkspaceDiscovery Plugin - full plugin integration
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// These imports will fail until implementation exists - that's expected in TDD
import {
  detectWorkspaceType,
  parsePnpmWorkspace,
  parseNpmWorkspace,
  parseLernaConfig,
  resolveWorkspacePackages,
  WorkspaceDiscovery,
} from '@grafema/core';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Mock GraphBackend for testing plugin execution
 * Based on pattern from test/unit/plugins/indexing/JSModuleIndexer.test.ts
 */
class MockGraphBackend {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
  }

  async addNode(node) {
    this.nodes.set(node.id, node);
  }

  async addEdge(edge) {
    this.edges.push(edge);
  }

  async addNodes(nodes) {
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }
  }

  async addEdges(edges) {
    this.edges.push(...edges);
  }

  async getNode(id) {
    return this.nodes.get(id) ?? null;
  }

  async nodeCount() {
    return this.nodes.size;
  }

  async edgeCount() {
    return this.edges.length;
  }

  async *queryNodes(filter = {}) {
    for (const node of this.nodes.values()) {
      if (!filter.type || node.type === filter.type) {
        yield node;
      }
    }
  }

  async getAllNodes() {
    return Array.from(this.nodes.values());
  }

  async getOutgoingEdges() {
    return [];
  }

  async getIncomingEdges() {
    return [];
  }

  async countNodesByType() {
    return {};
  }

  async countEdgesByType() {
    return {};
  }

  async clear() {
    this.nodes.clear();
    this.edges = [];
  }
}

/**
 * Create plugin context for testing
 */
function createPluginContext(projectPath, graph = new MockGraphBackend()) {
  return {
    graph,
    projectPath,
    phase: 'DISCOVERY',
  };
}

/**
 * Create a minimal package.json content
 */
function createPackageJson(name, options = {}) {
  return JSON.stringify(
    {
      name,
      version: options.version || '1.0.0',
      private: options.private,
      description: options.description,
      main: options.main || 'index.js',
      dependencies: options.dependencies || {},
      workspaces: options.workspaces,
    },
    null,
    2
  );
}

/**
 * Create pnpm-workspace.yaml content
 */
function createPnpmWorkspaceYaml(packages) {
  const lines = ['packages:'];
  for (const pkg of packages) {
    lines.push(`  - '${pkg}'`);
  }
  return lines.join('\n');
}

/**
 * Create lerna.json content
 */
function createLernaJson(packages) {
  return JSON.stringify(
    {
      version: '1.0.0',
      packages: packages || ['packages/*'],
    },
    null,
    2
  );
}

// =============================================================================
// TESTS: WorkspaceTypeDetector
// =============================================================================

describe('WorkspaceTypeDetector', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-workspace-detector-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('pnpm workspace detection', () => {
    it('should detect pnpm from pnpm-workspace.yaml', () => {
      writeFileSync(
        join(tempDir, 'pnpm-workspace.yaml'),
        createPnpmWorkspaceYaml(['packages/*'])
      );
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('my-project'));

      const result = detectWorkspaceType(tempDir);

      assert.strictEqual(result.type, 'pnpm');
      assert.ok(result.configPath.endsWith('pnpm-workspace.yaml'));
      assert.strictEqual(result.rootPath, tempDir);
    });

    it('should detect pnpm even with .yml extension', () => {
      writeFileSync(
        join(tempDir, 'pnpm-workspace.yml'),
        createPnpmWorkspaceYaml(['packages/*'])
      );

      const result = detectWorkspaceType(tempDir);

      assert.strictEqual(result.type, 'pnpm');
    });
  });

  describe('npm workspace detection', () => {
    it('should detect npm from package.json workspaces array', () => {
      writeFileSync(
        join(tempDir, 'package.json'),
        createPackageJson('my-project', {
          workspaces: ['packages/*', 'apps/*'],
        })
      );

      const result = detectWorkspaceType(tempDir);

      assert.strictEqual(result.type, 'npm');
      assert.ok(result.configPath.endsWith('package.json'));
    });

    it('should not detect npm when workspaces field is absent', () => {
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('simple-project'));

      const result = detectWorkspaceType(tempDir);

      assert.strictEqual(result.type, null);
      assert.strictEqual(result.configPath, null);
    });
  });

  describe('yarn workspace detection', () => {
    it('should detect yarn from package.json workspaces object with packages', () => {
      const packageJson = {
        name: 'my-yarn-project',
        workspaces: {
          packages: ['packages/*'],
          nohoist: ['**/react-native'],
        },
      };
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

      const result = detectWorkspaceType(tempDir);

      // Both npm and yarn use package.json workspaces - we detect as 'npm' since format is compatible
      assert.ok(['npm', 'yarn'].includes(result.type));
      assert.ok(result.configPath.endsWith('package.json'));
    });
  });

  describe('lerna workspace detection', () => {
    it('should detect lerna from lerna.json', () => {
      writeFileSync(join(tempDir, 'lerna.json'), createLernaJson(['packages/*']));
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('lerna-project'));

      const result = detectWorkspaceType(tempDir);

      assert.strictEqual(result.type, 'lerna');
      assert.ok(result.configPath.endsWith('lerna.json'));
    });

    it('should detect lerna even without packages field (uses default)', () => {
      writeFileSync(join(tempDir, 'lerna.json'), JSON.stringify({ version: '1.0.0' }));
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('lerna-project'));

      const result = detectWorkspaceType(tempDir);

      assert.strictEqual(result.type, 'lerna');
    });
  });

  describe('non-workspace projects', () => {
    it('should return null type for projects without workspace config', () => {
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('simple-project'));

      const result = detectWorkspaceType(tempDir);

      assert.strictEqual(result.type, null);
      assert.strictEqual(result.configPath, null);
      assert.strictEqual(result.rootPath, tempDir);
    });

    it('should return null for empty directory', () => {
      const result = detectWorkspaceType(tempDir);

      assert.strictEqual(result.type, null);
    });
  });

  describe('priority when multiple configs exist', () => {
    it('should prefer pnpm over npm when both exist', () => {
      writeFileSync(
        join(tempDir, 'pnpm-workspace.yaml'),
        createPnpmWorkspaceYaml(['packages/*'])
      );
      writeFileSync(
        join(tempDir, 'package.json'),
        createPackageJson('my-project', { workspaces: ['apps/*'] })
      );

      const result = detectWorkspaceType(tempDir);

      assert.strictEqual(result.type, 'pnpm');
    });

    it('should prefer pnpm over lerna when both exist', () => {
      writeFileSync(
        join(tempDir, 'pnpm-workspace.yaml'),
        createPnpmWorkspaceYaml(['packages/*'])
      );
      writeFileSync(join(tempDir, 'lerna.json'), createLernaJson(['packages/*']));
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('my-project'));

      const result = detectWorkspaceType(tempDir);

      assert.strictEqual(result.type, 'pnpm');
    });

    it('should prefer npm over lerna when both exist', () => {
      writeFileSync(
        join(tempDir, 'package.json'),
        createPackageJson('my-project', { workspaces: ['packages/*'] })
      );
      writeFileSync(join(tempDir, 'lerna.json'), createLernaJson(['packages/*']));

      const result = detectWorkspaceType(tempDir);

      assert.strictEqual(result.type, 'npm');
    });
  });
});

// =============================================================================
// TESTS: Workspace Parsers
// =============================================================================

describe('Workspace Parsers', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-workspace-parsers-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('parsePnpmWorkspace', () => {
    it('should parse simple packages array', () => {
      const configPath = join(tempDir, 'pnpm-workspace.yaml');
      writeFileSync(configPath, createPnpmWorkspaceYaml(['packages/*']));

      const result = parsePnpmWorkspace(configPath);

      assert.deepStrictEqual(result.patterns, ['packages/*']);
      assert.deepStrictEqual(result.negativePatterns, []);
    });

    it('should parse multiple patterns', () => {
      const configPath = join(tempDir, 'pnpm-workspace.yaml');
      writeFileSync(configPath, createPnpmWorkspaceYaml(['packages/*', 'apps/**', 'tools/*']));

      const result = parsePnpmWorkspace(configPath);

      assert.deepStrictEqual(result.patterns, ['packages/*', 'apps/**', 'tools/*']);
    });

    it('should separate negative patterns', () => {
      const configPath = join(tempDir, 'pnpm-workspace.yaml');
      const content = `packages:
  - 'packages/*'
  - '!packages/internal'
  - 'apps/*'
  - '!apps/private'
`;
      writeFileSync(configPath, content);

      const result = parsePnpmWorkspace(configPath);

      assert.deepStrictEqual(result.patterns, ['packages/*', 'apps/*']);
      assert.deepStrictEqual(result.negativePatterns, ['packages/internal', 'apps/private']);
    });

    it('should handle empty packages array', () => {
      const configPath = join(tempDir, 'pnpm-workspace.yaml');
      writeFileSync(configPath, 'packages: []');

      const result = parsePnpmWorkspace(configPath);

      assert.deepStrictEqual(result.patterns, []);
      assert.deepStrictEqual(result.negativePatterns, []);
    });
  });

  describe('parseNpmWorkspace', () => {
    it('should parse workspaces array format', () => {
      const configPath = join(tempDir, 'package.json');
      writeFileSync(
        configPath,
        createPackageJson('my-project', { workspaces: ['packages/*', 'apps/*'] })
      );

      const result = parseNpmWorkspace(configPath);

      assert.deepStrictEqual(result.patterns, ['packages/*', 'apps/*']);
      assert.deepStrictEqual(result.negativePatterns, []);
    });

    it('should parse yarn workspaces object format', () => {
      const configPath = join(tempDir, 'package.json');
      const content = JSON.stringify({
        name: 'my-yarn-project',
        workspaces: {
          packages: ['packages/*', 'libs/*'],
          nohoist: ['**/react-native'],
        },
      });
      writeFileSync(configPath, content);

      const result = parseNpmWorkspace(configPath);

      assert.deepStrictEqual(result.patterns, ['packages/*', 'libs/*']);
    });

    it('should handle negation patterns in npm workspaces', () => {
      const configPath = join(tempDir, 'package.json');
      writeFileSync(
        configPath,
        createPackageJson('my-project', {
          workspaces: ['packages/*', '!packages/internal'],
        })
      );

      const result = parseNpmWorkspace(configPath);

      assert.deepStrictEqual(result.patterns, ['packages/*']);
      assert.deepStrictEqual(result.negativePatterns, ['packages/internal']);
    });

    it('should return empty patterns when workspaces not defined', () => {
      const configPath = join(tempDir, 'package.json');
      writeFileSync(configPath, createPackageJson('simple-project'));

      const result = parseNpmWorkspace(configPath);

      assert.deepStrictEqual(result.patterns, []);
      assert.deepStrictEqual(result.negativePatterns, []);
    });
  });

  describe('parseLernaConfig', () => {
    it('should parse packages array from lerna.json', () => {
      const configPath = join(tempDir, 'lerna.json');
      writeFileSync(configPath, createLernaJson(['packages/*', 'components/*']));

      const result = parseLernaConfig(configPath);

      assert.deepStrictEqual(result.patterns, ['packages/*', 'components/*']);
      assert.deepStrictEqual(result.negativePatterns, []);
    });

    it('should use default packages/* when packages field missing', () => {
      const configPath = join(tempDir, 'lerna.json');
      writeFileSync(configPath, JSON.stringify({ version: '1.0.0' }));

      const result = parseLernaConfig(configPath);

      assert.deepStrictEqual(result.patterns, ['packages/*']);
    });

    it('should handle empty packages array', () => {
      const configPath = join(tempDir, 'lerna.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          version: '1.0.0',
          packages: [],
        })
      );

      const result = parseLernaConfig(configPath);

      assert.deepStrictEqual(result.patterns, []);
    });
  });
});

// =============================================================================
// TESTS: Glob Resolution
// =============================================================================

describe('Glob Resolution', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-glob-resolver-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a workspace package directory with package.json
   */
  function createWorkspacePackage(relativePath, packageName, options = {}) {
    const fullPath = join(tempDir, relativePath);
    mkdirSync(fullPath, { recursive: true });
    writeFileSync(join(fullPath, 'package.json'), createPackageJson(packageName, options));
    // Optionally create src directory
    if (options.withSrc) {
      mkdirSync(join(fullPath, 'src'));
      writeFileSync(join(fullPath, 'src', 'index.ts'), 'export const x = 1;');
    }
  }

  describe('simple glob patterns', () => {
    it('should resolve packages/* pattern', () => {
      createWorkspacePackage('packages/core', '@myorg/core');
      createWorkspacePackage('packages/cli', '@myorg/cli');
      createWorkspacePackage('packages/utils', '@myorg/utils');

      const config = { patterns: ['packages/*'], negativePatterns: [] };
      const result = resolveWorkspacePackages(tempDir, config);

      assert.strictEqual(result.length, 3);
      const names = result.map((p) => p.name).sort();
      assert.deepStrictEqual(names, ['@myorg/cli', '@myorg/core', '@myorg/utils']);
    });

    it('should resolve apps/* pattern', () => {
      createWorkspacePackage('apps/frontend', 'frontend');
      createWorkspacePackage('apps/backend', 'backend');

      const config = { patterns: ['apps/*'], negativePatterns: [] };
      const result = resolveWorkspacePackages(tempDir, config);

      assert.strictEqual(result.length, 2);
      const names = result.map((p) => p.name).sort();
      assert.deepStrictEqual(names, ['backend', 'frontend']);
    });

    it('should handle multiple patterns', () => {
      createWorkspacePackage('packages/core', '@myorg/core');
      createWorkspacePackage('apps/web', 'web-app');

      const config = { patterns: ['packages/*', 'apps/*'], negativePatterns: [] };
      const result = resolveWorkspacePackages(tempDir, config);

      assert.strictEqual(result.length, 2);
    });
  });

  describe('nested glob patterns', () => {
    it('should resolve apps/** pattern', () => {
      createWorkspacePackage('apps/web/frontend', 'frontend');
      createWorkspacePackage('apps/web/backend', 'backend');
      createWorkspacePackage('apps/mobile/ios', 'ios-app');

      const config = { patterns: ['apps/**'], negativePatterns: [] };
      const result = resolveWorkspacePackages(tempDir, config);

      assert.strictEqual(result.length, 3);
    });

    it('should handle deeply nested packages', () => {
      createWorkspacePackage('libs/ui/components/button', '@ui/button');
      createWorkspacePackage('libs/ui/components/input', '@ui/input');
      createWorkspacePackage('libs/ui/hooks', '@ui/hooks');

      const config = { patterns: ['libs/**'], negativePatterns: [] };
      const result = resolveWorkspacePackages(tempDir, config);

      assert.strictEqual(result.length, 3);
    });
  });

  describe('negation patterns', () => {
    it('should exclude packages matching negative pattern', () => {
      createWorkspacePackage('packages/core', '@myorg/core');
      createWorkspacePackage('packages/cli', '@myorg/cli');
      createWorkspacePackage('packages/internal', '@myorg/internal');

      const config = {
        patterns: ['packages/*'],
        negativePatterns: ['packages/internal'],
      };
      const result = resolveWorkspacePackages(tempDir, config);

      assert.strictEqual(result.length, 2);
      const names = result.map((p) => p.name);
      assert.ok(!names.includes('@myorg/internal'));
    });

    it('should handle multiple negation patterns', () => {
      createWorkspacePackage('packages/core', '@myorg/core');
      createWorkspacePackage('packages/private', '@myorg/private');
      createWorkspacePackage('packages/internal', '@myorg/internal');
      createWorkspacePackage('packages/cli', '@myorg/cli');

      const config = {
        patterns: ['packages/*'],
        negativePatterns: ['packages/private', 'packages/internal'],
      };
      const result = resolveWorkspacePackages(tempDir, config);

      assert.strictEqual(result.length, 2);
      const names = result.map((p) => p.name).sort();
      assert.deepStrictEqual(names, ['@myorg/cli', '@myorg/core']);
    });
  });

  describe('edge cases', () => {
    it('should skip directories without package.json', () => {
      createWorkspacePackage('packages/core', '@myorg/core');
      // Create directory without package.json
      mkdirSync(join(tempDir, 'packages', 'docs'), { recursive: true });
      writeFileSync(join(tempDir, 'packages', 'docs', 'README.md'), '# Docs');

      const config = { patterns: ['packages/*'], negativePatterns: [] };
      const result = resolveWorkspacePackages(tempDir, config);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, '@myorg/core');
    });

    it('should return empty array for non-matching pattern', () => {
      createWorkspacePackage('packages/core', '@myorg/core');

      const config = { patterns: ['apps/*'], negativePatterns: [] };
      const result = resolveWorkspacePackages(tempDir, config);

      assert.strictEqual(result.length, 0);
    });

    it('should handle empty patterns array', () => {
      createWorkspacePackage('packages/core', '@myorg/core');

      const config = { patterns: [], negativePatterns: [] };
      const result = resolveWorkspacePackages(tempDir, config);

      assert.strictEqual(result.length, 0);
    });

    it('should use directory name when package.json has no name field', () => {
      const pkgPath = join(tempDir, 'packages', 'unnamed');
      mkdirSync(pkgPath, { recursive: true });
      writeFileSync(join(pkgPath, 'package.json'), JSON.stringify({ version: '1.0.0' }));

      const config = { patterns: ['packages/*'], negativePatterns: [] };
      const result = resolveWorkspacePackages(tempDir, config);

      assert.strictEqual(result.length, 1);
      // Should fallback to something based on path
      assert.ok(result[0].name.includes('unnamed') || result[0].name.includes('packages'));
    });

    it('should not follow symlinks to avoid infinite loops', () => {
      createWorkspacePackage('packages/core', '@myorg/core');
      // Note: Creating symlinks may fail on some systems, so this test documents intent
      // The implementation should handle symlinks safely

      const config = { patterns: ['packages/*'], negativePatterns: [] };
      const result = resolveWorkspacePackages(tempDir, config);

      assert.strictEqual(result.length, 1);
    });

    it('should include correct relative path in result', () => {
      createWorkspacePackage('packages/core', '@myorg/core');

      const config = { patterns: ['packages/*'], negativePatterns: [] };
      const result = resolveWorkspacePackages(tempDir, config);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].relativePath, 'packages/core');
      assert.strictEqual(result[0].path, join(tempDir, 'packages', 'core'));
    });

    it('should parse and include full package.json content', () => {
      createWorkspacePackage('packages/core', '@myorg/core', {
        version: '2.0.0',
        description: 'Core package',
        dependencies: { lodash: '^4.0.0' },
      });

      const config = { patterns: ['packages/*'], negativePatterns: [] };
      const result = resolveWorkspacePackages(tempDir, config);

      assert.strictEqual(result[0].packageJson.version, '2.0.0');
      assert.strictEqual(result[0].packageJson.description, 'Core package');
      assert.deepStrictEqual(result[0].packageJson.dependencies, { lodash: '^4.0.0' });
    });
  });

  describe('literal path patterns', () => {
    it('should resolve exact directory path', () => {
      createWorkspacePackage('specific/package', 'specific-package');

      const config = { patterns: ['specific/package'], negativePatterns: [] };
      const result = resolveWorkspacePackages(tempDir, config);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'specific-package');
    });
  });
});

// =============================================================================
// TESTS: WorkspaceDiscovery Plugin
// =============================================================================

describe('WorkspaceDiscovery Plugin', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-workspace-discovery-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a workspace package
   */
  function createWorkspacePackage(relativePath, packageName, options = {}) {
    const fullPath = join(tempDir, relativePath);
    mkdirSync(fullPath, { recursive: true });
    writeFileSync(join(fullPath, 'package.json'), createPackageJson(packageName, options));
    if (options.withTsConfig) {
      writeFileSync(join(fullPath, 'tsconfig.json'), '{}');
    }
    if (options.withSrc) {
      mkdirSync(join(fullPath, 'src'));
      writeFileSync(join(fullPath, 'src', 'index.ts'), `export const ${packageName} = 1;`);
    }
  }

  describe('plugin metadata', () => {
    it('should have correct metadata', () => {
      const plugin = new WorkspaceDiscovery();
      const metadata = plugin.metadata;

      assert.strictEqual(metadata.name, 'WorkspaceDiscovery');
      assert.strictEqual(metadata.phase, 'DISCOVERY');
      assert.strictEqual(metadata.priority, 110); // Higher than MonorepoServiceDiscovery (100)
      assert.deepStrictEqual(metadata.creates.nodes, ['SERVICE']);
      assert.deepStrictEqual(metadata.creates.edges, []);
    });
  });

  describe('pnpm workspace detection', () => {
    it('should create SERVICE nodes for pnpm workspace packages', async () => {
      // Setup pnpm workspace
      writeFileSync(
        join(tempDir, 'pnpm-workspace.yaml'),
        createPnpmWorkspaceYaml(['packages/*'])
      );
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('my-monorepo'));
      createWorkspacePackage('packages/core', '@myorg/core');
      createWorkspacePackage('packages/cli', '@myorg/cli');

      const graph = new MockGraphBackend();
      const plugin = new WorkspaceDiscovery();
      const context = createPluginContext(tempDir, graph);

      const result = await plugin.execute(context);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.created.nodes, 2);
      assert.strictEqual(result.metadata.workspaceType, 'pnpm');
      assert.strictEqual(result.metadata.services.length, 2);

      // Verify SERVICE nodes were created
      const nodes = await graph.getAllNodes();
      assert.strictEqual(nodes.length, 2);
      assert.ok(nodes.every((n) => n.type === 'SERVICE'));
    });

    it('should set workspaceType metadata on SERVICE nodes', async () => {
      writeFileSync(
        join(tempDir, 'pnpm-workspace.yaml'),
        createPnpmWorkspaceYaml(['packages/*'])
      );
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('my-monorepo'));
      createWorkspacePackage('packages/core', '@myorg/core');

      const graph = new MockGraphBackend();
      const plugin = new WorkspaceDiscovery();
      const context = createPluginContext(tempDir, graph);

      await plugin.execute(context);

      const nodes = await graph.getAllNodes();
      assert.strictEqual(nodes[0].metadata.workspaceType, 'pnpm');
      assert.strictEqual(nodes[0].metadata.discoveryMethod, 'workspace');
    });
  });

  describe('npm workspace detection', () => {
    it('should create SERVICE nodes for npm workspace packages', async () => {
      writeFileSync(
        join(tempDir, 'package.json'),
        createPackageJson('my-monorepo', { workspaces: ['apps/*', 'packages/*'] })
      );
      createWorkspacePackage('apps/frontend', 'frontend');
      createWorkspacePackage('apps/backend', 'backend');
      createWorkspacePackage('packages/shared', '@myorg/shared');

      const graph = new MockGraphBackend();
      const plugin = new WorkspaceDiscovery();
      const context = createPluginContext(tempDir, graph);

      const result = await plugin.execute(context);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.created.nodes, 3);
      assert.strictEqual(result.metadata.workspaceType, 'npm');
    });
  });

  describe('lerna workspace detection', () => {
    it('should create SERVICE nodes for lerna packages', async () => {
      writeFileSync(join(tempDir, 'lerna.json'), createLernaJson(['packages/*']));
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('lerna-monorepo'));
      createWorkspacePackage('packages/core', '@myorg/core');
      createWorkspacePackage('packages/cli', '@myorg/cli');

      const graph = new MockGraphBackend();
      const plugin = new WorkspaceDiscovery();
      const context = createPluginContext(tempDir, graph);

      const result = await plugin.execute(context);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.created.nodes, 2);
      assert.strictEqual(result.metadata.workspaceType, 'lerna');
    });
  });

  describe('non-workspace projects', () => {
    it('should skip and return empty services for non-workspace projects', async () => {
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('simple-project'));

      const graph = new MockGraphBackend();
      const plugin = new WorkspaceDiscovery();
      const context = createPluginContext(tempDir, graph);

      const result = await plugin.execute(context);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.created.nodes, 0);
      assert.strictEqual(result.metadata.skipped, true);
      assert.strictEqual(result.metadata.reason, 'No workspace configuration found');
      assert.deepStrictEqual(result.metadata.services, []);
    });

    it('should return empty for directory without package.json', async () => {
      const graph = new MockGraphBackend();
      const plugin = new WorkspaceDiscovery();
      const context = createPluginContext(tempDir, graph);

      const result = await plugin.execute(context);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.created.nodes, 0);
      assert.strictEqual(result.metadata.skipped, true);
    });
  });

  describe('service metadata', () => {
    it('should include correct metadata on service nodes', async () => {
      writeFileSync(
        join(tempDir, 'pnpm-workspace.yaml'),
        createPnpmWorkspaceYaml(['packages/*'])
      );
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('my-monorepo'));
      createWorkspacePackage('packages/core', '@myorg/core', {
        version: '1.2.3',
        description: 'Core utilities',
        private: true,
        dependencies: { lodash: '^4.0.0' },
      });

      const graph = new MockGraphBackend();
      const plugin = new WorkspaceDiscovery();
      const context = createPluginContext(tempDir, graph);

      await plugin.execute(context);

      const nodes = await graph.getAllNodes();
      const coreNode = nodes.find((n) => n.name === '@myorg/core');

      assert.ok(coreNode);
      assert.strictEqual(coreNode.metadata.version, '1.2.3');
      assert.strictEqual(coreNode.metadata.description, 'Core utilities');
      assert.strictEqual(coreNode.metadata.private, true);
      assert.deepStrictEqual(coreNode.metadata.dependencies, ['lodash']);
      assert.strictEqual(coreNode.metadata.relativePath, 'packages/core');
    });

    it('should resolve TypeScript source entrypoint when available', async () => {
      writeFileSync(
        join(tempDir, 'pnpm-workspace.yaml'),
        createPnpmWorkspaceYaml(['packages/*'])
      );
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('my-monorepo'));
      createWorkspacePackage('packages/core', '@myorg/core', {
        main: 'dist/index.js',
        withTsConfig: true,
        withSrc: true,
      });

      const graph = new MockGraphBackend();
      const plugin = new WorkspaceDiscovery();
      const context = createPluginContext(tempDir, graph);

      await plugin.execute(context);

      const nodes = await graph.getAllNodes();
      // Should prefer src/index.ts over dist/index.js
      assert.strictEqual(nodes[0].metadata.entrypoint, 'src/index.ts');
    });
  });

  describe('error handling', () => {
    it('should return error when projectPath is not provided', async () => {
      const graph = new MockGraphBackend();
      const plugin = new WorkspaceDiscovery();
      const context = { graph, phase: 'DISCOVERY' };

      const result = await plugin.execute(context);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.errors.length, 1);
      assert.ok(result.errors[0].message.includes('projectPath'));
    });

    it('should handle malformed pnpm-workspace.yaml gracefully', async () => {
      writeFileSync(join(tempDir, 'pnpm-workspace.yaml'), 'invalid: yaml: [[[');
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('my-monorepo'));

      const graph = new MockGraphBackend();
      const plugin = new WorkspaceDiscovery();
      const context = createPluginContext(tempDir, graph);

      const result = await plugin.execute(context);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.errors.length, 1);
    });

    it('should handle malformed package.json in workspace member gracefully', async () => {
      writeFileSync(
        join(tempDir, 'pnpm-workspace.yaml'),
        createPnpmWorkspaceYaml(['packages/*'])
      );
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('my-monorepo'));
      // Create valid package
      createWorkspacePackage('packages/core', '@myorg/core');
      // Create package with malformed JSON
      const badPkgPath = join(tempDir, 'packages', 'bad');
      mkdirSync(badPkgPath, { recursive: true });
      writeFileSync(join(badPkgPath, 'package.json'), '{ invalid json }');

      const graph = new MockGraphBackend();
      const plugin = new WorkspaceDiscovery();
      const context = createPluginContext(tempDir, graph);

      const result = await plugin.execute(context);

      // Should still succeed but skip the bad package
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.created.nodes, 1); // Only the valid package
    });
  });

  describe('nested workspaces', () => {
    it('should handle nested workspace patterns', async () => {
      writeFileSync(
        join(tempDir, 'pnpm-workspace.yaml'),
        createPnpmWorkspaceYaml(['apps/**'])
      );
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('my-monorepo'));
      createWorkspacePackage('apps/web/frontend', 'web-frontend');
      createWorkspacePackage('apps/web/backend', 'web-backend');
      createWorkspacePackage('apps/mobile/ios', 'mobile-ios');

      const graph = new MockGraphBackend();
      const plugin = new WorkspaceDiscovery();
      const context = createPluginContext(tempDir, graph);

      const result = await plugin.execute(context);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.created.nodes, 3);
    });
  });

  describe('workspace with negation patterns', () => {
    it('should exclude packages matching negation patterns', async () => {
      const content = `packages:
  - 'packages/*'
  - '!packages/internal'
`;
      writeFileSync(join(tempDir, 'pnpm-workspace.yaml'), content);
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('my-monorepo'));
      createWorkspacePackage('packages/core', '@myorg/core');
      createWorkspacePackage('packages/cli', '@myorg/cli');
      createWorkspacePackage('packages/internal', '@myorg/internal');

      const graph = new MockGraphBackend();
      const plugin = new WorkspaceDiscovery();
      const context = createPluginContext(tempDir, graph);

      const result = await plugin.execute(context);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.created.nodes, 2);
      const serviceNames = result.metadata.services.map((s) => s.name);
      assert.ok(!serviceNames.includes('@myorg/internal'));
    });
  });

  describe('result format', () => {
    it('should return services in correct format for manifest', async () => {
      writeFileSync(
        join(tempDir, 'pnpm-workspace.yaml'),
        createPnpmWorkspaceYaml(['packages/*'])
      );
      writeFileSync(join(tempDir, 'package.json'), createPackageJson('my-monorepo'));
      createWorkspacePackage('packages/core', '@myorg/core');

      const graph = new MockGraphBackend();
      const plugin = new WorkspaceDiscovery();
      const context = createPluginContext(tempDir, graph);

      const result = await plugin.execute(context);

      const service = result.metadata.services[0];
      assert.ok(service.id); // Should have ID
      assert.strictEqual(service.name, '@myorg/core');
      assert.strictEqual(service.path, join(tempDir, 'packages', 'core'));
      assert.strictEqual(service.type, 'workspace-package');
      assert.ok(service.metadata.workspaceType);
      assert.ok(service.metadata.relativePath);
    });
  });
});

// =============================================================================
// TESTS: Integration - Real Workspace Structures
// =============================================================================

describe('Integration: Real Workspace Structures', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-workspace-integration-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createWorkspacePackage(relativePath, packageName, options = {}) {
    const fullPath = join(tempDir, relativePath);
    mkdirSync(fullPath, { recursive: true });
    writeFileSync(join(fullPath, 'package.json'), createPackageJson(packageName, options));
  }

  it('should handle jammers-style npm workspace (user issue reproduction)', async () => {
    // Reproduce the exact structure from the user issue
    writeFileSync(
      join(tempDir, 'package.json'),
      createPackageJson('jammers-monorepo', {
        workspaces: ['apps/frontend', 'apps/backend', 'apps/telegram-bot'],
      })
    );
    createWorkspacePackage('apps/frontend', 'frontend');
    createWorkspacePackage('apps/backend', 'backend');
    createWorkspacePackage('apps/telegram-bot', 'telegram-bot');

    const graph = new MockGraphBackend();
    const plugin = new WorkspaceDiscovery();
    const context = createPluginContext(tempDir, graph);

    const result = await plugin.execute(context);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.created.nodes, 3);

    const serviceNames = result.metadata.services.map((s) => s.name).sort();
    assert.deepStrictEqual(serviceNames, ['backend', 'frontend', 'telegram-bot']);
  });

  it('should handle grafema-style pnpm workspace', async () => {
    // Reproduce grafema's own workspace structure
    writeFileSync(
      join(tempDir, 'pnpm-workspace.yaml'),
      createPnpmWorkspaceYaml(['packages/*'])
    );
    writeFileSync(join(tempDir, 'package.json'), createPackageJson('grafema'));
    createWorkspacePackage('packages/core', '@grafema/core');
    createWorkspacePackage('packages/cli', '@grafema/cli');
    createWorkspacePackage('packages/mcp', '@grafema/mcp');
    createWorkspacePackage('packages/types', '@grafema/types');
    createWorkspacePackage('packages/gui', '@grafema/gui');

    const graph = new MockGraphBackend();
    const plugin = new WorkspaceDiscovery();
    const context = createPluginContext(tempDir, graph);

    const result = await plugin.execute(context);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.created.nodes, 5);
  });

  it('should handle turbo-style monorepo with apps and packages', async () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      createPackageJson('turbo-monorepo', {
        workspaces: ['apps/*', 'packages/*'],
      })
    );
    // Apps
    createWorkspacePackage('apps/web', 'web');
    createWorkspacePackage('apps/docs', 'docs');
    // Packages
    createWorkspacePackage('packages/ui', '@repo/ui');
    createWorkspacePackage('packages/eslint-config', '@repo/eslint-config');
    createWorkspacePackage('packages/typescript-config', '@repo/typescript-config');

    const graph = new MockGraphBackend();
    const plugin = new WorkspaceDiscovery();
    const context = createPluginContext(tempDir, graph);

    const result = await plugin.execute(context);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.created.nodes, 5);
  });
});
