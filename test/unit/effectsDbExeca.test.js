import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EffectsLookup } from '@grafema/util';
import { join } from 'node:path';

// Loads the REAL effects-db so this test guards effects-db/packages/execa.yaml.
const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

describe('effects-db: execa', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);

  // The async spawners are the SENDER side of the subprocess bridges. Each must
  // carry IO + IO:PROCESS:SPAWN + ASYNC + THROW and expose channel.binary=arg[0].
  for (const fn of ['execa', 'execaNode', 'execaCommand']) {
    it(`${fn} is an async spawning sender with binary channel`, () => {
      const entry = lookup.getEntry('execa', fn);
      assert.ok(entry, `Expected effects-db entry for execa.${fn}`);
      for (const effect of ['IO', 'IO:PROCESS:SPAWN', 'ASYNC', 'THROW']) {
        assert.ok(
          entry.effects.includes(effect),
          `Expected ${effect} in execa.${fn}, got: ${entry.effects}`,
        );
      }
      assert.deepEqual(
        entry.channel,
        { binary: 'arg[0]' },
        `Expected execa.${fn} to declare channel.binary=arg[0] for the subprocess bridge`,
      );
    });
  }

  // Sync spawners block the event loop: spawn + throw, but NOT async.
  for (const fn of ['execaSync', 'execaCommandSync']) {
    it(`${fn} spawns and throws synchronously (no ASYNC)`, () => {
      const effects = lookup.lookup('execa', fn);
      assert.ok(effects, `Expected effects for execa.${fn}`);
      assert.ok(
        effects.includes('IO:PROCESS:SPAWN'),
        `Expected IO:PROCESS:SPAWN in execa.${fn}, got: ${effects}`,
      );
      assert.ok(
        effects.includes('THROW'),
        `Expected THROW in execa.${fn}, got: ${effects}`,
      );
      assert.ok(
        !effects.includes('ASYNC'),
        `Expected NO ASYNC for sync call execa.${fn}, got: ${effects}`,
      );
    });
  }

  it('$ script tag spawns asynchronously and throws', () => {
    const effects = lookup.lookup('execa', '$');
    assert.ok(effects, 'Expected effects for execa.$');
    for (const effect of ['IO', 'IO:PROCESS:SPAWN', 'ASYNC', 'THROW']) {
      assert.ok(effects.includes(effect), `Expected ${effect} in execa.$, got: ${effects}`);
    }
  });

  it('resolves the same way an IMPORT_BINDING does: lookup(source, importedName)', () => {
    // Mirrors traceEffects.ts IMPORT_BINDING path: lookup('execa', 'execa').
    const effects = lookup.lookup('execa', 'execa');
    assert.ok(effects, 'Expected lookup("execa", "execa") to resolve');
    assert.ok(effects.includes('IO:PROCESS:SPAWN'));
  });
});
