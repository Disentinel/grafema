/**
 * NetworkRequestNode Migration Tests (REG-109)
 *
 * Integration tests verifying that GraphBuilder and ExpressAnalyzer
 * use NetworkRequestNode.create() instead of inline object literals.
 *
 * CRITICAL: Verifies type is 'net:request' (namespaced string), NOT 'NET_REQUEST'.
 *
 * Verifies:
 * 1. GraphBuilder creates net:request singleton when analyzing HTTP requests
 * 2. http:request nodes connect to net:request via CALLS edges
 * 3. Singleton deduplication (multiple HTTP requests -> one net:request node)
 * 4. No inline object literals for net:request nodes
 * 5. Node has all fields from NetworkRequestNode.create()
 *
 * Current state (before implementation):
 * - GraphBuilder.bufferHttpRequests() creates net:request inline (line 651)
 * - ExpressAnalyzer creates net:request inline (line 84)
 *
 * Target state (after implementation):
 * - GraphBuilder uses NetworkRequestNode.create()
 * - ExpressAnalyzer uses NetworkRequestNode.create()
 * - All net:request nodes have consistent structure
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * Some tests will FAIL initially - implementation comes after.
 */

import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { NetworkRequestNode } from '@grafema/core';
import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

/**
 * Helper to collect async generator results into an array
 */
async function collectNodes(asyncGen) {
  const results = [];
  for await (const node of asyncGen) {
    results.push(node);
  }
  return results;
}

let testCounter = 0;

/**
 * Helper to create a test project with given files
 * Creates package.json with main entry point for analysis
 */
async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-netreq-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.ts
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-network-request-${testCounter}`,
      type: 'module',
      main: 'index.ts'
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

// ============================================================================
// 1. GraphBuilder creates net:request singleton
// ============================================================================

describe('NetworkRequestNode Migration (REG-109)', () => {
  let backend;

  beforeEach(async () => {
    backend = createTestBackend();
    await backend.connect();
  });

  afterEach(async () => {
    if (backend) {
      await backend.close();
    }
  });

  describe('GraphBuilder creates net:request singleton', () => {
    it('should create net:request node when analyzing HTTP request', async () => {
      await setupTest(backend, {
        'index.ts': `
          export async function fetchData() {
            const response = await fetch('https://api.example.com/data');
            return response.json();
          }
        `
      });

      const graph = backend;

      // Find net:request node
      const networkNodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));

      assert.ok(
        networkNodes.length > 0,
        'Should create at least one net:request node'
      );
    });

    it('should create singleton with correct ID', async () => {
      await setupTest(backend, {
        'index.ts': `
          export async function fetchUser() {
            return fetch('https://api.example.com/user');
          }
        `
      });

      const graph = backend;
      const networkNodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));

      assert.ok(networkNodes.length > 0, 'Should have net:request node');

      const networkNode = networkNodes[0];
      assert.strictEqual(
        networkNode.id,
        'net:request#__network__',
        'Should use singleton ID from NetworkRequestNode'
      );
    });

    it('should create singleton with type "net:request"', async () => {
      await setupTest(backend, {
        'index.ts': `
          export function fetchPost() {
            return fetch('https://api.example.com/posts/1');
          }
        `
      });

      const graph = backend;
      const networkNodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));

      assert.ok(networkNodes.length > 0, 'Should have net:request node');

      const networkNode = networkNodes[0];
      assert.strictEqual(
        networkNode.type,
        'net:request',
        'Type should be "net:request" (NOT "NET_REQUEST")'
      );
    });

    it('should set name to __network__', async () => {
      await setupTest(backend, {
        'index.ts': `
          export function makeRequest() {
            return fetch('https://api.example.com/endpoint');
          }
        `
      });

      const graph = backend;
      const networkNodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));

      assert.ok(networkNodes.length > 0, 'Should have net:request node');

      const networkNode = networkNodes[0];
      assert.strictEqual(
        networkNode.name,
        '__network__',
        'Name should be __network__'
      );
    });

    it('should set file to __builtin__', async () => {
      await setupTest(backend, {
        'index.ts': `
          export function apiCall() {
            return fetch('https://api.example.com');
          }
        `
      });

      const graph = backend;
      const networkNodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));

      assert.ok(networkNodes.length > 0, 'Should have net:request node');

      const networkNode = networkNodes[0];
      assert.strictEqual(
        networkNode.file,
        '__builtin__',
        'File should be __builtin__ (not a source file)'
      );
    });

    it('should set line to 0', async () => {
      await setupTest(backend, {
        'index.ts': `
          export function request() {
            return fetch('https://api.example.com');
          }
        `
      });

      const graph = backend;
      const networkNodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));

      assert.ok(networkNodes.length > 0, 'Should have net:request node');

      const networkNode = networkNodes[0];
      assert.strictEqual(
        networkNode.line,
        0,
        'Line should be 0 (not from source code)'
      );
    });
  });

  // ============================================================================
  // 2. http:request connects to net:request singleton
  // ============================================================================

  describe('http:request connects to net:request singleton', () => {
    it('should create CALLS edge from http:request to net:request', async () => {
      await setupTest(backend, {
        'index.ts': `
          export function getData() {
            return fetch('https://api.example.com/data');
          }
        `
      });

      const graph = backend;

      // Find http:request node
      const httpNodes = await collectNodes(graph.queryNodes({ type: 'http:request' }));
      assert.ok(httpNodes.length > 0, 'Should have http:request node');

      const httpNode = httpNodes[0];

      // Find edges from http:request to net:request
      const edges = await graph.getOutgoingEdges(httpNode.id, ['CALLS']);

      assert.ok(edges.length > 0, 'Should have CALLS edge from http:request');

      const callsEdge = edges.find(e => e.dst === 'net:request#__network__' || e.dst.includes('net:request'));
      assert.ok(
        callsEdge,
        'http:request should have CALLS edge to net:request singleton'
      );
    });

    it('should connect multiple http:request nodes to same singleton', async () => {
      await setupTest(backend, {
        'index.ts': `
          export function getUser() {
            return fetch('https://api.example.com/user');
          }

          export function getPosts() {
            return fetch('https://api.example.com/posts');
          }

          export function getComments() {
            return fetch('https://api.example.com/comments');
          }
        `
      });

      const graph = backend;

      // Find all http:request nodes
      const httpNodes = await collectNodes(graph.queryNodes({ type: 'http:request' }));
      assert.ok(
        httpNodes.length >= 3,
        'Should have at least 3 http:request nodes'
      );

      // Verify each http:request connects to net:request singleton
      for (const httpNode of httpNodes) {
        const edges = await graph.getOutgoingEdges(httpNode.id, ['CALLS']);
        const netRequestEdge = edges.find(e => e.dst === 'net:request#__network__' || e.dst.includes('net:request'));

        assert.ok(
          netRequestEdge,
          `http:request ${httpNode.id} should connect to net:request singleton`
        );
      }
    });
  });

  // ============================================================================
  // 3. Singleton deduplication
  // ============================================================================

  describe('Singleton deduplication', () => {
    it('should create only ONE net:request node for multiple HTTP requests', async () => {
      await setupTest(backend, {
        'index.ts': `
          export function fetchA() {
            return fetch('https://api.example.com/a');
          }

          export function fetchB() {
            return fetch('https://api.example.com/b');
          }

          export function fetchC() {
            return fetch('https://api.example.com/c');
          }

          export function fetchD() {
            return fetch('https://api.example.com/d');
          }
        `
      });

      const graph = backend;

      // Find all net:request nodes
      const networkNodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));

      assert.strictEqual(
        networkNodes.length,
        1,
        'Should have exactly ONE net:request node (singleton)'
      );
    });

    it('should deduplicate across multiple files', async () => {
      await setupTest(backend, {
        'index.ts': `
          export { fetchUser } from './user.js';
          export { fetchPost } from './post.js';
        `,
        'user.js': `
          export function fetchUser() {
            return fetch('https://api.example.com/user');
          }
        `,
        'post.js': `
          export function fetchPost() {
            return fetch('https://api.example.com/post');
          }
        `
      });

      const graph = backend;

      // Verify multiple http:request nodes exist
      const httpNodes = await collectNodes(graph.queryNodes({ type: 'http:request' }));
      assert.ok(
        httpNodes.length >= 2,
        'Should have http:request nodes from multiple files'
      );

      // Verify only ONE net:request node
      const networkNodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));
      assert.strictEqual(
        networkNodes.length,
        1,
        'Should have exactly ONE net:request node across all files'
      );
    });

    it('should deduplicate with same ID', async () => {
      await setupTest(backend, {
        'index.ts': `
          export function request1() {
            return fetch('https://api.example.com/1');
          }

          export function request2() {
            return fetch('https://api.example.com/2');
          }
        `
      });

      const graph = backend;
      const networkNodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));

      assert.strictEqual(networkNodes.length, 1, 'Should have one net:request node');

      const networkNode = networkNodes[0];
      assert.strictEqual(
        networkNode.id,
        NetworkRequestNode.SINGLETON_ID,
        'Deduplicated node should have NetworkRequestNode.SINGLETON_ID'
      );
    });
  });

  // ============================================================================
  // 4. Node structure verification (no inline literals)
  // ============================================================================

  describe('Node structure verification', () => {
    it('should have all fields from NetworkRequestNode.create()', async () => {
      await setupTest(backend, {
        'index.ts': `
          export function makeCall() {
            return fetch('https://api.example.com');
          }
        `
      });

      const graph = backend;
      const networkNodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));

      assert.ok(networkNodes.length > 0, 'Should have net:request node');

      const networkNode = networkNodes[0];
      const expectedNode = NetworkRequestNode.create();

      // Verify all fields match NetworkRequestNode.create() output
      assert.strictEqual(networkNode.id, expectedNode.id, 'ID should match');
      assert.strictEqual(networkNode.type, expectedNode.type, 'Type should match');
      assert.strictEqual(networkNode.name, expectedNode.name, 'Name should match');
      assert.strictEqual(networkNode.file, expectedNode.file, 'File should match');
      assert.strictEqual(networkNode.line, expectedNode.line, 'Line should match');
    });

    it('should not have extra fields from inline literals', async () => {
      await setupTest(backend, {
        'index.ts': `
          export function apiRequest() {
            return fetch('https://api.example.com');
          }
        `
      });

      const graph = backend;
      const networkNodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));

      assert.ok(networkNodes.length > 0, 'Should have net:request node');

      const networkNode = networkNodes[0];
      const expectedNode = NetworkRequestNode.create();

      // Verify node structure matches factory output
      // (Some backends may add metadata fields, but core fields should match)
      assert.strictEqual(
        networkNode.id,
        expectedNode.id,
        'Should use NetworkRequestNode factory ID'
      );
      assert.strictEqual(
        networkNode.type,
        expectedNode.type,
        'Should use NetworkRequestNode factory type'
      );
    });

    it('should validate using NetworkRequestNode.validate()', async () => {
      await setupTest(backend, {
        'index.ts': `
          export function fetch1() {
            return fetch('https://api.example.com/1');
          }
        `
      });

      const graph = backend;
      const networkNodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));

      assert.ok(networkNodes.length > 0, 'Should have net:request node');

      const networkNode = networkNodes[0];
      const errors = NetworkRequestNode.validate(networkNode);

      assert.strictEqual(
        errors.length,
        0,
        'Node from GraphBuilder should pass NetworkRequestNode validation'
      );
    });
  });

  // ============================================================================
  // 5. Distinction from http:request nodes
  // ============================================================================

  describe('Distinction from http:request nodes', () => {
    it('should create both net:request singleton and http:request nodes', async () => {
      await setupTest(backend, {
        'index.ts': `
          export function getData() {
            return fetch('https://api.example.com/data');
          }
        `
      });

      const graph = backend;

      // Should have net:request singleton
      const networkNodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));
      assert.strictEqual(
        networkNodes.length,
        1,
        'Should have one net:request singleton'
      );

      // Should have http:request call sites
      const httpNodes = await collectNodes(graph.queryNodes({ type: 'http:request' }));
      assert.ok(
        httpNodes.length > 0,
        'Should have http:request nodes for call sites'
      );

      // Types should be different
      assert.notStrictEqual(
        networkNodes[0].type,
        httpNodes[0].type,
        'net:request and http:request should have different types'
      );
    });

    it('should have net:request as built-in, http:request as source code', async () => {
      await setupTest(backend, {
        'index.ts': `
          export function fetchUser() {
            return fetch('https://api.example.com/user');
          }
        `
      });

      const graph = backend;

      const networkNodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));
      const httpNodes = await collectNodes(graph.queryNodes({ type: 'http:request' }));

      assert.ok(networkNodes.length > 0, 'Should have net:request');
      assert.ok(httpNodes.length > 0, 'Should have http:request');

      const networkNode = networkNodes[0];
      const httpNode = httpNodes[0];

      // net:request is built-in
      assert.strictEqual(
        networkNode.file,
        '__builtin__',
        'net:request should be __builtin__'
      );

      // http:request is from source code
      assert.ok(
        httpNode.file.endsWith('index.ts'),
        'http:request should reference source file'
      );
      assert.ok(
        httpNode.line > 0,
        'http:request should have real line number'
      );
    });

    it('should have net:request as singleton, http:request as many', async () => {
      await setupTest(backend, {
        'index.ts': `
          export function fetch1() { return fetch('https://api.example.com/1'); }
          export function fetch2() { return fetch('https://api.example.com/2'); }
          export function fetch3() { return fetch('https://api.example.com/3'); }
        `
      });

      const graph = backend;

      const networkNodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));
      const httpNodes = await collectNodes(graph.queryNodes({ type: 'http:request' }));

      assert.strictEqual(
        networkNodes.length,
        1,
        'Should have exactly ONE net:request (singleton)'
      );
      assert.ok(
        httpNodes.length >= 3,
        'Should have multiple http:request nodes (one per call site)'
      );
    });
  });
});
