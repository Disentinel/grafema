/**
 * ManifestGenerator — re-export chain resolution for source TypeScript.
 *
 * Regression guard for a gap in `ManifestGenerator.findDefinition()`: when a
 * barrel re-exports a symbol with an *extensionless* specifier
 * (`export { x } from './impl'`) — the only form the JS analyzer emits, since
 * EXPORT_BINDING.source is the verbatim `from '...'` string (see
 * packages/js-analyzer/src/Rules/Declarations.hs:644,742 and the analyzer's own
 * passing test Spec.hs:313 which asserts source === "./utils") — the generator
 * must still resolve the re-export to its FUNCTION/CLASS/INTERFACE definition.
 *
 * Before the fix, `resolveSourcePath('./impl')` produced an extensionless
 * graph path (`<dir>/impl`) and the extension-fallback list only tried
 * `.js/.mjs/.cjs//index.js//index.mjs` — never `.ts`/`/index.ts`. So source-TS
 * re-exports silently degraded to `kind: 'TYPE'` instead of resolving the real
 * definition. These tests assert the resolved `kind` and `semanticId` against a
 * real RFDB graph shaped exactly as the analyzer emits it.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ManifestGenerator } from '@grafema/util';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(async () => {
  await cleanupAllTestDatabases();
});

const PKG = 'packages/foo/src';
const ENTRY = `${PKG}/index.ts`;

/**
 * Seed a barrel EXPORT(named) node whose EXPORTS edges point at the given
 * re-export bindings. Each binding carries an extensionless `source`, exactly
 * as the JS analyzer stores it.
 *
 * @param {any} backend
 * @param {Array<{name:string, source:string}>} bindings
 */
async function seedBarrel(backend, bindings) {
  await backend.addNode({ id: `${ENTRY}::module`, type: 'MODULE', name: ENTRY, file: ENTRY });
  const exportId = `${ENTRY}::EXPORT::named`;
  await backend.addNode({ id: exportId, type: 'EXPORT', name: 'named', file: ENTRY, exported: true });
  for (const b of bindings) {
    const bindingId = `${ENTRY}::EXPORT_BINDING::${b.name}`;
    await backend.addNode({
      id: bindingId,
      type: 'EXPORT_BINDING',
      name: b.name,
      file: ENTRY,
      exported: true,
      source: b.source,
      exportedName: b.name,
    });
    await backend.addEdge({ src: exportId, dst: bindingId, type: 'EXPORTS' });
  }
}

/** Seed a definition node (FUNCTION/CLASS/INTERFACE/...) in a file. */
async function seedDef(backend, { id, type, name, file }) {
  await backend.addNode({ id, type, name, file, exported: true });
}

/** Seed a re-export hop: an EXPORT_BINDING in `file` re-exporting `name` from `source`. */
async function seedReexportHop(backend, { file, name, source }) {
  await backend.addNode({
    id: `${file}::EXPORT_BINDING::${name}`,
    type: 'EXPORT_BINDING',
    name,
    file,
    exported: true,
    source,
    exportedName: name,
  });
}

function makeGenerator(backend) {
  return new ManifestGenerator(backend, {
    purl: 'pkg:npm/@grafema/foo@1.0.0',
    grafemaDir: '/nonexistent-grafema-dir',
    sourceType: 'source',
    entryFile: ENTRY,
  });
}

describe('ManifestGenerator re-export resolution (source TypeScript)', () => {
  /** @type {Awaited<ReturnType<typeof createTestDatabase>>} */
  let db;
  /** @type {any} */
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  it('extensionless re-export resolves to the FUNCTION definition (not TYPE)', async () => {
    await seedBarrel(backend, [{ name: 'doThing', source: './impl' }]);
    await seedDef(backend, {
      id: `${PKG}/impl.ts::FUNCTION::doThing`,
      type: 'FUNCTION',
      name: 'doThing',
      file: `${PKG}/impl.ts`,
    });

    const manifest = await makeGenerator(backend).generate();
    const entry = manifest.exports.find(e => e.name === 'doThing');

    assert.ok(entry, 'doThing export present');
    assert.equal(entry.kind, 'FUNCTION', 'extensionless re-export should resolve to FUNCTION definition');
    assert.equal(entry.semanticId, `${PKG}/impl.ts::FUNCTION::doThing`, 'semanticId points at the resolved definition');
  });

  it('extensionless re-export resolves to the INTERFACE definition (documented gap)', async () => {
    await seedBarrel(backend, [{ name: 'AuthenticatedRequest', source: './request' }]);
    await seedDef(backend, {
      id: `${PKG}/request.ts::INTERFACE::AuthenticatedRequest`,
      type: 'INTERFACE',
      name: 'AuthenticatedRequest',
      file: `${PKG}/request.ts`,
    });

    const manifest = await makeGenerator(backend).generate();
    const entry = manifest.exports.find(e => e.name === 'AuthenticatedRequest');

    assert.ok(entry, 'AuthenticatedRequest export present');
    assert.equal(entry.kind, 'INTERFACE', 'extensionless re-export should resolve to INTERFACE definition');
    assert.equal(entry.semanticId, `${PKG}/request.ts::INTERFACE::AuthenticatedRequest`);
  });

  it('directory re-export resolves through <dir>/index.ts', async () => {
    await seedBarrel(backend, [{ name: 'helper', source: './utils' }]);
    await seedDef(backend, {
      id: `${PKG}/utils/index.ts::FUNCTION::helper`,
      type: 'FUNCTION',
      name: 'helper',
      file: `${PKG}/utils/index.ts`,
    });

    const manifest = await makeGenerator(backend).generate();
    const entry = manifest.exports.find(e => e.name === 'helper');

    assert.ok(entry, 'helper export present');
    assert.equal(entry.kind, 'FUNCTION', 'directory re-export should resolve through index.ts');
    assert.equal(entry.semanticId, `${PKG}/utils/index.ts::FUNCTION::helper`);
  });

  it('does NOT resolve a re-export to a same-named symbol in an unrelated file', async () => {
    // The barrel re-exports `doThing` from './impl', but there is NO impl.ts in
    // the graph. A FUNCTION named `doThing` exists only in a completely
    // unrelated path. Resolution MUST stay file-scoped: the export must not be
    // bound to the unrelated definition (it falls back to an unresolved TYPE).
    await seedBarrel(backend, [{ name: 'doThing', source: './impl' }]);
    await seedDef(backend, {
      id: 'totally/unrelated/elsewhere.ts::FUNCTION::doThing',
      type: 'FUNCTION',
      name: 'doThing',
      file: 'totally/unrelated/elsewhere.ts',
    });

    const manifest = await makeGenerator(backend).generate();
    const entry = manifest.exports.find(e => e.name === 'doThing');

    assert.ok(entry, 'doThing export present');
    assert.notEqual(
      entry.semanticId,
      'totally/unrelated/elsewhere.ts::FUNCTION::doThing',
      'must not resolve to a same-named symbol in an unrelated file',
    );
    assert.notEqual(entry.kind, 'FUNCTION', 'unresolved re-export must not claim the unrelated FUNCTION');
  });

  it('multi-hop extensionless re-export chain resolves to the leaf definition', async () => {
    // index.ts: export { deep } from './mid'
    // mid.ts:   export { deep } from './leaf'
    // leaf.ts:  export function deep() {}
    await seedBarrel(backend, [{ name: 'deep', source: './mid' }]);
    await seedReexportHop(backend, { file: `${PKG}/mid.ts`, name: 'deep', source: './leaf' });
    await seedDef(backend, {
      id: `${PKG}/leaf.ts::FUNCTION::deep`,
      type: 'FUNCTION',
      name: 'deep',
      file: `${PKG}/leaf.ts`,
    });

    const manifest = await makeGenerator(backend).generate();
    const entry = manifest.exports.find(e => e.name === 'deep');

    assert.ok(entry, 'deep export present');
    assert.equal(entry.kind, 'FUNCTION', 'multi-hop extensionless chain should resolve to leaf FUNCTION');
    assert.equal(entry.semanticId, `${PKG}/leaf.ts::FUNCTION::deep`);
  });
});
