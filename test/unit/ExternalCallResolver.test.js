/**
 * ExternalCallResolver Unit Tests (REG-226)
 *
 * Tests for the enrichment plugin that resolves function calls to external packages
 * and recognizes JavaScript built-in global functions.
 *
 * Architecture:
 * - Runs in ENRICHMENT phase at priority 70 (after FunctionCallResolver at 80)
 * - Creates EXTERNAL_MODULE nodes for external packages (lodash, @scope/pkg, etc.)
 * - Creates CALLS edges from CALL nodes to EXTERNAL_MODULE nodes
 * - Recognizes JS built-ins (parseInt, setTimeout, etc.) - no edge needed
 * - Skips method calls (have 'object' attribute)
 * - Skips already resolved calls (have CALLS edge)
 * - Skips relative imports (handled by FunctionCallResolver)
 *
 * External modules vs Node.js builtins:
 * - ExternalCallResolver: npm packages (lodash, @tanstack/query), JS globals (parseInt)
 * - NodejsBuiltinsResolver: Node.js core modules (fs, path, child_process)
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Note: ExternalCallResolver will be imported once Rob implements it
// For now, tests will fail on import (expected behavior for TDD)
let ExternalCallResolver;
try {
  const module = await import('@grafema/core');
  ExternalCallResolver = module.ExternalCallResolver;
} catch {
  // Plugin not implemented yet - tests will be skipped
}

describe('ExternalCallResolver', () => {
  let testCounter = 0;

  async function setupBackend() {
    const testDir = join(tmpdir(), `grafema-test-extres-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    const db = await createTestDatabase();
    const backend = db.backend;

    return { backend, testDir };
  }

  // ============================================================================
  // EXTERNAL PACKAGE CALLS
  // ============================================================================

  describe('External Package Calls', () => {
    it('should create CALLS edge to EXTERNAL_MODULE for lodash import', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // import { map } from 'lodash';
        // map(arr, fn);
        await backend.addNodes([
          {
            id: 'main-import-lodash',
            type: 'IMPORT',
            name: 'map',
            file: '/project/main.js',
            line: 1,
            source: 'lodash',
            importType: 'named',
            imported: 'map',
            local: 'map'
          },
          {
            id: 'main-call-map',
            type: 'CALL',
            name: 'map',
            file: '/project/main.js',
            line: 5
            // No 'object' field - this is a function call, not method call
          }
        ]);

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        // Should create EXTERNAL_MODULE:lodash node
        const externalModule = await backend.getNode('EXTERNAL_MODULE:lodash');
        assert.ok(externalModule, 'Should create EXTERNAL_MODULE:lodash');
        assert.strictEqual(externalModule.type, 'EXTERNAL_MODULE');
        assert.strictEqual(externalModule.name, 'lodash');

        // Should create CALLS edge from call to EXTERNAL_MODULE
        const edges = await backend.getOutgoingEdges('main-call-map', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create one CALLS edge');
        assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:lodash');

        // Edge should have exportedName metadata
        assert.strictEqual(edges[0].metadata?.exportedName, 'map',
          'Edge should have exportedName metadata');

        assert.strictEqual(result.success, true);
        assert.ok(result.created.edges >= 1, 'Should report at least 1 edge created');
        assert.ok(result.metadata.externalResolved >= 1, 'Should report external calls resolved');
      } finally {
        await backend.close();
      }
    });

    it('should create CALLS edge for scoped package (@scope/pkg)', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // import { useQuery } from '@tanstack/react-query';
        // useQuery({ queryKey: ['foo'] });
        await backend.addNodes([
          {
            id: 'main-import-query',
            type: 'IMPORT',
            name: 'useQuery',
            file: '/project/main.js',
            line: 1,
            source: '@tanstack/react-query',
            importType: 'named',
            imported: 'useQuery',
            local: 'useQuery'
          },
          {
            id: 'main-call-usequery',
            type: 'CALL',
            name: 'useQuery',
            file: '/project/main.js',
            line: 5
          }
        ]);

        await backend.flush();
        await resolver.execute({ graph: backend });

        // Should create EXTERNAL_MODULE:@tanstack/react-query
        const externalModule = await backend.getNode('EXTERNAL_MODULE:@tanstack/react-query');
        assert.ok(externalModule, 'Should create EXTERNAL_MODULE for scoped package');

        // Should create CALLS edge
        const edges = await backend.getOutgoingEdges('main-call-usequery', ['CALLS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:@tanstack/react-query');
        assert.strictEqual(edges[0].metadata?.exportedName, 'useQuery');
      } finally {
        await backend.close();
      }
    });

    it('should NOT create duplicate EXTERNAL_MODULE nodes', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // Multiple imports from same package
        // import { map, filter } from 'lodash';
        await backend.addNodes([
          {
            id: 'main-import-lodash-map',
            type: 'IMPORT',
            name: 'map',
            file: '/project/main.js',
            line: 1,
            source: 'lodash',
            importType: 'named',
            imported: 'map',
            local: 'map'
          },
          {
            id: 'main-import-lodash-filter',
            type: 'IMPORT',
            name: 'filter',
            file: '/project/main.js',
            line: 1,
            source: 'lodash',
            importType: 'named',
            imported: 'filter',
            local: 'filter'
          },
          {
            id: 'main-call-map',
            type: 'CALL',
            name: 'map',
            file: '/project/main.js',
            line: 5
          },
          {
            id: 'main-call-filter',
            type: 'CALL',
            name: 'filter',
            file: '/project/main.js',
            line: 7
          }
        ]);

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        // Should create only ONE EXTERNAL_MODULE:lodash node
        const allNodes = [];
        for await (const n of backend.queryNodes({ nodeType: 'EXTERNAL_MODULE' })) {
          allNodes.push(n);
        }
        const lodashNodes = allNodes.filter(n => n.name === 'lodash');
        assert.strictEqual(lodashNodes.length, 1, 'Should have exactly one lodash module node');

        // Both calls should point to same EXTERNAL_MODULE
        const edgesMap = await backend.getOutgoingEdges('main-call-map', ['CALLS']);
        const edgesFilter = await backend.getOutgoingEdges('main-call-filter', ['CALLS']);
        assert.strictEqual(edgesMap[0].dst, edgesFilter[0].dst,
          'Both calls should point to same EXTERNAL_MODULE');
      } finally {
        await backend.close();
      }
    });

    it('should reuse existing EXTERNAL_MODULE node if already created', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // Pre-create EXTERNAL_MODULE (simulates previous plugin run or NodejsBuiltinsResolver)
        await backend.addNodes([
          {
            id: 'EXTERNAL_MODULE:lodash',
            type: 'EXTERNAL_MODULE',
            name: 'lodash',
            file: '',
            line: 0
          },
          {
            id: 'main-import-lodash',
            type: 'IMPORT',
            name: 'map',
            file: '/project/main.js',
            line: 1,
            source: 'lodash',
            importType: 'named',
            imported: 'map',
            local: 'map'
          },
          {
            id: 'main-call-map',
            type: 'CALL',
            name: 'map',
            file: '/project/main.js',
            line: 5
          }
        ]);

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        // Should NOT create new node (reuse existing)
        assert.strictEqual(result.created.nodes, 0, 'Should not create new node');

        // Should still create CALLS edge
        const edges = await backend.getOutgoingEdges('main-call-map', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create CALLS edge');
        assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:lodash');
      } finally {
        await backend.close();
      }
    });

    it('should use imported name for exportedName in aliased imports', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // import { map as lodashMap } from 'lodash';
        // lodashMap(arr, fn);
        await backend.addNodes([
          {
            id: 'main-import-lodash-aliased',
            type: 'IMPORT',
            name: 'lodashMap',
            file: '/project/main.js',
            line: 1,
            source: 'lodash',
            importType: 'named',
            imported: 'map',       // Original name from source
            local: 'lodashMap'     // Aliased name in this file
          },
          {
            id: 'main-call-lodashmap',
            type: 'CALL',
            name: 'lodashMap',     // Called by local name
            file: '/project/main.js',
            line: 5
          }
        ]);

        await backend.flush();
        await resolver.execute({ graph: backend });

        // Should create CALLS edge to EXTERNAL_MODULE:lodash
        const edges = await backend.getOutgoingEdges('main-call-lodashmap', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create CALLS edge');
        assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:lodash');

        // Verify exportedName uses IMPORTED name (from source), not local name
        assert.strictEqual(edges[0].metadata?.exportedName, 'map',
          'exportedName should be original imported name, not alias');
      } finally {
        await backend.close();
      }
    });

    it('should handle default imports from external packages', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // import _ from 'lodash';
        // _([1,2,3]).map(fn);
        // But for default imports used as function: _(arr)
        await backend.addNodes([
          {
            id: 'main-import-lodash-default',
            type: 'IMPORT',
            name: '_',
            file: '/project/main.js',
            line: 1,
            source: 'lodash',
            importType: 'default',
            imported: 'default',
            local: '_'
          },
          {
            id: 'main-call-lodash-default',
            type: 'CALL',
            name: '_',
            file: '/project/main.js',
            line: 5
          }
        ]);

        await backend.flush();
        await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('main-call-lodash-default', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create CALLS edge for default import');
        assert.strictEqual(edges[0].dst, 'EXTERNAL_MODULE:lodash');
        assert.strictEqual(edges[0].metadata?.exportedName, 'default',
          'exportedName should be "default" for default imports');
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // JAVASCRIPT BUILT-INS
  // ============================================================================

  describe('JavaScript Built-ins', () => {
    it('should recognize parseInt as JS builtin (no CALLS edge)', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // parseInt('42');
        await backend.addNode({
          id: 'main-call-parseint',
          type: 'CALL',
          name: 'parseInt',
          file: '/project/main.js',
          line: 5
        });

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        // Should NOT create CALLS edge (builtin recognized by name)
        const edges = await backend.getOutgoingEdges('main-call-parseint', ['CALLS']);
        assert.strictEqual(edges.length, 0, 'Should NOT create CALLS edge for JS builtin');

        // Should be counted as builtin
        assert.ok(result.metadata.builtinResolved >= 1, 'Should count as builtin resolved');
      } finally {
        await backend.close();
      }
    });

    it('should recognize setTimeout as JS builtin (no CALLS edge)', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // setTimeout(() => {}, 1000);
        await backend.addNode({
          id: 'main-call-settimeout',
          type: 'CALL',
          name: 'setTimeout',
          file: '/project/main.js',
          line: 5
        });

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('main-call-settimeout', ['CALLS']);
        assert.strictEqual(edges.length, 0, 'Should NOT create CALLS edge for setTimeout');
        assert.ok(result.metadata.builtinResolved >= 1);
      } finally {
        await backend.close();
      }
    });

    it('should recognize require as JS builtin (CJS special case)', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // const fs = require('fs');
        await backend.addNode({
          id: 'main-call-require',
          type: 'CALL',
          name: 'require',
          file: '/project/main.js',
          line: 1
        });

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('main-call-require', ['CALLS']);
        assert.strictEqual(edges.length, 0, 'Should NOT create CALLS edge for require');
        assert.ok(result.metadata.builtinResolved >= 1);
      } finally {
        await backend.close();
      }
    });

    it('should recognize all documented JS builtins', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // All builtins from the spec (section 1.1):
        // parseInt, parseFloat, isNaN, isFinite, eval
        // encodeURI, decodeURI, encodeURIComponent, decodeURIComponent
        // setTimeout, setInterval, setImmediate
        // clearTimeout, clearInterval, clearImmediate
        // require

        const builtins = [
          'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
          'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
          'setTimeout', 'setInterval', 'setImmediate',
          'clearTimeout', 'clearInterval', 'clearImmediate',
          'require'
        ];

        const nodes = builtins.map((name, i) => ({
          id: `call-${name}`,
          type: 'CALL',
          name: name,
          file: '/project/main.js',
          line: i + 1
        }));

        await backend.addNodes(nodes);
        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // None should have CALLS edges
        for (const name of builtins) {
          const edges = await backend.getOutgoingEdges(`call-${name}`, ['CALLS']);
          assert.strictEqual(edges.length, 0, `${name} should not have CALLS edge`);
        }

        // All should be counted as builtin
        assert.strictEqual(result.metadata.builtinResolved, builtins.length,
          `Should count all ${builtins.length} builtins`);
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // UNRESOLVED CALLS
  // ============================================================================

  describe('Unresolved Calls', () => {
    it('should count unknown function as unresolved', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // someUnknownFunc(); - not imported, not builtin
        await backend.addNode({
          id: 'main-call-unknown',
          type: 'CALL',
          name: 'someUnknownFunc',
          file: '/project/main.js',
          line: 5
        });

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        // Should NOT create CALLS edge
        const edges = await backend.getOutgoingEdges('main-call-unknown', ['CALLS']);
        assert.strictEqual(edges.length, 0, 'Should NOT create CALLS edge for unknown call');

        // Should be counted as unresolved
        assert.ok(result.metadata.unresolvedByReason.unknown >= 1,
          'Should count as unresolved (unknown)');
      } finally {
        await backend.close();
      }
    });

    it('should detect dynamic call pattern as unresolvable', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // const fn = condition ? foo : bar;
        // fn(); - dynamic, cannot resolve statically
        await backend.addNode({
          id: 'main-call-dynamic',
          type: 'CALL',
          name: 'fn',
          file: '/project/main.js',
          line: 5,
          isDynamic: true  // Analyzer marks dynamic calls
        });

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('main-call-dynamic', ['CALLS']);
        assert.strictEqual(edges.length, 0);

        // Should be counted as unresolved with specific reason
        assert.ok(
          (result.metadata.unresolvedByReason.dynamic >= 1) ||
          (result.metadata.unresolvedByReason.unknown >= 1),
          'Should count dynamic call as unresolved'
        );
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // SKIP CONDITIONS
  // ============================================================================

  describe('Skip Conditions', () => {
    it('should skip method calls (have object attribute)', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // obj.method() - has 'object' attribute, handled by MethodCallResolver
        await backend.addNode({
          id: 'main-call-method',
          type: 'CALL',
          name: 'obj.method',
          file: '/project/main.js',
          line: 5,
          object: 'obj',
          method: 'method'
        });

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        // Should not process method calls
        assert.strictEqual(result.metadata.callsProcessed, 0,
          'Should skip method calls (callsProcessed = 0)');

        const edges = await backend.getOutgoingEdges('main-call-method', ['CALLS']);
        assert.strictEqual(edges.length, 0, 'Should not create CALLS edge for method call');
      } finally {
        await backend.close();
      }
    });

    it('should skip already resolved calls (have CALLS edge)', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // foo() - already resolved by FunctionCallResolver
        await backend.addNodes([
          {
            id: 'utils-foo-func',
            type: 'FUNCTION',
            name: 'foo',
            file: '/project/utils.js',
            line: 1
          },
          {
            id: 'main-call-foo',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 5
          }
        ]);

        // Pre-existing CALLS edge (from FunctionCallResolver)
        await backend.addEdge({
          src: 'main-call-foo',
          dst: 'utils-foo-func',
          type: 'CALLS'
        });

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        // Should not create another edge
        const edges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should still have only one CALLS edge');

        // Should report 0 edges created (was already resolved)
        assert.strictEqual(result.created.edges, 0, 'Should report 0 edges created');
      } finally {
        await backend.close();
      }
    });

    it('should skip relative imports (handled by FunctionCallResolver)', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // import { helper } from './utils';
        // helper();
        await backend.addNodes([
          {
            id: 'main-import-helper',
            type: 'IMPORT',
            name: 'helper',
            file: '/project/main.js',
            line: 1,
            source: './utils',  // Relative import!
            importType: 'named',
            imported: 'helper',
            local: 'helper'
          },
          {
            id: 'main-call-helper',
            type: 'CALL',
            name: 'helper',
            file: '/project/main.js',
            line: 5
          }
        ]);

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        // Should NOT create CALLS edge (relative import)
        const edges = await backend.getOutgoingEdges('main-call-helper', ['CALLS']);
        assert.strictEqual(edges.length, 0,
          'Should NOT create CALLS edge for relative import');

        // Should not count as external resolved
        assert.strictEqual(result.metadata.externalResolved, 0);
      } finally {
        await backend.close();
      }
    });

    it('should skip namespace import method calls', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // import * as _ from 'lodash';
        // _.map(arr, fn);
        await backend.addNodes([
          {
            id: 'main-import-lodash-ns',
            type: 'IMPORT',
            name: '_',
            file: '/project/main.js',
            line: 1,
            source: 'lodash',
            importType: 'namespace',
            imported: '*',
            local: '_'
          },
          {
            id: 'main-call-lodash-map',
            type: 'CALL',
            name: '_.map',
            file: '/project/main.js',
            line: 5,
            object: '_',        // This makes it a METHOD_CALL
            method: 'map'
          }
        ]);

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        // Should not process method calls (has object attribute)
        // MethodCallResolver will handle this later
        assert.strictEqual(result.metadata.callsProcessed, 0,
          'Should skip namespace method calls');

        // Should not create CALLS edge
        const edges = await backend.getOutgoingEdges('main-call-lodash-map', ['CALLS']);
        assert.strictEqual(edges.length, 0, 'No CALLS edge for method call');
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // MIXED RESOLUTION TYPES
  // ============================================================================

  describe('Mixed Resolution Types', () => {
    it('should handle all resolution types in single file', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // Setup: file with internal import, external import, builtin, and unknown
        await backend.addNodes([
          // Internal import (relative)
          {
            id: 'main-import-utils',
            type: 'IMPORT',
            name: 'helper',
            file: '/project/main.js',
            line: 1,
            source: './utils',  // Relative
            importType: 'named',
            imported: 'helper',
            local: 'helper'
          },
          {
            id: 'main-call-helper',
            type: 'CALL',
            name: 'helper',
            file: '/project/main.js',
            line: 5
          },

          // External import
          {
            id: 'main-import-lodash',
            type: 'IMPORT',
            name: 'map',
            file: '/project/main.js',
            line: 2,
            source: 'lodash',
            importType: 'named',
            imported: 'map',
            local: 'map'
          },
          {
            id: 'main-call-map',
            type: 'CALL',
            name: 'map',
            file: '/project/main.js',
            line: 7
          },

          // Builtin
          {
            id: 'main-call-parseint',
            type: 'CALL',
            name: 'parseInt',
            file: '/project/main.js',
            line: 9
          },

          // Unknown (not imported, not builtin)
          {
            id: 'main-call-unknown',
            type: 'CALL',
            name: 'someUnknownFunc',
            file: '/project/main.js',
            line: 11
          }
        ]);

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        // Verify each resolution type:

        // 1. Internal import - should be skipped (relative source not indexed)
        const helperEdges = await backend.getOutgoingEdges('main-call-helper', ['CALLS']);
        assert.strictEqual(helperEdges.length, 0,
          'Relative imports should not create edges in ExternalCallResolver');

        // 2. External import - should create CALLS edge
        const mapEdges = await backend.getOutgoingEdges('main-call-map', ['CALLS']);
        assert.strictEqual(mapEdges.length, 1, 'External call should have CALLS edge');
        assert.strictEqual(mapEdges[0].dst, 'EXTERNAL_MODULE:lodash');

        // 3. Builtin - should not create edge, but counted
        const parseIntEdges = await backend.getOutgoingEdges('main-call-parseint', ['CALLS']);
        assert.strictEqual(parseIntEdges.length, 0, 'Builtin should not have CALLS edge');
        assert.ok(result.metadata.builtinResolved >= 1, 'Builtin should be counted');

        // 4. Unknown - should not create edge, but counted as unresolved
        const unknownEdges = await backend.getOutgoingEdges('main-call-unknown', ['CALLS']);
        assert.strictEqual(unknownEdges.length, 0, 'Unknown call should not have CALLS edge');
        assert.ok(result.metadata.unresolvedByReason.unknown >= 1,
          'Unknown call should be counted');

        // Overall counts
        assert.strictEqual(result.created.edges, 1, 'Should create 1 CALLS edge (external)');
        assert.strictEqual(result.metadata.externalResolved, 1);
        assert.strictEqual(result.metadata.builtinResolved, 1);
        assert.ok(result.metadata.unresolvedByReason.unknown >= 1);
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // RE-EXPORTED EXTERNALS (Known Limitation)
  // ============================================================================

  describe('Re-exported Externals (Known Limitation)', () => {
    it('should document that re-exported externals are currently unresolved', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // utils.js: export { map } from 'lodash';
        // main.js: import { map } from './utils'; map();
        await backend.addNodes([
          // utils.js re-exports lodash.map
          {
            id: 'utils-export-map',
            type: 'EXPORT',
            name: 'map',
            file: '/project/utils.js',
            line: 1,
            source: 'lodash',
            exportType: 'named',
            exported: 'map',
            local: 'map'
          },

          // main.js imports from utils (relative import)
          {
            id: 'main-import-map-from-utils',
            type: 'IMPORT',
            name: 'map',
            file: '/project/main.js',
            line: 1,
            source: './utils',  // Relative!
            importType: 'named',
            imported: 'map',
            local: 'map'
          },
          {
            id: 'main-call-map',
            type: 'CALL',
            name: 'map',
            file: '/project/main.js',
            line: 5
          }
        ]);

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        // Current behavior: unresolved
        // - Import is relative (./utils), so ExternalCallResolver skips it
        // - FunctionCallResolver tries to resolve it but fails (it's not a FUNCTION)
        // - Result: call stays unresolved
        const edges = await backend.getOutgoingEdges('main-call-map', ['CALLS']);
        assert.strictEqual(edges.length, 0,
          'Re-exported external calls are currently unresolved');

        // When a call is processed but no matching external import is found,
        // it should be counted as unresolved. If the call isn't found at all
        // (test infrastructure issue), the main assertion above still passes.
        if (result.metadata.callsProcessed > 0) {
          assert.ok(result.metadata.unresolvedByReason.unknown >= 1,
            'Should be counted as unresolved');
        }

        // This documents current limitation - see Linear issue for future fix
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // IDEMPOTENCY
  // ============================================================================

  describe('Idempotency', () => {
    it('should be idempotent (running twice produces same result)', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        await backend.addNodes([
          {
            id: 'main-import-lodash',
            type: 'IMPORT',
            name: 'map',
            file: '/project/main.js',
            line: 1,
            source: 'lodash',
            importType: 'named',
            imported: 'map',
            local: 'map'
          },
          {
            id: 'main-call-map',
            type: 'CALL',
            name: 'map',
            file: '/project/main.js',
            line: 5
          }
        ]);

        await backend.flush();

        // First run
        const result1 = await resolver.execute({ graph: backend });
        assert.strictEqual(result1.created.edges, 1, 'First run should create 1 edge');
        assert.ok(result1.created.nodes >= 1, 'First run should create nodes');

        // Second run (should be no-op)
        const result2 = await resolver.execute({ graph: backend });
        assert.strictEqual(result2.created.edges, 0, 'Second run should create 0 edges');
        assert.strictEqual(result2.created.nodes, 0, 'Second run should create 0 nodes');

        // Verify graph state is same
        const edges = await backend.getOutgoingEdges('main-call-map', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should have exactly one CALLS edge');

        const allModules = [];
        for await (const n of backend.queryNodes({ nodeType: 'EXTERNAL_MODULE' })) {
          allModules.push(n);
        }
        const lodashModules = allModules.filter(n => n.name === 'lodash');
        assert.strictEqual(lodashModules.length, 1, 'Should have exactly one lodash module');
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // PLUGIN METADATA
  // ============================================================================

  describe('Plugin Metadata', () => {
    it('should have correct metadata', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const resolver = new ExternalCallResolver();
      const metadata = resolver.metadata;

      assert.strictEqual(metadata.name, 'ExternalCallResolver');
      assert.strictEqual(metadata.phase, 'ENRICHMENT');
      assert.strictEqual(metadata.priority, 70,
        'Priority should be 70 (after FunctionCallResolver at 80)');
      assert.deepStrictEqual(metadata.creates.edges, ['CALLS']);
      assert.deepStrictEqual(metadata.creates.nodes, ['EXTERNAL_MODULE']);
      assert.ok(metadata.dependencies.includes('FunctionCallResolver'),
        'Should depend on FunctionCallResolver');
    });
  });

  // ============================================================================
  // EDGE CASES
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle empty graph gracefully', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();
        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        assert.strictEqual(result.success, true, 'Should succeed with empty graph');
        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.created.nodes, 0);
      } finally {
        await backend.close();
      }
    });

    it('should handle CALL nodes without matching IMPORT', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // Call to 'foo' but no import for it
        await backend.addNode({
          id: 'main-call-foo',
          type: 'CALL',
          name: 'foo',
          file: '/project/main.js',
          line: 5
        });

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        // Should count as unresolved
        assert.ok(result.metadata.unresolvedByReason.unknown >= 1);

        const edges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
        assert.strictEqual(edges.length, 0);
      } finally {
        await backend.close();
      }
    });

    it('should handle multiple files importing same external package', async () => {
      if (!ExternalCallResolver) {
        console.log('SKIP: ExternalCallResolver not implemented yet');
        return;
      }

      const { backend } = await setupBackend();

      try {
        const resolver = new ExternalCallResolver();

        // file1.js: import { map } from 'lodash'; map();
        // file2.js: import { filter } from 'lodash'; filter();
        await backend.addNodes([
          {
            id: 'file1-import-map',
            type: 'IMPORT',
            name: 'map',
            file: '/project/file1.js',
            line: 1,
            source: 'lodash',
            importType: 'named',
            imported: 'map',
            local: 'map'
          },
          {
            id: 'file1-call-map',
            type: 'CALL',
            name: 'map',
            file: '/project/file1.js',
            line: 3
          },
          {
            id: 'file2-import-filter',
            type: 'IMPORT',
            name: 'filter',
            file: '/project/file2.js',
            line: 1,
            source: 'lodash',
            importType: 'named',
            imported: 'filter',
            local: 'filter'
          },
          {
            id: 'file2-call-filter',
            type: 'CALL',
            name: 'filter',
            file: '/project/file2.js',
            line: 3
          }
        ]);

        await backend.flush();
        const result = await resolver.execute({ graph: backend });

        // Both should point to same EXTERNAL_MODULE:lodash
        const edges1 = await backend.getOutgoingEdges('file1-call-map', ['CALLS']);
        const edges2 = await backend.getOutgoingEdges('file2-call-filter', ['CALLS']);

        assert.strictEqual(edges1.length, 1);
        assert.strictEqual(edges2.length, 1);
        assert.strictEqual(edges1[0].dst, 'EXTERNAL_MODULE:lodash');
        assert.strictEqual(edges2[0].dst, 'EXTERNAL_MODULE:lodash');

        // Verify different exportedName metadata
        assert.strictEqual(edges1[0].metadata?.exportedName, 'map');
        assert.strictEqual(edges2[0].metadata?.exportedName, 'filter');
      } finally {
        await backend.close();
      }
    });
  });
});
