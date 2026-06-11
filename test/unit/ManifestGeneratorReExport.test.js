/**
 * ManifestGenerator re-export resolution — extension/index coverage.
 *
 * Guards a class-not-instance sibling of the 2026-06-08 re-export fixes
 * (packages/util/src/enrichers/packageApiEnricher.ts, PR #370): the
 * `ManifestGenerator.findDefinition` extension-fallback list must cover the
 * same JS/TS source extensions the orchestrator indexes, so that an
 * extensionless or directory re-export (`export { x } from './x'`) whose
 * definition lives in a `.ts`/`.tsx` file resolves to the real definition
 * node instead of being silently demoted to a `TYPE` export.
 *
 * Backend is a minimal in-memory fake implementing only the GraphBackend
 * methods ManifestGenerator.generate() exercises on the entry-file path:
 * queryNodes / getOutgoingEdges / getNode.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ManifestGenerator } from '@grafema/util';

/** Build a fake GraphBackend over fixed node/edge arrays. */
function makeBackend(nodes, edges) {
  const FILTER_KEYS = ['type', 'name', 'file'];
  return {
    async *queryNodes(filter) {
      for (const node of nodes) {
        const ok = FILTER_KEYS.every(
          k => filter[k] === undefined || node[k] === filter[k],
        );
        if (ok) yield node;
      }
    },
    async getOutgoingEdges(id, edgeTypes) {
      return edges.filter(
        e => e.src === id && (!edgeTypes || edgeTypes.includes(e.type)),
      );
    },
    async getNode(id) {
      return nodes.find(n => n.id === id) ?? null;
    },
  };
}

/** Barrel that re-exports three symbols via different specifier shapes. */
function fixture() {
  const nodes = [
    { id: 'idx#EXPORT', type: 'EXPORT', name: 'named', file: 'pkg/src/index.ts' },
    // extensionless specifier → defined in foo.ts
    { id: 'idx#foo', type: 'EXPORT_BINDING', name: 'foo', source: './foo', file: 'pkg/src/index.ts' },
    // directory specifier → defined in sub/index.ts
    { id: 'idx#bar', type: 'EXPORT_BINDING', name: 'bar', source: './sub', file: 'pkg/src/index.ts' },
    // ESM .js specifier → defined in baz.ts (already handled via .js→.ts rewrite)
    { id: 'idx#baz', type: 'EXPORT_BINDING', name: 'baz', source: './baz.js', file: 'pkg/src/index.ts' },

    { id: 'foo.ts#foo', type: 'FUNCTION', name: 'foo', file: 'pkg/src/foo.ts', exported: true },
    { id: 'sub#bar', type: 'FUNCTION', name: 'bar', file: 'pkg/src/sub/index.ts', exported: true },
    { id: 'baz.ts#baz', type: 'FUNCTION', name: 'baz', file: 'pkg/src/baz.ts', exported: true },
  ];
  const edges = [
    { src: 'idx#EXPORT', dst: 'idx#foo', type: 'EXPORTS' },
    { src: 'idx#EXPORT', dst: 'idx#bar', type: 'EXPORTS' },
    { src: 'idx#EXPORT', dst: 'idx#baz', type: 'EXPORTS' },
  ];
  return { nodes, edges };
}

async function generateExports() {
  const { nodes, edges } = fixture();
  const gen = new ManifestGenerator(makeBackend(nodes, edges), {
    purl: 'pkg:npm/test@0.0.0',
    grafemaDir: '/nonexistent-grafema-dir',
    entryFile: 'pkg/src/index.ts',
  });
  const manifest = await gen.generate();
  return new Map(manifest.exports.map(e => [e.name, e]));
}

describe('ManifestGenerator re-export resolution', () => {
  it('resolves an extensionless re-export to its .ts FUNCTION definition', async () => {
    const exp = await generateExports();
    const foo = exp.get('foo');
    assert.ok(foo, 'foo export missing from manifest');
    assert.equal(foo.kind, 'FUNCTION', `expected FUNCTION, got ${foo.kind}`);
    assert.equal(foo.semanticId, 'foo.ts#foo', 'semanticId must point at the definition, not the binding');
  });

  it('resolves a directory re-export to its index.ts FUNCTION definition', async () => {
    const exp = await generateExports();
    const bar = exp.get('bar');
    assert.ok(bar, 'bar export missing from manifest');
    assert.equal(bar.kind, 'FUNCTION', `expected FUNCTION, got ${bar.kind}`);
    assert.equal(bar.semanticId, 'sub#bar', 'semanticId must point at the definition, not the binding');
  });

  it('still resolves an ESM .js re-export to its .ts FUNCTION definition (regression guard)', async () => {
    const exp = await generateExports();
    const baz = exp.get('baz');
    assert.ok(baz, 'baz export missing from manifest');
    assert.equal(baz.kind, 'FUNCTION', `expected FUNCTION, got ${baz.kind}`);
    assert.equal(baz.semanticId, 'baz.ts#baz', 'semanticId must point at the definition, not the binding');
  });
});
