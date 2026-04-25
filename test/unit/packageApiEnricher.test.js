/**
 * Tests for packageApiEnricher (plan: atomic-purring-rivest Sprint 3 Phase A2).
 *
 * The enricher scans monorepo barrels (`packages/<pkg>/src/index.ts`), reads
 * their EXPORT_BINDING nodes, and emits a `package:export` FEATURE node per
 * export plus a HANDLES edge to the underlying definition (when resolvable).
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { enrichPackageApis } from '@grafema/util/enrichers/packageApiEnricher';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(async () => {
  await cleanupAllTestDatabases();
});

/** Find a single WireNode by its TestRFDB-stored originalId. */
async function getWireNodeByOriginalId(client, originalId, type) {
  for await (const wn of client.queryNodes(type ? { type } : {})) {
    let meta = {};
    try { meta = wn.metadata ? JSON.parse(wn.metadata) : {}; } catch { /* empty */ }
    if (meta.originalId === originalId) return wn;
  }
  return null;
}

async function getEdges(client, srcWireId, edgeType) {
  return client.getOutgoingEdges(srcWireId, [edgeType]);
}

/** Seed a barrel module + scope at the given file path. */
async function seedBarrelModule(backend, file) {
  await backend.addNode({
    id: `${file}::module`,
    type: 'MODULE',
    name: file,
    file,
    relativePath: file,
    contentHash: 'h1',
  });
  await backend.addNode({
    id: `${file}::scope`,
    type: 'SCOPE',
    name: 'global',
    file,
    scopeType: 'module',
  });
  await backend.addEdge({ src: `${file}::module`, dst: `${file}::scope`, type: 'HAS_SCOPE' });
}

describe('packageApiEnricher', () => {
  /** @type {Awaited<ReturnType<typeof createTestDatabase>>} */
  let db;
  /** @type {any} */
  let backend;
  /** @type {any} */
  let client;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
    client = backend.client;
  });

  it('single barrel with one direct export: 1 package:export node + 1 HANDLES edge', async () => {
    const barrel = 'packages/pkg-a/src/index.ts';
    const defFile = 'packages/pkg-a/src/foo.ts';

    await seedBarrelModule(backend, barrel);
    await seedBarrelModule(backend, defFile);

    // EXPORT_BINDING in the barrel re-exports `foo` from ./foo.js
    await backend.addNode({
      id: 'test::eb-foo',
      type: 'EXPORT_BINDING',
      name: 'foo',
      file: barrel,
      exported: true,
      exportedName: 'foo',
      source: './foo.js',
    });

    // Definition lives in foo.ts
    await backend.addNode({
      id: 'test::fn-foo',
      type: 'FUNCTION',
      name: 'foo',
      file: defFile,
      arrowFunction: false,
    });

    const result = await enrichPackageApis(client);

    assert.equal(result.packagesScanned, 1);
    assert.equal(result.apiNodesCreated, 1);
    assert.equal(result.handlesEdgesCreated, 1);
    assert.equal(result.exportsWithoutHandler, 0);

    const apiNodes = [];
    for await (const wn of client.queryNodes({ type: 'package:export' })) apiNodes.push(wn);
    assert.equal(apiNodes.length, 1);
    assert.equal(apiNodes[0].name, 'foo');

    const has = await getEdges(client, apiNodes[0].id, 'HANDLES');
    assert.equal(has.length, 1, 'one HANDLES edge expected');

    const target = await client.getNode(String(has[0].dst));
    assert.ok(target, 'HANDLES target should be readable');
    assert.equal(target.nodeType, 'FUNCTION');
    assert.equal(target.name, 'foo');
  });

  it('re-export from another (unindexed) package: node created, exportsWithoutHandler++', async () => {
    const barrel = 'packages/pkg-a/src/index.ts';
    await seedBarrelModule(backend, barrel);

    // Re-export from external @scope/other — no MODULE for that file in this graph.
    await backend.addNode({
      id: 'test::eb-bar',
      type: 'EXPORT_BINDING',
      name: 'Bar',
      file: barrel,
      exported: true,
      exportedName: 'Bar',
      source: '@scope/other',
    });

    const result = await enrichPackageApis(client);

    assert.equal(result.apiNodesCreated, 1);
    assert.equal(result.handlesEdgesCreated, 0);
    assert.equal(result.exportsWithoutHandler, 1);

    const apiNodes = [];
    for await (const wn of client.queryNodes({ type: 'package:export' })) apiNodes.push(wn);
    assert.equal(apiNodes.length, 1);
    assert.equal(apiNodes[0].name, 'Bar');

    // metadata.source should be preserved
    const meta = JSON.parse(apiNodes[0].metadata);
    assert.equal(meta.source, '@scope/other');
    assert.equal(meta.exportedName, 'Bar');
  });

  it('multiple exports in one barrel: 3 nodes', async () => {
    const barrel = 'packages/pkg-a/src/index.ts';
    const defFile = 'packages/pkg-a/src/types.ts';
    await seedBarrelModule(backend, barrel);
    await seedBarrelModule(backend, defFile);

    const exportNames = ['Alpha', 'Beta', 'gamma'];
    const kinds = ['CLASS', 'CONSTANT', 'FUNCTION'];
    for (let i = 0; i < exportNames.length; i++) {
      const n = exportNames[i];
      await backend.addNode({
        id: `test::eb-${n}`,
        type: 'EXPORT_BINDING',
        name: n,
        file: barrel,
        exported: true,
        exportedName: n,
        source: './types.js',
      });
      await backend.addNode({
        id: `test::def-${n}`,
        type: kinds[i],
        name: n,
        file: defFile,
      });
    }

    const result = await enrichPackageApis(client);

    assert.equal(result.apiNodesCreated, 3);
    assert.equal(result.handlesEdgesCreated, 3);
    assert.equal(result.exportsWithoutHandler, 0);

    const apiNodes = [];
    for await (const wn of client.queryNodes({ type: 'package:export' })) apiNodes.push(wn);
    assert.equal(apiNodes.length, 3);

    const names = apiNodes.map(n => n.name).sort();
    assert.deepEqual(names, ['Alpha', 'Beta', 'gamma']);
  });

  it('two packages: each export tagged with its own barrel/package', async () => {
    const barrelA = 'packages/pkg-a/src/index.ts';
    const barrelB = 'packages/pkg-b/src/index.ts';
    const defA = 'packages/pkg-a/src/a.ts';
    const defB = 'packages/pkg-b/src/b.ts';
    for (const f of [barrelA, barrelB, defA, defB]) await seedBarrelModule(backend, f);

    await backend.addNode({
      id: 'test::eb-a',
      type: 'EXPORT_BINDING',
      name: 'aFunc',
      file: barrelA,
      exported: true,
      exportedName: 'aFunc',
      source: './a.js',
    });
    await backend.addNode({
      id: 'test::fn-a',
      type: 'FUNCTION',
      name: 'aFunc',
      file: defA,
    });

    await backend.addNode({
      id: 'test::eb-b',
      type: 'EXPORT_BINDING',
      name: 'bFunc',
      file: barrelB,
      exported: true,
      exportedName: 'bFunc',
      source: './b.js',
    });
    await backend.addNode({
      id: 'test::fn-b',
      type: 'FUNCTION',
      name: 'bFunc',
      file: defB,
    });

    const result = await enrichPackageApis(client);

    assert.equal(result.packagesScanned, 2);
    assert.equal(result.apiNodesCreated, 2);
    assert.equal(result.handlesEdgesCreated, 2);

    const apiNodes = [];
    for await (const wn of client.queryNodes({ type: 'package:export' })) apiNodes.push(wn);
    assert.equal(apiNodes.length, 2);

    // Each api node should record its barrel correctly.
    for (const n of apiNodes) {
      const meta = JSON.parse(n.metadata);
      if (n.name === 'aFunc') assert.equal(meta.barrel, barrelA);
      if (n.name === 'bFunc') assert.equal(meta.barrel, barrelB);
    }
  });

  it('idempotent: running twice does not duplicate nodes or HANDLES edges', async () => {
    const barrel = 'packages/pkg-a/src/index.ts';
    const defFile = 'packages/pkg-a/src/foo.ts';
    await seedBarrelModule(backend, barrel);
    await seedBarrelModule(backend, defFile);

    await backend.addNode({
      id: 'test::eb-foo',
      type: 'EXPORT_BINDING',
      name: 'foo',
      file: barrel,
      exported: true,
      exportedName: 'foo',
      source: './foo.js',
    });
    await backend.addNode({
      id: 'test::fn-foo',
      type: 'FUNCTION',
      name: 'foo',
      file: defFile,
    });

    const r1 = await enrichPackageApis(client);
    assert.equal(r1.apiNodesCreated, 1);

    const r2 = await enrichPackageApis(client);
    assert.equal(r2.apiNodesCreated, 1, 'second run reports re-upsert count');

    // Graph state must not have grown.
    const apiNodes = [];
    for await (const wn of client.queryNodes({ type: 'package:export' })) apiNodes.push(wn);
    assert.equal(apiNodes.length, 1, 'no duplicate package:export nodes');

    const has = await getEdges(client, apiNodes[0].id, 'HANDLES');
    assert.equal(has.length, 1, 'no duplicate HANDLES edges');
  });
});
