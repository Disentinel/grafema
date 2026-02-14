/**
 * NestJSRouteAnalyzer Tests
 *
 * Tests that NestJSRouteAnalyzer correctly identifies HTTP routes from NestJS decorators
 * and creates http:route nodes with proper metadata.
 *
 * The analyzer is graph-based: it queries DECORATOR nodes created by JSASTAnalyzer,
 * rather than parsing AST directly.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../../helpers/createTestOrchestrator.js';
import { NestJSRouteAnalyzer } from '@grafema/core';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);

let testCounter = 0;

// =============================================================================
// TEST HELPERS
// =============================================================================

async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-nestjs-routes-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-nestjs-routes-${testCounter}`,
      type: 'module',
      main: 'index.ts'
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, {
    forceAnalysis: true,
    extraPlugins: [
      new NestJSRouteAnalyzer()
    ]
  });
  await orchestrator.run(testDir);

  return { testDir };
}

async function getNodesByType(backend, nodeType) {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n) => n.type === nodeType);
}

async function getEdgesByType(backend, edgeType) {
  const allNodes = await backend.getAllNodes();
  const allEdges = [];

  for (const node of allNodes) {
    const outgoing = await backend.getOutgoingEdges(node.id);
    allEdges.push(...outgoing);
  }

  return allEdges
    .filter(e => (e.edgeType || e.type) === edgeType)
    .map(e => {
      const meta = e.metadata
        ? (typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata)
        : {};
      return {
        ...e,
        type: e.edgeType || e.type,
        src: meta._origSrc || e.src,
        dst: meta._origDst || e.dst,
      };
    });
}

// =============================================================================
// TESTS
// =============================================================================

describe('NestJSRouteAnalyzer', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db?.cleanup) {
      await db.cleanup();
    }
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db?.cleanup) {
      await db.cleanup();
    }
  });

  it('should create http:route for basic @Controller + @Get', async () => {
    const code = `
// Define decorators locally as factory functions
function Controller(path?: string | string[] | object) {
  return function(target: any) {};
}
function Get(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}

@Controller('users')
class UsersController {
  @Get()
  findAll() {
    return [];
  }
}
`;

    await setupTest(backend, { 'index.ts': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const route = routes[0];
    assert.strictEqual(route.method, 'GET', 'Method should be GET');
    assert.strictEqual(route.path, '/users', 'Path should be /users');
    assert.strictEqual(route.framework, 'nestjs', 'Framework should be nestjs');
  });

  it('should create http:route with sub-path', async () => {
    const code = `
function Controller(path?: string | string[] | object) {
  return function(target: any) {};
}
function Get(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}

@Controller('users')
class UsersController {
  @Get(':id')
  findOne() {
    return {};
  }
}
`;

    await setupTest(backend, { 'index.ts': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const route = routes[0];
    assert.strictEqual(route.method, 'GET', 'Method should be GET');
    assert.strictEqual(route.path, '/users/:id', 'Path should be /users/:id');
  });

  it('should create multiple routes for multiple methods', async () => {
    const code = `
function Controller(path?: string | string[] | object) {
  return function(target: any) {};
}
function Get(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}
function Post(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}
function Put(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}

@Controller('items')
class ItemsController {
  @Get()
  findAll() {
    return [];
  }

  @Post()
  create() {
    return {};
  }

  @Put(':id')
  update() {
    return {};
  }
}
`;

    await setupTest(backend, { 'index.ts': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 3, 'Should have 3 http:routes');

    const getRoute = routes.find(r => r.method === 'GET' && r.path === '/items');
    assert(getRoute, 'Should have GET /items route');

    const postRoute = routes.find(r => r.method === 'POST' && r.path === '/items');
    assert(postRoute, 'Should have POST /items route');

    const putRoute = routes.find(r => r.method === 'PUT' && r.path === '/items/:id');
    assert(putRoute, 'Should have PUT /items/:id route');
  });

  it('should handle empty controller path', async () => {
    const code = `
function Controller(path?: string | string[] | object) {
  return function(target: any) {};
}
function Get(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}

@Controller()
class HealthController {
  @Get('health')
  check() {
    return { status: 'ok' };
  }
}
`;

    await setupTest(backend, { 'index.ts': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const route = routes[0];
    assert.strictEqual(route.method, 'GET', 'Method should be GET');
    assert.strictEqual(route.path, '/health', 'Path should be /health');
  });

  it('should handle array base paths', async () => {
    const code = `
function Controller(path?: string | string[] | object) {
  return function(target: any) {};
}
function Get(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}

@Controller(['users', 'api/users'])
class UsersController {
  @Get()
  findAll() {
    return [];
  }
}
`;

    await setupTest(backend, { 'index.ts': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 2, 'Should have 2 http:routes for array base paths');

    const route1 = routes.find(r => r.path === '/users');
    assert(route1, 'Should have /users route');
    assert.strictEqual(route1.method, 'GET', 'Method should be GET');

    const route2 = routes.find(r => r.path === '/api/users');
    assert(route2, 'Should have /api/users route');
    assert.strictEqual(route2.method, 'GET', 'Method should be GET');
  });

  it('should handle object form controller path', async () => {
    const code = `
function Controller(path?: string | string[] | object) {
  return function(target: any) {};
}
function Get(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}

@Controller({ path: 'users' })
class UsersController {
  @Get()
  findAll() {
    return [];
  }
}
`;

    await setupTest(backend, { 'index.ts': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const route = routes[0];
    assert.strictEqual(route.method, 'GET', 'Method should be GET');
    assert.strictEqual(route.path, '/users', 'Path should be /users');
  });

  it('should handle all HTTP methods', async () => {
    const code = `
function Controller(path?: string | string[] | object) {
  return function(target: any) {};
}
function Get(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}
function Post(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}
function Put(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}
function Patch(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}
function Delete(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}
function Options(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}
function Head(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}

@Controller('test')
class TestController {
  @Get()
  getMethod() {}

  @Post()
  postMethod() {}

  @Put()
  putMethod() {}

  @Patch()
  patchMethod() {}

  @Delete()
  deleteMethod() {}

  @Options()
  optionsMethod() {}

  @Head()
  headMethod() {}
}
`;

    await setupTest(backend, { 'index.ts': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 7, 'Should have 7 http:routes for all HTTP methods');

    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];
    for (const method of methods) {
      const route = routes.find(r => r.method === method);
      assert(route, `Should have ${method} route`);
      assert.strictEqual(route.path, '/test', `${method} route should have path /test`);
    }
  });

  it('should not create routes when no @Controller decorator', async () => {
    const code = `
function Get(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}

class NotAController {
  @Get()
  findAll() {
    return [];
  }
}
`;

    await setupTest(backend, { 'index.ts': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 0, 'Should have 0 http:routes without @Controller');
  });

  it('should create CONTAINS edge from MODULE to http:route', async () => {
    const code = `
function Controller(path?: string | string[] | object) {
  return function(target: any) {};
}
function Get(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}

@Controller('users')
class UsersController {
  @Get()
  findAll() {
    return [];
  }
}
`;

    await setupTest(backend, { 'index.ts': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const containsEdges = await getEdgesByType(backend, 'CONTAINS');
    const routeContainsEdges = containsEdges.filter(e => e.dst === routes[0].id);
    assert(routeContainsEdges.length > 0, 'Should have at least one CONTAINS edge to http:route');

    // Verify the source is a MODULE
    const sourceNode = await backend.getNode(routeContainsEdges[0].src);
    assert(sourceNode, 'Source node should exist');
    assert.strictEqual(sourceNode.type, 'MODULE', 'Source should be MODULE');
  });

  it('should set framework metadata to nestjs', async () => {
    const code = `
function Controller(path?: string | string[] | object) {
  return function(target: any) {};
}
function Get(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}

@Controller('test')
class TestController {
  @Get()
  test() {
    return {};
  }
}
`;

    await setupTest(backend, { 'index.ts': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const route = routes[0];
    assert.strictEqual(route.framework, 'nestjs', 'Framework metadata should be set to nestjs');
  });

  it('should handle controller with no methods', async () => {
    const code = `
function Controller(path?: string | string[] | object) {
  return function(target: any) {};
}

@Controller('empty')
class EmptyController {
  // No route methods
}
`;

    await setupTest(backend, { 'index.ts': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 0, 'Should have 0 http:routes for controller with no methods');
  });

  it('should handle multiple controllers in same file', async () => {
    const code = `
function Controller(path?: string | string[] | object) {
  return function(target: any) {};
}
function Get(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}
function Post(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}

@Controller('users')
class UsersController {
  @Get()
  findAll() {
    return [];
  }
}

@Controller('posts')
class PostsController {
  @Post()
  create() {
    return {};
  }
}
`;

    await setupTest(backend, { 'index.ts': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 2, 'Should have 2 http:routes from 2 controllers');

    const usersRoute = routes.find(r => r.path === '/users');
    assert(usersRoute, 'Should have /users route');
    assert.strictEqual(usersRoute.method, 'GET', 'Users route should be GET');

    const postsRoute = routes.find(r => r.path === '/posts');
    assert(postsRoute, 'Should have /posts route');
    assert.strictEqual(postsRoute.method, 'POST', 'Posts route should be POST');
  });

  it('should handle path normalization', async () => {
    const code = `
function Controller(path?: string | string[] | object) {
  return function(target: any) {};
}
function Get(path?: string) {
  return function(target: any, key: string, descriptor: any) {};
}

@Controller('/users/')
class UsersController {
  @Get('/profile/')
  getProfile() {
    return {};
  }
}
`;

    await setupTest(backend, { 'index.ts': code });

    const routes = await getNodesByType(backend, 'http:route');
    assert.strictEqual(routes.length, 1, 'Should have 1 http:route');

    const route = routes[0];
    // Path should be normalized (no duplicate slashes, no trailing slash)
    assert.strictEqual(route.path, '/users/profile', 'Path should be normalized to /users/profile');
  });
});
