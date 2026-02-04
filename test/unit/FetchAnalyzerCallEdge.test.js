/**
 * FetchAnalyzer MAKES_REQUEST edge to CALL node Tests (REG-321)
 *
 * Tests that FetchAnalyzer creates MAKES_REQUEST edges from CALL nodes
 * to http:request nodes, not just from FUNCTION nodes.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

/**
 * Helper to create a test project with given files and run analysis
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-fetch-call-edge-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-fetch-call-edge-${testCounter}`,
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
 * Find http:request node by method and URL pattern
 */
async function findHttpRequestNode(backend, method, urlPattern) {
  const allNodes = await backend.getAllNodes();
  return allNodes.find((n) =>
    n.type === 'http:request' &&
    n.method === method.toUpperCase() &&
    n.url.includes(urlPattern)
  );
}

/**
 * Find MAKES_REQUEST edges targeting a specific http:request
 */
async function findMakesRequestEdges(backend, httpRequestId) {
  const allEdges = await backend.getAllEdges();
  return allEdges.filter((e) => e.type === 'MAKES_REQUEST' && e.dst === httpRequestId);
}

describe('FetchAnalyzer MAKES_REQUEST edge to CALL node (REG-321)', () => {
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

  it('should create MAKES_REQUEST edge from CALL node for fetch()', async () => {
    await setupTest(backend, {
      'index.js': `
async function fetchUsers() {
  const response = await fetch('/api/users');
  return response.json();
}
      `
    });

    // Find http:request node
    const requestNode = await findHttpRequestNode(backend, 'GET', '/api/users');
    assert.ok(requestNode, 'Should have http:request node for GET /api/users');

    // Find MAKES_REQUEST edges targeting this request
    const makesRequestEdges = await findMakesRequestEdges(backend, requestNode.id);

    // Should have 2 edges: one from FUNCTION, one from CALL
    assert.ok(
      makesRequestEdges.length >= 2,
      `Should have at least 2 MAKES_REQUEST edges (FUNCTION and CALL). Got: ${makesRequestEdges.length}`
    );

    // Find the edge from CALL node
    const allNodes = await backend.getAllNodes();
    const callEdge = makesRequestEdges.find(edge => {
      const srcNode = allNodes.find((n) => n.id === edge.src);
      return srcNode?.type === 'CALL';
    });

    assert.ok(callEdge, 'Should have MAKES_REQUEST edge from CALL node');

    // Verify the CALL node is the fetch() call
    const callNode = allNodes.find((n) => n.id === callEdge.src);
    assert.ok(callNode, 'CALL node should exist');
    assert.strictEqual(callNode.name, 'fetch', 'CALL should be fetch()');
  });

  it('should create MAKES_REQUEST edge from axios.get() CALL node', async () => {
    await setupTest(backend, {
      'index.js': `
import axios from 'axios';

async function fetchUsers() {
  const response = await axios.get('/api/users');
  return response.data;
}
      `
    });

    // Find http:request node
    const requestNode = await findHttpRequestNode(backend, 'GET', '/api/users');
    assert.ok(requestNode, 'Should have http:request node for axios.get');

    // Find MAKES_REQUEST edges
    const makesRequestEdges = await findMakesRequestEdges(backend, requestNode.id);

    // Find the edge from CALL node
    const allNodes = await backend.getAllNodes();
    const callEdge = makesRequestEdges.find(edge => {
      const srcNode = allNodes.find((n) => n.id === edge.src);
      return srcNode?.type === 'CALL';
    });

    assert.ok(callEdge, 'Should have MAKES_REQUEST edge from CALL node');

    // Verify the CALL node is axios.get()
    const callNode = allNodes.find((n) => n.id === callEdge.src);
    assert.ok(callNode, 'CALL node should exist');
    assert.strictEqual(callNode.name, 'axios.get', 'CALL should be axios.get()');
  });

  it('should create MAKES_REQUEST edge from custom wrapper authFetch()', async () => {
    await setupTest(backend, {
      'index.js': `
async function fetchUsers() {
  const response = await authFetch('/api/users');
  return response.json();
}
      `
    });

    // Find http:request node
    const requestNode = await findHttpRequestNode(backend, 'GET', '/api/users');
    assert.ok(requestNode, 'Should have http:request node for authFetch');

    // Find MAKES_REQUEST edges
    const makesRequestEdges = await findMakesRequestEdges(backend, requestNode.id);

    // Find the edge from CALL node
    const allNodes = await backend.getAllNodes();
    const callEdge = makesRequestEdges.find(edge => {
      const srcNode = allNodes.find((n) => n.id === edge.src);
      return srcNode?.type === 'CALL';
    });

    assert.ok(callEdge, 'Should have MAKES_REQUEST edge from CALL node');

    // Verify the CALL node is authFetch()
    const callNode = allNodes.find((n) => n.id === callEdge.src);
    assert.ok(callNode, 'CALL node should exist');
    assert.strictEqual(callNode.name, 'authFetch', 'CALL should be authFetch()');
  });
});
