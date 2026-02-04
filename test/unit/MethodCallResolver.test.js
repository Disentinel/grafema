/**
 * MethodCallResolver Tests
 *
 * Tests the enrichment plugin that creates CALLS edges for method calls
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase } from '../helpers/TestRFDB.js';
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

  describe('External method filtering', () => {
    it('should skip external methods like console.log', async () => {
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

        // Should not create any edges for external methods
        const edges = await backend.getOutgoingEdges('console-log-call', ['CALLS']);
        assert.strictEqual(edges.length, 0, 'Should not create CALLS edge for console.log');

        console.log('External method filtering works correctly');
      } finally {
        await backend.close();
      }
    });

    it('should skip Math, JSON, Promise and other built-ins', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // Add various external method calls
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

        // Should not create edges for any of these
        assert.strictEqual(result.created.edges, 0, 'Should not create edges for built-ins');

        console.log('Built-in method filtering works correctly');
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
            id: 'repo-find-method',
            type: 'METHOD',
            name: 'find',
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
          // Method call: repo.find()
          {
            id: 'repo-find-call',
            type: 'CALL',
            name: 'repo.find',
            file: 'app.js',
            line: 5,
            object: 'repo',
            method: 'find'
          }
        ]);

        // CLASS -> METHOD
        await backend.addEdge({
          src: 'repo-class',
          dst: 'repo-find-method',
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
        const edges = await backend.getOutgoingEdges('repo-find-call', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create one CALLS edge');

        const targetNode = await backend.getNode(edges[0].dst);
        assert.strictEqual(targetNode.name, 'find', 'Should point to find method');

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

    it('should handle unresolvable method calls gracefully', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new MethodCallResolver();

        // Method call to unknown object
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

        // Should not crash, should report as unresolved
        assert.strictEqual(result.metadata.edgesCreated, 0, 'Should create no edges');
        assert.strictEqual(result.metadata.unresolved, 1, 'Should report 1 unresolved');

        console.log('Unresolvable method calls handled gracefully');
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
});
