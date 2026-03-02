/**
 * Tests for ExpressPlugin domain analyzer (REG-591, Commit 4)
 *
 * ExpressPlugin implements the DomainPlugin interface. It scans FileResult
 * for Express.js patterns and creates domain-specific nodes:
 *
 *   - http:route  — route registration (app.get, app.post, etc.)
 *   - express:mount — router mounting (app.use)
 *
 * Detection is data-flow based: a variable must be assigned from express()
 * or express.Router() to be recognized as an Express instance. This avoids
 * false positives from variables named 'app' that are not Express apps.
 *
 * The plugin reads argValues metadata from CALL nodes (from Commit 1) to
 * extract route paths without re-parsing the AST.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { walkFile, jsRegistry } from '../../packages/core-v2/dist/index.js';
import { ExpressPlugin } from '../../packages/core/dist/plugins/domain/index.js';

/**
 * Helper: walk code with ExpressPlugin and return the FileResult.
 */
async function walkWithExpress(code, file = 'src/app.ts') {
  return walkFile(code, file, jsRegistry, { domainPlugins: [new ExpressPlugin()] });
}

/**
 * Helper: find all nodes of a given type in the result.
 */
function findNodesByType(result, type) {
  return result.nodes.filter(n => n.type === type);
}

/**
 * Helper: find edges of a given type targeting a specific node.
 */
function findEdgesTo(result, type, dstId) {
  return result.edges.filter(e => e.type === type && e.dst === dstId);
}

describe('ExpressPlugin (REG-591)', () => {

  // ==========================================================================
  // Basic route detection
  // ==========================================================================

  describe('Basic route detection', () => {
    it('should detect GET route via app.get()', async () => {
      const code = `
        import express from 'express';
        const app = express();
        app.get('/users', handler);
      `;
      const result = await walkWithExpress(code);

      const routeNodes = findNodesByType(result, 'http:route');
      assert.ok(routeNodes.length >= 1, 'Should create at least one http:route node');

      const routeNode = routeNodes[0];
      assert.equal(routeNode.metadata.method, 'GET');
      assert.equal(routeNode.metadata.path, '/users');
      assert.equal(routeNode.metadata.mountedOn, 'app');

      // EXPOSES edge from MODULE to route
      const exposesEdges = findEdgesTo(result, 'EXPOSES', routeNode.id);
      assert.ok(exposesEdges.length >= 1, 'Should have EXPOSES edge from MODULE to http:route');
    });
  });

  // ==========================================================================
  // Non-standard variable name (data flow approach)
  // ==========================================================================

  describe('Non-standard variable name', () => {
    it('should detect route when Express app has non-standard variable name', async () => {
      const code = `
        import express from 'express';
        const server = express();
        server.get('/users', handler);
      `;
      const result = await walkWithExpress(code);

      const routeNodes = findNodesByType(result, 'http:route');
      assert.ok(routeNodes.length >= 1, 'Should detect route on non-standard variable name');
      assert.equal(routeNodes[0].metadata.method, 'GET');
      assert.equal(routeNodes[0].metadata.path, '/users');
      assert.equal(routeNodes[0].metadata.mountedOn, 'server');
    });
  });

  // ==========================================================================
  // Router detection
  // ==========================================================================

  describe('Router detection', () => {
    it('should detect route on variable assigned from express.Router()', async () => {
      const code = `
        import express from 'express';
        const myRouter = express.Router();
        myRouter.get('/items', handler);
      `;
      const result = await walkWithExpress(code, 'src/routes.ts');

      const routeNodes = findNodesByType(result, 'http:route');
      assert.ok(routeNodes.length >= 1, 'Should detect route on express.Router() variable');
      assert.equal(routeNodes[0].metadata.mountedOn, 'myRouter');
    });
  });

  // ==========================================================================
  // Non-Express object guard (data flow)
  // ==========================================================================

  describe('Non-Express object guard', () => {
    it('should NOT create routes for non-express objects even if named app', async () => {
      const code = `
        const app = {};
        app.get('/users', handler);
      `;
      const result = await walkWithExpress(code, 'src/other.ts');

      const routeNodes = findNodesByType(result, 'http:route');
      assert.equal(routeNodes.length, 0, 'No http:route for non-express object');
    });

    it('should NOT create routes when express is imported but app is a plain object', async () => {
      const code = `
        import express from 'express';
        const app = {};
        app.get('/users', handler);
      `;
      const result = await walkWithExpress(code, 'src/other.ts');

      const routeNodes = findNodesByType(result, 'http:route');
      assert.equal(routeNodes.length, 0, 'No routes for non-express variable even with express import');
    });
  });

  // ==========================================================================
  // All HTTP methods
  // ==========================================================================

  describe('All HTTP methods', () => {
    const methods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all'];

    for (const method of methods) {
      it(`should detect ${method.toUpperCase()} route via app.${method}()`, async () => {
        const code = `
          import express from 'express';
          const app = express();
          app.${method}('/path', handler);
        `;
        const result = await walkWithExpress(code);

        const routeNodes = findNodesByType(result, 'http:route');
        assert.ok(routeNodes.length >= 1, `Should create http:route for app.${method}`);

        const expectedMethod = method === 'all' ? 'ALL' : method.toUpperCase();
        assert.equal(routeNodes[0].metadata.method, expectedMethod);
      });
    }
  });

  // ==========================================================================
  // app.use() with path (mount point)
  // ==========================================================================

  describe('app.use() with path', () => {
    it('should create express:mount node with prefix', async () => {
      const code = `
        import express from 'express';
        const app = express();
        app.use('/api', router);
      `;
      const result = await walkWithExpress(code);

      const mountNodes = findNodesByType(result, 'express:mount');
      assert.ok(mountNodes.length >= 1, 'Should create express:mount node');
      assert.equal(mountNodes[0].metadata.prefix, '/api');

      // MOUNTS edge from MODULE
      const mountsEdges = findEdgesTo(result, 'MOUNTS', mountNodes[0].id);
      assert.ok(mountsEdges.length >= 1, 'Should have MOUNTS edge from MODULE');
    });
  });

  // ==========================================================================
  // app.use() without path (global middleware)
  // ==========================================================================

  describe('app.use() without path', () => {
    it('should create express:mount node with path / for global middleware', async () => {
      const code = `
        import express from 'express';
        const app = express();
        app.use(middleware);
      `;
      const result = await walkWithExpress(code);

      const mountNodes = findNodesByType(result, 'express:mount');
      assert.ok(mountNodes.length >= 1, 'Should create express:mount node for global middleware');
      assert.equal(mountNodes[0].metadata.prefix, '/');
    });
  });

  // ==========================================================================
  // Route path from argValues
  // ==========================================================================

  describe('Route path extraction', () => {
    it('should extract route path from argValues', async () => {
      const code = `
        import express from 'express';
        const app = express();
        app.get('/users/:id', getUser);
      `;
      const result = await walkWithExpress(code);

      const routeNodes = findNodesByType(result, 'http:route');
      assert.ok(routeNodes.length >= 1, 'Should create http:route node');
      assert.equal(routeNodes[0].metadata.path, '/users/:id');
    });

    it('should skip route when path is dynamic (non-string first arg)', async () => {
      const code = `
        import express from 'express';
        const app = express();
        app.get(pathVariable, handler);
      `;
      const result = await walkWithExpress(code);

      const routeNodes = findNodesByType(result, 'http:route');
      assert.equal(routeNodes.length, 0, 'No route node when path is a variable');
    });
  });

  // ==========================================================================
  // Alias chain detection
  // ==========================================================================

  describe('Alias chain detection', () => {
    it('should detect routes on aliased Express variable', async () => {
      const code = `
        import express from 'express';
        const app = express();
        const server = app;
        server.get('/ping', handler);
      `;
      const result = await walkWithExpress(code);

      const routeNodes = findNodesByType(result, 'http:route');
      assert.ok(routeNodes.length >= 1, 'Should detect route on aliased variable');
      assert.equal(routeNodes[0].metadata.mountedOn, 'server');
    });
  });

  // ==========================================================================
  // CommonJS require pattern
  // ==========================================================================

  describe('CommonJS require pattern', () => {
    it('should detect routes with require("express") pattern', async () => {
      const code = `
        const express = require('express');
        const app = express();
        app.get('/users', handler);
      `;
      const result = await walkWithExpress(code);

      const routeNodes = findNodesByType(result, 'http:route');
      assert.ok(routeNodes.length >= 1, 'Should detect route with CommonJS require');
      assert.equal(routeNodes[0].metadata.method, 'GET');
      assert.equal(routeNodes[0].metadata.path, '/users');
    });
  });

  // ==========================================================================
  // Empty result for non-express files
  // ==========================================================================

  describe('Non-express files', () => {
    it('should return no domain nodes for file without express import', async () => {
      const code = `
        const x = 1;
        console.log(x);
      `;
      const result = await walkWithExpress(code, 'src/util.ts');

      const domainNodes = result.nodes.filter(
        n => n.type === 'http:route' || n.type === 'express:mount'
      );
      assert.equal(domainNodes.length, 0, 'No domain nodes for file without express');
    });

    it('should return no domain nodes when express is imported but no routes defined', async () => {
      const code = `import express from 'express';`;
      const result = await walkWithExpress(code, 'src/index.ts');

      const domainNodes = result.nodes.filter(
        n => n.type === 'http:route' || n.type === 'express:mount'
      );
      assert.equal(domainNodes.length, 0, 'No domain nodes when no routes are defined');
    });
  });

  // ==========================================================================
  // http:route node structure
  // ==========================================================================

  describe('http:route node structure', () => {
    it('should have correct node ID format', async () => {
      const code = `
        import express from 'express';
        const app = express();
        app.get('/users', handler);
      `;
      const result = await walkWithExpress(code);

      const routeNode = findNodesByType(result, 'http:route')[0];
      assert.ok(routeNode, 'http:route node should exist');

      // ID format: {file}->http:route->{METHOD}:{path}#{line}
      assert.ok(routeNode.id.includes('http:route'), 'ID should contain http:route');
      assert.ok(routeNode.id.includes('GET'), 'ID should contain method');
      assert.ok(routeNode.id.includes('/users'), 'ID should contain path');
    });

    it('should have correct name format', async () => {
      const code = `
        import express from 'express';
        const app = express();
        app.post('/items', handler);
      `;
      const result = await walkWithExpress(code);

      const routeNode = findNodesByType(result, 'http:route')[0];
      assert.ok(routeNode, 'http:route node should exist');
      assert.equal(routeNode.name, 'POST /items');
    });

    it('should have file and line from the original CALL node', async () => {
      const code = `
        import express from 'express';
        const app = express();
        app.get('/users', handler);
      `;
      const result = await walkWithExpress(code, 'src/routes.ts');

      const routeNode = findNodesByType(result, 'http:route')[0];
      assert.ok(routeNode, 'http:route node should exist');
      assert.equal(routeNode.file, 'src/routes.ts');
      assert.ok(routeNode.line > 0, 'Line number should be positive');
    });
  });

  // ==========================================================================
  // express:mount node structure
  // ==========================================================================

  describe('express:mount node structure', () => {
    it('should have correct node ID format', async () => {
      const code = `
        import express from 'express';
        const app = express();
        app.use('/api', router);
      `;
      const result = await walkWithExpress(code);

      const mountNode = findNodesByType(result, 'express:mount')[0];
      assert.ok(mountNode, 'express:mount node should exist');

      // ID format: {file}->express:mount->{prefix}#{line}
      assert.ok(mountNode.id.includes('express:mount'), 'ID should contain express:mount');
      assert.ok(mountNode.id.includes('/api'), 'ID should contain prefix');
    });

    it('should have mountedOn in metadata', async () => {
      const code = `
        import express from 'express';
        const app = express();
        app.use('/api', router);
      `;
      const result = await walkWithExpress(code);

      const mountNode = findNodesByType(result, 'express:mount')[0];
      assert.ok(mountNode, 'express:mount node should exist');
      assert.equal(mountNode.metadata.mountedOn, 'app');
    });
  });

  // ==========================================================================
  // Multiple routes in one file
  // ==========================================================================

  describe('Multiple routes in one file', () => {
    it('should detect multiple routes from the same Express app', async () => {
      const code = `
        import express from 'express';
        const app = express();
        app.get('/users', getUsers);
        app.post('/users', createUser);
        app.delete('/users/:id', deleteUser);
      `;
      const result = await walkWithExpress(code);

      const routeNodes = findNodesByType(result, 'http:route');
      assert.ok(routeNodes.length >= 3, `Should detect 3 routes, got ${routeNodes.length}`);

      const methods = routeNodes.map(n => n.metadata.method).sort();
      assert.ok(methods.includes('GET'), 'Should have GET route');
      assert.ok(methods.includes('POST'), 'Should have POST route');
      assert.ok(methods.includes('DELETE'), 'Should have DELETE route');
    });
  });

  // ==========================================================================
  // app.use() with dynamic prefix
  // ==========================================================================

  describe('app.use() with dynamic prefix', () => {
    it('should create mount node with ${dynamic} prefix for variable paths', async () => {
      const code = `
        import express from 'express';
        const app = express();
        app.use(dynamicPath, router);
      `;
      const result = await walkWithExpress(code);

      const mountNodes = findNodesByType(result, 'express:mount');
      assert.ok(mountNodes.length >= 1, 'Should create express:mount for dynamic path');
      assert.equal(mountNodes[0].metadata.prefix, '${dynamic}');
    });
  });
});
