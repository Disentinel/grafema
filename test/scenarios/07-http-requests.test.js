/**
 * Тест для HTTP requests паттернов
 * Проверяем: fetch, axios, custom wrappers
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { assertGraph } from '../helpers/GraphAsserter.js';
import { TestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { FetchAnalyzer } from '@grafema/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, '../fixtures/07-http-requests');

describe('HTTP Requests Analysis', () => {
  let backend;
  let orchestrator;

  beforeEach(async () => {
    backend = new TestBackend();
    await backend.connect();
    // Добавляем FetchAnalyzer к стандартным плагинам
    orchestrator = createTestOrchestrator(backend, {
      extraPlugins: [new FetchAnalyzer()]
    });
  });

  afterEach(async () => {
    if (backend) await backend.cleanup();
  });

  it('should detect SERVICE from package.json', async () => {
    await orchestrator.run(FIXTURE_PATH);

    (await assertGraph(backend))
      .hasNode('SERVICE', 'http-requests-fixture')
      .hasNodeCount('SERVICE', 1);
  });

  it('should detect MODULE files', async () => {
    await orchestrator.run(FIXTURE_PATH);

    (await assertGraph(backend))
      .hasNode('MODULE', 'index.js')
      .hasNode('MODULE', 'client.js')
      .hasNodeCount('MODULE', 2);
  });

  describe('Fetch API Detection', () => {
    it('should detect native fetch calls', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // client.js содержит:
      // fetch('/api/users') - fetchUsers
      // fetch('/api/users', { method: 'POST' }) - createUser
      // fetch(`/api/gigs/${gigId}`) - fetchGig
      // fetch(`https://api.spotify.com/...`) - searchSpotify
      // fetch('/api/gigs') - fetchAndProcess
      // fetch('/api/users'), fetch('/api/gigs'), fetch('/api/tracks') - fetchMultiple

      const allNodes = await backend.getAllNodes();
      const fetchRequests = allNodes.filter(n =>
        n.type === 'http:request' && n.library === 'fetch'
      );

      assert.ok(fetchRequests.length >= 6,
        `Expected at least 6 fetch requests, got ${fetchRequests.length}`);
    });

    it('should detect fetch with different methods', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const fetchRequests = allNodes.filter(n =>
        n.type === 'http:request' && n.library === 'fetch'
      );

      const methods = fetchRequests.map(n => n.method);
      assert.ok(methods.includes('GET'), 'Should detect GET requests');
      assert.ok(methods.includes('POST'), 'Should detect POST requests');
    });

    it('should extract URLs from fetch calls', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const fetchRequests = allNodes.filter(n =>
        n.type === 'http:request' && n.library === 'fetch'
      );

      const urls = fetchRequests.map(n => n.url);
      assert.ok(urls.includes('/api/users'), 'Should detect /api/users URL');
      assert.ok(urls.some(u => u.includes('/api/gigs')), 'Should detect /api/gigs URL');
    });
  });

  describe('Axios Detection', () => {
    it('should detect axios.get calls', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // client.js содержит:
      // axios.get('/api/users') - getUsersAxios
      // axios.get('https://gitlab.com/api/v4/projects') - fetchGitlab

      const allNodes = await backend.getAllNodes();
      const axiosGetRequests = allNodes.filter(n =>
        n.type === 'http:request' &&
        n.library === 'axios' &&
        n.method === 'GET'
      );

      assert.ok(axiosGetRequests.length >= 2,
        `Expected at least 2 axios GET requests, got ${axiosGetRequests.length}`);
    });

    it('should detect axios.post calls', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // client.js содержит:
      // axios.post('/api/users', userData) - createUserAxios

      const allNodes = await backend.getAllNodes();
      const axiosPostRequests = allNodes.filter(n =>
        n.type === 'http:request' &&
        n.library === 'axios' &&
        n.method === 'POST'
      );

      assert.ok(axiosPostRequests.length >= 1,
        `Expected at least 1 axios POST request, got ${axiosPostRequests.length}`);
    });
  });

  describe('Custom Wrapper Detection', () => {
    it('should detect custom fetch wrapper calls', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // client.js содержит:
      // authFetch('/api/protected') - fetchProtectedData

      const allNodes = await backend.getAllNodes();
      const customRequests = allNodes.filter(n =>
        n.type === 'http:request' && n.library === 'authFetch'
      );

      assert.ok(customRequests.length >= 1,
        `Expected at least 1 authFetch request, got ${customRequests.length}`);
    });
  });

  describe('External API Detection', () => {
    it('should detect external APIs', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // client.js содержит внешние API:
      // https://api.spotify.com/...
      // https://gitlab.com/...

      const allNodes = await backend.getAllNodes();
      const externalNodes = allNodes.filter(n => n.type === 'EXTERNAL');

      assert.ok(externalNodes.length >= 2,
        `Expected at least 2 EXTERNAL nodes, got ${externalNodes.length}`);

      const domains = externalNodes.map(n => n.domain);
      assert.ok(domains.includes('api.spotify.com'), 'Should detect api.spotify.com');
      assert.ok(domains.includes('gitlab.com'), 'Should detect gitlab.com');
    });

    it('should create CALLS_API edges', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allEdges = await backend.getAllEdges();
      const callsApiEdges = allEdges.filter(e => e.type === 'CALLS_API');

      assert.ok(callsApiEdges.length >= 2,
        `Expected at least 2 CALLS_API edges, got ${callsApiEdges.length}`);
    });
  });

  describe('Function Detection', () => {
    it('should detect all HTTP-related functions', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasNode('FUNCTION', 'fetchUsers')
        .hasNode('FUNCTION', 'createUser')
        .hasNode('FUNCTION', 'fetchGig')
        .hasNode('FUNCTION', 'searchSpotify')
        .hasNode('FUNCTION', 'getUsersAxios')
        .hasNode('FUNCTION', 'createUserAxios')
        .hasNode('FUNCTION', 'fetchGitlab')
        .hasNode('FUNCTION', 'fetchProtectedData')
        .hasNode('FUNCTION', 'fetchAndProcess')
        .hasNode('FUNCTION', 'fetchMultiple');
    });

    it('should detect authFetch arrow function', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // authFetch - это arrow function assigned to const
      (await assertGraph(backend))
        .hasNode('FUNCTION', 'authFetch');
    });
  });

  describe('Graph Structure Validation', () => {
    it('should have valid graph structure', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .allEdgesValid()
        .noDuplicateIds();
    });

    it('should connect modules to service', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasEdge('SERVICE', 'http-requests-fixture', 'CONTAINS', 'MODULE', 'index.js')
        .hasEdge('SERVICE', 'http-requests-fixture', 'CONTAINS', 'MODULE', 'client.js');
    });

    it('should connect http:request nodes to modules via CONTAINS', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allEdges = await backend.getAllEdges();
      const containsEdges = allEdges.filter(e => e.type === 'CONTAINS');

      const allNodes = await backend.getAllNodes();
      const moduleIds = new Set(allNodes.filter(n => n.type === 'MODULE').map(n => n.id));
      const requestIds = new Set(allNodes.filter(n => n.type === 'http:request').map(n => n.id));

      const moduleToRequestEdges = containsEdges.filter(e =>
        moduleIds.has(e.fromId || e.src) && requestIds.has(e.toId || e.dst)
      );

      assert.ok(moduleToRequestEdges.length >= 1,
        'Should have CONTAINS edges from MODULE to http:request');
    });
  });
});
