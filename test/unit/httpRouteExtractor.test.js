/**
 * Tests for httpRouteExtractor (REG-1115).
 *
 * Each test seeds a small synthetic graph that mirrors what the JS analyzer +
 * the `js_http_routes_nodes` / `js_http_routes_edges` DERIVE PACKS now produce
 * for one of:
 *
 *   const app = express();
 *   app.get('/users', handler)
 *   app.post('/users/:id', handler)
 *   app.put('/orders/:orderId/items/:itemId', handler)
 *   app.use('/api', router)        // mountpoint — extractor returns null
 *   app.delete('/x/:id?', handler) // optional path param
 *
 * HISTORY: these tests used to materialise the `http:route` FEATURE by running
 * `libraryCallbackEnricher`. As of Wave 14 (PR #397, feature-detection) the
 * 6 HTTP frameworks (express/fastify/koa/koa-router/@koa/router/hono) were
 * RETIRED from that enricher's LIBRARY_NODE_TYPE map — the default-on
 * `js_http_routes_nodes`/`js_http_routes_edges` derive packs are now the sole
 * producer of js `http:route` nodes. So the enricher seeding no longer mints a
 * FEATURE and the extractor tests had nothing to consume.
 *
 * `httpRouteExtractor` itself is NOT retired — it still transforms any
 * `http:route` node → SpecedContractData at runtime regardless of who minted
 * it. These tests now seed the `http:route` node + its anchor CALL DIRECTLY in
 * the exact shape the derive pack emits (node `metadata.anchorCall` = the
 * registration call id, `metadata.method` = the BARE HTTP method name, the
 * route path as a quoted LITERAL at PASSES_ARGUMENT[index=0]). This exercises
 * the REAL runtime input contract of the extractor — the same contract the
 * pack's @materialize_node + ROUTES_TO output satisfies in production.
 *
 * One smoke test loads each HTTP-framework YAML cleanly via EffectsLookup to
 * guard against typos — that path is independent of the enricher/pack split.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { EffectsLookup } from '@grafema/util';
import {
  httpRouteExtractor,
  parsePathParams,
} from '@grafema/util/enrichers/extractors/httpRouteExtractor';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

after(async () => {
  await cleanupAllTestDatabases();
});

// ---------------------------------------------------------------------------
// Fixture builder. Seeds the shape the js_http_routes_* derive packs emit:
//   - MODULE
//   - CALL(name='app.<method>')                      ← the anchor registration
//       --PASSES_ARGUMENT[index=0]--> LITERAL("'<path>'")   (ROUTE_PATH arg)
//       --PASSES_ARGUMENT[index=1]--> FUNCTION(handler)     (ENTRY_POINT_CALLBACK)
//   - http:route FEATURE node, with metadata:
//       { anchorCall: <callId>, method: '<bare-method>', library: 'express' }
//       --EXPOSES--> seeded from the registration CALL; --HANDLES--> handler.
//
// The extractor reads ONLY metadata.anchorCall + metadata.method off the
// http:route node, then walks PASSES_ARGUMENT[index=0] on the anchor CALL for
// the path literal — so we seed exactly those. `method` is the BARE name
// (e.g. 'get', 'use'), matching delta 5 of js_http_routes_nodes.dl (the pack
// stores the bare verb; the legacy enricher stored 'Application.get').
// ---------------------------------------------------------------------------

let nodeCounter = 0;
function nextId(prefix) {
  return `t${++nodeCounter}::${prefix}`;
}

/**
 * Seed an anchor registration CALL + its path/handler arguments, plus the
 * `http:route` node the derive pack would mint for it. Returns the seeded ids.
 *
 * @param {object} backend  the TestDatabase backend
 * @param {string} file     source file path
 * @param {string} method   bare HTTP method (e.g. 'get', 'post', 'use')
 * @param {string} path     route path literal (e.g. '/users/:id')
 * @param {object} [opts]
 * @param {number} [opts.handlerArgIndex=1]  index of the handler PASSES_ARGUMENT
 * @param {boolean} [opts.omitPathArg=false] skip seeding the path literal arg
 * @param {boolean} [opts.omitFeature=false] skip seeding the http:route node
 * @param {boolean} [opts.omitAnchorMeta=false] mint the http:route node WITHOUT
 *        anchorCall/method metadata (orphan FEATURE case)
 */
async function seedRoute(backend, file, method, path, {
  handlerArgIndex = 1,
  omitPathArg = false,
  omitFeature = false,
  omitAnchorMeta = false,
} = {}) {
  const moduleId = nextId('module');
  await backend.addNodes([
    { id: moduleId, type: 'MODULE', name: file, file, relativePath: file, contentHash: 'h1' },
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
      // The pack reads the LITERAL `name` = RAW source text INCLUDING quotes
      // (header: LITERAL name keeps raw source quoting, "'overview'"); the
      // extractor strips matching quote pairs in readLiteralValue.
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

  let featureId = null;
  if (!omitFeature) {
    featureId = nextId('http-route');
    // Mint the http:route node in the pack's shape. The pack's
    // @materialize_node stores meta(library, method, anchorCall) with `method`
    // the BARE verb. We anchor on the same CALL id we seeded (the extractor
    // does client.getNode(anchorCall) — a semantic-id round-trip that the
    // shared test client resolves directly since we store nodes under that id).
    const featureMeta = omitAnchorMeta
      ? { library: 'express' }
      : { library: 'express', method, anchorCall: callId };
    await backend.addNode({
      id: featureId,
      type: 'http:route',
      name: omitPathArg ? '<unnamed-http-route>' : path,
      file,
      ...featureMeta,
    });
    // EXPOSES (registration CALL -> http:route) + HANDLES (http:route -> handler)
    // — the edge-pack vocabulary; seeded for fidelity though the extractor does
    // not currently traverse them (it reaches the call via anchorCall metadata).
    await backend.addEdges([
      { src: callId, dst: featureId, type: 'EXPOSES' },
      { src: featureId, dst: handlerId, type: 'HANDLES' },
    ]);
  }

  return { callId, handlerId, featureId };
}

/** Look up the http:route FEATURE node(s) currently in the graph. */
async function getRouteFeatures(client) {
  const out = [];
  for await (const wn of client.queryNodes({ type: 'http:route' })) out.push(wn);
  return out;
}

/**
 * Fetch the (single) seeded http:route FEATURE and run the extractor on it.
 * Returns { feature, data }.
 */
async function extractSeededRoute(client) {
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
    const { data } = await extractSeededRoute(client);
    assert.ok(data, 'extractor should not return null');
    assert.equal(data.source, 'http-route');
    assert.equal(data.inputs.length, 0);
    assert.equal(data.outputs.length, 1);
    assert.equal(data.outputs[0].description, 'GET /users');
    assert.equal(data.errors.length, 0);
  });

  it('POST /users/:id yields one input "id" and "POST /users/:id" output', async () => {
    await seedRoute(backend, 'app.ts', 'post', '/users/:id');
    const { data } = await extractSeededRoute(client);
    assert.ok(data);
    assert.equal(data.inputs.length, 1);
    assert.equal(data.inputs[0].name, 'id');
    assert.equal(data.inputs[0].type, 'string');
    assert.equal(data.inputs[0].optional, false);
    assert.equal(data.outputs[0].description, 'POST /users/:id');
  });

  it('PUT /orders/:orderId/items/:itemId yields two required inputs', async () => {
    await seedRoute(backend, 'app.ts', 'put', '/orders/:orderId/items/:itemId');
    const { data } = await extractSeededRoute(client);
    assert.ok(data);
    assert.equal(data.inputs.length, 2);
    assert.equal(data.inputs[0].name, 'orderId');
    assert.equal(data.inputs[0].optional, false);
    assert.equal(data.inputs[1].name, 'itemId');
    assert.equal(data.inputs[1].optional, false);
    assert.equal(data.outputs[0].description, 'PUT /orders/:orderId/items/:itemId');
  });

  it("app.use('/api', router) is a mountpoint — extractor returns null", async () => {
    // Mountpoint case: `use` carries an ENTRY_POINT_CALLBACK arg so the derive
    // pack DOES mint an http:route node for it (it doesn't distinguish
    // mountpoint registrations at mint time — `use` is simply not in hr_verb,
    // so no ROUTES_TO is derived, but the node still exists). The extractor
    // must reject it because the BARE metadata.method is `use`, which is in
    // MOUNTPOINT_METHODS.
    await seedRoute(backend, 'app.ts', 'use', '/api');
    const feats = await getRouteFeatures(client);
    assert.equal(feats.length, 1, 'use() still produces a FEATURE node');
    const data = await httpRouteExtractor.extract(client, feats[0]);
    assert.equal(data, null, 'extractor must return null for mountpoint');
  });

  it('GET /static/*name captures named wildcard as optional input', async () => {
    await seedRoute(backend, 'app.ts', 'get', '/static/*name');
    const { data } = await extractSeededRoute(client);
    assert.ok(data);
    assert.equal(data.inputs.length, 1);
    assert.equal(data.inputs[0].name, 'name');
    assert.equal(data.inputs[0].optional, true);
  });

  it('DELETE /x/:id? produces optional path parameter', async () => {
    await seedRoute(backend, 'app.ts', 'delete', '/x/:id?');
    const { data } = await extractSeededRoute(client);
    assert.ok(data);
    assert.equal(data.inputs.length, 1);
    assert.equal(data.inputs[0].name, 'id');
    assert.equal(data.inputs[0].optional, true);
    assert.equal(data.outputs[0].description, 'DELETE /x/:id?');
  });

  it('v2: top-level name = "<METHOD> <path>" and outputs carry kind="http"', async () => {
    await seedRoute(backend, 'app.ts', 'get', '/users/:id');
    const { data } = await extractSeededRoute(client);
    assert.ok(data);
    assert.equal(data.name, 'GET /users/:id');
    assert.equal(data.outputs.length, 1);
    assert.equal(data.outputs[0].kind, 'http');
    assert.equal(data.outputs[0].description, 'GET /users/:id');
  });

  it('returns null when the FEATURE has no anchorCall metadata', async () => {
    // Build a synthetic http:route FEATURE with no anchorCall metadata —
    // simulating a producer (or a user-authored fixture) that emits a
    // FEATURE without the pack's meta(anchorCall). The extractor cannot reach
    // a registration call and must bail.
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
    // The pack mints a node (name "<unnamed-http-route>") whenever the handler
    // arg exists, even if the ROUTE_PATH literal is absent. The anchorCall
    // resolves, but PASSES_ARGUMENT[index=0] yields no literal, so the
    // extractor must return null.
    await seedRoute(backend, 'app.ts', 'get', '/never-read', { omitPathArg: true });
    const features = await getRouteFeatures(client);
    assert.equal(features.length, 1, 'http:route FEATURE should still be minted');
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
