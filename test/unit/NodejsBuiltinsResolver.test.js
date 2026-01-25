/**
 * NodejsBuiltinsResolver Unit Tests (REG-218)
 *
 * Tests for the enrichment plugin that creates EXTERNAL_FUNCTION nodes
 * and CALLS edges for Node.js builtin function calls.
 *
 * Architecture:
 * - Runs in ENRICHMENT phase (after analysis)
 * - Creates EXTERNAL_FUNCTION nodes lazily (only for used functions)
 * - Creates CALLS edges from CALL nodes to EXTERNAL_FUNCTION nodes
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RFDBServerBackend, NodejsBuiltinsResolver } from '@grafema/core';
import { join } from 'path';
import { tmpdir } from 'os';

describe('NodejsBuiltinsResolver', () => {
  let testCounter = 0;

  async function setupBackend() {
    const testDir = join(tmpdir(), `navi-test-builtins-${Date.now()}-${testCounter++}`);

    const backend = new RFDBServerBackend({ dbPath: join(testDir, 'test.db') });
    await backend.connect();

    return { backend, testDir };
  }

  describe('EXTERNAL_FUNCTION Node Creation', () => {
    it('should create EXTERNAL_FUNCTION node for fs.readFile call', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new NodejsBuiltinsResolver();

        // Simulate IMPORT node for fs
        await backend.addNode({
          id: 'import-fs',
          type: 'IMPORT',
          name: 'readFile',
          file: 'test.js',
          line: 1,
          source: 'fs'
        });

        // Simulate CALL node for readFile
        await backend.addNode({
          id: 'call-readfile',
          type: 'CALL',
          name: 'readFile',
          file: 'test.js',
          line: 5,
          callee: 'readFile'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // Should create EXTERNAL_FUNCTION:fs.readFile
        const externalFunc = await backend.getNode('EXTERNAL_FUNCTION:fs.readFile');
        assert.ok(externalFunc, 'Should create EXTERNAL_FUNCTION:fs.readFile');
        assert.strictEqual(externalFunc.type, 'EXTERNAL_FUNCTION');
        assert.strictEqual(externalFunc.name, 'fs.readFile');
        assert.strictEqual(externalFunc.isBuiltin, true);

        assert.ok(result.created.nodes >= 1, 'Should have created at least 1 node');
      } finally {
        await backend.close();
      }
    });

    it('should create EXTERNAL_FUNCTION node with correct metadata', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new NodejsBuiltinsResolver();

        // Setup: IMPORT + CALL for child_process.exec
        await backend.addNodes([
          {
            id: 'import-cp',
            type: 'IMPORT',
            name: 'exec',
            file: 'test.js',
            line: 1,
            source: 'child_process'
          },
          {
            id: 'call-exec',
            type: 'CALL',
            name: 'exec',
            file: 'test.js',
            line: 5,
            callee: 'exec'
          }
        ]);

        await backend.flush();

        await resolver.execute({ graph: backend });

        // Should have security:exec metadata
        const externalFunc = await backend.getNode('EXTERNAL_FUNCTION:child_process.exec');
        assert.ok(externalFunc);
        assert.strictEqual(externalFunc.security, 'exec');

      } finally {
        await backend.close();
      }
    });

    it('should NOT create duplicate EXTERNAL_FUNCTION nodes', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new NodejsBuiltinsResolver();

        // Two calls to the same builtin function
        await backend.addNodes([
          {
            id: 'import-fs',
            type: 'IMPORT',
            name: 'readFile',
            file: 'test.js',
            line: 1,
            source: 'fs'
          },
          {
            id: 'call-readfile-1',
            type: 'CALL',
            name: 'readFile',
            file: 'test.js',
            line: 5,
            callee: 'readFile'
          },
          {
            id: 'call-readfile-2',
            type: 'CALL',
            name: 'readFile',
            file: 'test.js',
            line: 10,
            callee: 'readFile'
          }
        ]);

        await backend.flush();

        await resolver.execute({ graph: backend });

        // Should create only ONE EXTERNAL_FUNCTION node
        const allNodes = [];
        for await (const n of backend.queryNodes({ nodeType: 'EXTERNAL_FUNCTION' })) {
          allNodes.push(n);
        }
        const fsReadFiles = allNodes.filter(n => n.name === 'fs.readFile');
        assert.strictEqual(fsReadFiles.length, 1, 'Should have exactly one fs.readFile node');
      } finally {
        await backend.close();
      }
    });

    it('should NOT create EXTERNAL_FUNCTION for non-builtin modules', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new NodejsBuiltinsResolver();

        // Import from lodash (not a builtin)
        await backend.addNodes([
          {
            id: 'import-lodash',
            type: 'IMPORT',
            name: 'map',
            file: 'test.js',
            line: 1,
            source: 'lodash'
          },
          {
            id: 'call-map',
            type: 'CALL',
            name: 'map',
            file: 'test.js',
            line: 5,
            callee: 'map'
          }
        ]);

        await backend.flush();

        await resolver.execute({ graph: backend });

        // Should NOT create EXTERNAL_FUNCTION for lodash
        const allNodes = [];
        for await (const n of backend.queryNodes({ nodeType: 'EXTERNAL_FUNCTION' })) {
          allNodes.push(n);
        }
        assert.strictEqual(allNodes.length, 0, 'Should not create EXTERNAL_FUNCTION for lodash');
      } finally {
        await backend.close();
      }
    });
  });

  describe('CALLS Edge Creation', () => {
    it('should create CALLS edge from call to EXTERNAL_FUNCTION', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new NodejsBuiltinsResolver();

        await backend.addNodes([
          {
            id: 'import-fs',
            type: 'IMPORT',
            name: 'readFile',
            file: 'test.js',
            line: 1,
            source: 'fs'
          },
          {
            id: 'call-readfile',
            type: 'CALL',
            name: 'readFile',
            file: 'test.js',
            line: 5,
            callee: 'readFile'
          }
        ]);

        await backend.flush();

        await resolver.execute({ graph: backend });

        // Should create CALLS edge
        const edges = await backend.getOutgoingEdges('call-readfile', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create one CALLS edge');
        assert.strictEqual(edges[0].dst, 'EXTERNAL_FUNCTION:fs.readFile');
      } finally {
        await backend.close();
      }
    });

    it('should create CALLS edges for multiple calls to same function', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new NodejsBuiltinsResolver();

        await backend.addNodes([
          {
            id: 'import-fs',
            type: 'IMPORT',
            name: 'readFile',
            file: 'test.js',
            line: 1,
            source: 'fs'
          },
          {
            id: 'call-1',
            type: 'CALL',
            name: 'readFile',
            file: 'test.js',
            line: 5,
            callee: 'readFile'
          },
          {
            id: 'call-2',
            type: 'CALL',
            name: 'readFile',
            file: 'test.js',
            line: 10,
            callee: 'readFile'
          }
        ]);

        await backend.flush();

        await resolver.execute({ graph: backend });

        // Both calls should have CALLS edges to same EXTERNAL_FUNCTION
        const edges1 = await backend.getOutgoingEdges('call-1', ['CALLS']);
        const edges2 = await backend.getOutgoingEdges('call-2', ['CALLS']);
        assert.strictEqual(edges1.length, 1);
        assert.strictEqual(edges2.length, 1);
        assert.strictEqual(edges1[0].dst, edges2[0].dst); // Same target
      } finally {
        await backend.close();
      }
    });

    it('should NOT create duplicate CALLS edges', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new NodejsBuiltinsResolver();

        // Pre-create EXTERNAL_FUNCTION and CALLS edge
        await backend.addNodes([
          {
            id: 'import-fs',
            type: 'IMPORT',
            name: 'readFile',
            file: 'test.js',
            line: 1,
            source: 'fs'
          },
          {
            id: 'EXTERNAL_FUNCTION:fs.readFile',
            type: 'EXTERNAL_FUNCTION',
            name: 'fs.readFile',
            file: '',
            line: 0,
            isBuiltin: true
          },
          {
            id: 'call-readfile',
            type: 'CALL',
            name: 'readFile',
            file: 'test.js',
            line: 5,
            callee: 'readFile'
          }
        ]);

        // Pre-existing edge
        await backend.addEdge({
          src: 'call-readfile',
          dst: 'EXTERNAL_FUNCTION:fs.readFile',
          type: 'CALLS'
        });

        await backend.flush();

        await resolver.execute({ graph: backend });

        // Should still have only one CALLS edge
        const edges = await backend.getOutgoingEdges('call-readfile', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should have exactly one CALLS edge');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Aliased Imports', () => {
    it('should resolve aliased import (import { readFile as rf })', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new NodejsBuiltinsResolver();

        // Aliased import
        await backend.addNodes([
          {
            id: 'import-fs',
            type: 'IMPORT',
            name: 'rf',  // Local alias
            file: 'test.js',
            line: 1,
            source: 'fs',
            imported: 'readFile'  // Original name
          },
          {
            id: 'call-rf',
            type: 'CALL',
            name: 'rf',  // Called by alias
            file: 'test.js',
            line: 5,
            callee: 'rf'
          }
        ]);

        await backend.flush();

        await resolver.execute({ graph: backend });

        // Should create EXTERNAL_FUNCTION:fs.readFile (original name, not alias)
        const externalFunc = await backend.getNode('EXTERNAL_FUNCTION:fs.readFile');
        assert.ok(externalFunc, 'Should create EXTERNAL_FUNCTION with original name');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Namespace Imports', () => {
    it('should resolve namespace import (import * as fs)', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new NodejsBuiltinsResolver();

        // Namespace import
        await backend.addNodes([
          {
            id: 'import-fs-ns',
            type: 'IMPORT',
            name: 'fs',  // Namespace name
            file: 'test.js',
            line: 1,
            source: 'fs',
            importType: 'namespace'
          },
          // Call fs.readFile()
          {
            id: 'call-fs-readfile',
            type: 'CALL',
            name: 'fs.readFile',
            file: 'test.js',
            line: 5,
            object: 'fs',
            method: 'readFile'
          }
        ]);

        await backend.flush();

        await resolver.execute({ graph: backend });

        // Should create EXTERNAL_FUNCTION:fs.readFile
        const externalFunc = await backend.getNode('EXTERNAL_FUNCTION:fs.readFile');
        assert.ok(externalFunc, 'Should create EXTERNAL_FUNCTION for namespace call');
      } finally {
        await backend.close();
      }
    });
  });

  describe('node: Prefix Handling', () => {
    it('should normalize node:fs to fs', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new NodejsBuiltinsResolver();

        await backend.addNodes([
          {
            id: 'import-node-fs',
            type: 'IMPORT',
            name: 'readFile',
            file: 'test.js',
            line: 1,
            source: 'node:fs'  // With node: prefix
          },
          {
            id: 'call-readfile',
            type: 'CALL',
            name: 'readFile',
            file: 'test.js',
            line: 5,
            callee: 'readFile'
          }
        ]);

        await backend.flush();

        await resolver.execute({ graph: backend });

        // Should create EXTERNAL_FUNCTION:fs.readFile (normalized)
        const externalFunc = await backend.getNode('EXTERNAL_FUNCTION:fs.readFile');
        assert.ok(externalFunc, 'Should normalize node: prefix');
      } finally {
        await backend.close();
      }
    });
  });

  describe('fs/promises Handling', () => {
    it('should handle fs/promises as separate module', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new NodejsBuiltinsResolver();

        await backend.addNodes([
          {
            id: 'import-fs-promises',
            type: 'IMPORT',
            name: 'readFile',
            file: 'test.js',
            line: 1,
            source: 'fs/promises'
          },
          {
            id: 'call-readfile',
            type: 'CALL',
            name: 'readFile',
            file: 'test.js',
            line: 5,
            callee: 'readFile'
          }
        ]);

        await backend.flush();

        await resolver.execute({ graph: backend });

        // Should create EXTERNAL_FUNCTION:fs/promises.readFile
        const externalFunc = await backend.getNode('EXTERNAL_FUNCTION:fs/promises.readFile');
        assert.ok(externalFunc, 'Should handle fs/promises');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Result Reporting', () => {
    it('should report created nodes and edges', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new NodejsBuiltinsResolver();

        await backend.addNodes([
          {
            id: 'import-fs',
            type: 'IMPORT',
            name: 'readFile',
            file: 'test.js',
            line: 1,
            source: 'fs'
          },
          {
            id: 'call-readfile',
            type: 'CALL',
            name: 'readFile',
            file: 'test.js',
            line: 5,
            callee: 'readFile'
          }
        ]);

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // Note: EXTERNAL_FUNCTION node + EXTERNAL_MODULE node
        assert.ok(result.created.nodes >= 1, 'Should have created nodes');
        // Note: CALLS edge + IMPORTS_FROM edge
        assert.ok(result.created.edges >= 1, 'Should have created edges');
      } finally {
        await backend.close();
      }
    });
  });
});
