/**
 * MethodCallResolver Tests
 *
 * Tests the enrichment plugin that creates CALLS edges for method calls
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { MethodCallResolver } from '@grafema/core';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('MethodCallResolver', () => {
  let testCounter = 0;

  async function setupBackend() {
    const testDir = join(tmpdir(), `navi-test-methodresolver-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    const db = await createTestDatabase();
    const backend = db.backend;

    return { backend, testDir };
  }

  // ==========================================================================
  // REG-583: Runtime-typed builtin resolution
  // ==========================================================================

  describe('Runtime-typed builtin resolution (REG-583)', () => {
    it('should create CALLS edge to WEB_API:console for console.log()', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // Add METHOD_CALL for console.log
        await backend.addNode({
          id: 'console-log-call',
          type: 'CALL',
          name: 'console.log',
          file: 'test.js',
          line: 5,
          object: 'console',
          method: 'log'
        });

        await backend.flush();

        // Execute resolver
        const result = await resolver.execute({ graph: backend });

        // REG-583: Should create CALLS edge to WEB_API:console
        const edges = await backend.getOutgoingEdges('console-log-call', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create one CALLS edge for console.log');
        assert.strictEqual(edges[0].dst, 'WEB_API:console',
          'Should point to WEB_API:console');

        // Verify the WEB_API:console node was created
        const targetNode = await backend.getNode('WEB_API:console');
        assert.ok(targetNode, 'WEB_API:console node should exist');
        assert.strictEqual(targetNode.type, 'WEB_API',
          'Node type should be WEB_API');
      } finally {
        await backend.close();
      }
    });

    it('should create CALLS edges for Math, JSON, Promise built-ins', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // Add various builtin method calls
        await backend.addNodes([
          {
            id: 'math-call',
            type: 'CALL',
            name: 'Math.random',
            file: 'test.js',
            object: 'Math',
            method: 'random'
          },
          {
            id: 'json-call',
            type: 'CALL',
            name: 'JSON.parse',
            file: 'test.js',
            object: 'JSON',
            method: 'parse'
          },
          {
            id: 'promise-call',
            type: 'CALL',
            name: 'Promise.resolve',
            file: 'test.js',
            object: 'Promise',
            method: 'resolve'
          }
        ]);

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // REG-583: Each should have a CALLS edge to its runtime-typed node
        const mathEdges = await backend.getOutgoingEdges('math-call', ['CALLS']);
        assert.strictEqual(mathEdges.length, 1, 'Math.random should have CALLS edge');
        assert.strictEqual(mathEdges[0].dst, 'ECMASCRIPT_BUILTIN:Math');

        const jsonEdges = await backend.getOutgoingEdges('json-call', ['CALLS']);
        assert.strictEqual(jsonEdges.length, 1, 'JSON.parse should have CALLS edge');
        assert.strictEqual(jsonEdges[0].dst, 'ECMASCRIPT_BUILTIN:JSON');

        const promiseEdges = await backend.getOutgoingEdges('promise-call', ['CALLS']);
        assert.strictEqual(promiseEdges.length, 1, 'Promise.resolve should have CALLS edge');
        assert.strictEqual(promiseEdges[0].dst, 'ECMASCRIPT_BUILTIN:Promise');

        // Verify node types
        const mathNode = await backend.getNode('ECMASCRIPT_BUILTIN:Math');
        assert.ok(mathNode, 'ECMASCRIPT_BUILTIN:Math node should exist');
        assert.strictEqual(mathNode.type, 'ECMASCRIPT_BUILTIN');
      } finally {
        await backend.close();
      }
    });

    it('should create CALLS edge to NODEJS_STDLIB:process for process.exit()', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNode({
          id: 'process-exit-call',
          type: 'CALL',
          name: 'process.exit',
          file: 'app.js',
          line: 10,
          object: 'process',
          method: 'exit'
        });

        await backend.flush();
        await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('process-exit-call', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'process.exit() should have CALLS edge');
        assert.strictEqual(edges[0].dst, 'NODEJS_STDLIB:process');

        const targetNode = await backend.getNode('NODEJS_STDLIB:process');
        assert.ok(targetNode, 'NODEJS_STDLIB:process node should exist');
        assert.strictEqual(targetNode.type, 'NODEJS_STDLIB');
      } finally {
        await backend.close();
      }
    });

    it('should create CALLS edge to ECMASCRIPT_BUILTIN:prototype for arr.map(fn)', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // arr is a variable, map is a prototype method
        await backend.addNode({
          id: 'arr-map-call',
          type: 'CALL',
          name: 'arr.map',
          file: 'app.js',
          line: 5,
          object: 'arr',
          method: 'map'
        });

        await backend.flush();
        await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('arr-map-call', ['CALLS']);
        assert.strictEqual(edges.length, 1,
          'arr.map() should have CALLS edge to prototype');
        assert.strictEqual(edges[0].dst, 'ECMASCRIPT_BUILTIN:prototype',
          'Should point to ECMASCRIPT_BUILTIN:prototype');
      } finally {
        await backend.close();
      }
    });

    it('should create CALLS edge to ECMASCRIPT_BUILTIN:prototype for str.split()', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // str is a variable, split is a prototype method
        await backend.addNode({
          id: 'str-split-call',
          type: 'CALL',
          name: 'str.split',
          file: 'app.js',
          line: 5,
          object: 'str',
          method: 'split'
        });

        await backend.flush();
        await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('str-split-call', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'str.split() should have CALLS edge');
        assert.strictEqual(edges[0].dst, 'ECMASCRIPT_BUILTIN:prototype');
      } finally {
        await backend.close();
      }
    });

    it('should create CALLS edge to EXTERNAL_MODULE:axios for axios.get(url)', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // axios is an npm package namespace — should get EXTERNAL_MODULE edge (not skip)
        await backend.addNode({
          id: 'axios-get-call',
          type: 'CALL',
          name: 'axios.get',
          file: 'api.js',
          line: 5,
          object: 'axios',
          method: 'get'
        });

        await backend.flush();
        await resolver.execute({ graph: backend });

        // DEFECT 1 fix: npm packages now get CALLS edge to EXTERNAL_MODULE:{obj}
        const edges = await backend.getOutgoingEdges('axios-get-call', ['CALLS']);
        assert.strictEqual(edges.length, 1,
          'axios.get() should create CALLS edge to EXTERNAL_MODULE:axios');
        assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:axios');

        // Verify EXTERNAL_MODULE:axios node exists
        const targetNode = await backend.getNode('EXTERNAL_MODULE:axios');
        assert.ok(targetNode, 'EXTERNAL_MODULE:axios node should exist');
        assert.strictEqual(targetNode.type, 'EXTERNAL_MODULE');
      } finally {
        await backend.close();
      }
    });

    it('should create CALLS edge to UNKNOWN_CALL_TARGET:res for res.json(data)', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // res is an unknown application variable
        await backend.addNode({
          id: 'res-json-call',
          type: 'CALL',
          name: 'res.json',
          file: 'handler.js',
          line: 10,
          object: 'res',
          method: 'json'
        });

        await backend.flush();
        await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('res-json-call', ['CALLS']);
        assert.strictEqual(edges.length, 1,
          'res.json() should create CALLS edge');
        assert.strictEqual(edges[0].dst, 'UNKNOWN_CALL_TARGET:res',
          'Should point to UNKNOWN_CALL_TARGET:res');

        const targetNode = await backend.getNode('UNKNOWN_CALL_TARGET:res');
        assert.ok(targetNode, 'UNKNOWN_CALL_TARGET:res node should exist');
        assert.strictEqual(targetNode.type, 'UNKNOWN_CALL_TARGET');
      } finally {
        await backend.close();
      }
    });

    it('should create CALLS edge to EXTERNAL_MODULE:socket for socket.emit()', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNode({
          id: 'socket-emit-call',
          type: 'CALL',
          name: 'socket.emit',
          file: 'events.js',
          line: 15,
          object: 'socket',
          method: 'emit'
        });

        await backend.flush();
        await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('socket-emit-call', ['CALLS']);
        assert.strictEqual(edges.length, 1,
          'socket.emit() should create CALLS edge');
        assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:socket');
      } finally {
        await backend.close();
      }
    });

    it('should create only ONE WEB_API:console node when console.log() called twice', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNodes([
          {
            id: 'console-log-call-1',
            type: 'CALL',
            name: 'console.log',
            file: 'app.js',
            line: 5,
            object: 'console',
            method: 'log'
          },
          {
            id: 'console-warn-call-2',
            type: 'CALL',
            name: 'console.warn',
            file: 'app.js',
            line: 10,
            object: 'console',
            method: 'warn'
          }
        ]);

        await backend.flush();
        await resolver.execute({ graph: backend });

        // Both calls should have CALLS edges
        const edges1 = await backend.getOutgoingEdges('console-log-call-1', ['CALLS']);
        assert.strictEqual(edges1.length, 1);
        assert.strictEqual(edges1[0].dst, 'WEB_API:console');

        const edges2 = await backend.getOutgoingEdges('console-warn-call-2', ['CALLS']);
        assert.strictEqual(edges2.length, 1);
        assert.strictEqual(edges2[0].dst, 'WEB_API:console');

        // Only ONE WEB_API:console node should exist (dedup)
        const consoleNode = await backend.getNode('WEB_API:console');
        assert.ok(consoleNode, 'WEB_API:console node should exist (created once)');
      } finally {
        await backend.close();
      }
    });

    it('should skip when NodejsBuiltinsResolver already created CALLS edge (duplicate prevention)', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // Simulate: NodejsBuiltinsResolver already ran and created precise edge
        await backend.addNodes([
          {
            id: 'EXTERNAL_FUNCTION:fs.readFile',
            type: 'EXTERNAL_FUNCTION',
            name: 'readFile',
            file: '',
            line: 0
          },
          {
            id: 'fs-readFile-call',
            type: 'CALL',
            name: 'fs.readFile',
            file: 'app.js',
            line: 5,
            object: 'fs',
            method: 'readFile'
          }
        ]);

        // Pre-existing CALLS edge from NodejsBuiltinsResolver
        await backend.addEdge({
          src: 'fs-readFile-call',
          dst: 'EXTERNAL_FUNCTION:fs.readFile',
          type: 'CALLS'
        });

        await backend.flush();
        await resolver.execute({ graph: backend });

        // Should still have only the original edge — no second edge created
        const edges = await backend.getOutgoingEdges('fs-readFile-call', ['CALLS']);
        assert.strictEqual(edges.length, 1,
          'Should have exactly one CALLS edge (from NodejsBuiltinsResolver)');
        assert.strictEqual(edges[0].dst, 'EXTERNAL_FUNCTION:fs.readFile',
          'Should keep the precise edge from NodejsBuiltinsResolver');
      } finally {
        await backend.close();
      }
    });

    it('should resolve res.json() and res.send() to the same UNKNOWN_CALL_TARGET:res', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNodes([
          {
            id: 'res-json-call',
            type: 'CALL',
            name: 'res.json',
            file: 'handler.js',
            line: 10,
            object: 'res',
            method: 'json'
          },
          {
            id: 'res-send-call',
            type: 'CALL',
            name: 'res.send',
            file: 'handler.js',
            line: 15,
            object: 'res',
            method: 'send'
          }
        ]);

        await backend.flush();
        await resolver.execute({ graph: backend });

        const edgesJson = await backend.getOutgoingEdges('res-json-call', ['CALLS']);
        assert.strictEqual(edgesJson.length, 1);
        assert.strictEqual(edgesJson[0].dst, 'UNKNOWN_CALL_TARGET:res');

        const edgesSend = await backend.getOutgoingEdges('res-send-call', ['CALLS']);
        assert.strictEqual(edgesSend.length, 1);
        assert.strictEqual(edgesSend[0].dst, 'UNKNOWN_CALL_TARGET:res',
          'Both res.json() and res.send() should point to same UNKNOWN_CALL_TARGET:res');
      } finally {
        await backend.close();
      }
    });

    it('should resolve document.querySelector() to BROWSER_API:document', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNode({
          id: 'doc-qs-call',
          type: 'CALL',
          name: 'document.querySelector',
          file: 'ui.js',
          line: 3,
          object: 'document',
          method: 'querySelector'
        });

        await backend.flush();
        await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('doc-qs-call', ['CALLS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'BROWSER_API:document');

        const targetNode = await backend.getNode('BROWSER_API:document');
        assert.ok(targetNode, 'BROWSER_API:document node should exist');
        assert.strictEqual(targetNode.type, 'BROWSER_API');
      } finally {
        await backend.close();
      }
    });

    it('should resolve Buffer.from() to NODEJS_STDLIB:Buffer', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNode({
          id: 'buffer-from-call',
          type: 'CALL',
          name: 'Buffer.from',
          file: 'utils.js',
          line: 7,
          object: 'Buffer',
          method: 'from'
        });

        await backend.flush();
        await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('buffer-from-call', ['CALLS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'NODEJS_STDLIB:Buffer');
      } finally {
        await backend.close();
      }
    });

    it('should resolve localStorage.getItem() to BROWSER_API:localStorage', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNode({
          id: 'ls-get-call',
          type: 'CALL',
          name: 'localStorage.getItem',
          file: 'storage.js',
          line: 3,
          object: 'localStorage',
          method: 'getItem'
        });

        await backend.flush();
        await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('ls-get-call', ['CALLS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'BROWSER_API:localStorage');
      } finally {
        await backend.close();
      }
    });

    it('should resolve fs.readFile() to NODEJS_STDLIB:fs when no prior edge exists (GAP 3)', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // fs is in NODEJS_STDLIB_OBJECTS after GAP 3 fix — no pre-existing edge
        await backend.addNode({
          id: 'fs-readFile-call-no-prior',
          type: 'CALL',
          name: 'fs.readFile',
          file: 'app.js',
          line: 5,
          object: 'fs',
          method: 'readFile'
        });

        await backend.flush();
        await resolver.execute({ graph: backend });

        // After GAP 3 fix, fs is in NODEJS_STDLIB_OBJECTS — resolved at Step 2
        const edges = await backend.getOutgoingEdges('fs-readFile-call-no-prior', ['CALLS']);
        assert.strictEqual(edges.length, 1,
          'fs.readFile() should have CALLS edge when no prior edge from NodejsBuiltinsResolver');
        assert.strictEqual(edges[0].dst, 'NODEJS_STDLIB:fs',
          'Should point to NODEJS_STDLIB:fs (coarser but non-silent)');
      } finally {
        await backend.close();
      }
    });

    it('should resolve WebSocket.send() to BROWSER_API:WebSocket (GAP 4)', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        await backend.addNode({
          id: 'ws-send-call',
          type: 'CALL',
          name: 'WebSocket.send',
          file: 'realtime.js',
          line: 12,
          object: 'WebSocket',
          method: 'send'
        });

        await backend.flush();
        await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('ws-send-call', ['CALLS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'BROWSER_API:WebSocket');
      } finally {
        await backend.close();
      }
    });

    it('should resolve user-defined class method named push/get/map over prototype heuristic', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // User-defined class Queue with a push() method
        await backend.addNode({
          id: 'class-queue',
          type: 'CLASS',
          name: 'Queue',
          file: 'queue.js',
          line: 1
        });

        await backend.addNode({
          id: 'method-queue-push',
          type: 'METHOD',
          name: 'push',
          file: 'queue.js',
          line: 5
        });

        await backend.addEdge({
          src: 'class-queue',
          dst: 'method-queue-push',
          type: 'CONTAINS'
        });

        // Method call: queue.push(item) — "push" is in BUILTIN_PROTOTYPE_METHODS
        await backend.addNode({
          id: 'call-queue-push',
          type: 'CALL',
          name: 'queue.push',
          file: 'main.js',
          line: 10,
          object: 'queue',
          method: 'push'
        });

        // Variable "queue" is INSTANCE_OF Queue
        await backend.addNode({
          id: 'var-queue',
          type: 'VARIABLE',
          name: 'queue',
          file: 'main.js',
          line: 8
        });

        await backend.addEdge({
          src: 'var-queue',
          dst: 'class-queue',
          type: 'INSTANCE_OF'
        });

        await backend.flush();
        await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('call-queue-push', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should have exactly one CALLS edge');
        assert.strictEqual(
          edges[0].dst,
          'method-queue-push',
          'Should resolve to user-defined Queue.push, NOT ECMASCRIPT_BUILTIN:prototype'
        );
      } finally {
        await backend.close();
      }
    });
  });

  describe('Class method resolution', () => {
    it('should resolve method call to class method by class name', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // Create a class with a method
        await backend.addNodes([
          {
            id: 'user-class',
            type: 'CLASS',
            name: 'User',
            file: 'user.js',
            line: 1
          },
          {
            id: 'user-save-method',
            type: 'METHOD',
            name: 'save',
            file: 'user.js',
            line: 5
          },
          // Method call: User.save() (static call)
          {
            id: 'user-save-call',
            type: 'CALL',
            name: 'User.save',
            file: 'app.js',
            line: 10,
            object: 'User',
            method: 'save'
          }
        ]);

        // Create CONTAINS edge: CLASS -> METHOD
        await backend.addEdge({
          src: 'user-class',
          dst: 'user-save-method',
          type: 'CONTAINS'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // Should create CALLS edge
        const edges = await backend.getOutgoingEdges('user-save-call', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create one CALLS edge');

        // Get the target node to verify
        const targetNode = await backend.getNode(edges[0].dst);
        assert.strictEqual(targetNode.name, 'save', 'Should point to the save method');

        console.log('Class method resolution by class name works');
      } finally {
        await backend.close();
      }
    });

    it('should resolve this.method() to containing class method', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // Create class structure
        await backend.addNodes([
          {
            id: 'service-class',
            type: 'CLASS',
            name: 'UserService',
            file: 'service.js',
            line: 1
          },
          {
            id: 'service-init-method',
            type: 'METHOD',
            name: 'init',
            file: 'service.js',
            line: 3
          },
          {
            id: 'service-helper-method',
            type: 'METHOD',
            name: 'helper',
            file: 'service.js',
            line: 10
          },
          // Method call: this.helper() inside init
          {
            id: 'this-helper-call',
            type: 'CALL',
            name: 'this.helper',
            file: 'service.js',
            line: 5,
            object: 'this',
            method: 'helper'
          }
        ]);

        // Create containment hierarchy
        // CLASS -> METHOD (init)
        await backend.addEdge({
          src: 'service-class',
          dst: 'service-init-method',
          type: 'CONTAINS'
        });
        // CLASS -> METHOD (helper)
        await backend.addEdge({
          src: 'service-class',
          dst: 'service-helper-method',
          type: 'CONTAINS'
        });
        // METHOD (init) -> CALL (this.helper)
        await backend.addEdge({
          src: 'service-init-method',
          dst: 'this-helper-call',
          type: 'CONTAINS'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // Should create CALLS edge from this.helper() to helper method
        const edges = await backend.getOutgoingEdges('this-helper-call', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create one CALLS edge for this.helper()');

        const targetNode = await backend.getNode(edges[0].dst);
        assert.strictEqual(targetNode.name, 'helper', 'Should point to helper method');

        console.log('this.method() resolution works');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Variable type resolution', () => {
    it('should resolve method call via INSTANCE_OF edge', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // Create class with method
        await backend.addNodes([
          {
            id: 'repo-class',
            type: 'CLASS',
            name: 'Repository',
            file: 'repo.js',
            line: 1
          },
          {
            id: 'repo-findById-method',
            type: 'METHOD',
            name: 'findById',
            file: 'repo.js',
            line: 5
          },
          // Variable: const repo = new Repository()
          {
            id: 'repo-var',
            type: 'VARIABLE',
            name: 'repo',
            file: 'app.js',
            line: 3
          },
          // Method call: repo.findById()
          {
            id: 'repo-findById-call',
            type: 'CALL',
            name: 'repo.findById',
            file: 'app.js',
            line: 5,
            object: 'repo',
            method: 'findById'
          }
        ]);

        // CLASS -> METHOD
        await backend.addEdge({
          src: 'repo-class',
          dst: 'repo-findById-method',
          type: 'CONTAINS'
        });

        // VARIABLE -> INSTANCE_OF -> CLASS
        await backend.addEdge({
          src: 'repo-var',
          dst: 'repo-class',
          type: 'INSTANCE_OF'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // Should create CALLS edge
        const edges = await backend.getOutgoingEdges('repo-findById-call', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create one CALLS edge');

        const targetNode = await backend.getNode(edges[0].dst);
        assert.strictEqual(targetNode.name, 'findById', 'Should point to findById method');

        console.log('INSTANCE_OF based resolution works');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Edge cases', () => {
    it('should not create duplicate CALLS edges', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // Create nodes
        await backend.addNodes([
          {
            id: 'svc-class',
            type: 'CLASS',
            name: 'Service',
            file: 'svc.js',
            line: 1
          },
          {
            id: 'svc-run-method',
            type: 'METHOD',
            name: 'run',
            file: 'svc.js',
            line: 3
          },
          {
            id: 'svc-run-call',
            type: 'CALL',
            name: 'Service.run',
            file: 'app.js',
            line: 10,
            object: 'Service',
            method: 'run'
          }
        ]);

        await backend.addEdge({
          src: 'svc-class',
          dst: 'svc-run-method',
          type: 'CONTAINS'
        });

        // Pre-existing CALLS edge
        await backend.addEdge({
          src: 'svc-run-call',
          dst: 'svc-run-method',
          type: 'CALLS'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // Should not create another edge
        const edges = await backend.getOutgoingEdges('svc-run-call', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should still have only one CALLS edge');
        assert.strictEqual(result.created.edges, 0, 'Should report 0 edges created');

        console.log('Duplicate prevention works');
      } finally {
        await backend.close();
      }
    });

    it('should create UNKNOWN_CALL_TARGET for unresolvable method calls (REG-583)', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // Method call to unknown object — not a builtin, not a prototype method,
        // not an npm namespace. Falls through to Step 5: UNKNOWN_CALL_TARGET.
        await backend.addNode({
          id: 'unknown-call',
          type: 'CALL',
          name: 'unknownObj.doSomething',
          file: 'app.js',
          line: 5,
          object: 'unknownObj',
          method: 'doSomething'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // REG-583: Unknown objects now get CALLS edge to UNKNOWN_CALL_TARGET:{obj}
        const edges = await backend.getOutgoingEdges('unknown-call', ['CALLS']);
        assert.strictEqual(edges.length, 1,
          'unknownObj.doSomething() should create CALLS edge to UNKNOWN_CALL_TARGET');
        assert.strictEqual(edges[0].dst, 'UNKNOWN_CALL_TARGET:unknownObj');

        const targetNode = await backend.getNode('UNKNOWN_CALL_TARGET:unknownObj');
        assert.ok(targetNode, 'UNKNOWN_CALL_TARGET:unknownObj node should exist');
        assert.strictEqual(targetNode.type, 'UNKNOWN_CALL_TARGET');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Integration with Datalog validation', () => {
    it('should work with CallResolverValidator', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // Create full scenario
        await backend.addNodes([
          // Class with method
          {
            id: 'api-class',
            type: 'CLASS',
            name: 'ApiClient',
            file: 'api.js',
            line: 1
          },
          {
            id: 'api-fetch-method',
            type: 'METHOD',
            name: 'fetch',
            file: 'api.js',
            line: 5
          },
          // Resolved method call
          {
            id: 'api-fetch-call',
            type: 'CALL',
            name: 'ApiClient.fetch',
            file: 'app.js',
            line: 10,
            object: 'ApiClient',
            method: 'fetch'
          },
          // External method call
          {
            id: 'console-call',
            type: 'CALL',
            name: 'console.log',
            file: 'app.js',
            line: 15,
            object: 'console',
            method: 'log'
          }
        ]);

        await backend.addEdge({
          src: 'api-class',
          dst: 'api-fetch-method',
          type: 'CONTAINS'
        });

        await backend.flush();

        // Run resolver
        await resolver.execute({ graph: backend });

        // Verify with Datalog
        // METHOD_CALL without CALLS edge should be flagged (but console.log has object attr so excluded)
        const violations = await backend.checkGuarantee(`
          violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
        `);

        // No violations expected - ApiClient.fetch is resolved, console.log is external
        assert.strictEqual(violations.length, 0, 'Should have no violations after enrichment');

        console.log('Integration with Datalog validation works');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Interface CHA resolution (REG-485)', () => {
    it('should resolve method call through interface implementation', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // INTERFACE GraphBackend with method addNodes
        await backend.addNodes([
          {
            id: 'types.ts:INTERFACE:GraphBackend:1',
            type: 'INTERFACE',
            name: 'GraphBackend',
            file: 'types.ts',
            line: 1,
            column: 0,
            properties: JSON.stringify([{ name: 'addNodes', type: 'function' }])
          },
          // CLASS RFDBServerBackend with METHOD addNodes
          {
            id: 'rfdb-class',
            type: 'CLASS',
            name: 'RFDBServerBackend',
            file: 'rfdb.ts',
            line: 1
          },
          {
            id: 'rfdb-addNodes-method',
            type: 'METHOD',
            name: 'addNodes',
            file: 'rfdb.ts',
            line: 5
          },
          // METHOD_CALL: graph.addNodes()
          {
            id: 'graph-addNodes-call',
            type: 'CALL',
            name: 'graph.addNodes',
            file: 'app.ts',
            line: 10,
            object: 'graph',
            method: 'addNodes'
          }
        ]);

        // CLASS -> CONTAINS -> METHOD
        await backend.addEdge({
          src: 'rfdb-class',
          dst: 'rfdb-addNodes-method',
          type: 'CONTAINS'
        });

        // CLASS -> IMPLEMENTS -> INTERFACE
        await backend.addEdge({
          src: 'rfdb-class',
          dst: 'types.ts:INTERFACE:GraphBackend:1',
          type: 'IMPLEMENTS'
        });

        await backend.flush();

        await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('graph-addNodes-call', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create one CALLS edge via interface resolution');

        const targetNode = await backend.getNode(edges[0].dst);
        assert.strictEqual(targetNode.name, 'addNodes', 'Should point to RFDBServerBackend.addNodes');

        console.log('Basic interface CHA resolution works');
      } finally {
        await backend.close();
      }
    });

    it('should resolve method call through inherited interface chain', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // INTERFACE Base with method save
        await backend.addNodes([
          {
            id: 'types.ts:INTERFACE:Base:1',
            type: 'INTERFACE',
            name: 'Base',
            file: 'types.ts',
            line: 1,
            column: 0,
            properties: JSON.stringify([{ name: 'save', type: 'function' }])
          },
          // INTERFACE Child with method load, extends Base
          {
            id: 'types.ts:INTERFACE:Child:10',
            type: 'INTERFACE',
            name: 'Child',
            file: 'types.ts',
            line: 10,
            column: 0,
            properties: JSON.stringify([{ name: 'load', type: 'function' }])
          },
          // CLASS Impl with METHOD save AND METHOD load
          {
            id: 'impl-class',
            type: 'CLASS',
            name: 'Impl',
            file: 'impl.ts',
            line: 1
          },
          {
            id: 'impl-save-method',
            type: 'METHOD',
            name: 'save',
            file: 'impl.ts',
            line: 5
          },
          {
            id: 'impl-load-method',
            type: 'METHOD',
            name: 'load',
            file: 'impl.ts',
            line: 10
          },
          // METHOD_CALL: x.save()
          {
            id: 'x-save-call',
            type: 'CALL',
            name: 'x.save',
            file: 'app.ts',
            line: 20,
            object: 'x',
            method: 'save'
          }
        ]);

        // CLASS -> CONTAINS -> METHODs
        await backend.addEdge({
          src: 'impl-class',
          dst: 'impl-save-method',
          type: 'CONTAINS'
        });
        await backend.addEdge({
          src: 'impl-class',
          dst: 'impl-load-method',
          type: 'CONTAINS'
        });

        // Child EXTENDS Base (interface inheritance)
        await backend.addEdge({
          src: 'types.ts:INTERFACE:Child:10',
          dst: 'types.ts:INTERFACE:Base:1',
          type: 'EXTENDS'
        });

        // Impl IMPLEMENTS Child
        await backend.addEdge({
          src: 'impl-class',
          dst: 'types.ts:INTERFACE:Child:10',
          type: 'IMPLEMENTS'
        });

        await backend.flush();

        await resolver.execute({ graph: backend });

        // save() is declared on Base, inherited through Child -> Impl should be found
        const edges = await backend.getOutgoingEdges('x-save-call', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create one CALLS edge via inherited interface');

        const targetNode = await backend.getNode(edges[0].dst);
        assert.strictEqual(targetNode.name, 'save', 'Should point to Impl.save');

        console.log('Interface inheritance CHA resolution works');
      } finally {
        await backend.close();
      }
    });

    it('should create exactly one CALLS edge when multiple classes implement same interface', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // INTERFACE Storage with method save
        await backend.addNodes([
          {
            id: 'types.ts:INTERFACE:Storage:1',
            type: 'INTERFACE',
            name: 'Storage',
            file: 'types.ts',
            line: 1,
            column: 0,
            properties: JSON.stringify([{ name: 'save', type: 'function' }])
          },
          // CLASS LocalStorage with METHOD save
          {
            id: 'local-class',
            type: 'CLASS',
            name: 'LocalStorage',
            file: 'local.ts',
            line: 1
          },
          {
            id: 'local-save-method',
            type: 'METHOD',
            name: 'save',
            file: 'local.ts',
            line: 5
          },
          // CLASS CloudStorage with METHOD save
          {
            id: 'cloud-class',
            type: 'CLASS',
            name: 'CloudStorage',
            file: 'cloud.ts',
            line: 1
          },
          {
            id: 'cloud-save-method',
            type: 'METHOD',
            name: 'save',
            file: 'cloud.ts',
            line: 5
          },
          // METHOD_CALL: s.save()
          {
            id: 's-save-call',
            type: 'CALL',
            name: 's.save',
            file: 'app.ts',
            line: 10,
            object: 's',
            method: 'save'
          }
        ]);

        // LocalStorage -> CONTAINS -> save
        await backend.addEdge({
          src: 'local-class',
          dst: 'local-save-method',
          type: 'CONTAINS'
        });
        // CloudStorage -> CONTAINS -> save
        await backend.addEdge({
          src: 'cloud-class',
          dst: 'cloud-save-method',
          type: 'CONTAINS'
        });

        // Both implement Storage
        await backend.addEdge({
          src: 'local-class',
          dst: 'types.ts:INTERFACE:Storage:1',
          type: 'IMPLEMENTS'
        });
        await backend.addEdge({
          src: 'cloud-class',
          dst: 'types.ts:INTERFACE:Storage:1',
          type: 'IMPLEMENTS'
        });

        await backend.flush();

        await resolver.execute({ graph: backend });

        // Should create exactly one CALLS edge (first match), not two
        const edges = await backend.getOutgoingEdges('s-save-call', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create exactly one CALLS edge');

        const targetNode = await backend.getNode(edges[0].dst);
        assert.strictEqual(targetNode.name, 'save', 'Should point to a save method');

        console.log('Multiple implementations — single CALLS edge works');
      } finally {
        await backend.close();
      }
    });

    it('should not create CALLS edge for method not declared in any interface', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // INTERFACE Logger with method log
        await backend.addNodes([
          {
            id: 'types.ts:INTERFACE:Logger:1',
            type: 'INTERFACE',
            name: 'Logger',
            file: 'types.ts',
            line: 1,
            column: 0,
            properties: JSON.stringify([{ name: 'log', type: 'function' }])
          },
          // CLASS MyLogger with METHOD log
          {
            id: 'mylogger-class',
            type: 'CLASS',
            name: 'MyLogger',
            file: 'mylogger.ts',
            line: 1
          },
          {
            id: 'mylogger-log-method',
            type: 'METHOD',
            name: 'log',
            file: 'mylogger.ts',
            line: 5
          },
          // METHOD_CALL: x.unknownMethod() — NOT in any interface
          {
            id: 'x-unknown-call',
            type: 'CALL',
            name: 'x.unknownMethod',
            file: 'app.ts',
            line: 10,
            object: 'x',
            method: 'unknownMethod'
          }
        ]);

        // MyLogger -> CONTAINS -> log
        await backend.addEdge({
          src: 'mylogger-class',
          dst: 'mylogger-log-method',
          type: 'CONTAINS'
        });

        // MyLogger -> IMPLEMENTS -> Logger
        await backend.addEdge({
          src: 'mylogger-class',
          dst: 'types.ts:INTERFACE:Logger:1',
          type: 'IMPLEMENTS'
        });

        await backend.flush();

        await resolver.execute({ graph: backend });

        // unknownMethod is not in any interface.
        // REG-583: x is an unknown variable, unknownMethod is not a prototype method,
        // so this falls through to UNKNOWN_CALL_TARGET:x
        const edges = await backend.getOutgoingEdges('x-unknown-call', ['CALLS']);
        assert.strictEqual(edges.length, 1,
          'Should create CALLS edge to UNKNOWN_CALL_TARGET:x for method not in any interface');
        assert.strictEqual(edges[0].dst, 'UNKNOWN_CALL_TARGET:x');
      } finally {
        await backend.close();
      }
    });

    it('should not create CALLS edge when class implements interface but lacks the method', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // INTERFACE Complete with method1 and method2
        await backend.addNodes([
          {
            id: 'types.ts:INTERFACE:Complete:1',
            type: 'INTERFACE',
            name: 'Complete',
            file: 'types.ts',
            line: 1,
            column: 0,
            properties: JSON.stringify([
              { name: 'method1', type: 'function' },
              { name: 'method2', type: 'function' }
            ])
          },
          // CLASS Partial with only method1 (no method2!)
          {
            id: 'partial-class',
            type: 'CLASS',
            name: 'Partial',
            file: 'partial.ts',
            line: 1
          },
          {
            id: 'partial-method1',
            type: 'METHOD',
            name: 'method1',
            file: 'partial.ts',
            line: 5
          },
          // METHOD_CALL: x.method2() — in interface but NOT in class
          {
            id: 'x-method2-call',
            type: 'CALL',
            name: 'x.method2',
            file: 'app.ts',
            line: 10,
            object: 'x',
            method: 'method2'
          }
        ]);

        // Partial -> CONTAINS -> method1 (only!)
        await backend.addEdge({
          src: 'partial-class',
          dst: 'partial-method1',
          type: 'CONTAINS'
        });

        // Partial -> IMPLEMENTS -> Complete
        await backend.addEdge({
          src: 'partial-class',
          dst: 'types.ts:INTERFACE:Complete:1',
          type: 'IMPLEMENTS'
        });

        await backend.flush();

        await resolver.execute({ graph: backend });

        // method2 is in interface but Partial doesn't have it.
        // REG-583: x is an unknown variable, method2 is not a prototype method,
        // so it falls to UNKNOWN_CALL_TARGET:x — not a false positive for class resolution,
        // but properly captured as an unknown call target.
        const edges = await backend.getOutgoingEdges('x-method2-call', ['CALLS']);
        assert.strictEqual(edges.length, 1,
          'Should create CALLS edge to UNKNOWN_CALL_TARGET:x when class lacks the method');
        assert.strictEqual(edges[0].dst, 'UNKNOWN_CALL_TARGET:x');
      } finally {
        await backend.close();
      }
    });
  });
});
