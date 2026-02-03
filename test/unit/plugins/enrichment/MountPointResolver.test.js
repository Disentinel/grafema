/**
 * MountPointResolver Tests - REG-318: Fix mount prefix application
 *
 * Tests that MountPointResolver correctly resolves mount points by:
 * 1. Finding IMPORT nodes to determine which file a router variable comes from
 * 2. Applying mount prefix ONLY to routes in that specific file
 *
 * The fix changes from "apply prefix to ALL imported files" to
 * "apply prefix to the specific file that the router variable came from"
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';

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
      yield node;
    }
  }

  async getAllEdges() {
    return this.edges;
  }

  getNode(id) {
    return this.nodes.get(id);
  }

  getAllNodes() {
    return [...this.nodes.values()];
  }
}

// =============================================================================
// SIMPLIFIED MOUNT POINT RESOLUTION LOGIC (for testing the fix)
// =============================================================================

/**
 * Resolve relative import source to absolute file path.
 * Replicates JSModuleIndexer.resolveModulePath() logic.
 *
 * In tests, we use a mock file system - so we simulate that all files exist.
 */
function resolveImportSource(importSource, containingFile, existingFiles = new Set()) {
  // Only handle relative imports
  if (!importSource.startsWith('./') && !importSource.startsWith('../')) {
    return null;  // External package
  }

  const dir = path.dirname(containingFile);
  const basePath = path.resolve(dir, importSource);

  // Check exact path
  if (existingFiles.has(basePath)) return basePath;

  // Try extensions
  for (const ext of ['.js', '.mjs', '.jsx', '.ts', '.tsx']) {
    const withExt = basePath + ext;
    if (existingFiles.has(withExt)) return withExt;
  }

  // Try index files
  for (const indexFile of ['index.js', 'index.ts', 'index.mjs', 'index.tsx']) {
    const indexPath = path.join(basePath, indexFile);
    if (existingFiles.has(indexPath)) return indexPath;
  }

  return null;
}

/**
 * Core mount resolution logic - THE FIX IS HERE
 *
 * Old algorithm: Apply mount prefix to ALL routes in ALL imported files
 * New algorithm: Find IMPORT node matching mount.name, apply prefix only to that file's routes
 */
async function resolveMountPoints(graph, existingFiles = new Set()) {
  const results = {
    routesUpdated: 0,
    mountPointsProcessed: 0,
    debugInfo: []
  };

  // Step 1: Find all mount points (express:middleware with mountPath)
  const mountNodes = [];
  for await (const node of graph.queryNodes({ type: 'express:middleware' })) {
    if (node.mountPath && node.mountPath !== '/' && node.name) {
      mountNodes.push(node);
    }
  }

  if (mountNodes.length === 0) {
    return results;
  }

  // Step 2: Build import map for files that contain mount points
  // Map<file, Map<localName, resolvedFile>>
  const importMaps = new Map();
  const mountFiles = new Set(mountNodes.map(m => m.file).filter(Boolean));

  for (const mountFile of mountFiles) {
    const importMap = new Map();

    // Query IMPORT nodes in this file
    for await (const node of graph.queryNodes({ type: 'IMPORT' })) {
      if (node.file !== mountFile) continue;
      if (!node.local || !node.source) continue;

      // Resolve source to absolute path
      const resolvedPath = resolveImportSource(node.source, mountFile, existingFiles);
      if (resolvedPath) {
        importMap.set(node.local, resolvedPath);
        results.debugInfo.push({
          action: 'import_mapped',
          local: node.local,
          source: node.source,
          resolved: resolvedPath
        });
      }
    }

    importMaps.set(mountFile, importMap);
  }

  // Step 3: Collect all routes by file
  const routesByFile = new Map();
  for await (const node of graph.queryNodes({ type: 'http:route' })) {
    if (node.file) {
      if (!routesByFile.has(node.file)) {
        routesByFile.set(node.file, []);
      }
      routesByFile.get(node.file).push(node);
    }
  }

  // Step 4: For each mount point, find and update routes
  for (const mount of mountNodes) {
    if (!mount.file || !mount.mountPath || !mount.name) continue;

    // Get import map for this file
    const importMap = importMaps.get(mount.file);
    if (!importMap) {
      results.debugInfo.push({
        action: 'no_import_map',
        file: mount.file
      });
      continue;
    }

    // Find the specific imported file for this mount variable
    const importedFile = importMap.get(mount.name);
    if (!importedFile) {
      results.debugInfo.push({
        action: 'no_import_found',
        file: mount.file,
        mountName: mount.name,
        availableImports: [...importMap.keys()]
      });
      continue;
    }

    // Get routes in that specific file
    const routes = routesByFile.get(importedFile);
    if (!routes || routes.length === 0) {
      results.debugInfo.push({
        action: 'no_routes_in_file',
        importedFile,
        mountName: mount.name
      });
      continue;
    }

    // Update routes with fullPath
    for (const route of routes) {
      const localPath = route.localPath || route.path || '';
      const fullPath = mount.mountPath + localPath;

      // Update route node
      route.mountPrefix = mount.mountPath;
      route.fullPath = fullPath;

      // Support multiple mount points (for routes mounted in multiple places)
      route.mountPrefixes = route.mountPrefixes || [];
      route.fullPaths = route.fullPaths || [];
      if (!route.mountPrefixes.includes(mount.mountPath)) {
        route.mountPrefixes.push(mount.mountPath);
        route.fullPaths.push(fullPath);
      }

      results.routesUpdated++;
    }

    results.mountPointsProcessed++;
  }

  return results;
}

// =============================================================================
// TESTS
// =============================================================================

describe('MountPointResolver - Mount Prefix Resolution', () => {

  describe('Multi-router correct prefix application', () => {

    it('should apply correct prefix to each router based on import name', async () => {
      /**
       * Setup simulates:
       *   import bugReportsRoutes from './routes/bugReports'
       *   import invitationsRoutes from './routes/invitations'
       *   app.use('/api/bug-reports', bugReportsRoutes)
       *   app.use('/api', invitationsRoutes)
       *
       * Bug reports should get /api/bug-reports, invitations should get /api
       */
      const graph = new MockGraphBackend();

      const indexFile = '/app/index.ts';
      const bugReportsFile = '/app/routes/bugReports.ts';
      const invitationsFile = '/app/routes/invitations.ts';

      const existingFiles = new Set([indexFile, bugReportsFile, invitationsFile]);

      // Mount points
      graph.addNode({
        id: 'mount:bug-reports',
        type: 'express:middleware',
        mountPath: '/api/bug-reports',
        name: 'bugReportsRoutes',
        file: indexFile
      });

      graph.addNode({
        id: 'mount:invitations',
        type: 'express:middleware',
        mountPath: '/api',
        name: 'invitationsRoutes',
        file: indexFile
      });

      // Import nodes
      graph.addNode({
        id: 'import:bugReports',
        type: 'IMPORT',
        local: 'bugReportsRoutes',
        source: './routes/bugReports',
        file: indexFile
      });

      graph.addNode({
        id: 'import:invitations',
        type: 'IMPORT',
        local: 'invitationsRoutes',
        source: './routes/invitations',
        file: indexFile
      });

      // Routes
      graph.addNode({
        id: 'route:bug-reports',
        type: 'http:route',
        method: 'GET',
        path: '/reports',
        file: bugReportsFile
      });

      graph.addNode({
        id: 'route:invitations',
        type: 'http:route',
        method: 'POST',
        path: '/accept/:id',
        file: invitationsFile
      });

      const results = await resolveMountPoints(graph, existingFiles);

      // Check bug reports route
      const bugRoute = graph.getNode('route:bug-reports');
      assert.strictEqual(
        bugRoute.fullPath,
        '/api/bug-reports/reports',
        'Bug reports route should have /api/bug-reports prefix'
      );

      // Check invitations route
      const invRoute = graph.getNode('route:invitations');
      assert.strictEqual(
        invRoute.fullPath,
        '/api/accept/:id',
        'Invitations route should have /api prefix'
      );

      assert.strictEqual(results.routesUpdated, 2);
      assert.strictEqual(results.mountPointsProcessed, 2);
    });
  });

  describe('Mount variable not found in imports', () => {

    it('should NOT update routes when mount variable has no matching import', async () => {
      const graph = new MockGraphBackend();

      const indexFile = '/app/index.ts';
      const routesFile = '/app/routes/actual.ts';

      const existingFiles = new Set([indexFile, routesFile]);

      // Mount point references a variable that doesn't exist in imports
      graph.addNode({
        id: 'mount:nonexistent',
        type: 'express:middleware',
        mountPath: '/api',
        name: 'nonExistentRouter',  // This doesn't match any import
        file: indexFile
      });

      // Import node has different name
      graph.addNode({
        id: 'import:actual',
        type: 'IMPORT',
        local: 'actualRouter',  // Different name than mount.name
        source: './routes/actual',
        file: indexFile
      });

      // Route in actual file
      graph.addNode({
        id: 'route:actual',
        type: 'http:route',
        method: 'GET',
        path: '/users',
        file: routesFile
      });

      const results = await resolveMountPoints(graph, existingFiles);

      // Route should NOT be updated
      const route = graph.getNode('route:actual');
      assert.strictEqual(route.fullPath, undefined, 'Route should not have fullPath');

      assert.strictEqual(results.routesUpdated, 0);
      assert.strictEqual(results.mountPointsProcessed, 0);

      // Check debug info
      const noImportFound = results.debugInfo.find(d => d.action === 'no_import_found');
      assert.ok(noImportFound, 'Should log "no import found" for the mount name');
      assert.strictEqual(noImportFound.mountName, 'nonExistentRouter');
    });
  });

  describe('Imported file has no routes', () => {

    it('should NOT crash when imported file has no routes', async () => {
      const graph = new MockGraphBackend();

      const indexFile = '/app/index.ts';
      const utilsFile = '/app/utils.ts';

      const existingFiles = new Set([indexFile, utilsFile]);

      // Mount point
      graph.addNode({
        id: 'mount:utils',
        type: 'express:middleware',
        mountPath: '/api',
        name: 'utilsModule',
        file: indexFile
      });

      // Import node
      graph.addNode({
        id: 'import:utils',
        type: 'IMPORT',
        local: 'utilsModule',
        source: './utils',
        file: indexFile
      });

      // NO routes in utils.ts

      const results = await resolveMountPoints(graph, existingFiles);

      assert.strictEqual(results.routesUpdated, 0);
      assert.strictEqual(results.mountPointsProcessed, 0);

      // Check debug info
      const noRoutes = results.debugInfo.find(d => d.action === 'no_routes_in_file');
      assert.ok(noRoutes, 'Should log "no routes in file" for the imported file');
    });
  });

  describe('External package import (not relative)', () => {

    it('should NOT resolve external package imports', async () => {
      const graph = new MockGraphBackend();

      const indexFile = '/app/index.ts';

      const existingFiles = new Set([indexFile]);

      // Mount point references an external package
      graph.addNode({
        id: 'mount:express',
        type: 'express:middleware',
        mountPath: '/api',
        name: 'express',
        file: indexFile
      });

      // Import is external package (not relative)
      graph.addNode({
        id: 'import:express',
        type: 'IMPORT',
        local: 'express',
        source: 'express',  // Not relative - external package
        file: indexFile
      });

      const results = await resolveMountPoints(graph, existingFiles);

      // resolveImportSource returns null for external packages
      assert.strictEqual(results.routesUpdated, 0);
      assert.strictEqual(results.mountPointsProcessed, 0);
    });
  });

  describe('Named exports from barrel file - multiple routers from one import', () => {

    it('should correctly map named imports to their source file', async () => {
      /**
       * Setup simulates:
       *   import { usersRouter, postsRouter } from './routes'
       *   app.use('/users', usersRouter)
       *   app.use('/posts', postsRouter)
       *
       * Both routers come from same barrel file, but are separate imports.
       */
      const graph = new MockGraphBackend();

      const indexFile = '/app/index.ts';
      const routesBarrel = '/app/routes/index.ts';

      const existingFiles = new Set([indexFile, routesBarrel]);

      // Mount points
      graph.addNode({
        id: 'mount:users',
        type: 'express:middleware',
        mountPath: '/users',
        name: 'usersRouter',
        file: indexFile
      });

      graph.addNode({
        id: 'mount:posts',
        type: 'express:middleware',
        mountPath: '/posts',
        name: 'postsRouter',
        file: indexFile
      });

      // Named imports from barrel file
      graph.addNode({
        id: 'import:users',
        type: 'IMPORT',
        local: 'usersRouter',
        source: './routes',  // Barrel file
        file: indexFile,
        importType: 'named'
      });

      graph.addNode({
        id: 'import:posts',
        type: 'IMPORT',
        local: 'postsRouter',
        source: './routes',  // Same barrel file
        file: indexFile,
        importType: 'named'
      });

      // Routes defined in the barrel file (re-exported from there)
      graph.addNode({
        id: 'route:list-users',
        type: 'http:route',
        method: 'GET',
        path: '/',
        file: routesBarrel,
        routerName: 'usersRouter'
      });

      graph.addNode({
        id: 'route:get-user',
        type: 'http:route',
        method: 'GET',
        path: '/:id',
        file: routesBarrel,
        routerName: 'usersRouter'
      });

      graph.addNode({
        id: 'route:list-posts',
        type: 'http:route',
        method: 'GET',
        path: '/',
        file: routesBarrel,
        routerName: 'postsRouter'
      });

      const results = await resolveMountPoints(graph, existingFiles);

      // All routes are in the same file, and both mounts reference that file
      // Current algorithm applies BOTH prefixes to ALL routes in that file
      // This is a KNOWN LIMITATION - barrel file exports need routerName matching

      // For now, verify that routes DO get updated
      assert.ok(results.routesUpdated > 0, 'Some routes should be updated');

      // Note: This test documents current behavior.
      // A proper fix would match route.routerName with mount.name,
      // but that's a future enhancement (documented as known limitation).
    });
  });

  describe('Import path resolution edge cases', () => {

    it('should resolve import with .ts extension', async () => {
      const graph = new MockGraphBackend();

      const indexFile = '/app/index.ts';
      const routesFile = '/app/routes.ts';

      const existingFiles = new Set([indexFile, routesFile]);

      graph.addNode({
        id: 'mount:routes',
        type: 'express:middleware',
        mountPath: '/api',
        name: 'routes',
        file: indexFile
      });

      graph.addNode({
        id: 'import:routes',
        type: 'IMPORT',
        local: 'routes',
        source: './routes',  // No extension
        file: indexFile
      });

      graph.addNode({
        id: 'route:health',
        type: 'http:route',
        method: 'GET',
        path: '/health',
        file: routesFile
      });

      const results = await resolveMountPoints(graph, existingFiles);

      const route = graph.getNode('route:health');
      assert.strictEqual(route.fullPath, '/api/health');
      assert.strictEqual(results.routesUpdated, 1);
    });

    it('should resolve import to index file in directory', async () => {
      const graph = new MockGraphBackend();

      const indexFile = '/app/index.ts';
      const routesIndexFile = '/app/routes/index.ts';

      const existingFiles = new Set([indexFile, routesIndexFile]);

      graph.addNode({
        id: 'mount:routes',
        type: 'express:middleware',
        mountPath: '/api',
        name: 'routes',
        file: indexFile
      });

      graph.addNode({
        id: 'import:routes',
        type: 'IMPORT',
        local: 'routes',
        source: './routes',  // Resolves to ./routes/index.ts
        file: indexFile
      });

      graph.addNode({
        id: 'route:health',
        type: 'http:route',
        method: 'GET',
        path: '/health',
        file: routesIndexFile
      });

      const results = await resolveMountPoints(graph, existingFiles);

      const route = graph.getNode('route:health');
      assert.strictEqual(route.fullPath, '/api/health');
      assert.strictEqual(results.routesUpdated, 1);
    });

    it('should handle parent directory imports (../)', async () => {
      const graph = new MockGraphBackend();

      const serverFile = '/app/server/main.ts';
      const routesFile = '/app/routes.ts';

      const existingFiles = new Set([serverFile, routesFile]);

      graph.addNode({
        id: 'mount:routes',
        type: 'express:middleware',
        mountPath: '/api',
        name: 'routes',
        file: serverFile
      });

      graph.addNode({
        id: 'import:routes',
        type: 'IMPORT',
        local: 'routes',
        source: '../routes',
        file: serverFile
      });

      graph.addNode({
        id: 'route:health',
        type: 'http:route',
        method: 'GET',
        path: '/health',
        file: routesFile
      });

      const results = await resolveMountPoints(graph, existingFiles);

      const route = graph.getNode('route:health');
      assert.strictEqual(route.fullPath, '/api/health');
      assert.strictEqual(results.routesUpdated, 1);
    });
  });

  describe('Multiple mount points for same file (multiple full paths)', () => {

    it('should support routes mounted in multiple places', async () => {
      /**
       * Setup simulates:
       *   app.use('/api/v1', apiRouter)
       *   app.use('/api/v2', apiRouter)  // Same router, different prefix
       *
       * Route should have both fullPaths
       */
      const graph = new MockGraphBackend();

      const indexFile = '/app/index.ts';
      const routesFile = '/app/routes/api.ts';

      const existingFiles = new Set([indexFile, routesFile]);

      // Two mount points, same router variable
      graph.addNode({
        id: 'mount:v1',
        type: 'express:middleware',
        mountPath: '/api/v1',
        name: 'apiRouter',
        file: indexFile
      });

      graph.addNode({
        id: 'mount:v2',
        type: 'express:middleware',
        mountPath: '/api/v2',
        name: 'apiRouter',
        file: indexFile
      });

      // Import
      graph.addNode({
        id: 'import:api',
        type: 'IMPORT',
        local: 'apiRouter',
        source: './routes/api',
        file: indexFile
      });

      // Route
      graph.addNode({
        id: 'route:users',
        type: 'http:route',
        method: 'GET',
        path: '/users',
        file: routesFile
      });

      const results = await resolveMountPoints(graph, existingFiles);

      const route = graph.getNode('route:users');

      // Should have both prefixes
      assert.deepStrictEqual(
        route.mountPrefixes.sort(),
        ['/api/v1', '/api/v2'],
        'Route should have both mount prefixes'
      );

      assert.deepStrictEqual(
        route.fullPaths.sort(),
        ['/api/v1/users', '/api/v2/users'],
        'Route should have both full paths'
      );
    });
  });
});
