/**
 * FunctionCallResolver Tests
 *
 * Tests the enrichment plugin that creates CALLS edges for imported function calls.
 *
 * Pattern: import { foo } from './utils'; foo();
 * Result: CALL_SITE -> CALLS -> FUNCTION
 *
 * This plugin runs AFTER ImportExportLinker (which creates IMPORTS_FROM edges)
 * and uses those edges to resolve function calls to their definitions.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// Cleanup all test databases after all tests complete
after(cleanupAllTestDatabases);
import { FunctionCallResolver } from '@grafema/core';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('FunctionCallResolver', () => {
  let testCounter = 0;

  async function setupBackend() {
    const testDir = join(tmpdir(), `grafema-test-funcresolver-${Date.now()}-${testCounter++}`);
    mkdirSync(testDir, { recursive: true });

    const db = await createTestDatabase();
    const backend = db.backend;

    return { backend, testDir };
  }

  // ============================================================================
  // NAMED IMPORTS
  // ============================================================================

  describe('Named imports', () => {
    it('should resolve named import function call', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // Setup: utils.js exports foo, main.js imports and calls it
        // import { foo } from './utils'; foo();

        await backend.addNodes([
          // FUNCTION in utils.js
          {
            id: 'utils-foo-func',
            type: 'FUNCTION',
            name: 'foo',
            file: '/project/utils.js',
            line: 1
          },
          // EXPORT in utils.js (named export)
          {
            id: 'utils-export-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/utils.js',
            line: 1,
            exportType: 'named',
            local: 'foo'
          },
          // IMPORT in main.js
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            line: 1,
            source: './utils',
            importType: 'named',
            imported: 'foo',
            local: 'foo'
          },
          // CALL in main.js (no object = function call, not method call)
          {
            id: 'main-call-foo',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 3
            // Note: no 'object' field - this is a CALL_SITE, not METHOD_CALL
          }
        ]);

        // Pre-existing edge (from ImportExportLinker):
        // IMPORT -> IMPORTS_FROM -> EXPORT
        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'utils-export-foo'
        });

        await backend.flush();

        // Run FunctionCallResolver
        const result = await resolver.execute({ graph: backend });

        // Assert: CALLS edge created from CALL to FUNCTION
        const edges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create one CALLS edge');
        assert.strictEqual(edges[0].dst, 'utils-foo-func', 'Should point to the function');

        assert.strictEqual(result.success, true, 'Plugin should succeed');
        assert.strictEqual(result.created.edges, 2, 'Should report 2 edges created (CALLS + HANDLED_BY)');

        console.log('Named import function call resolution works');
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // DEFAULT IMPORTS
  // ============================================================================

  describe('Default imports', () => {
    it('should resolve default import function call', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // Setup: utils.js has default export, main.js imports and calls it
        // export default function formatDate() {}
        // import fmt from './utils'; fmt();

        await backend.addNodes([
          // FUNCTION in utils.js (the actual function)
          {
            id: 'utils-formatDate-func',
            type: 'FUNCTION',
            name: 'formatDate',
            file: '/project/utils.js',
            line: 1
          },
          // EXPORT (default) in utils.js
          {
            id: 'utils-export-default',
            type: 'EXPORT',
            name: 'default',
            file: '/project/utils.js',
            line: 1,
            exportType: 'default',
            local: 'formatDate'  // The local name in the source file
          },
          // IMPORT (default) in main.js - imported as 'fmt'
          {
            id: 'main-import-fmt',
            type: 'IMPORT',
            name: 'fmt',
            file: '/project/main.js',
            line: 1,
            source: './utils',
            importType: 'default',
            imported: 'default',
            local: 'fmt'  // Local binding name
          },
          // CALL in main.js - calls 'fmt()'
          {
            id: 'main-call-fmt',
            type: 'CALL',
            name: 'fmt',
            file: '/project/main.js',
            line: 3
            // No 'object' field
          }
        ]);

        // Pre-existing edge from ImportExportLinker
        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-fmt',
          dst: 'utils-export-default'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('main-call-fmt', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create one CALLS edge');
        assert.strictEqual(edges[0].dst, 'utils-formatDate-func', 'Should point to formatDate function');

        console.log('Default import function call resolution works');
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // ALIASED IMPORTS
  // ============================================================================

  describe('Aliased named imports', () => {
    it('should resolve aliased named import function call', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // Setup: import { foo as bar } from './utils'; bar();

        await backend.addNodes([
          // FUNCTION in utils.js
          {
            id: 'utils-foo-func',
            type: 'FUNCTION',
            name: 'foo',
            file: '/project/utils.js',
            line: 1
          },
          // EXPORT in utils.js
          {
            id: 'utils-export-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/utils.js',
            line: 1,
            exportType: 'named',
            local: 'foo'
          },
          // IMPORT with alias: { foo as bar }
          {
            id: 'main-import-bar',
            type: 'IMPORT',
            name: 'bar',
            file: '/project/main.js',
            line: 1,
            source: './utils',
            importType: 'named',
            imported: 'foo',  // Original name in source
            local: 'bar'      // Aliased local name
          },
          // CALL uses the aliased name: bar()
          {
            id: 'main-call-bar',
            type: 'CALL',
            name: 'bar',
            file: '/project/main.js',
            line: 3
          }
        ]);

        // IMPORT -> IMPORTS_FROM -> EXPORT
        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-bar',
          dst: 'utils-export-foo'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('main-call-bar', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create one CALLS edge');
        assert.strictEqual(edges[0].dst, 'utils-foo-func', 'Should point to foo function');

        console.log('Aliased import function call resolution works');
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // NAMESPACE IMPORTS (Skip Case)
  // ============================================================================

  describe('Namespace imports (skip case)', () => {
    it('should skip namespace import method calls', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // Setup: import * as utils from './utils'; utils.foo();
        // This creates a METHOD_CALL (has object attribute), not CALL_SITE

        await backend.addNodes([
          // FUNCTION in utils.js
          {
            id: 'utils-foo-func',
            type: 'FUNCTION',
            name: 'foo',
            file: '/project/utils.js',
            line: 1
          },
          // IMPORT (namespace)
          {
            id: 'main-import-utils',
            type: 'IMPORT',
            name: 'utils',
            file: '/project/main.js',
            line: 1,
            source: './utils',
            importType: 'namespace',
            imported: '*',
            local: 'utils'
          },
          // CALL with object = 'utils' (METHOD_CALL pattern)
          {
            id: 'main-call-utils-foo',
            type: 'CALL',
            name: 'utils.foo',
            file: '/project/main.js',
            line: 3,
            object: 'utils',  // <-- Has object attribute = method call
            method: 'foo'
          }
        ]);

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // Should NOT create CALLS edge (has object attribute = method call)
        const edges = await backend.getOutgoingEdges('main-call-utils-foo', ['CALLS']);
        assert.strictEqual(edges.length, 0, 'Should not create CALLS edge for namespace method call');

        console.log('Namespace import method calls correctly skipped');
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // ALREADY RESOLVED (Skip Case)
  // ============================================================================

  describe('Already resolved calls (skip case)', () => {
    it('should not create duplicate CALLS edges', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        await backend.addNodes([
          {
            id: 'utils-foo-func',
            type: 'FUNCTION',
            name: 'foo',
            file: '/project/utils.js',
            line: 1
          },
          {
            id: 'utils-export-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/utils.js',
            line: 1,
            exportType: 'named',
            local: 'foo'
          },
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            line: 1,
            source: './utils',
            importType: 'named',
            imported: 'foo',
            local: 'foo'
          },
          {
            id: 'main-call-foo',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 3
          }
        ]);

        // Pre-existing edges
        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'utils-export-foo'
        });

        // CALL already has CALLS edge (simulates already resolved)
        await backend.addEdge({
          type: 'CALLS',
          src: 'main-call-foo',
          dst: 'utils-foo-func'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // Should not create another edge
        const edges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should still have only one CALLS edge');
        assert.strictEqual(result.created.edges, 0, 'Should report 0 edges created');

        console.log('Duplicate prevention works');
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // EXTERNAL IMPORTS (Skip Case)
  // ============================================================================

  describe('External imports (skip case)', () => {
    it('should skip external module imports', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // Setup: import lodash from 'lodash'; lodash();
        // External import (non-relative path)

        await backend.addNodes([
          // IMPORT from external module (lodash)
          {
            id: 'main-import-lodash',
            type: 'IMPORT',
            name: '_',
            file: '/project/main.js',
            line: 1,
            source: 'lodash',  // <-- Non-relative! External module
            importType: 'default',
            imported: 'default',
            local: '_'
          },
          // CALL to _()
          {
            id: 'main-call-lodash',
            type: 'CALL',
            name: '_',
            file: '/project/main.js',
            line: 3
          }
        ]);

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // Should NOT create CALLS edge (external import)
        const edges = await backend.getOutgoingEdges('main-call-lodash', ['CALLS']);
        assert.strictEqual(edges.length, 0, 'Should not create CALLS edge for external import');

        console.log('External imports correctly skipped');
      } finally {
        await backend.close();
      }
    });

    it('should skip scoped package imports', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        await backend.addNodes([
          {
            id: 'main-import-query',
            type: 'IMPORT',
            name: 'useQuery',
            file: '/project/main.js',
            line: 1,
            source: '@tanstack/react-query',  // Scoped package
            importType: 'named',
            imported: 'useQuery',
            local: 'useQuery'
          },
          {
            id: 'main-call-query',
            type: 'CALL',
            name: 'useQuery',
            file: '/project/main.js',
            line: 5
          }
        ]);

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('main-call-query', ['CALLS']);
        assert.strictEqual(edges.length, 0, 'Should not create CALLS edge for scoped package');

        console.log('Scoped package imports correctly skipped');
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // MISSING IMPORTS_FROM EDGE (Graceful Handling)
  // ============================================================================

  describe('Missing IMPORTS_FROM edge (graceful handling)', () => {
    it('should handle missing IMPORTS_FROM edge gracefully', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // Setup: IMPORT exists but no IMPORTS_FROM edge
        // (file not analyzed or import resolution failed)

        await backend.addNodes([
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            line: 1,
            source: './utils',  // Relative, but no IMPORTS_FROM edge
            importType: 'named',
            imported: 'foo',
            local: 'foo'
          },
          {
            id: 'main-call-foo',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 3
          }
        ]);

        // Note: NO IMPORTS_FROM edge created

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // Should not crash, should report success
        assert.strictEqual(result.success, true, 'Plugin should succeed');

        // No edge should be created
        const edges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
        assert.strictEqual(edges.length, 0, 'Should not create edge without IMPORTS_FROM');

        console.log('Missing IMPORTS_FROM edge handled gracefully');
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // RE-EXPORT CHAIN RESOLUTION
  // ============================================================================

  describe('Re-export chain resolution', () => {
    it('should resolve single-hop re-export chain', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        await backend.addNodes([
          // Function in other.js
          {
            id: 'other-foo-func',
            type: 'FUNCTION',
            name: 'foo',
            file: '/project/other.js',
            line: 1
          },
          // Export in other.js (local export)
          {
            id: 'other-export-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/other.js',
            line: 1,
            exportType: 'named',
            local: 'foo'
          },
          // Re-export in index.js (barrel file)
          {
            id: 'index-reexport-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/index.js',
            line: 1,
            exportType: 'named',
            local: 'foo',
            source: './other'  // <-- Re-export indicator
          },
          // Import in main.js
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            line: 1,
            source: './index',
            importType: 'named',
            imported: 'foo',
            local: 'foo'
          },
          // Call in main.js
          {
            id: 'main-call-foo',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 3
          }
        ]);

        // Pre-existing edge from ImportExportLinker
        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'index-reexport-foo'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // Should create CALLS edge through re-export chain
        const edges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create one CALLS edge');
        assert.strictEqual(edges[0].dst, 'other-foo-func',
          'Should resolve through re-export to actual function');

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.created.edges, 2, 'Should create 2 edges (CALLS + HANDLED_BY)');
        assert.strictEqual(result.metadata.reExportsResolved, 1,
          'Should report 1 re-export resolved');

        console.log('Single-hop re-export chain resolution works');
      } finally {
        await backend.close();
      }
    });

    it('should resolve multi-hop re-export chain (2 hops)', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        await backend.addNodes([
          // Actual function in impl.js
          {
            id: 'impl-helper-func',
            type: 'FUNCTION',
            name: 'helper',
            file: '/project/impl.js',
            line: 1
          },
          // Export in impl.js
          {
            id: 'impl-export-helper',
            type: 'EXPORT',
            name: 'helper',
            file: '/project/impl.js',
            exportType: 'named',
            local: 'helper'
          },
          // Re-export in internal.js (hop 1)
          {
            id: 'internal-reexport-helper',
            type: 'EXPORT',
            name: 'helper',
            file: '/project/internal.js',
            exportType: 'named',
            local: 'helper',
            source: './impl'
          },
          // Re-export in index.js (hop 2)
          {
            id: 'index-reexport-helper',
            type: 'EXPORT',
            name: 'helper',
            file: '/project/index.js',
            exportType: 'named',
            local: 'helper',
            source: './internal'
          },
          // Import in app.js
          {
            id: 'app-import-helper',
            type: 'IMPORT',
            name: 'helper',
            file: '/project/app.js',
            source: './index',
            importType: 'named',
            imported: 'helper',
            local: 'helper'
          },
          // Call in app.js
          {
            id: 'app-call-helper',
            type: 'CALL',
            name: 'helper',
            file: '/project/app.js',
            line: 3
          }
        ]);

        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'app-import-helper',
          dst: 'index-reexport-helper'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('app-call-helper', ['CALLS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'impl-helper-func',
          'Should resolve through 2-hop re-export chain');

        console.log('Multi-hop re-export chain (2 hops) resolution works');
      } finally {
        await backend.close();
      }
    });

    it('should handle circular re-export chains gracefully', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        await backend.addNodes([
          // Circular re-export: a.js -> b.js -> a.js
          {
            id: 'a-reexport-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/a.js',
            exportType: 'named',
            local: 'foo',
            source: './b'
          },
          {
            id: 'b-reexport-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/b.js',
            exportType: 'named',
            local: 'foo',
            source: './a'
          },
          // Import and call
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            source: './a',
            importType: 'named',
            imported: 'foo',
            local: 'foo'
          },
          {
            id: 'main-call-foo',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 3
          }
        ]);

        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'a-reexport-foo'
        });

        await backend.flush();

        // Should not crash
        const result = await resolver.execute({ graph: backend });

        assert.strictEqual(result.success, true, 'Should succeed without crashing');

        // No edge should be created
        const edges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
        assert.strictEqual(edges.length, 0, 'Should not create edge for circular re-export');

        // Should report as broken (circular chains are treated as broken)
        assert.ok(
          result.metadata.skipped.reExportsBroken > 0,
          'Should report circular chain as broken in skipped counters'
        );

        console.log('Circular re-export chain handled gracefully');
      } finally {
        await backend.close();
      }
    });

    it('should handle broken re-export chain (missing export)', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        await backend.addNodes([
          // Re-export in index.js pointing to missing export
          {
            id: 'index-reexport-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/index.js',
            exportType: 'named',
            local: 'foo',
            source: './other'  // other.js has no 'foo' export
          },
          // Need a placeholder for other.js to exist in knownFiles
          // But it won't have the 'foo' export
          {
            id: 'other-bar-export',
            type: 'EXPORT',
            name: 'bar',
            file: '/project/other.js',
            exportType: 'named',
            local: 'bar'
            // Note: No 'foo' export here!
          },
          // Import and call
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            source: './index',
            importType: 'named',
            imported: 'foo',
            local: 'foo'
          },
          {
            id: 'main-call-foo',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 3
          }
        ]);

        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'index-reexport-foo'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        assert.strictEqual(result.success, true, 'Should succeed without crashing');

        const edges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
        assert.strictEqual(edges.length, 0, 'Should not create edge for broken chain');

        assert.ok(result.metadata.skipped.reExportsBroken > 0,
          'Should report broken chain in skipped counters');

        console.log('Broken re-export chain handled gracefully');
      } finally {
        await backend.close();
      }
    });

    it('should resolve default re-export chain', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        await backend.addNodes([
          // Function in utils.js
          {
            id: 'utils-formatDate-func',
            type: 'FUNCTION',
            name: 'formatDate',
            file: '/project/utils.js',
            line: 1
          },
          // Default export in utils.js
          {
            id: 'utils-export-default',
            type: 'EXPORT',
            name: 'default',
            file: '/project/utils.js',
            exportType: 'default',
            local: 'formatDate'
          },
          // Re-export default in index.js
          {
            id: 'index-reexport-default',
            type: 'EXPORT',
            name: 'default',
            file: '/project/index.js',
            exportType: 'default',
            local: 'default',
            source: './utils'
          },
          // Import default in main.js as 'fmt'
          {
            id: 'main-import-fmt',
            type: 'IMPORT',
            name: 'fmt',
            file: '/project/main.js',
            source: './index',
            importType: 'default',
            imported: 'default',
            local: 'fmt'
          },
          // Call fmt()
          {
            id: 'main-call-fmt',
            type: 'CALL',
            name: 'fmt',
            file: '/project/main.js',
            line: 3
          }
        ]);

        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-fmt',
          dst: 'index-reexport-default'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('main-call-fmt', ['CALLS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'utils-formatDate-func',
          'Should resolve default re-export to actual function');

        console.log('Default re-export chain resolution works');
      } finally {
        await backend.close();
      }
    });

    it('should skip re-export chain exceeding maxDepth (11 hops)', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // Create 11-hop re-export chain (exceeds maxDepth=10 limit)
        // file0.js -> file1.js -> ... -> file10.js -> file11.js (actual function)

        const nodes = [];

        // Actual function in file11.js (end of chain)
        nodes.push({
          id: 'file11-foo-func',
          type: 'FUNCTION',
          name: 'foo',
          file: '/project/file11.js',
          line: 1
        });

        // Export in file11.js (no source - terminal)
        nodes.push({
          id: 'file11-export-foo',
          type: 'EXPORT',
          name: 'foo',
          file: '/project/file11.js',
          exportType: 'named',
          local: 'foo'
        });

        // Re-exports in file10.js down to file0.js (11 hops)
        for (let i = 10; i >= 0; i--) {
          nodes.push({
            id: `file${i}-reexport-foo`,
            type: 'EXPORT',
            name: 'foo',
            file: `/project/file${i}.js`,
            exportType: 'named',
            local: 'foo',
            source: `./file${i + 1}`
          });
        }

        // Import in main.js from file0.js
        nodes.push({
          id: 'main-import-foo',
          type: 'IMPORT',
          name: 'foo',
          file: '/project/main.js',
          source: './file0',
          importType: 'named',
          imported: 'foo',
          local: 'foo'
        });

        // Call in main.js
        nodes.push({
          id: 'main-call-foo',
          type: 'CALL',
          name: 'foo',
          file: '/project/main.js',
          line: 3
        });

        await backend.addNodes(nodes);

        // IMPORTS_FROM edge from main's import to file0's re-export
        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'file0-reexport-foo'
        });

        await backend.flush();

        // Should NOT crash or infinite loop
        const result = await resolver.execute({ graph: backend });

        assert.strictEqual(result.success, true, 'Should succeed without crashing');

        // Chain exceeds maxDepth=10, so no CALLS edge should be created
        const edges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
        assert.strictEqual(edges.length, 0, 'Should NOT create CALLS edge for chain exceeding maxDepth');

        // Should be counted as broken (maxDepth exceeded returns null same as broken)
        assert.ok(
          result.metadata.skipped.reExportsBroken > 0,
          'Should report chain as broken (maxDepth exceeded)'
        );

        console.log('Re-export chain exceeding maxDepth (11 hops) correctly skipped');
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // ARROW FUNCTION EXPORTS
  // ============================================================================

  describe('Arrow function exports', () => {
    it('should resolve calls to exported arrow functions', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // Setup: const foo = () => {}; export { foo };
        // foo(); in main.js

        await backend.addNodes([
          // Arrow function in utils.js
          {
            id: 'utils-foo-arrow',
            type: 'FUNCTION',
            name: 'foo',
            file: '/project/utils.js',
            line: 1,
            kind: 'arrow'  // Arrow function
          },
          // Named export
          {
            id: 'utils-export-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/utils.js',
            line: 2,
            exportType: 'named',
            local: 'foo'
          },
          // Import
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            line: 1,
            source: './utils',
            importType: 'named',
            imported: 'foo',
            local: 'foo'
          },
          // Call
          {
            id: 'main-call-foo',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 3
          }
        ]);

        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'utils-export-foo'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
        assert.strictEqual(edges.length, 1, 'Should create CALLS edge');
        assert.strictEqual(edges[0].dst, 'utils-foo-arrow', 'Should point to arrow function');

        console.log('Arrow function export resolution works');
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // MULTIPLE CALLS TO SAME IMPORTED FUNCTION
  // ============================================================================

  describe('Multiple calls to same imported function', () => {
    it('should resolve multiple calls to the same imported function', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        await backend.addNodes([
          {
            id: 'utils-foo-func',
            type: 'FUNCTION',
            name: 'foo',
            file: '/project/utils.js',
            line: 1
          },
          {
            id: 'utils-export-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/utils.js',
            line: 1,
            exportType: 'named',
            local: 'foo'
          },
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            line: 1,
            source: './utils',
            importType: 'named',
            imported: 'foo',
            local: 'foo'
          },
          // Multiple calls to foo()
          {
            id: 'main-call-foo-1',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 3
          },
          {
            id: 'main-call-foo-2',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 5
          },
          {
            id: 'main-call-foo-3',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 7
          }
        ]);

        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'utils-export-foo'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // All calls should be resolved
        const edges1 = await backend.getOutgoingEdges('main-call-foo-1', ['CALLS']);
        const edges2 = await backend.getOutgoingEdges('main-call-foo-2', ['CALLS']);
        const edges3 = await backend.getOutgoingEdges('main-call-foo-3', ['CALLS']);

        assert.strictEqual(edges1.length, 1, 'Call 1 should have CALLS edge');
        assert.strictEqual(edges2.length, 1, 'Call 2 should have CALLS edge');
        assert.strictEqual(edges3.length, 1, 'Call 3 should have CALLS edge');

        assert.strictEqual(edges1[0].dst, 'utils-foo-func');
        assert.strictEqual(edges2[0].dst, 'utils-foo-func');
        assert.strictEqual(edges3[0].dst, 'utils-foo-func');

        assert.strictEqual(result.created.edges, 6, 'Should create 6 edges (3 CALLS + 3 HANDLED_BY)');

        console.log('Multiple calls to same function resolved correctly');
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // MULTIPLE IMPORTS FROM SAME FILE
  // ============================================================================

  describe('Multiple imports from same file', () => {
    it('should resolve calls to multiple functions from same source', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // import { foo, bar, baz } from './utils';

        await backend.addNodes([
          // Functions
          {
            id: 'utils-foo-func',
            type: 'FUNCTION',
            name: 'foo',
            file: '/project/utils.js',
            line: 1
          },
          {
            id: 'utils-bar-func',
            type: 'FUNCTION',
            name: 'bar',
            file: '/project/utils.js',
            line: 5
          },
          {
            id: 'utils-baz-func',
            type: 'FUNCTION',
            name: 'baz',
            file: '/project/utils.js',
            line: 10
          },
          // Exports
          {
            id: 'utils-export-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/utils.js',
            exportType: 'named',
            local: 'foo'
          },
          {
            id: 'utils-export-bar',
            type: 'EXPORT',
            name: 'bar',
            file: '/project/utils.js',
            exportType: 'named',
            local: 'bar'
          },
          {
            id: 'utils-export-baz',
            type: 'EXPORT',
            name: 'baz',
            file: '/project/utils.js',
            exportType: 'named',
            local: 'baz'
          },
          // Imports
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            source: './utils',
            importType: 'named',
            imported: 'foo',
            local: 'foo'
          },
          {
            id: 'main-import-bar',
            type: 'IMPORT',
            name: 'bar',
            file: '/project/main.js',
            source: './utils',
            importType: 'named',
            imported: 'bar',
            local: 'bar'
          },
          {
            id: 'main-import-baz',
            type: 'IMPORT',
            name: 'baz',
            file: '/project/main.js',
            source: './utils',
            importType: 'named',
            imported: 'baz',
            local: 'baz'
          },
          // Calls
          {
            id: 'main-call-foo',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 5
          },
          {
            id: 'main-call-bar',
            type: 'CALL',
            name: 'bar',
            file: '/project/main.js',
            line: 6
          },
          {
            id: 'main-call-baz',
            type: 'CALL',
            name: 'baz',
            file: '/project/main.js',
            line: 7
          }
        ]);

        // IMPORTS_FROM edges
        await backend.addEdge({ type: 'IMPORTS_FROM', src: 'main-import-foo', dst: 'utils-export-foo' });
        await backend.addEdge({ type: 'IMPORTS_FROM', src: 'main-import-bar', dst: 'utils-export-bar' });
        await backend.addEdge({ type: 'IMPORTS_FROM', src: 'main-import-baz', dst: 'utils-export-baz' });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        const edgesFoo = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
        const edgesBar = await backend.getOutgoingEdges('main-call-bar', ['CALLS']);
        const edgesBaz = await backend.getOutgoingEdges('main-call-baz', ['CALLS']);

        assert.strictEqual(edgesFoo[0].dst, 'utils-foo-func');
        assert.strictEqual(edgesBar[0].dst, 'utils-bar-func');
        assert.strictEqual(edgesBaz[0].dst, 'utils-baz-func');

        assert.strictEqual(result.created.edges, 6, 'Should create 6 edges (3 CALLS + 3 HANDLED_BY)');

        console.log('Multiple imports from same file resolved correctly');
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // CALL TO NON-IMPORTED FUNCTION (Should not resolve)
  // ============================================================================

  describe('Call to non-imported function', () => {
    it('should not resolve call to function that was not imported', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // Setup: Call to 'helper' but only 'foo' is imported

        await backend.addNodes([
          {
            id: 'utils-foo-func',
            type: 'FUNCTION',
            name: 'foo',
            file: '/project/utils.js',
            line: 1
          },
          {
            id: 'utils-export-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/utils.js',
            exportType: 'named',
            local: 'foo'
          },
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            source: './utils',
            importType: 'named',
            imported: 'foo',
            local: 'foo'
          },
          // Call to foo - should resolve
          {
            id: 'main-call-foo',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 3
          },
          // Call to helper - NOT imported, should NOT resolve
          {
            id: 'main-call-helper',
            type: 'CALL',
            name: 'helper',
            file: '/project/main.js',
            line: 5
          }
        ]);

        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'utils-export-foo'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        const edgesFoo = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
        const edgesHelper = await backend.getOutgoingEdges('main-call-helper', ['CALLS']);

        assert.strictEqual(edgesFoo.length, 1, 'foo() should be resolved');
        assert.strictEqual(edgesHelper.length, 0, 'helper() should NOT be resolved (not imported)');

        console.log('Non-imported function calls correctly not resolved');
      } finally {
        await backend.close();
      }
    });
  });

  // ============================================================================
  // PLUGIN METADATA
  // ============================================================================

  describe('Plugin metadata', () => {
    it('should have correct metadata', async () => {
      const resolver = new FunctionCallResolver();
      const metadata = resolver.metadata;

      assert.strictEqual(metadata.name, 'FunctionCallResolver');
      assert.strictEqual(metadata.phase, 'ENRICHMENT');
      assert.deepStrictEqual(metadata.creates.edges, ['CALLS', 'HANDLED_BY']);
      assert.deepStrictEqual(metadata.creates.nodes, ['EXTERNAL_MODULE']);
      assert.ok(metadata.dependencies.includes('ImportExportLinker'), 'Should depend on ImportExportLinker');

      console.log('Plugin metadata is correct');
    });
  });

  // ============================================================================
  // HANDLED_BY EDGES (REG-545)
  // ============================================================================

  describe('HANDLED_BY Edges (REG-545)', () => {
    it('should create HANDLED_BY edge for named import called at top level', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // import { foo } from './utils'; foo();
        // CALL at top level (no parentScopeId) -> should get HANDLED_BY -> IMPORT

        await backend.addNodes([
          // FUNCTION in utils.js
          {
            id: 'utils-foo-func',
            type: 'FUNCTION',
            name: 'foo',
            file: '/project/utils.js',
            line: 1
          },
          // EXPORT in utils.js
          {
            id: 'utils-export-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/utils.js',
            line: 1,
            exportType: 'named',
            local: 'foo'
          },
          // IMPORT in main.js
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            line: 1,
            source: './utils',
            importType: 'named',
            importBinding: 'value',
            imported: 'foo',
            local: 'foo'
          },
          // CALL at top level (no parentScopeId)
          {
            id: 'main-call-foo',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 3
          }
        ]);

        // Pre-existing edge from ImportExportLinker
        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'utils-export-foo'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // CALLS edge should still be created
        const callsEdges = await backend.getOutgoingEdges('main-call-foo', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1, 'Should create CALLS edge');
        assert.strictEqual(callsEdges[0].dst, 'utils-foo-func', 'CALLS should point to function');

        // HANDLED_BY edge should be created: CALL -> IMPORT
        const handledByEdges = await backend.getOutgoingEdges('main-call-foo', ['HANDLED_BY']);
        assert.strictEqual(handledByEdges.length, 1, 'Should create one HANDLED_BY edge');
        assert.strictEqual(handledByEdges[0].dst, 'main-import-foo',
          'HANDLED_BY should point to the IMPORT node');

        console.log('HANDLED_BY edge created for top-level named import call');
      } finally {
        await backend.close();
      }
    });

    it('should create HANDLED_BY edge for named import called inside nested scope (not shadowed)', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // import { foo } from './utils';
        // function bar() { foo(); }
        // CALL has parentScopeId but no local VARIABLE/CONSTANT shadows import name

        await backend.addNodes([
          // FUNCTION in utils.js
          {
            id: 'utils-foo-func',
            type: 'FUNCTION',
            name: 'foo',
            file: '/project/utils.js',
            line: 1
          },
          // EXPORT in utils.js
          {
            id: 'utils-export-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/utils.js',
            line: 1,
            exportType: 'named',
            local: 'foo'
          },
          // IMPORT in main.js
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            line: 1,
            source: './utils',
            importType: 'named',
            importBinding: 'value',
            imported: 'foo',
            local: 'foo'
          },
          // Enclosing FUNCTION in main.js
          {
            id: 'main-bar-func',
            type: 'FUNCTION',
            name: 'bar',
            file: '/project/main.js',
            line: 3
          },
          // CALL inside nested scope (has parentScopeId)
          {
            id: 'main-call-foo-nested',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 4,
            parentScopeId: 'main-bar-func'
          }
        ]);

        // Pre-existing edge from ImportExportLinker
        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'utils-export-foo'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // CALLS edge should still be created
        const callsEdges = await backend.getOutgoingEdges('main-call-foo-nested', ['CALLS']);
        assert.strictEqual(callsEdges.length, 1, 'Should create CALLS edge');
        assert.strictEqual(callsEdges[0].dst, 'utils-foo-func', 'CALLS should point to function');

        // HANDLED_BY edge should be created (no shadowing)
        const handledByEdges = await backend.getOutgoingEdges('main-call-foo-nested', ['HANDLED_BY']);
        assert.strictEqual(handledByEdges.length, 1,
          'Should create HANDLED_BY edge even in nested scope (not shadowed)');
        assert.strictEqual(handledByEdges[0].dst, 'main-import-foo',
          'HANDLED_BY should point to the IMPORT node');

        console.log('HANDLED_BY edge created for nested scope call (no shadow)');
      } finally {
        await backend.close();
      }
    });

    it('should NOT create HANDLED_BY edge when import name is shadowed by local variable', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // import { foo } from './utils';
        // function bar() { const foo = 42; foo(); }
        // Local VARIABLE 'foo' with parentScopeId shadows the import

        await backend.addNodes([
          // FUNCTION in utils.js
          {
            id: 'utils-foo-func',
            type: 'FUNCTION',
            name: 'foo',
            file: '/project/utils.js',
            line: 1
          },
          // EXPORT in utils.js
          {
            id: 'utils-export-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/utils.js',
            line: 1,
            exportType: 'named',
            local: 'foo'
          },
          // IMPORT in main.js
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            line: 1,
            source: './utils',
            importType: 'named',
            importBinding: 'value',
            imported: 'foo',
            local: 'foo'
          },
          // Enclosing FUNCTION in main.js
          {
            id: 'main-bar-func',
            type: 'FUNCTION',
            name: 'bar',
            file: '/project/main.js',
            line: 3
          },
          // Local VARIABLE that shadows the import name
          // MUST have parentScopeId to trigger shadow detection
          {
            id: 'main-var-foo',
            type: 'VARIABLE',
            name: 'foo',
            file: '/project/main.js',
            line: 4,
            parentScopeId: 'main-bar-func'
          },
          // CALL inside the same scope as the shadowing variable
          {
            id: 'main-call-foo-shadowed',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 5,
            parentScopeId: 'main-bar-func'
          }
        ]);

        // Pre-existing edge from ImportExportLinker
        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'utils-export-foo'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // HANDLED_BY edge should NOT be created (shadowed by local variable)
        const handledByEdges = await backend.getOutgoingEdges('main-call-foo-shadowed', ['HANDLED_BY']);
        assert.strictEqual(handledByEdges.length, 0,
          'Should NOT create HANDLED_BY edge when import is shadowed by local variable');

        console.log('HANDLED_BY edge correctly skipped for shadowed import');
      } finally {
        await backend.close();
      }
    });

    it('should NOT create HANDLED_BY edge for type-only import (Dijkstra GAP 1)', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // import type { Foo } from './utils';
        // Foo(); // Type-only import should not get HANDLED_BY
        // (would be a TS error at runtime, but we handle it gracefully)

        await backend.addNodes([
          // FUNCTION in utils.js
          {
            id: 'utils-foo-func',
            type: 'FUNCTION',
            name: 'Foo',
            file: '/project/utils.js',
            line: 1
          },
          // EXPORT in utils.js
          {
            id: 'utils-export-foo',
            type: 'EXPORT',
            name: 'Foo',
            file: '/project/utils.js',
            line: 1,
            exportType: 'named',
            local: 'Foo'
          },
          // IMPORT with importBinding: 'type' (type-only import)
          {
            id: 'main-import-foo-type',
            type: 'IMPORT',
            name: 'Foo',
            file: '/project/main.js',
            line: 1,
            source: './utils',
            importType: 'named',
            importBinding: 'type',
            imported: 'Foo',
            local: 'Foo'
          },
          // CALL to Foo()
          {
            id: 'main-call-foo-type',
            type: 'CALL',
            name: 'Foo',
            file: '/project/main.js',
            line: 3
          }
        ]);

        // Pre-existing edge from ImportExportLinker
        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo-type',
          dst: 'utils-export-foo'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // HANDLED_BY edge should NOT be created for type-only imports
        const handledByEdges = await backend.getOutgoingEdges('main-call-foo-type', ['HANDLED_BY']);
        assert.strictEqual(handledByEdges.length, 0,
          'Should NOT create HANDLED_BY edge for type-only import');

        console.log('HANDLED_BY edge correctly skipped for type-only import');
      } finally {
        await backend.close();
      }
    });

    it('should create HANDLED_BY edge for re-export chain terminating at external module (Dijkstra GAP 3)', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // main.js: import { foo } from './utils'; foo();
        // utils.js: export { foo } from 'external-lib';
        // Re-export chain resolves to external module.
        // HANDLED_BY should still link CALL to the local IMPORT in main.js.

        await backend.addNodes([
          // Re-export in utils.js pointing to external module
          {
            id: 'utils-reexport-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/utils.js',
            line: 1,
            exportType: 'named',
            local: 'foo',
            source: 'external-lib'  // External (non-relative) re-export
          },
          // IMPORT in main.js (from relative ./utils)
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            line: 1,
            source: './utils',
            importType: 'named',
            importBinding: 'value',
            imported: 'foo',
            local: 'foo'
          },
          // CALL in main.js
          {
            id: 'main-call-foo',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 3
          }
        ]);

        // Pre-existing edge from ImportExportLinker
        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'utils-reexport-foo'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // HANDLED_BY edge should be created pointing to the local IMPORT
        const handledByEdges = await backend.getOutgoingEdges('main-call-foo', ['HANDLED_BY']);
        assert.strictEqual(handledByEdges.length, 1,
          'Should create HANDLED_BY edge even when re-export resolves to external module');
        assert.strictEqual(handledByEdges[0].dst, 'main-import-foo',
          'HANDLED_BY should point to the local IMPORT node in the calling file');

        console.log('HANDLED_BY edge created for re-export chain to external module');
      } finally {
        await backend.close();
      }
    });

    it('should NOT shadow via PARAMETER node (Dijkstra GAP 2 - known limitation)', async () => {
      const { backend } = await setupBackend();

      try {
        const resolver = new FunctionCallResolver();

        // import { foo } from './utils';
        // function bar(foo) { foo(); }
        // PARAMETER named 'foo' does NOT have parentScopeId — uses functionId instead.
        // The shadow index queries VARIABLE/CONSTANT with parentScopeId,
        // so PARAMETER shadows are NOT detected. This test documents the gap.

        await backend.addNodes([
          // FUNCTION in utils.js
          {
            id: 'utils-foo-func',
            type: 'FUNCTION',
            name: 'foo',
            file: '/project/utils.js',
            line: 1
          },
          // EXPORT in utils.js
          {
            id: 'utils-export-foo',
            type: 'EXPORT',
            name: 'foo',
            file: '/project/utils.js',
            line: 1,
            exportType: 'named',
            local: 'foo'
          },
          // IMPORT in main.js
          {
            id: 'main-import-foo',
            type: 'IMPORT',
            name: 'foo',
            file: '/project/main.js',
            line: 1,
            source: './utils',
            importType: 'named',
            importBinding: 'value',
            imported: 'foo',
            local: 'foo'
          },
          // Enclosing FUNCTION in main.js
          {
            id: 'main-bar-func',
            type: 'FUNCTION',
            name: 'bar',
            file: '/project/main.js',
            line: 3
          },
          // PARAMETER named 'foo' — uses functionId, NOT parentScopeId
          {
            id: 'main-param-foo',
            type: 'PARAMETER',
            name: 'foo',
            file: '/project/main.js',
            line: 3,
            column: 14,
            functionId: 'main-bar-func',
            index: 0,
            rest: false
          },
          // CALL inside the function
          {
            id: 'main-call-foo-param',
            type: 'CALL',
            name: 'foo',
            file: '/project/main.js',
            line: 4,
            parentScopeId: 'main-bar-func'
          }
        ]);

        // Pre-existing edge from ImportExportLinker
        await backend.addEdge({
          type: 'IMPORTS_FROM',
          src: 'main-import-foo',
          dst: 'utils-export-foo'
        });

        await backend.flush();

        const result = await resolver.execute({ graph: backend });

        // GAP: PARAMETER nodes don't have parentScopeId, so buildShadowIndex()
        // won't detect the shadow. HANDLED_BY edge WILL be created even though
        // the parameter shadows the import at runtime.
        // This documents the known limitation (Dijkstra GAP 2).
        const handledByEdges = await backend.getOutgoingEdges('main-call-foo-param', ['HANDLED_BY']);
        assert.strictEqual(handledByEdges.length, 1,
          'HANDLED_BY edge IS created (PARAMETER shadow not detected — known GAP 2)');
        assert.strictEqual(handledByEdges[0].dst, 'main-import-foo',
          'HANDLED_BY points to IMPORT (parameter shadow undetected)');

        console.log('PARAMETER shadow gap documented (Dijkstra GAP 2)');
      } finally {
        await backend.close();
      }
    });
  });
});
