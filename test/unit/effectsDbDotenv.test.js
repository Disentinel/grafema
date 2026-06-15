/**
 * Effects-db coverage guard for the `dotenv` package (env-var bridge sender).
 *
 * Why this exists:
 *   - effects-db/bridges.yaml defines an `env-var` bridge: a sender with
 *     `IO:ENV:SET` is matched to a receiver with `IO:ENV:READ` to reason about
 *     "process A sets an env var, process B reads it" cross-process flow. The
 *     runtime files already annotate the SET side for non-JS languages
 *     (rust env.set_var, python putenv, elixir put_env), but no npm package
 *     filled the env-var sender side for the Node ecosystem.
 *   - `dotenv` (~40M weekly downloads) is the canonical env-var sender:
 *     `config()` reads a `.env` file (IO:FILE:READ) and assigns the parsed keys
 *     into `process.env` (IO:ENV:SET). Annotating it lights up the sender side
 *     of the env-var bridge the same way axios lit up the http-bridge sender.
 *   - This test pins the annotations so a future edit cannot silently drop
 *     IO:ENV:SET (which would make dotenv invisible to env-var bridge detection)
 *     or mark the pure `parse` helper as effectful (which would pollute effect
 *     propagation with false IO).
 *
 * It asserts GRAPH-INDEPENDENT facts only — that the YAML loads and the
 * documented lookups resolve — because this environment cannot run a live
 * analyze. End-to-end bridge detection on a real dotenv-using repo is a separate
 * live-graph validation (out of scope here).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EffectsLookup } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

/** The functions that read a .env file AND write process.env (env-var sender). */
const ENV_SETTERS = ['config', 'configDotenv'];

test('dotenv config/configDotenv carry IO:ENV:SET (env-var bridge sender)', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  for (const m of ENV_SETTERS) {
    const effects = lookup.lookup('dotenv', m);
    assert.ok(effects, `Expected effects for dotenv.${m}`);
    assert.ok(
      effects.includes('IO:ENV:SET'),
      `dotenv.${m} must include IO:ENV:SET (env-var bridge sender), got: ${effects}`,
    );
    assert.ok(
      effects.includes('IO:FILE:READ'),
      `dotenv.${m} reads a .env file, must include IO:FILE:READ, got: ${effects}`,
    );
    assert.ok(effects.includes('IO'), `dotenv.${m} must include parent IO, got: ${effects}`);
  }
});

test('dotenv.parse is a pure parser (string/Buffer -> object, no IO)', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  assert.deepEqual(
    lookup.lookup('dotenv', 'parse'),
    ['PURE'],
    'dotenv.parse must be PURE — it parses an in-memory string/Buffer and touches neither disk nor process.env',
  );
});

test('dotenv.populate mutates its target arg but is not itself an env-var sender', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
  const effects = lookup.lookup('dotenv', 'populate');
  assert.ok(effects, 'Expected effects for dotenv.populate');
  assert.ok(
    effects.includes('MUTATION'),
    `dotenv.populate writes into its caller-provided target object, must include MUTATION, got: ${effects}`,
  );
  // Verified against dotenv lib/main.js: populate throws OBJECT_REQUIRED when
  // the `parsed` arg is not an object.
  assert.ok(
    effects.includes('THROW'),
    `dotenv.populate throws OBJECT_REQUIRED on a non-object source, must include THROW, got: ${effects}`,
  );
  // populate's target is an arbitrary object passed by the caller, not
  // necessarily process.env, so it must NOT be flagged as an env-var sender —
  // that would create false CALLS_REMOTE edges for non-env targets.
  assert.ok(
    !effects.includes('IO:ENV:SET'),
    `dotenv.populate must NOT claim IO:ENV:SET (target is a caller arg, not always process.env), got: ${effects}`,
  );
});
