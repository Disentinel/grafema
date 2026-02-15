/**
 * PackageCoverageValidator Tests (REG-259)
 *
 * Tests that PackageCoverageValidator creates ISSUE nodes for external
 * packages imported but not covered by any loaded analysis plugin.
 *
 * The validator:
 * 1. Reads coveredPackages (Set<string>) from ResourceRegistry
 * 2. Queries IMPORT nodes for external packages
 * 3. Extracts package names (handles scoped packages, subpath imports)
 * 4. Filters out Node.js built-in modules
 * 5. Creates one ISSUE per unique uncovered package
 * 6. Reports summary in result metadata
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  PackageCoverageValidator,
  ResourceRegistryImpl,
  COVERED_PACKAGES_RESOURCE_ID,
  createCoveredPackagesResource,
} from '@grafema/core';

// =============================================================================
// MOCK GRAPH BACKEND
// =============================================================================

class MockGraphBackend {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
  }

  addNode(node) {
    this.nodes.set(node.id, node);
  }

  async addEdge(edge) {
    this.edges.push(edge);
  }

  async *queryNodes(filter) {
    for (const node of this.nodes.values()) {
      if (filter?.type && node.type !== filter.type) continue;
      if (filter?.nodeType && node.type !== filter.nodeType) continue;
      yield node;
    }
  }

  async getIncomingEdges(nodeId, edgeTypes = null) {
    return this.edges.filter(e => {
      if (e.dst !== nodeId) return false;
      if (edgeTypes && !edgeTypes.includes(e.type)) return false;
      return true;
    });
  }

  async getOutgoingEdges(nodeId, edgeTypes = null) {
    return this.edges.filter(e => {
      if (e.src !== nodeId) return false;
      if (edgeTypes && !edgeTypes.includes(e.type)) return false;
      return true;
    });
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function createMockReportIssue() {
  const issues = [];
  const reportIssue = async (issue) => {
    issues.push(issue);
    return `issue:coverage#mock-${issues.length}`;
  };
  return { reportIssue, issues };
}

/**
 * Create a ResourceRegistry with a coveredPackages resource.
 * @param {string[]} packageNames - packages declared as covered by plugins
 * @returns {ResourceRegistryImpl}
 */
function createResourcesWithCoverage(packageNames) {
  const registry = new ResourceRegistryImpl();
  const coveredSet = new Set(packageNames);
  registry.getOrCreate(COVERED_PACKAGES_RESOURCE_ID, () =>
    createCoveredPackagesResource(coveredSet)
  );
  return registry;
}

/**
 * Add an external IMPORT node to the mock graph.
 */
function addExternalImport(graph, { id, source, file, line }) {
  graph.addNode({
    id: id || `import:${source}:${file}:${line || 1}`,
    type: 'IMPORT',
    source,
    file,
    line: line || 1,
    importType: 'default',
    local: source.split('/').pop(),
    name: source.split('/').pop(),
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('PackageCoverageValidator', () => {

  // ===========================================================================
  // HAPPY PATH
  // ===========================================================================

  describe('Happy Path', () => {

    it('should create no issues when there are no external imports', async () => {
      const graph = new MockGraphBackend();
      const resources = createResourcesWithCoverage(['sqlite3']);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 0);
      assert.strictEqual(result.metadata.summary.importedPackages, 0);
      assert.strictEqual(result.metadata.summary.uncoveredPackages, 0);
    });

    it('should create no issues when all packages are covered', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'sqlite3', file: 'db.js' });
      addExternalImport(graph, { source: 'express', file: 'app.js' });

      const resources = createResourcesWithCoverage(['sqlite3', 'express']);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 0);
      assert.strictEqual(result.metadata.summary.importedPackages, 2);
      assert.strictEqual(result.metadata.summary.coveredPackages, 2);
      assert.strictEqual(result.metadata.summary.uncoveredPackages, 0);
    });

    it('should create one ISSUE for one uncovered package', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'sqlite3', file: 'db.js' });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 1);
      assert.strictEqual(issues[0].category, 'coverage');
      assert.strictEqual(issues[0].severity, 'warning');
      assert.ok(issues[0].message.includes('sqlite3'));
      assert.strictEqual(result.metadata.summary.uncoveredPackages, 1);
    });

    it('should create one ISSUE per unique uncovered package', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'sqlite3', file: 'db.js' });
      addExternalImport(graph, { source: '@prisma/client', file: 'orm.js' });
      addExternalImport(graph, { source: 'pg', file: 'postgres.js' });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 3);
      assert.strictEqual(result.metadata.summary.uncoveredPackages, 3);

      // Verify each package got its own issue
      const packageNames = issues.map(i => i.context?.packageName);
      assert.ok(packageNames.includes('sqlite3'));
      assert.ok(packageNames.includes('@prisma/client'));
      assert.ok(packageNames.includes('pg'));
    });
  });

  // ===========================================================================
  // FILTERING
  // ===========================================================================

  describe('Filtering', () => {

    it('should filter out Node.js built-in modules', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'fs', file: 'app.js' });
      addExternalImport(graph, { source: 'path', file: 'app.js' });
      addExternalImport(graph, { source: 'http', file: 'server.js' });
      addExternalImport(graph, { source: 'crypto', file: 'auth.js' });
      addExternalImport(graph, { source: 'events', file: 'bus.js' });
      addExternalImport(graph, { source: 'stream', file: 'pipe.js' });
      addExternalImport(graph, { source: 'util', file: 'helpers.js' });
      addExternalImport(graph, { source: 'os', file: 'system.js' });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 0,
        'Node.js built-in modules should not create coverage issues');
    });

    it('should filter out Node.js built-in modules with node: prefix', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'node:fs', file: 'app.js' });
      addExternalImport(graph, { source: 'node:path', file: 'app.js' });
      addExternalImport(graph, { source: 'node:http', file: 'server.js' });
      addExternalImport(graph, { source: 'node:test', file: 'test.js' });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 0,
        'Node.js built-ins with node: prefix should not create coverage issues');
    });

    it('should correctly extract scoped package names', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: '@prisma/client', file: 'db.js' });
      addExternalImport(graph, { source: '@tanstack/react-query', file: 'api.js' });

      const resources = createResourcesWithCoverage(['@prisma/client']);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      // @prisma/client is covered, @tanstack/react-query is not
      assert.strictEqual(issues.length, 1);
      assert.strictEqual(issues[0].context?.packageName, '@tanstack/react-query');
    });

    it('should extract base package name from subpath imports', async () => {
      const graph = new MockGraphBackend();
      // lodash/map should be treated as package 'lodash'
      addExternalImport(graph, { source: 'lodash/map', file: 'utils.js' });
      // lodash/filter is the same package
      addExternalImport(graph, { source: 'lodash/filter', file: 'utils.js' });

      const resources = createResourcesWithCoverage(['lodash']);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 0,
        'Subpath imports should resolve to base package name (lodash)');
    });

    it('should extract scoped package from scoped subpath imports', async () => {
      const graph = new MockGraphBackend();
      // @prisma/client/runtime/library → package is @prisma/client
      addExternalImport(graph, { source: '@prisma/client/runtime/library', file: 'db.js' });

      const resources = createResourcesWithCoverage(['@prisma/client']);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 0,
        'Scoped subpath import should resolve to scoped package name');
    });

    it('should skip relative imports', async () => {
      const graph = new MockGraphBackend();
      // Relative imports are NOT external
      graph.addNode({
        id: 'import:relative-1',
        type: 'IMPORT',
        source: './utils',
        file: 'app.js',
        line: 1,
      });
      graph.addNode({
        id: 'import:relative-2',
        type: 'IMPORT',
        source: '../lib/helper',
        file: 'app.js',
        line: 2,
      });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 0,
        'Relative imports should not be treated as external packages');
    });

    it('should skip absolute path imports', async () => {
      const graph = new MockGraphBackend();
      graph.addNode({
        id: 'import:absolute',
        type: 'IMPORT',
        source: '/usr/local/lib/custom',
        file: 'app.js',
        line: 1,
      });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 0,
        'Absolute path imports should not be treated as external packages');
    });
  });

  // ===========================================================================
  // EDGE CASES
  // ===========================================================================

  describe('Edge Cases', () => {

    it('should create only one issue per unique package even if imported in multiple files', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, {
        id: 'import:sqlite3:db1',
        source: 'sqlite3',
        file: 'db/connection.js',
        line: 1,
      });
      addExternalImport(graph, {
        id: 'import:sqlite3:db2',
        source: 'sqlite3',
        file: 'db/queries.js',
        line: 1,
      });
      addExternalImport(graph, {
        id: 'import:sqlite3:db3',
        source: 'sqlite3',
        file: 'db/migration.js',
        line: 1,
      });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 1,
        'Should create only ONE issue per unique uncovered package, not per file');
      assert.strictEqual(issues[0].context?.packageName, 'sqlite3');
    });

    it('should create no issue for a covered package that is not imported', async () => {
      const graph = new MockGraphBackend();
      // No imports at all, but sqlite3 is covered
      const resources = createResourcesWithCoverage(['sqlite3', 'express']);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 0,
        'Covered but not imported packages should not create issues');
    });

    it('should handle empty graph without errors', async () => {
      const graph = new MockGraphBackend();
      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 0);
      assert.strictEqual(result.metadata.summary.importedPackages, 0);
      assert.strictEqual(result.metadata.summary.uncoveredPackages, 0);
    });

    it('should treat missing coveredPackages resource as empty set', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'sqlite3', file: 'db.js' });

      // ResourceRegistry without coveredPackages resource
      const resources = new ResourceRegistryImpl();
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      // sqlite3 should be reported as uncovered (no builtins in this test)
      assert.strictEqual(issues.length, 1);
      assert.strictEqual(issues[0].context?.packageName, 'sqlite3');
    });

    it('should handle context without resources (no ResourceRegistry)', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'sqlite3', file: 'db.js' });

      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      // No resources on context at all
      const result = await plugin.execute({ graph, reportIssue });

      assert.ok(result.success);
      // Should still work — treats as empty coverage set
      assert.strictEqual(issues.length, 1);
    });

    it('should work when reportIssue is not available (no-op)', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'sqlite3', file: 'db.js' });

      const resources = createResourcesWithCoverage([]);

      const plugin = new PackageCoverageValidator();
      // No reportIssue on context
      const result = await plugin.execute({ graph, resources });

      assert.ok(result.success);
      // Should still track uncovered count even without reportIssue
      assert.strictEqual(result.metadata.summary.uncoveredPackages, 1);
    });
  });

  // ===========================================================================
  // ISSUE NODE CONTENT
  // ===========================================================================

  describe('ISSUE Node Content', () => {

    it('should set issue category to "coverage"', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'sqlite3', file: 'db.js' });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      await plugin.execute({ graph, reportIssue, resources });

      assert.strictEqual(issues[0].category, 'coverage');
    });

    it('should set issue severity to "warning"', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'sqlite3', file: 'db.js' });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      await plugin.execute({ graph, reportIssue, resources });

      assert.strictEqual(issues[0].severity, 'warning');
    });

    it('should include packageName in issue context', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'sqlite3', file: 'db.js' });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      await plugin.execute({ graph, reportIssue, resources });

      assert.ok(issues[0].context);
      assert.strictEqual(issues[0].context.packageName, 'sqlite3');
    });

    it('should include descriptive message with package name', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: '@tanstack/react-query', file: 'api.js' });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      await plugin.execute({ graph, reportIssue, resources });

      assert.ok(issues[0].message.includes('@tanstack/react-query'),
        'Issue message should include the uncovered package name');
    });

    it('should set issue type to UNCOVERED_PACKAGE in context', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'pg', file: 'db.js' });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      await plugin.execute({ graph, reportIssue, resources });

      assert.strictEqual(issues[0].context?.type, 'UNCOVERED_PACKAGE');
    });
  });

  // ===========================================================================
  // RESULT METADATA / SUMMARY
  // ===========================================================================

  describe('Result Metadata / Summary', () => {

    it('should include summary with correct counts', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'sqlite3', file: 'db.js' });
      addExternalImport(graph, { source: 'express', file: 'app.js' });
      addExternalImport(graph, { source: 'pg', file: 'postgres.js' });

      const resources = createResourcesWithCoverage(['express']);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.metadata.summary);
      assert.strictEqual(result.metadata.summary.importedPackages, 3);
      assert.strictEqual(result.metadata.summary.coveredPackages, 1);
      assert.strictEqual(result.metadata.summary.uncoveredPackages, 2);
      assert.strictEqual(result.metadata.summary.issuesCreated, 2);
    });

    it('should not count builtins as imported packages in summary', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'fs', file: 'app.js' });
      addExternalImport(graph, { source: 'path', file: 'app.js' });
      addExternalImport(graph, { source: 'sqlite3', file: 'db.js' });

      const resources = createResourcesWithCoverage(['sqlite3']);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      // Builtins should be excluded from imported count
      assert.strictEqual(result.metadata.summary.importedPackages, 1,
        'Built-in modules should not count as imported packages in summary');
      assert.strictEqual(result.metadata.summary.uncoveredPackages, 0);
    });

    it('should return success even when uncovered packages found', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'sqlite3', file: 'db.js' });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success,
        'Validator should return success=true even when issues are found');
    });
  });

  // ===========================================================================
  // PLUGIN METADATA
  // ===========================================================================

  describe('Plugin Metadata', () => {

    it('should declare phase as VALIDATION', () => {
      const plugin = new PackageCoverageValidator();
      assert.strictEqual(plugin.metadata.phase, 'VALIDATION');
    });

    it('should declare name as PackageCoverageValidator', () => {
      const plugin = new PackageCoverageValidator();
      assert.strictEqual(plugin.metadata.name, 'PackageCoverageValidator');
    });

    it('should declare ISSUE node creation', () => {
      const plugin = new PackageCoverageValidator();
      assert.ok(plugin.metadata.creates?.nodes?.includes('ISSUE'));
    });

    it('should declare AFFECTS edge creation', () => {
      const plugin = new PackageCoverageValidator();
      assert.ok(plugin.metadata.creates?.edges?.includes('AFFECTS'));
    });
  });

  // ===========================================================================
  // MIXED SCENARIOS
  // ===========================================================================

  describe('Mixed Scenarios', () => {

    it('should handle mix of builtins, covered, and uncovered packages', async () => {
      const graph = new MockGraphBackend();
      // Builtins
      addExternalImport(graph, { source: 'fs', file: 'app.js' });
      addExternalImport(graph, { source: 'node:path', file: 'app.js' });
      // Covered
      addExternalImport(graph, { source: 'sqlite3', file: 'db.js' });
      addExternalImport(graph, { source: 'express', file: 'server.js' });
      // Uncovered
      addExternalImport(graph, { source: '@prisma/client', file: 'orm.js' });
      addExternalImport(graph, { source: 'pg', file: 'postgres.js' });

      const resources = createResourcesWithCoverage(['sqlite3', 'express']);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      // Only uncovered packages should produce issues
      assert.strictEqual(issues.length, 2);

      const packageNames = issues.map(i => i.context?.packageName).sort();
      assert.deepStrictEqual(packageNames, ['@prisma/client', 'pg']);
    });

    it('should deduplicate subpath imports to same base package', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, {
        id: 'import:lodash-map',
        source: 'lodash/map',
        file: 'a.js',
      });
      addExternalImport(graph, {
        id: 'import:lodash-filter',
        source: 'lodash/filter',
        file: 'b.js',
      });
      addExternalImport(graph, {
        id: 'import:lodash-reduce',
        source: 'lodash/reduce',
        file: 'c.js',
      });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      // lodash/map, lodash/filter, lodash/reduce all resolve to 'lodash'
      assert.strictEqual(issues.length, 1,
        'Multiple subpath imports of same package should produce only one issue');
      assert.strictEqual(issues[0].context?.packageName, 'lodash');
    });

    it('should handle imports without source field gracefully', async () => {
      const graph = new MockGraphBackend();
      graph.addNode({
        id: 'import:no-source',
        type: 'IMPORT',
        file: 'app.js',
        line: 1,
        // No source field
      });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 0,
        'IMPORT nodes without source should be skipped gracefully');
    });

    it('should handle imports without file field gracefully', async () => {
      const graph = new MockGraphBackend();
      graph.addNode({
        id: 'import:no-file',
        type: 'IMPORT',
        source: 'sqlite3',
        line: 1,
        // No file field
      });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      // Should still detect sqlite3 as uncovered even without file
      // (validator should be resilient to missing fields)
    });
  });

  // ===========================================================================
  // ADDITIONAL NODE.JS BUILTIN MODULES
  // ===========================================================================

  describe('Additional Node.js Builtins', () => {

    it('should filter less common Node.js builtins', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'child_process', file: 'spawn.js' });
      addExternalImport(graph, { source: 'cluster', file: 'worker.js' });
      addExternalImport(graph, { source: 'net', file: 'tcp.js' });
      addExternalImport(graph, { source: 'dns', file: 'resolve.js' });
      addExternalImport(graph, { source: 'tls', file: 'secure.js' });
      addExternalImport(graph, { source: 'dgram', file: 'udp.js' });
      addExternalImport(graph, { source: 'readline', file: 'cli.js' });
      addExternalImport(graph, { source: 'zlib', file: 'compress.js' });
      addExternalImport(graph, { source: 'buffer', file: 'binary.js' });
      addExternalImport(graph, { source: 'assert', file: 'test.js' });
      addExternalImport(graph, { source: 'url', file: 'parse.js' });
      addExternalImport(graph, { source: 'querystring', file: 'qs.js' });
      addExternalImport(graph, { source: 'string_decoder', file: 'decode.js' });
      addExternalImport(graph, { source: 'timers', file: 'timer.js' });
      addExternalImport(graph, { source: 'perf_hooks', file: 'perf.js' });
      addExternalImport(graph, { source: 'worker_threads', file: 'threads.js' });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 0,
        'All Node.js built-in modules should be filtered out');
    });

    it('should filter node: prefixed builtins for newer Node.js modules', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'node:crypto', file: 'auth.js' });
      addExternalImport(graph, { source: 'node:stream', file: 'pipe.js' });
      addExternalImport(graph, { source: 'node:util', file: 'fmt.js' });
      addExternalImport(graph, { source: 'node:os', file: 'sys.js' });
      addExternalImport(graph, { source: 'node:child_process', file: 'exec.js' });
      addExternalImport(graph, { source: 'node:worker_threads', file: 'pool.js' });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 0,
        'node: prefixed builtins should all be filtered');
    });

    it('should filter fs/promises subpath of builtin', async () => {
      const graph = new MockGraphBackend();
      addExternalImport(graph, { source: 'fs/promises', file: 'io.js' });

      const resources = createResourcesWithCoverage([]);
      const { reportIssue, issues } = createMockReportIssue();

      const plugin = new PackageCoverageValidator();
      const result = await plugin.execute({ graph, reportIssue, resources });

      assert.ok(result.success);
      assert.strictEqual(issues.length, 0,
        'fs/promises should resolve to builtin "fs" and be filtered');
    });
  });
});
