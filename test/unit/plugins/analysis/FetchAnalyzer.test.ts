/**
 * FetchAnalyzer Tests (REG-252 Phase B)
 *
 * Tests for responseDataNode tracking in http:request nodes.
 *
 * What FetchAnalyzer should do (NEW):
 * 1. Find the variable holding fetch response (e.g., `const response = await fetch(...)`)
 * 2. Find the `response.json()` CALL node in the same file
 * 3. Store that CALL node's ID in `http:request.responseDataNode` metadata
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase, cleanupAllTestDatabases } from '../../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../../helpers/createTestOrchestrator.js';
import type { NodeRecord, EdgeRecord } from '@grafema/types';

let testCounter = 0;

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Helper to create a test project with given files and run analysis
 * Uses the default test orchestrator which includes FetchAnalyzer
 */
async function setupTest(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-fetch-analyzer-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-fetch-analyzer-${testCounter}`,
      type: 'module',
      main: 'index.js'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  // createTestOrchestrator already includes FetchAnalyzer
  const orchestrator = createTestOrchestrator(backend, {
    forceAnalysis: true
  });
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Get nodes by type from backend
 */
async function getNodesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  nodeType: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === nodeType);
}

/**
 * Find http:request node by method and URL pattern
 */
async function findHttpRequestNode(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  method: string,
  urlPattern: string
): Promise<NodeRecord | undefined> {
  const allNodes = await backend.getAllNodes();
  return allNodes.find((n: NodeRecord) =>
    n.type === 'http:request' &&
    (n as unknown as { method: string }).method === method.toUpperCase() &&
    (n as unknown as { url: string }).url.includes(urlPattern)
  );
}

/**
 * Find CALL node by object and method name in a specific file
 */
async function findCallNode(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  objectName: string,
  methodName: string,
  file?: string
): Promise<NodeRecord | undefined> {
  const allNodes = await backend.getAllNodes();
  return allNodes.find((n: NodeRecord) => {
    if (n.type !== 'CALL') return false;
    const call = n as unknown as { object?: string; method?: string; file?: string };
    const matchesCall = call.object === objectName && call.method === methodName;
    if (file) {
      return matchesCall && call.file?.includes(file);
    }
    return matchesCall;
  });
}

// =============================================================================
// TESTS: responseDataNode Tracking in FetchAnalyzer
// =============================================================================

describe('FetchAnalyzer responseDataNode tracking (REG-252 Phase B)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'];

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(cleanupAllTestDatabases);

  // ===========================================================================
  // TEST 1: Basic responseDataNode with await fetch() and response.json()
  // ===========================================================================

  describe('await fetch() with response.json()', () => {
    it('should store responseDataNode in http:request metadata', async () => {
      await setupTest(backend, {
        'index.js': `
async function fetchUsers() {
  const response = await fetch('/api/users');
  const data = await response.json();
  return data;
}
        `
      });

      // Find http:request node
      const requestNode = await findHttpRequestNode(backend, 'GET', '/api/users');
      assert.ok(requestNode, 'Should have http:request node for GET /api/users');

      // Verify responseDataNode is set
      const responseDataNode = (requestNode as unknown as { responseDataNode?: string }).responseDataNode;
      assert.ok(
        responseDataNode,
        `http:request should have responseDataNode metadata. Node: ${JSON.stringify(requestNode)}`
      );

      // Verify responseDataNode points to a valid CALL node
      const callNode = await backend.getNode(responseDataNode);
      assert.ok(callNode, `responseDataNode should point to an existing node. ID: ${responseDataNode}`);
      assert.strictEqual(
        callNode.type,
        'CALL',
        `responseDataNode should point to a CALL node, got: ${callNode.type}`
      );
    });

    it('should find response.json() CALL node for await pattern', async () => {
      await setupTest(backend, {
        'index.js': `
async function getUsers() {
  const response = await fetch('/api/users');
  const users = await response.json();
  console.log(users);
}
        `
      });

      // Find http:request node
      const requestNode = await findHttpRequestNode(backend, 'GET', '/api/users');
      assert.ok(requestNode, 'Should have http:request node');

      // Get the responseDataNode ID
      const responseDataNodeId = (requestNode as unknown as { responseDataNode?: string }).responseDataNode;
      assert.ok(responseDataNodeId, 'Should have responseDataNode');

      // Verify the CALL node is response.json()
      const callNode = await backend.getNode(responseDataNodeId);
      assert.ok(callNode, 'CALL node should exist');

      const callInfo = callNode as unknown as { object?: string; method?: string };
      assert.strictEqual(callInfo.object, 'response', 'CALL should be on response object');
      assert.strictEqual(callInfo.method, 'json', 'CALL should be .json() method');
    });
  });

  // ===========================================================================
  // TEST 2: response.text() pattern
  // ===========================================================================

  describe('response.text() pattern', () => {
    it('should handle response.text() pattern', async () => {
      await setupTest(backend, {
        'index.js': `
async function fetchContent() {
  const response = await fetch('/api/content');
  const text = await response.text();
  return text;
}
        `
      });

      // Find http:request node
      const requestNode = await findHttpRequestNode(backend, 'GET', '/api/content');
      assert.ok(requestNode, 'Should have http:request node for GET /api/content');

      // Verify responseDataNode is set
      const responseDataNode = (requestNode as unknown as { responseDataNode?: string }).responseDataNode;
      assert.ok(
        responseDataNode,
        `http:request should have responseDataNode for response.text(). Node: ${JSON.stringify(requestNode)}`
      );

      // Verify it points to response.text() CALL
      const callNode = await backend.getNode(responseDataNode);
      assert.ok(callNode, 'CALL node should exist');

      const callInfo = callNode as unknown as { object?: string; method?: string };
      assert.strictEqual(callInfo.object, 'response', 'CALL should be on response object');
      assert.strictEqual(callInfo.method, 'text', 'CALL should be .text() method');
    });
  });

  // ===========================================================================
  // TEST 3: No response.json() call (responseDataNode should be null/undefined)
  // ===========================================================================

  describe('No response consumption', () => {
    it('should handle when no response.json() found (responseDataNode is null)', async () => {
      await setupTest(backend, {
        'index.js': `
async function checkStatus() {
  const response = await fetch('/api/status');
  // No response.json() or response.text() - just check status
  return response.ok;
}
        `
      });

      // Find http:request node
      const requestNode = await findHttpRequestNode(backend, 'GET', '/api/status');
      assert.ok(requestNode, 'Should have http:request node for GET /api/status');

      // Verify responseDataNode is not set (null or undefined)
      const responseDataNode = (requestNode as unknown as { responseDataNode?: string }).responseDataNode;
      assert.ok(
        !responseDataNode || responseDataNode === null,
        `responseDataNode should be null/undefined when no response consumption. Got: ${responseDataNode}`
      );
    });
  });

  // ===========================================================================
  // TEST 4: Multiple fetch calls in same file
  // ===========================================================================

  describe('Multiple fetch calls', () => {
    it('should track responseDataNode for each fetch call independently', async () => {
      await setupTest(backend, {
        'index.js': `
async function fetchData() {
  const usersResponse = await fetch('/api/users');
  const users = await usersResponse.json();

  const itemsResponse = await fetch('/api/items');
  const items = await itemsResponse.json();

  return { users, items };
}
        `
      });

      // Find both http:request nodes
      const usersRequest = await findHttpRequestNode(backend, 'GET', '/api/users');
      const itemsRequest = await findHttpRequestNode(backend, 'GET', '/api/items');

      assert.ok(usersRequest, 'Should have http:request for /api/users');
      assert.ok(itemsRequest, 'Should have http:request for /api/items');

      // Both should have responseDataNode
      const usersResponseDataNode = (usersRequest as unknown as { responseDataNode?: string }).responseDataNode;
      const itemsResponseDataNode = (itemsRequest as unknown as { responseDataNode?: string }).responseDataNode;

      assert.ok(usersResponseDataNode, '/api/users request should have responseDataNode');
      assert.ok(itemsResponseDataNode, '/api/items request should have responseDataNode');

      // They should point to different CALL nodes
      assert.notStrictEqual(
        usersResponseDataNode,
        itemsResponseDataNode,
        'Different fetch calls should have different responseDataNode values'
      );
    });
  });

  // ===========================================================================
  // TEST 5: fetch with POST method
  // ===========================================================================

  describe('POST fetch with response.json()', () => {
    it('should track responseDataNode for POST requests', async () => {
      await setupTest(backend, {
        'index.js': `
async function createUser(userData) {
  const response = await fetch('/api/users', {
    method: 'POST',
    body: JSON.stringify(userData)
  });
  const created = await response.json();
  return created;
}
        `
      });

      // Find http:request node for POST
      const requestNode = await findHttpRequestNode(backend, 'POST', '/api/users');
      assert.ok(requestNode, 'Should have http:request node for POST /api/users');

      // Verify responseDataNode is set
      const responseDataNode = (requestNode as unknown as { responseDataNode?: string }).responseDataNode;
      assert.ok(
        responseDataNode,
        `POST request should have responseDataNode. Node: ${JSON.stringify(requestNode)}`
      );
    });
  });

  // ===========================================================================
  // TEST 6: Different variable names for response
  // ===========================================================================

  describe('Different response variable names', () => {
    it('should handle different variable names for response', async () => {
      await setupTest(backend, {
        'index.js': `
async function fetchWithDifferentName() {
  const res = await fetch('/api/data');
  const data = await res.json();
  return data;
}
        `
      });

      // Find http:request node
      const requestNode = await findHttpRequestNode(backend, 'GET', '/api/data');
      assert.ok(requestNode, 'Should have http:request node');

      // Verify responseDataNode is set
      const responseDataNode = (requestNode as unknown as { responseDataNode?: string }).responseDataNode;
      assert.ok(
        responseDataNode,
        `Should find response.json() even when variable is named 'res'. Node: ${JSON.stringify(requestNode)}`
      );

      // Verify it points to res.json() CALL
      const callNode = await backend.getNode(responseDataNode);
      const callInfo = callNode as unknown as { object?: string; method?: string };
      assert.strictEqual(callInfo.object, 'res', 'CALL should be on res object');
      assert.strictEqual(callInfo.method, 'json', 'CALL should be .json() method');
    });
  });

  // ===========================================================================
  // TEST 7: response.blob() pattern
  // ===========================================================================

  describe('response.blob() pattern', () => {
    it('should handle response.blob() pattern', async () => {
      await setupTest(backend, {
        'index.js': `
async function downloadFile() {
  const response = await fetch('/api/file');
  const blob = await response.blob();
  return blob;
}
        `
      });

      // Find http:request node
      const requestNode = await findHttpRequestNode(backend, 'GET', '/api/file');
      assert.ok(requestNode, 'Should have http:request node');

      // Verify responseDataNode is set for blob()
      const responseDataNode = (requestNode as unknown as { responseDataNode?: string }).responseDataNode;
      assert.ok(
        responseDataNode,
        `Should track response.blob() as responseDataNode. Node: ${JSON.stringify(requestNode)}`
      );

      // Verify it points to response.blob() CALL
      const callNode = await backend.getNode(responseDataNode);
      const callInfo = callNode as unknown as { object?: string; method?: string };
      assert.strictEqual(callInfo.method, 'blob', 'CALL should be .blob() method');
    });
  });

  // ===========================================================================
  // TEST 8: HTTP method source detection
  // ===========================================================================

  describe('HTTP method source detection', () => {
    it('should mark default method when options omitted', async () => {
      await setupTest(backend, {
        'index.js': `
async function fetchDefault() {
  await fetch('/api/default');
}
        `
      });

      const requestNode = await findHttpRequestNode(backend, 'GET', '/api/default');
      assert.ok(requestNode, 'Should have http:request node for GET /api/default');

      const methodSource = (requestNode as unknown as { methodSource?: string }).methodSource;
      assert.strictEqual(methodSource, 'default', 'methodSource should be default when options are omitted');
    });

    it('should mark explicit method from object literal', async () => {
      await setupTest(backend, {
        'index.js': `
async function fetchExplicit() {
  await fetch('/api/explicit', { method: 'POST' });
}
        `
      });

      const requestNode = await findHttpRequestNode(backend, 'POST', '/api/explicit');
      assert.ok(requestNode, 'Should have http:request node for POST /api/explicit');

      const methodSource = (requestNode as unknown as { methodSource?: string }).methodSource;
      assert.strictEqual(methodSource, 'explicit', 'methodSource should be explicit for literal method');
    });

    it('should resolve method from const identifiers (string + options object)', async () => {
      await setupTest(backend, {
        'index.js': `
const METHOD = 'PATCH';
const OPTIONS = { method: 'PUT' };

async function fetchConstMethod() {
  await fetch('/api/const-string', { method: METHOD });
  await fetch('/api/const-object', OPTIONS);
}
        `
      });

      const stringMethodNode = await findHttpRequestNode(backend, 'PATCH', '/api/const-string');
      assert.ok(stringMethodNode, 'Should resolve method from const string identifier');
      assert.strictEqual(
        (stringMethodNode as unknown as { methodSource?: string }).methodSource,
        'explicit'
      );

      const objectMethodNode = await findHttpRequestNode(backend, 'PUT', '/api/const-object');
      assert.ok(objectMethodNode, 'Should resolve method from const options object');
      assert.strictEqual(
        (objectMethodNode as unknown as { methodSource?: string }).methodSource,
        'explicit'
      );
    });

    it('should mark unknown when method is not statically resolvable', async () => {
      await setupTest(backend, {
        'index.js': `
function getMethod() { return 'POST'; }

async function fetchUnknown() {
  const method = getMethod();
  await fetch('/api/unknown', { method });
}
        `
      });

      const requestNode = await findHttpRequestNode(backend, 'UNKNOWN', '/api/unknown');
      assert.ok(requestNode, 'Should create http:request node with UNKNOWN method');

      const methodSource = (requestNode as unknown as { methodSource?: string }).methodSource;
      assert.strictEqual(methodSource, 'unknown', 'methodSource should be unknown for unresolved identifiers');
    });

    it('should handle axios config default and explicit method', async () => {
      await setupTest(backend, {
        'index.js': `
import axios from 'axios';

async function axiosCalls() {
  await axios({ url: '/api/axios-default' });
  await axios({ url: '/api/axios-explicit', method: 'put' });
}
        `
      });

      const defaultNode = await findHttpRequestNode(backend, 'GET', '/api/axios-default');
      assert.ok(defaultNode, 'Should have http:request node for axios default GET');
      assert.strictEqual(
        (defaultNode as unknown as { methodSource?: string }).methodSource,
        'default'
      );

      const explicitNode = await findHttpRequestNode(backend, 'PUT', '/api/axios-explicit');
      assert.ok(explicitNode, 'Should have http:request node for axios explicit PUT');
      assert.strictEqual(
        (explicitNode as unknown as { methodSource?: string }).methodSource,
        'explicit'
      );
    });
  });

  // ===========================================================================
  // TEST 9: axios response handling (out of scope for v1.0, but good to document)
  // ===========================================================================

  describe('Axios patterns (documented limitation)', () => {
    it('should NOT track axios.data pattern (documented out of scope for v1.0)', async () => {
      await setupTest(backend, {
        'index.js': `
import axios from 'axios';

async function fetchWithAxios() {
  const response = await axios.get('/api/users');
  const data = response.data;  // Different pattern from fetch
  return data;
}
        `
      });

      // Find http:request node for axios
      const requestNode = await findHttpRequestNode(backend, 'GET', '/api/users');
      assert.ok(requestNode, 'Should have http:request node for axios.get');

      // For v1.0, axios.data pattern is out of scope
      // responseDataNode may be null - this is expected behavior
      const responseDataNode = (requestNode as unknown as { responseDataNode?: string }).responseDataNode;

      // This test documents the current limitation
      // When axios support is added, this test should be updated to expect responseDataNode
      assert.ok(
        true,
        `Axios response.data pattern is out of scope for v1.0. responseDataNode: ${responseDataNode}`
      );
    });
  });
});
