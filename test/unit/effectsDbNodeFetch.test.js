/**
 * Effects-db coverage guard for the `node-fetch` HTTP client.
 *
 * Why this exists:
 *   - The `http` bridge pattern (effects-db/bridges.yaml) matches a sender with
 *     `IO:HTTP:REQUEST` to a receiver with `IO:HTTP:LISTEN` to synthesize
 *     CALLS_REMOTE edges. The receiver side already exists on node's built-in
 *     http/https server (runtimes/node.yaml: createServer / Server.listen); the
 *     gap was a popular userland HTTP *client* on the sender side. node-fetch is
 *     one of the most-downloaded on npm; annotating its default `fetch` export
 *     lights up the sender side for every `import fetch from 'node-fetch'` call site.
 *   - This test pins the effect annotations so a future edit can't silently drop
 *     IO:HTTP:REQUEST (which would break http-bridge sender detection), drop the
 *     `channel.url` metadata the bridge uses for URL extraction, or — critically —
 *     ADD a THROW effect. Unlike axios, node-fetch follows WHATWG fetch semantics:
 *     it RESOLVES on any HTTP status and only rejects on a network failure, so a
 *     THROW here would mis-mark every caller as possibly-throwing.
 *
 * It asserts GRAPH-INDEPENDENT facts only — that the YAML loads and the
 * documented lookups resolve — because this environment cannot run a live
 * analyze. End-to-end bridge detection on a real node-fetch-using repo is a
 * separate live-graph validation (out of scope here).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EffectsLookup } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

test('node-fetch default export is an http-bridge sender (IO:HTTP:REQUEST + ASYNC)', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  const effects = lookup.lookup('node-fetch', 'fetch');
  assert.ok(effects, 'Expected effects for node-fetch.fetch');
  assert.ok(effects.includes('IO'), `node-fetch.fetch must include parent IO, got: ${effects}`);
  assert.ok(
    effects.includes('IO:HTTP:REQUEST'),
    `node-fetch.fetch must include IO:HTTP:REQUEST, got: ${effects}`,
  );
  assert.ok(effects.includes('ASYNC'), `node-fetch.fetch must include ASYNC, got: ${effects}`);
});

test('node-fetch.fetch does NOT throw — WHATWG fetch resolves on non-2xx (contrast axios)', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  const effects = lookup.lookup('node-fetch', 'fetch');
  assert.ok(effects, 'Expected effects for node-fetch.fetch');
  assert.ok(
    !effects.includes('THROW'),
    `node-fetch.fetch must NOT include THROW (fetch resolves on 4xx/5xx), got: ${effects}`,
  );
});

test('node-fetch.fetch declares channel.url = arg[0] for http-bridge URL extraction', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  const entry = lookup.getEntry('node-fetch', 'fetch');
  assert.ok(entry, 'Expected an entry for node-fetch.fetch');
  assert.equal(
    entry.channel?.url,
    'arg[0]',
    `node-fetch.fetch must declare channel.url = arg[0], got: ${JSON.stringify(entry.channel)}`,
  );
});

test('node-fetch WHATWG value-object constructors are PURE', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  for (const ctor of ['Headers', 'Request', 'Response', 'FetchError', 'AbortError']) {
    assert.deepEqual(
      lookup.lookup('node-fetch', ctor),
      ['PURE'],
      `node-fetch.${ctor} constructor must be PURE`,
    );
  }
});

test('node-fetch.isRedirect is a pure status-code predicate', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  assert.deepEqual(lookup.lookup('node-fetch', 'isRedirect'), ['PURE']);
});

test('node-fetch Response body readers are ASYNC but not network IO', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  for (const m of ['json', 'text', 'arrayBuffer', 'blob', 'buffer']) {
    const effects = lookup.lookup('node-fetch', `Response.${m}`);
    assert.ok(effects, `Expected effects for node-fetch Response.${m}`);
    assert.ok(effects.includes('ASYNC'), `Response.${m} must include ASYNC, got: ${effects}`);
    assert.ok(
      !effects.includes('IO:HTTP:REQUEST'),
      `Response.${m} must not re-emit IO:HTTP:REQUEST (network IO belongs to fetch), got: ${effects}`,
    );
  }
});

test('node-fetch file helpers read the filesystem; async/sync split mirrors node:fs', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  for (const fn of ['blobFrom', 'fileFrom']) {
    const effects = lookup.lookup('node-fetch', fn);
    assert.ok(effects, `Expected effects for node-fetch.${fn}`);
    assert.ok(effects.includes('IO:FILE:READ'), `node-fetch.${fn} must include IO:FILE:READ, got: ${effects}`);
    assert.ok(effects.includes('ASYNC'), `node-fetch.${fn} must include ASYNC, got: ${effects}`);
  }
  for (const fn of ['blobFromSync', 'fileFromSync']) {
    const effects = lookup.lookup('node-fetch', fn);
    assert.ok(effects, `Expected effects for node-fetch.${fn}`);
    assert.ok(effects.includes('IO:FILE:READ'), `node-fetch.${fn} must include IO:FILE:READ, got: ${effects}`);
    assert.ok(!effects.includes('ASYNC'), `node-fetch.${fn} (sync) must NOT include ASYNC, got: ${effects}`);
  }
});
