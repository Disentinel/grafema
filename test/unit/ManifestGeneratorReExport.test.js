import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { ManifestGenerator } from '@grafema/util';

/**
 * Regression: ManifestGenerator.findDefinition must resolve an *extensionless*
 * (or directory) re-export whose definition lives in a TypeScript file.
 *
 * The analyzer stores `EXPORT_BINDING.source` as the verbatim `from '...'`
 * specifier. Source TypeScript commonly re-exports without an extension
 * (`export { foo } from './foo'`) or from a directory (`from './sub'`), while
 * the real graph node lives in `foo.ts` / `sub/index.ts`. resolveSourcePath
 * rewrites a *trailing* `.js`→`.ts`, but it cannot help the extensionless and
 * directory forms — those reach findDefinition's extension-fallback loop.
 *
 * That loop used to carry a `.js`-only candidate list
 * (`['.js','.mjs','.cjs','/index.js','/index.mjs']`) and never tried `.ts` /
 * `/index.ts`, so a pure-TypeScript re-export resolved to nothing and the
 * export was silently demoted to a bare `TYPE` entry (wrong kind, the binding
 * id as semanticId, no params/effects) instead of the real FUNCTION.
 *
 * This is the same `.js`-only-fallback class already fixed for the package-API
 * enricher (REEXPORT_EXTENSIONS, PR #370). The fix shares one TS-first
 * extension constant between the two so they cannot drift apart again.
 */

/**
 * Minimal in-memory GraphBackend implementing only the methods
 * ManifestGenerator.generate() exercises: an async-generator queryNodes
 * (filtered by type / file / name) plus getNode / getOutgoingEdges.
 */
class MockGraphBackend {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
  }
  add(node) {
    this.nodes.set(node.id, node);
  }
  addEdge(edge) {
    this.edges.push(edge);
  }
  async *queryNodes(query) {
    for (const n of this.nodes.values()) {
      if (query.type !== undefined && n.type !== query.type) continue;
      if (query.file !== undefined && n.file !== query.file) continue;
      if (query.name !== undefined && n.name !== query.name) continue;
      yield n;
    }
  }
  async getNode(id) {
    return this.nodes.get(id) ?? null;
  }
  async getOutgoingEdges(id, edgeTypes) {
    return this.edges.filter(
      e => e.src === id && (!edgeTypes || edgeTypes.includes(e.type)),
    );
  }
  async getIncomingEdges(id, edgeTypes) {
    return this.edges.filter(
      e => e.dst === id && (!edgeTypes || edgeTypes.includes(e.type)),
    );
  }
}

/** Build a generator over a barrel whose binding re-exports `name` from `source`. */
function generatorFor(defNode, source) {
  const backend = new MockGraphBackend();
  backend.add({ id: 'exp', type: 'EXPORT', name: defNode.name, file: 'src/index.ts' });
  backend.add({
    id: 'bind',
    type: 'EXPORT_BINDING',
    name: defNode.name,
    file: 'src/index.ts',
    source,
  });
  backend.add(defNode);
  backend.addEdge({ src: 'exp', dst: 'bind', type: 'EXPORTS' });

  return new ManifestGenerator(backend, {
    purl: 'pkg:npm/test@0.0.0',
    grafemaDir: '/nonexistent-grafema-dir',
    entryFile: 'src/index.ts',
    sourceType: 'source',
  });
}

describe('ManifestGenerator re-export resolution (TS extension fallback)', () => {
  it('resolves an extensionless re-export to its .ts FUNCTION definition', async () => {
    const gen = generatorFor(
      { id: 'fn-foo', type: 'FUNCTION', name: 'foo', file: 'src/foo.ts', params: ['x'], exported: true },
      './foo',
    );
    const manifest = await gen.generate();
    const foo = manifest.exports.find(e => e.name === 'foo');
    assert.ok(foo, 'foo export should be present');
    assert.equal(foo.kind, 'FUNCTION', 'extensionless .ts re-export must resolve to FUNCTION, not a demoted TYPE');
    assert.equal(foo.semanticId, 'fn-foo', 'semanticId must point at the real definition, not the binding');
  });

  it('resolves a directory re-export to a src/sub/index.ts FUNCTION definition', async () => {
    const gen = generatorFor(
      { id: 'fn-bar', type: 'FUNCTION', name: 'bar', file: 'src/sub/index.ts', exported: true },
      './sub',
    );
    const manifest = await gen.generate();
    const bar = manifest.exports.find(e => e.name === 'bar');
    assert.ok(bar, 'bar export should be present');
    assert.equal(bar.kind, 'FUNCTION', 'directory re-export must resolve to index.ts FUNCTION, not a demoted TYPE');
    assert.equal(bar.semanticId, 'fn-bar', 'semanticId must point at the real definition, not the binding');
  });
});
