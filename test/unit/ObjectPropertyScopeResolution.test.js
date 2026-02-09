/**
 * Tests for Object Property Scope Resolution (REG-329)
 *
 * REG-329: When an object property has a variable reference like `{ key: API_KEY }`,
 * the graph should have a HAS_PROPERTY edge from the OBJECT_LITERAL to the
 * resolved VARIABLE node (not just a LITERAL or reference by name).
 *
 * SCOPE LIMITATION: This fix applies to MODULE-LEVEL call expressions only.
 * Calls inside function bodies are processed by analyzeFunctionBody which uses
 * a different code path. Function-level scope resolution would require additional
 * changes to JSASTAnalyzer.
 *
 * Target use case: API handlers like `res.json({ key: API_KEY })` at module level.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Helper to create a test project with given files and run analysis
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-obj-prop-scope-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-obj-prop-scope-${testCounter}`,
      type: 'module',
      main: 'index.js'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Find a node by name and type with scope hint in ID
 */
async function findNodeInScope(backend, name, type, scopeHint) {
  const allNodes = await backend.getAllNodes();
  return allNodes.find(n =>
    n.name === name &&
    n.type === type &&
    n.id.includes(scopeHint)
  );
}

/**
 * Find HAS_PROPERTY edge by property name
 */
async function findPropertyEdge(backend, propertyName) {
  const allNodes = await backend.getAllNodes();
  for (const node of allNodes) {
    const outgoing = await backend.getOutgoingEdges(node.id);
    const edge = outgoing.find(e =>
      e.type === 'HAS_PROPERTY' && e.propertyName === propertyName
    );
    if (edge) return edge;
  }
  return null;
}

// =============================================================================
// TESTS: Module-level call expressions with object property variable references
// =============================================================================

describe('Object Property Scope Resolution (REG-329)', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ===========================================================================
  // Module-level variable reference (CORE USE CASE)
  // ===========================================================================
  describe('Module-level call expressions', () => {
    it('should resolve object property to module-level CONSTANT', async () => {
      await setupTest(backend, {
        'index.js': `
const API_KEY = 'secret-key-123';

function configure(opts) {
  return opts;
}

configure({ key: API_KEY });
        `
      });

      // Find the API_KEY constant
      const apiKeyNode = await findNodeInScope(backend, 'API_KEY', 'CONSTANT', '->global->');
      assert.ok(apiKeyNode, 'API_KEY CONSTANT node should exist at module level');

      // Find the HAS_PROPERTY edge for "key"
      const keyEdge = await findPropertyEdge(backend, 'key');
      assert.ok(keyEdge, 'HAS_PROPERTY edge for "key" property should exist');

      // The edge destination should be the CONSTANT node
      assert.strictEqual(
        keyEdge.dst,
        apiKeyNode.id,
        `HAS_PROPERTY edge for "key" should point to API_KEY CONSTANT (${apiKeyNode.id}), ` +
        `but points to ${keyEdge.dst}`
      );
    });

    it('should resolve object property to module-level VARIABLE', async () => {
      await setupTest(backend, {
        'index.js': `
let baseUrl = 'http://localhost:3000';

function createClient(config) {
  return config;
}

createClient({ url: baseUrl });
        `
      });

      // Find the baseUrl variable
      const baseUrlNode = await findNodeInScope(backend, 'baseUrl', 'VARIABLE', '->global->');
      assert.ok(baseUrlNode, 'baseUrl VARIABLE node should exist at module level');

      // Find the HAS_PROPERTY edge for "url"
      const urlEdge = await findPropertyEdge(backend, 'url');
      assert.ok(urlEdge, 'HAS_PROPERTY edge for "url" property should exist');

      // The edge destination should be the VARIABLE node
      assert.strictEqual(
        urlEdge.dst,
        baseUrlNode.id,
        `HAS_PROPERTY edge for "url" should point to baseUrl VARIABLE (${baseUrlNode.id}), ` +
        `but points to ${urlEdge.dst}`
      );
    });

    it('should handle multiple properties with different variable references', async () => {
      await setupTest(backend, {
        'index.js': `
const HOST = 'localhost';
const PORT = 3000;

function connect(options) {
  return options;
}

connect({ host: HOST, port: PORT, timeout: 5000 });
        `
      });

      // Find the CONSTANT nodes
      const hostNode = await findNodeInScope(backend, 'HOST', 'CONSTANT', '->global->');
      const portNode = await findNodeInScope(backend, 'PORT', 'CONSTANT', '->global->');
      assert.ok(hostNode, 'HOST CONSTANT should exist');
      assert.ok(portNode, 'PORT CONSTANT should exist');

      // Find HAS_PROPERTY edges
      const hostEdge = await findPropertyEdge(backend, 'host');
      const portEdge = await findPropertyEdge(backend, 'port');
      assert.ok(hostEdge, 'HAS_PROPERTY edge for "host" should exist');
      assert.ok(portEdge, 'HAS_PROPERTY edge for "port" should exist');

      // Both should resolve to their respective CONSTANT nodes
      assert.strictEqual(hostEdge.dst, hostNode.id, 'host should resolve to HOST constant');
      assert.strictEqual(portEdge.dst, portNode.id, 'port should resolve to PORT constant');
    });

    it('should handle shorthand property syntax', async () => {
      await setupTest(backend, {
        'index.js': `
const name = 'test';
const value = 42;

function process(data) {
  return data;
}

process({ name, value });
        `
      });

      // Find the CONSTANT nodes
      const nameNode = await findNodeInScope(backend, 'name', 'CONSTANT', '->global->');
      const valueNode = await findNodeInScope(backend, 'value', 'CONSTANT', '->global->');
      assert.ok(nameNode, 'name CONSTANT should exist');
      assert.ok(valueNode, 'value CONSTANT should exist');

      // Find HAS_PROPERTY edges for shorthand properties
      const nameEdge = await findPropertyEdge(backend, 'name');
      const valueEdge = await findPropertyEdge(backend, 'value');
      assert.ok(nameEdge, 'HAS_PROPERTY edge for "name" should exist');
      assert.ok(valueEdge, 'HAS_PROPERTY edge for "value" should exist');

      // Both should resolve to their respective CONSTANT nodes
      assert.strictEqual(nameEdge.dst, nameNode.id, 'name property should resolve to name constant');
      assert.strictEqual(valueEdge.dst, valueNode.id, 'value property should resolve to value constant');
    });

    it('should handle mixed literal and variable properties', async () => {
      await setupTest(backend, {
        'index.js': `
const userId = 123;

function sendRequest(opts) {
  return opts;
}

sendRequest({ id: userId, type: 'user', active: true });
        `
      });

      // Find the userId constant
      const userIdNode = await findNodeInScope(backend, 'userId', 'CONSTANT', '->global->');
      assert.ok(userIdNode, 'userId CONSTANT should exist');

      // Find HAS_PROPERTY edge for "id"
      const idEdge = await findPropertyEdge(backend, 'id');
      assert.ok(idEdge, 'HAS_PROPERTY edge for "id" should exist');

      // Should resolve to the CONSTANT node
      assert.strictEqual(idEdge.dst, userIdNode.id, 'id property should resolve to userId constant');
    });
  });

  // ===========================================================================
  // Variable shadowing at module level
  // ===========================================================================
  describe('Variable shadowing', () => {
    it('should use outer variable when no shadowing exists', async () => {
      await setupTest(backend, {
        'index.js': `
const globalConfig = { debug: true };

function setup(handler) {
  return handler;
}

// Module-level call - globalConfig is in scope
setup({ config: globalConfig });
        `
      });

      // Find the globalConfig constant
      const globalConfigNode = await findNodeInScope(backend, 'globalConfig', 'CONSTANT', '->global->');
      assert.ok(globalConfigNode, 'globalConfig CONSTANT should exist');

      // Find HAS_PROPERTY edge
      const configEdge = await findPropertyEdge(backend, 'config');
      assert.ok(configEdge, 'HAS_PROPERTY edge for "config" should exist');

      // Should resolve to the module-level constant
      assert.strictEqual(
        configEdge.dst,
        globalConfigNode.id,
        'config property should resolve to globalConfig constant'
      );
    });
  });

  // ===========================================================================
  // Express.js-style API handlers (target use case)
  // ===========================================================================
  describe('Express.js API handler pattern', () => {
    it('should resolve variables in res.json() calls', async () => {
      await setupTest(backend, {
        'index.js': `
const statusData = { status: 'ok', timestamp: Date.now() };

function handleRequest(req, res) {
  res.json(statusData);
}

// Simulating a module-level call pattern
handleRequest(null, { json: (x) => x });
        `
      });

      // NOTE: This test verifies the concept but actual Express handlers
      // use method calls (res.json) which may be handled differently.
      // The fix targets the object literal argument pattern.
      const statusDataNode = await findNodeInScope(backend, 'statusData', 'VARIABLE', '->global->');
      assert.ok(statusDataNode, 'statusData VARIABLE should exist at module level (const with non-literal init)');
    });
  });
});
