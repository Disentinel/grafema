/**
 * ExportEntityLinker Tests
 *
 * Tests for EXPORT → entity EXPORTS edge creation (REG-569)
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { ExportEntityLinker } from '@grafema/core';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(cleanupAllTestDatabases);

describe('ExportEntityLinker', () => {
  async function setupBackend() {
    const db = await createTestDatabase();
    return { backend: db.backend, db };
  }

  describe('Named exports', () => {
    it('should create EXPORTS edge for named function export', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          { id: 'fn-foo', type: 'FUNCTION', name: 'foo', file: 'a.js', line: 1 },
          { id: 'exp-foo', type: 'EXPORT', name: 'foo', file: 'a.js', line: 1, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 1);
        const edges = await backend.getOutgoingEdges('exp-foo', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'fn-foo');
      } finally {
        await backend.close();
      }
    });

    it('should create EXPORTS edge for named const export', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          { id: 'var-x', type: 'VARIABLE_DECLARATION', name: 'x', file: 'a.js', line: 1 },
          { id: 'exp-x', type: 'EXPORT', name: 'x', file: 'a.js', line: 1, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 1);
        const edges = await backend.getOutgoingEdges('exp-x', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'var-x');
      } finally {
        await backend.close();
      }
    });

    it('should create EXPORTS edge for named class export', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          { id: 'cls-Foo', type: 'CLASS', name: 'Foo', file: 'a.js', line: 1 },
          { id: 'exp-Foo', type: 'EXPORT', name: 'Foo', file: 'a.js', line: 1, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 1);
        const edges = await backend.getOutgoingEdges('exp-Foo', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'cls-Foo');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Export specifiers', () => {
    it('should create EXPORTS edge for { x } specifier', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          { id: 'var-x', type: 'VARIABLE_DECLARATION', name: 'x', file: 'a.js', line: 1 },
          { id: 'exp-x', type: 'EXPORT', name: 'x', file: 'a.js', line: 3, exportType: 'named', local: 'x' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 1);
        const edges = await backend.getOutgoingEdges('exp-x', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'var-x');
      } finally {
        await backend.close();
      }
    });

    it('should create EXPORTS edge for { x as y } using local field', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          { id: 'fn-x', type: 'FUNCTION', name: 'x', file: 'a.js', line: 1 },
          { id: 'exp-y', type: 'EXPORT', name: 'y', file: 'a.js', line: 3, exportType: 'named', local: 'x' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 1);
        const edges = await backend.getOutgoingEdges('exp-y', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'fn-x');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Default exports', () => {
    it('should create EXPORTS edge for default export with local name', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          { id: 'fn-foo', type: 'FUNCTION', name: 'foo', file: 'a.js', line: 1 },
          { id: 'exp-default', type: 'EXPORT', name: 'default', file: 'a.js', line: 3, exportType: 'default', local: 'foo' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 1);
        const edges = await backend.getOutgoingEdges('exp-default', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'fn-foo');
      } finally {
        await backend.close();
      }
    });

    it('should use line-based fallback for anonymous default export', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          { id: 'fn-anon', type: 'FUNCTION', name: 'anonymous', file: 'a.js', line: 5 },
          { id: 'exp-default', type: 'EXPORT', name: 'default', file: 'a.js', line: 5, exportType: 'default', local: 'default' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 1);
        const edges = await backend.getOutgoingEdges('exp-default', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'fn-anon');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Scope correctness', () => {
    it('should only match module-level entities, not inner variables', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          // Module-level function 'x' (no parentScopeId)
          { id: 'fn-x', type: 'FUNCTION', name: 'x', file: 'a.js', line: 1 },
          // Inner variable 'x' inside some function (has parentScopeId)
          { id: 'var-x-inner', type: 'VARIABLE_DECLARATION', name: 'x', file: 'a.js', line: 5, parentScopeId: 'scope-outer' },
          { id: 'exp-x', type: 'EXPORT', name: 'x', file: 'a.js', line: 10, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 1);
        const edges = await backend.getOutgoingEdges('exp-x', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'fn-x', 'Should link to module-level entity, not inner variable');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Re-exports', () => {
    it('should create EXPORTS edge for named re-export to EXPORT in source file', async () => {
      const { backend } = await setupBackend();
      try {
        // File b.js has: export function foo() {}
        // File a.js has: export { foo } from './b'
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: '/project/a.js', line: 1 },
          { id: 'mod-b', type: 'MODULE', name: 'b.js', file: '/project/b.js', line: 1 },
          { id: 'exp-foo-b', type: 'EXPORT', name: 'foo', file: '/project/b.js', line: 1, exportType: 'named' },
          { id: 'exp-foo-a', type: 'EXPORT', name: 'foo', file: '/project/a.js', line: 1, exportType: 'named', source: './b', local: 'foo' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        // exp-foo-a → exp-foo-b (re-export chain)
        const edges = await backend.getOutgoingEdges('exp-foo-a', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'exp-foo-b');
      } finally {
        await backend.close();
      }
    });

    it('should create EXPORTS edge for default re-export', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: '/project/a.js', line: 1 },
          { id: 'mod-b', type: 'MODULE', name: 'b.js', file: '/project/b.js', line: 1 },
          { id: 'exp-default-b', type: 'EXPORT', name: 'default', file: '/project/b.js', line: 1, exportType: 'default' },
          { id: 'exp-default-a', type: 'EXPORT', name: 'default', file: '/project/a.js', line: 1, exportType: 'named', source: './b', local: 'default' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('exp-default-a', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'exp-default-b');
      } finally {
        await backend.close();
      }
    });

    it('should create EXPORTS edge for export * from to MODULE', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: '/project/a.js', line: 1 },
          { id: 'mod-b', type: 'MODULE', name: 'b.js', file: '/project/b.js', line: 1 },
          { id: 'exp-all-a', type: 'EXPORT', name: '*', file: '/project/a.js', line: 1, exportType: 'all', source: './b' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        const edges = await backend.getOutgoingEdges('exp-all-a', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'mod-b');
      } finally {
        await backend.close();
      }
    });

    it('should gracefully skip external package re-exports', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: '/project/a.js', line: 1 },
          // Re-export from external package (non-relative)
          { id: 'exp-ext', type: 'EXPORT', name: 'foo', file: '/project/a.js', line: 1, exportType: 'named', source: 'lodash', local: 'foo' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        // Should skip, not crash
        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.metadata.skipped, 1);
      } finally {
        await backend.close();
      }
    });
  });

  describe('TypeScript exports', () => {
    it('should create EXPORTS edge for interface export', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.ts', file: 'a.ts', line: 1 },
          { id: 'iface-Foo', type: 'INTERFACE', name: 'Foo', file: 'a.ts', line: 1 },
          { id: 'exp-Foo', type: 'EXPORT', name: 'Foo', file: 'a.ts', line: 1, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 1);
        const edges = await backend.getOutgoingEdges('exp-Foo', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'iface-Foo');
      } finally {
        await backend.close();
      }
    });

    it('should create EXPORTS edge for type alias export', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.ts', file: 'a.ts', line: 1 },
          { id: 'type-Bar', type: 'TYPE', name: 'Bar', file: 'a.ts', line: 1 },
          { id: 'exp-Bar', type: 'EXPORT', name: 'Bar', file: 'a.ts', line: 1, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 1);
        const edges = await backend.getOutgoingEdges('exp-Bar', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'type-Bar');
      } finally {
        await backend.close();
      }
    });

    it('should create EXPORTS edge for enum export', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.ts', file: 'a.ts', line: 1 },
          { id: 'enum-Dir', type: 'ENUM', name: 'Direction', file: 'a.ts', line: 1 },
          { id: 'exp-Dir', type: 'EXPORT', name: 'Direction', file: 'a.ts', line: 1, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 1);
        const edges = await backend.getOutgoingEdges('exp-Dir', ['EXPORTS']);
        assert.strictEqual(edges.length, 1);
        assert.strictEqual(edges[0].dst, 'enum-Dir');
      } finally {
        await backend.close();
      }
    });
  });

  describe('Graceful handling', () => {
    it('should skip when no matching entity found without crashing', async () => {
      const { backend } = await setupBackend();
      try {
        await backend.addNodes([
          { id: 'mod-a', type: 'MODULE', name: 'a.js', file: 'a.js', line: 1 },
          // Export for entity that doesn't exist in graph
          { id: 'exp-missing', type: 'EXPORT', name: 'missing', file: 'a.js', line: 1, exportType: 'named' },
        ]);
        await backend.flush();

        const enricher = new ExportEntityLinker();
        const result = await enricher.execute({ graph: backend });

        assert.strictEqual(result.created.edges, 0);
        assert.strictEqual(result.metadata.notFound, 1);
      } finally {
        await backend.close();
      }
    });
  });
});
