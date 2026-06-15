/**
 * Effects-db coverage guard for the `axios` HTTP client.
 *
 * Why this exists:
 *   - The effects-db had an HTTP *server* (express → IO:HTTP:LISTEN) but no
 *     popular HTTP *client*. The `http` bridge pattern (effects-db/bridges.yaml)
 *     matches a sender with `IO:HTTP:REQUEST` to a receiver with `IO:HTTP:LISTEN`
 *     to synthesize CALLS_REMOTE edges. Without an annotated client package, the
 *     sender side of that bridge is invisible for the ~50M-weekly-download axios.
 *   - This test pins the effect annotations so a future edit can't silently drop
 *     IO:HTTP:REQUEST (which would break http-bridge sender detection) or
 *     mis-annotate the pure helpers as effectful (which would pollute effect
 *     propagation with false IO/THROW).
 *
 * It asserts GRAPH-INDEPENDENT facts only — that the YAML loads and the
 * documented lookups resolve — because this environment cannot run a live
 * analyze. End-to-end bridge detection on a real axios-using repo is a separate
 * live-graph validation (out of scope here).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EffectsLookup } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

/** The request methods that perform an outgoing HTTP request. */
const REQUEST_METHODS = [
  'request', 'get', 'delete', 'head', 'options',
  'post', 'put', 'patch', 'postForm', 'putForm', 'patchForm',
];

test('axios request methods carry IO:HTTP:REQUEST (http-bridge sender)', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  for (const m of REQUEST_METHODS) {
    const effects = lookup.lookup('axios', m);
    assert.ok(effects, `Expected effects for axios.${m}`);
    assert.ok(
      effects.includes('IO:HTTP:REQUEST'),
      `axios.${m} must include IO:HTTP:REQUEST, got: ${effects}`,
    );
    assert.ok(effects.includes('IO'), `axios.${m} must include parent IO, got: ${effects}`);
    assert.ok(effects.includes('ASYNC'), `axios.${m} must include ASYNC, got: ${effects}`);
  }
});

test('axios.create is a pure factory returning an AxiosInstance', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  assert.deepEqual(lookup.lookup('axios', 'create'), ['PURE']);
  const entry = lookup.getEntry('axios', 'create');
  assert.ok(entry, 'Expected an entry for axios.create');
  assert.equal(entry.returns?.type, 'AxiosInstance', 'axios.create must declare returns.type AxiosInstance');
});

test('AxiosInstance request methods mirror the default export (post-create() usage)', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  // Instance methods are keyed as `<ReturnType>.<method>` under the package,
  // mirroring express's `Application.get` / `Router.get` convention.
  for (const m of REQUEST_METHODS) {
    const effects = lookup.lookup('axios', `AxiosInstance.${m}`);
    assert.ok(effects, `Expected effects for axios AxiosInstance.${m}`);
    assert.ok(
      effects.includes('IO:HTTP:REQUEST'),
      `AxiosInstance.${m} must include IO:HTTP:REQUEST, got: ${effects}`,
    );
  }
});

test('axios pure helpers are not effectful', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  for (const helper of ['isAxiosError', 'isCancel', 'getUri', 'toFormData', 'formToJSON', 'spread']) {
    assert.deepEqual(
      lookup.lookup('axios', helper),
      ['PURE'],
      `axios.${helper} must be PURE`,
    );
  }
});
