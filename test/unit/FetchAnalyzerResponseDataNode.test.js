/**
 * FetchAnalyzer responseDataNode scope tests (REG-324)
 *
 * Tests that responseDataNode correctly links to the response.json()
 * call in the SAME function as the fetch, not a different function
 * with the same variable name.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-response-data-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-response-data-${testCounter}`,
      type: 'module',
      main: 'index.js'
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Find http:request node by URL pattern
 */
async function findHttpRequestByUrl(backend, urlPattern) {
  const allNodes = await backend.getAllNodes();
  return allNodes.find((n) =>
    n.type === 'http:request' && n.url?.includes(urlPattern)
  );
}

/**
 * Get CALL node by ID
 */
async function getCallNode(backend, nodeId) {
  return backend.getNode(nodeId);
}

describe('FetchAnalyzer responseDataNode scope (REG-324)', () => {
  let backend;

  beforeEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
    backend = createTestBackend();
    await backend.connect();
  });

  after(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  it('should link to correct response.json() when multiple functions use same variable name', async () => {
    await setupTest(backend, {
      'index.js': `
// Function 1: fetchUsers
async function fetchUsers() {
  const response = await fetch('/api/users');
  const data = await response.json();  // Line 5 - should be linked to fetchUsers request
  return data;
}

// Function 2: fetchPosts
async function fetchPosts() {
  const response = await fetch('/api/posts');
  const data = await response.json();  // Line 12 - should be linked to fetchPosts request
  return data;
}
      `
    });

    // Find both http:request nodes
    const usersRequest = await findHttpRequestByUrl(backend, '/api/users');
    const postsRequest = await findHttpRequestByUrl(backend, '/api/posts');

    assert.ok(usersRequest, 'Should have http:request for /api/users');
    assert.ok(postsRequest, 'Should have http:request for /api/posts');

    // Get responseDataNode IDs
    const usersResponseDataNodeId = usersRequest.responseDataNode;
    const postsResponseDataNodeId = postsRequest.responseDataNode;

    assert.ok(usersResponseDataNodeId, '/api/users should have responseDataNode');
    assert.ok(postsResponseDataNodeId, '/api/posts should have responseDataNode');

    // They should be DIFFERENT nodes
    assert.notStrictEqual(
      usersResponseDataNodeId,
      postsResponseDataNodeId,
      'Each request should link to its own response.json() call'
    );

    // Verify line numbers: users request (line 4) should link to response.json at line 5
    // posts request (line 11) should link to response.json at line 12
    const usersResponseNode = await getCallNode(backend, usersResponseDataNodeId);
    const postsResponseNode = await getCallNode(backend, postsResponseDataNodeId);

    assert.ok(usersResponseNode, 'Users responseDataNode should exist');
    assert.ok(postsResponseNode, 'Posts responseDataNode should exist');

    // Users response.json should be at smaller line than posts
    assert.ok(
      usersResponseNode.line < postsResponseNode.line,
      `Users response.json (line ${usersResponseNode.line}) should be before posts (line ${postsResponseNode.line})`
    );
  });

  it('should link to closest response.json() after fetch call', async () => {
    await setupTest(backend, {
      'index.js': `
async function fetchData() {
  // First fetch
  const response = await fetch('/api/first');
  const first = await response.json();  // Should link here

  // Second fetch with different response variable
  const resp = await fetch('/api/second');
  const second = await resp.json();  // Should NOT affect first

  return { first, second };
}
      `
    });

    const firstRequest = await findHttpRequestByUrl(backend, '/api/first');
    assert.ok(firstRequest, 'Should have http:request for /api/first');

    const responseDataNodeId = firstRequest.responseDataNode;
    assert.ok(responseDataNodeId, 'Should have responseDataNode');

    const responseNode = await getCallNode(backend, responseDataNodeId);
    assert.ok(responseNode, 'responseDataNode should exist');

    // Should be the response.json() call, not resp.json()
    assert.strictEqual(responseNode.object, 'response', 'Should be response.json(), not resp.json()');
  });
});
