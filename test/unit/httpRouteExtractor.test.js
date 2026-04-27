/**
 * Tests for httpRouteExtractor (REG-1115).
 *
 * Each test seeds a small synthetic graph that mirrors what the JS analyzer +
 * libraryCallbackEnricher would produce for one of:
 *
 *   const app = express();
 *   app.get('/users', handler)
 *   app.post('/users/:id', handler)
 *   app.put('/orders/:orderId/items/:itemId', handler)
 *   app.use('/api', router)        // mountpoint — extractor returns null
 *   app.delete('/x/:id?', handler) // optional path param
 *
 * We run libraryCallbackEnricher first to produce the http:route FEATURE,
 * then invoke the extractor directly (bypassing the framework) and verify the
 * returned SpecedContractData. Going through the framework as well would be
 * redundant — the framework's own tests already cover dispatch.
 *
 * One smoke test loads each new HTTP-framework YAML cleanly via EffectsLookup
 * to guard against typos.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { EffectsLookup } from '@grafema/util';
import { enrichLibraryCallbacks } from '@grafema/util/enrichers/libraryCallbackEnricher';
import {
  httpRouteExtractor,
  parsePathParams,
} from '@grafema/util/enrichers/extractors/httpRouteExtractor';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

// ---------------------------------------------------------------------------
// One effects-db with the express entries the enricher uses.
// ---------------------------------------------------------------------------

let effectsDbDir;
let effectsLookup;

before(() => {
  effectsDbDir = mkdtempSync(join(tmpdir(), 'effectsdb-http-extr-'));
  mkdirSync(join(effectsDbDir, 'packages'), { recursive: true });
  mkdirSync(join(effectsDbDir, 'runtimes'), { recursive: true });
  writeFileSync(
    join(effectsDbDir, 'packages', 'express.yaml'),
    [
      'express:',
      '  express:',
      '    effects: [PURE]',
      '    returns: { type: Application }',
      '  Application.get:',
      '    effects: [MUTATION]',
      '    args:',
      '      - index: 0',
      '        role: ROUTE_PATH',
      '      - index: 1',
      '        role: ENTRY_POINT_CALLBACK',
      '    returns: { type: Application }',
      '  Application.post:',
      '    effects: [MUTATION]',
      '    args:',
      '      - index: 0',
      '        role: ROUTE_PATH',
      '      - index: 1',
      '        role: ENTRY_POINT_CALLBACK',
      '    returns: { type: Application }',
      '  Application.put:',
      '    effects: [MUTATION]',
      '    args:',
      '      - index: 0',
      '        role: ROUTE_PATH',
      '      - index: 1',
      '        role: ENTRY_POINT_CALLBACK',
      '    returns: { type: Application }',
      '  Application.delete:',
      '    effects: [MUTATION]',
      '    args:',
      '      - index: 0',
      '        role: ROUTE_PATH',
      '      - index: 1',
      '        role: ENTRY_POINT_CALLBACK',
      '    returns: { type: Application }',
      '  Application.use:',
      '    effects: [MUTATION]',
      '    args:',
      '      - index: 0',
      '        role: MOUNTPOINT',
      '      - index: 1',
      '        role: ENTRY_POINT_CALLBACK',
      '    returns: { type: Application }',
      '',
    ].join('\n'),
  );
  effectsLookup = EffectsLookup.load(effectsDbDir);
});

after(async () => {
  if (effectsDbDir) rmSync(effectsDbDir, { recursive: true, force: true });
  await cleanupAllTestDatabases();
});

// ---------------------------------------------------------------------------
// Fixture builder. Seeds:
//   - MODULE + SCOPE
//   - IMPORT_BINDING(name='express', source='express')
//   - CONSTANT(name='app') --ASSIGNED_FROM--> CALL(name='express', kind='new')
//     (libraryCallbackEnricher's findImportSourceForName traces this back to
//     the import binding via the constructor name)
//   - CALL(name='<obj>.<method>', kind=method) with the route path literal
//     at PASSES_ARGUMENT[index=0] and a handler FUNCTION at index=1.
//
// The receiver-tracing path in libraryCallbackEnricher needs an additional
// piece: the IMPORT_BINDING for `express` so the enricher can resolve
// `app.get(...)` back to the `express` library. We seed an IMPORT_BINDING
// directly named `app` that points at express; libraryCallbackEnricher's
// findImportSourceForName matches IMPORT_BINDING by name first.
// ---------------------------------------------------------------------------

let nodeCounter = 0;
function nextId(prefix) {
  return `t${++nodeCounter}::${prefix}`;
}

async function seedRoute(backend, file, method, path, { handlerArgIndex = 1, omitPathArg = false } = {}) {
  const moduleId = nextId('module');
  const scopeId = nextId('scope');
  const ibId = nextId('ib');
  await backend.addNodes([
    { id: moduleId, type: 'MODULE', name: file, file, relativePath: file, contentHash: 'h1' },
    { id: scopeId, type: 'SCOPE', name: 'global', file, scopeType: 'module' },
    {
      // Seed the receiver `app` directly as an import binding pointing at
      // express. The actual JS analyzer would emit IMPORT_BINDING for `express`
      // and a CONSTANT `app` with ASSIGNED_FROM -> CALL(express()); for unit
      // tests we collapse this into a single IMPORT_BINDING named `app`.
      id: ibId,
      type: 'IMPORT_BINDING',
      name: 'app',
      file,
      importedName: 'default',
      source: 'express',
    },
  ]);
  await backend.addEdges([
    { src: moduleId, dst: scopeId, type: 'HAS_SCOPE' },
    { src: scopeId, dst: ibId, type: 'DECLARES' },
  ]);

  const callId = nextId(`call-${method}`);
  await backend.addNode({
    id: callId,
    type: 'CALL',
    name: `app.${method}`,
    file,
    argCount: omitPathArg ? 1 : 2,
  });

  if (!omitPathArg) {
    const pathArgId = nextId('arg-path');
    await backend.addNode({
      id: pathArgId,
      type: 'LITERAL',
      name: `'${path}'`,
      file,
      value: `'${path}'`,
    });
    await backend.addEdge({
      src: callId,
      dst: pathArgId,
      type: 'PASSES_ARGUMENT',
      index: 0,
    });
  }

  const handlerId = nextId('arg-handler');
  await backend.addNode({
    id: handlerId,
    type: 'FUNCTION',
    name: 'handler',
    file,
    async: false,
    generator: false,
    exported: false,
    arrowFunction: true,
  });
  await backend.addEdge({
    src: callId,
    dst: handlerId,
    type: 'PASSES_ARGUMENT',
    index: handlerArgIndex,
  });

  return { callId, handlerId };
}

/** Look up the http:route FEATURE node (after enricher run). */
async function getRouteFeatures(client) {
  const out = [];
  for await (const wn of client.queryNodes({ type: 'http:route' })) out.push(wn);
  return out;
}

/**
 * Run libraryCallbackEnricher to materialise the http:route FEATURE, then
 * invoke httpRouteExtractor on it. Returns { feature, data }.
 */
async function runEnricherThenExtract(client) {
  const r = await enrichLibraryCallbacks(client, effectsLookup);
  assert.ok(
    r.domainNodesCreated >= 1,
    `libraryCallbackEnricher should have created http:route (got ${r.domainNodesCreated}, unresolved=${r.unresolvedCalls})`,
  );
  const features = await getRouteFeatures(client);
  assert.ok(features.length >= 1, 'http:route FEATURE should exist');
  const data = await httpRouteExtractor.extract(client, features[0]);
  return { feature: features[0], data };
}

// ---------------------------------------------------------------------------

describe('parsePathParams (unit)', () => {
  it('returns [] for path with no params', () => {
    assert.deepEqual(parsePathParams('/users'), []);
  });

  it('captures one required :param', () => {
    assert.deepEqual(parsePathParams('/users/:id'), [
      { name: 'id', optional: false },
    ]);
  });

  it('captures multiple :params', () => {
    assert.deepEqual(parsePathParams('/orders/:orderId/items/:itemId'), [
      { name: 'orderId', optional: false },
      { name: 'itemId', optional: false },
    ]);
  });

  it('captures optional :id?', () => {
    assert.deepEqual(parsePathParams('/x/:id?'), [
      { name: 'id', optional: true },
    ]);
  });

  it('captures anonymous wildcard *', () => {
    assert.deepEqual(parsePathParams('/static/*'), [
      { name: 'wildcard', optional: true },
    ]);
  });

  it('captures named wildcard *path', () => {
    assert.deepEqual(parsePathParams('/static/*path'), [
      { name: 'path', optional: true },
    ]);
  });

  it('handles empty path safely', () => {
    assert.deepEqual(parsePathParams(''), []);
  });
});

describe('httpRouteExtractor', () => {
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

  it('GET /users with no path params yields 0 inputs and "GET /users" output', async () => {
    await seedRoute(backend, 'app.ts', 'get', '/users');
    const { data } = await runEnricherThenExtract(client);
    assert.ok(data, 'extractor should not return null');
    assert.equal(data.source, 'http-route');
    assert.equal(data.inputs.length, 0);
    assert.equal(data.outputs.length, 1);
    assert.equal(data.outputs[0].description, 'GET /users');
    assert.equal(data.errors.length, 0);
  });

  it('POST /users/:id yields one input "id" and "POST /users/:id" output', async () => {
    await seedRoute(backend, 'app.ts', 'post', '/users/:id');
    const { data } = await runEnricherThenExtract(client);
    assert.ok(data);
    assert.equal(data.inputs.length, 1);
    assert.equal(data.inputs[0].name, 'id');
    assert.equal(data.inputs[0].type, 'string');
    assert.equal(data.inputs[0].optional, false);
    assert.equal(data.outputs[0].description, 'POST /users/:id');
  });

  it('PUT /orders/:orderId/items/:itemId yields two required inputs', async () => {
    await seedRoute(backend, 'app.ts', 'put', '/orders/:orderId/items/:itemId');
    const { data } = await runEnricherThenExtract(client);
    assert.ok(data);
    assert.equal(data.inputs.length, 2);
    assert.equal(data.inputs[0].name, 'orderId');
    assert.equal(data.inputs[0].optional, false);
    assert.equal(data.inputs[1].name, 'itemId');
    assert.equal(data.inputs[1].optional, false);
    assert.equal(data.outputs[0].description, 'PUT /orders/:orderId/items/:itemId');
  });

  it("app.use('/api', router) is a mountpoint — extractor returns null", async () => {
    // Mountpoint case: the libraryCallbackEnricher will still see args[1]
    // (a router-handler) annotated as ENTRY_POINT_CALLBACK and produce a
    // FEATURE; but the extractor must reject because metadata.method is
    // `Application.use`.
    await seedRoute(backend, 'app.ts', 'use', '/api');
    const features = await getRouteFeatures(client);
    // Run the enricher so the FEATURE is materialised:
    const r = await enrichLibraryCallbacks(client, effectsLookup);
    assert.equal(r.domainNodesCreated, 1, 'use() still produces a FEATURE');
    const feats = await getRouteFeatures(client);
    assert.equal(feats.length, 1);
    const data = await httpRouteExtractor.extract(client, feats[0]);
    assert.equal(data, null, 'extractor must return null for mountpoint');
    // Quiet linter — `features` baseline is captured for symmetry with other tests.
    void features;
  });

  it('GET /static/*name captures named wildcard as optional input', async () => {
    await seedRoute(backend, 'app.ts', 'get', '/static/*name');
    const { data } = await runEnricherThenExtract(client);
    assert.ok(data);
    assert.equal(data.inputs.length, 1);
    assert.equal(data.inputs[0].name, 'name');
    assert.equal(data.inputs[0].optional, true);
  });

  it('DELETE /x/:id? produces optional path parameter', async () => {
    await seedRoute(backend, 'app.ts', 'delete', '/x/:id?');
    const { data } = await runEnricherThenExtract(client);
    assert.ok(data);
    assert.equal(data.inputs.length, 1);
    assert.equal(data.inputs[0].name, 'id');
    assert.equal(data.inputs[0].optional, true);
    assert.equal(data.outputs[0].description, 'DELETE /x/:id?');
  });

  it('returns null when the FEATURE has no anchorCall metadata', async () => {
    // Build a synthetic http:route FEATURE with no anchorCall metadata —
    // simulating a future code path that produces FEATUREs without the
    // libraryCallbackEnricher chain (e.g. user-authored fixture).
    const file = 'orphan.ts';
    await backend.addNodes([
      { id: 'orphan::module', type: 'MODULE', name: file, file, relativePath: file, contentHash: 'h1' },
      {
        id: 'orphan::feature',
        type: 'http:route',
        name: '/orphan',
        file,
      },
    ]);
    const features = await getRouteFeatures(client);
    assert.ok(features.length >= 1);
    const data = await httpRouteExtractor.extract(client, features[0]);
    assert.equal(data, null);
  });

  it('returns null when the path-literal arg is missing on the anchor call', async () => {
    // Force anchorCall to exist but have no PASSES_ARGUMENT[index=0].
    await seedRoute(backend, 'app.ts', 'get', '/never-read', { omitPathArg: true });
    // The libraryCallbackEnricher requires the callback at args[1]; with no
    // path literal at args[0], the FEATURE may still be created (the enricher
    // looks up the callback target via its own PASSES_ARGUMENT walk). The
    // extractor must then return null.
    const r = await enrichLibraryCallbacks(client, effectsLookup);
    if (r.domainNodesCreated === 0) {
      // Acceptable outcome: enricher couldn't create the FEATURE without
      // a recoverable handler binding. Nothing to extract.
      return;
    }
    const features = await getRouteFeatures(client);
    if (features.length === 0) return;
    const data = await httpRouteExtractor.extract(client, features[0]);
    assert.equal(data, null);
  });
});

// ---------------------------------------------------------------------------
// YAML smoke tests — each new HTTP-framework YAML must load via EffectsLookup
// without throwing, and contribute at least one entry under its package key.
// ---------------------------------------------------------------------------

describe('HTTP framework effects-db YAML', () => {
  const REPO_EFFECTS_DB = join(import.meta.dirname, '..', '..', 'effects-db');

  /** Map: YAML file (relative to packages/) → top-level package key it should
   *  declare and a representative method we expect to exist. */
  const FRAMEWORK_FIXTURES = [
    { file: 'express.yaml', pkg: 'express', method: 'Application.get' },
    { file: 'fastify.yaml', pkg: 'fastify', method: 'FastifyInstance.get' },
    { file: 'koa.yaml', pkg: 'koa', method: 'Koa.use' },
    { file: 'koa-router.yaml', pkg: 'koa-router', method: 'Router.get' },
    { file: 'koa-router-scoped.yaml', pkg: '@koa/router', method: 'Router.get' },
    { file: 'hono.yaml', pkg: 'hono', method: 'Hono.get' },
  ];

  for (const fx of FRAMEWORK_FIXTURES) {
    it(`loads ${fx.file} and resolves ${fx.pkg}/${fx.method}`, () => {
      const lookup = EffectsLookup.load(REPO_EFFECTS_DB);
      const entry = lookup.getEntry(fx.pkg, fx.method);
      assert.ok(entry, `Expected entry for ${fx.pkg} ${fx.method}`);
      assert.ok(Array.isArray(entry.effects), 'effects[] must be an array');
    });
  }
});
