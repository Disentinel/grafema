/**
 * Tests for Object Property Scope Resolution (REG-329)
 *
 * V2 model:
 * When an object property has a variable reference like `{ key: API_KEY }`,
 * the graph should have:
 *   - LITERAL node (type="LITERAL", name="{...}") for the object
 *   - HAS_PROPERTY edge from LITERAL to PROPERTY_ASSIGNMENT node
 *   - PROPERTY_ASSIGNMENT has PROPERTY_KEY edge to the key and PROPERTY_VALUE edge to the value
 *   - PROPERTY_VALUE edge from PROPERTY_ASSIGNMENT to the resolved VARIABLE/CONSTANT (non-shorthand)
 *   - READS_FROM edge from PROPERTY_ASSIGNMENT to the resolved VARIABLE/CONSTANT (shorthand)
 *
 * For shorthand properties `{ x }`, PROPERTY_ASSIGNMENT gets a READS_FROM deferred
 * to the variable x.
 * For non-shorthand `{ key: value }`, PROPERTY_ASSIGNMENT gets a PROPERTY_VALUE edge
 * to the target VARIABLE/CONSTANT (REG-598).
 *
 * Originally checked HAS_PROPERTY edge dst pointing directly to CONSTANT/VARIABLE.
 * Updated for v2 where HAS_PROPERTY points to PROPERTY_ASSIGNMENT which has
 * READS_FROM (shorthand) or PROPERTY_VALUE (non-shorthand) to the variable.
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
 * V2: Find a PROPERTY_ASSIGNMENT node by property name that is a child of an
 * object literal (via HAS_PROPERTY edge).
 * Returns the PROPERTY_ASSIGNMENT node and the resolved target variable.
 * Non-shorthand `{ key: var }` uses PROPERTY_VALUE edge (REG-598).
 * Shorthand `{ x }` uses READS_FROM edge.
 */
async function findPropertyInObjectLiteral(backend, propertyName) {
  const allNodes = await backend.getAllNodes();
  const allEdges = await backend.getAllEdges();

  // Find HAS_PROPERTY edges to PROPERTY_ASSIGNMENT nodes with the given name
  for (const edge of allEdges) {
    if (edge.type === 'HAS_PROPERTY') {
      const dstNode = allNodes.find(n => n.id === edge.dst);
      if (dstNode && dstNode.type === 'PROPERTY_ASSIGNMENT' && dstNode.name === propertyName) {
        // Find what this PROPERTY_ASSIGNMENT resolves to via PROPERTY_VALUE or READS_FROM
        const valueEdge = allEdges.find(e =>
          (e.type === 'PROPERTY_VALUE' || e.type === 'READS_FROM') && e.src === dstNode.id
        );
        const resolvedNode = valueEdge ? allNodes.find(n => n.id === valueEdge.dst) : null;
        return { propertyAssignment: dstNode, resolvedNode, hasPropertyEdge: edge };
      }
    }
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
    it('should resolve object property to module-level CONSTANT via READS_FROM', async () => {
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
      const allNodes = await backend.getAllNodes();
      const apiKeyNode = allNodes.find(n =>
        n.name === 'API_KEY' && (n.type === 'CONSTANT' || n.type === 'VARIABLE')
      );
      assert.ok(apiKeyNode, 'API_KEY CONSTANT node should exist at module level');

      // V2: Find the PROPERTY_ASSIGNMENT for "key" that is under a HAS_PROPERTY edge
      const result = await findPropertyInObjectLiteral(backend, 'key');
      assert.ok(result, 'HAS_PROPERTY -> PROPERTY_ASSIGNMENT for "key" should exist');

      // V2: The PROPERTY_ASSIGNMENT should have READS_FROM to the CONSTANT node
      assert.ok(result.resolvedNode, 'PROPERTY_ASSIGNMENT should have READS_FROM to a node');
      assert.strictEqual(
        result.resolvedNode.id,
        apiKeyNode.id,
        `PROPERTY_ASSIGNMENT "key" should resolve to API_KEY CONSTANT (${apiKeyNode.id}), ` +
        `but resolves to ${result.resolvedNode.id}`
      );
    });

    it('should resolve object property to module-level VARIABLE via READS_FROM', async () => {
      await setupTest(backend, {
        'index.js': `
let baseUrl = 'http://localhost:3000';

function createClient(config) {
  return config;
}

createClient({ url: baseUrl });
        `
      });

      const allNodes = await backend.getAllNodes();
      // Find the baseUrl variable
      const baseUrlNode = allNodes.find(n =>
        n.name === 'baseUrl' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(baseUrlNode, 'baseUrl VARIABLE node should exist at module level');

      // V2: Find the PROPERTY_ASSIGNMENT for "url" under HAS_PROPERTY
      const result = await findPropertyInObjectLiteral(backend, 'url');
      assert.ok(result, 'HAS_PROPERTY -> PROPERTY_ASSIGNMENT for "url" should exist');

      // V2: PROPERTY_ASSIGNMENT should resolve to baseUrl via READS_FROM
      assert.ok(result.resolvedNode, 'PROPERTY_ASSIGNMENT should have READS_FROM to a node');
      assert.strictEqual(
        result.resolvedNode.id,
        baseUrlNode.id,
        `PROPERTY_ASSIGNMENT "url" should resolve to baseUrl VARIABLE (${baseUrlNode.id}), ` +
        `but resolves to ${result.resolvedNode.id}`
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

      const allNodes = await backend.getAllNodes();

      // Find the CONSTANT nodes
      const hostNode = allNodes.find(n =>
        n.name === 'HOST' && (n.type === 'CONSTANT' || n.type === 'VARIABLE')
      );
      const portNode = allNodes.find(n =>
        n.name === 'PORT' && (n.type === 'CONSTANT' || n.type === 'VARIABLE')
      );
      assert.ok(hostNode, 'HOST CONSTANT should exist');
      assert.ok(portNode, 'PORT CONSTANT should exist');

      // V2: Find PROPERTY_ASSIGNMENT nodes for "host" and "port" under HAS_PROPERTY
      const hostResult = await findPropertyInObjectLiteral(backend, 'host');
      const portResult = await findPropertyInObjectLiteral(backend, 'port');
      assert.ok(hostResult, 'HAS_PROPERTY -> PROPERTY_ASSIGNMENT for "host" should exist');
      assert.ok(portResult, 'HAS_PROPERTY -> PROPERTY_ASSIGNMENT for "port" should exist');

      // Both should resolve to their respective CONSTANT nodes
      assert.ok(hostResult.resolvedNode, 'host should resolve via READS_FROM');
      assert.ok(portResult.resolvedNode, 'port should resolve via READS_FROM');
      assert.strictEqual(hostResult.resolvedNode.id, hostNode.id, 'host should resolve to HOST constant');
      assert.strictEqual(portResult.resolvedNode.id, portNode.id, 'port should resolve to PORT constant');
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

      const allNodes = await backend.getAllNodes();

      // Find the CONSTANT nodes
      const nameNode = allNodes.find(n =>
        n.name === 'name' && (n.type === 'CONSTANT' || n.type === 'VARIABLE')
      );
      const valueNode = allNodes.find(n =>
        n.name === 'value' && (n.type === 'CONSTANT' || n.type === 'VARIABLE')
      );
      assert.ok(nameNode, 'name CONSTANT should exist');
      assert.ok(valueNode, 'value CONSTANT should exist');

      // V2: Find PROPERTY_ASSIGNMENT nodes under HAS_PROPERTY
      const nameResult = await findPropertyInObjectLiteral(backend, 'name');
      const valueResult = await findPropertyInObjectLiteral(backend, 'value');
      assert.ok(nameResult, 'HAS_PROPERTY -> PROPERTY_ASSIGNMENT for "name" should exist');
      assert.ok(valueResult, 'HAS_PROPERTY -> PROPERTY_ASSIGNMENT for "value" should exist');

      // Both should resolve to their respective CONSTANT nodes via READS_FROM
      assert.ok(nameResult.resolvedNode, 'name should resolve via READS_FROM');
      assert.ok(valueResult.resolvedNode, 'value should resolve via READS_FROM');
      assert.strictEqual(nameResult.resolvedNode.id, nameNode.id, 'name property should resolve to name constant');
      assert.strictEqual(valueResult.resolvedNode.id, valueNode.id, 'value property should resolve to value constant');
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

      const allNodes = await backend.getAllNodes();

      // Find the userId constant
      const userIdNode = allNodes.find(n =>
        n.name === 'userId' && (n.type === 'CONSTANT' || n.type === 'VARIABLE')
      );
      assert.ok(userIdNode, 'userId CONSTANT should exist');

      // V2: Find PROPERTY_ASSIGNMENT for "id" under HAS_PROPERTY
      const idResult = await findPropertyInObjectLiteral(backend, 'id');
      assert.ok(idResult, 'HAS_PROPERTY -> PROPERTY_ASSIGNMENT for "id" should exist');

      // Should resolve to the CONSTANT node via READS_FROM
      assert.ok(idResult.resolvedNode, 'id should resolve via READS_FROM');
      assert.strictEqual(idResult.resolvedNode.id, userIdNode.id, 'id property should resolve to userId constant');
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

      const allNodes = await backend.getAllNodes();

      // Find the globalConfig constant
      const globalConfigNode = allNodes.find(n =>
        n.name === 'globalConfig' && (n.type === 'CONSTANT' || n.type === 'VARIABLE')
      );
      assert.ok(globalConfigNode, 'globalConfig CONSTANT should exist');

      // V2: Find PROPERTY_ASSIGNMENT for "config" under HAS_PROPERTY
      const configResult = await findPropertyInObjectLiteral(backend, 'config');
      assert.ok(configResult, 'HAS_PROPERTY -> PROPERTY_ASSIGNMENT for "config" should exist');

      // Should resolve to the module-level constant via READS_FROM
      assert.ok(configResult.resolvedNode, 'config should resolve via READS_FROM');
      assert.strictEqual(
        configResult.resolvedNode.id,
        globalConfigNode.id,
        'config property should resolve to globalConfig constant'
      );
    });
  });

  // ===========================================================================
  // Express.js-style API handlers (target use case)
  // ===========================================================================
  describe('Express.js API handler pattern', () => {
    it('should have statusData variable at module level', async () => {
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

      const allNodes = await backend.getAllNodes();

      // V2: statusData is a VARIABLE (not CONSTANT, because of non-trivial init)
      const statusDataNode = allNodes.find(n =>
        n.name === 'statusData' && (n.type === 'VARIABLE' || n.type === 'CONSTANT')
      );
      assert.ok(statusDataNode, 'statusData should exist at module level');
    });
  });
});
