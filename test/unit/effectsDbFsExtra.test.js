import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EffectsLookup } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

/**
 * effects-db coverage for the `fs-extra` npm package (~70-90M weekly downloads),
 * the dominant Node filesystem wrapper. Before this entry, the file-ipc bridge
 * (bridges.yaml: sender IO:FILE:WRITE -> receiver IO:FILE:READ) had ZERO npm
 * package coverage — only the node:fs runtime. fs-extra adds value-add methods
 * (copy/move/outputFile/readJson/writeJson/ensureDir/remove) plus re-exports all
 * of node:fs, so its file read/write methods must carry IO:FILE:READ / IO:FILE:WRITE
 * subtypes to participate in the bridge.
 *
 * Resolution: a named import `import { readJson } from 'fs-extra'` is an
 * IMPORT_BINDING with source='fs-extra', importedName='readJson', which
 * traceEffects.ts resolves via lookup('fs-extra', 'readJson') (bare-key, like
 * minimatch). End-to-end default-import member resolution (`fse.readJson()`) and
 * live file-ipc bridge detection require a live graph and are out of scope here;
 * these tests assert the effects-db lookup shape directly, the same way
 * test/unit/effects-lookup.test.js validates other packages.
 */
describe('effects-db: fs-extra', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);

  it('is loaded as a package', () => {
    assert.equal(lookup.isLoaded, true);
  });

  it('readJson reads a file: IO + IO:FILE:READ + ASYNC + THROW (JSON.parse)', () => {
    const effects = lookup.lookup('fs-extra', 'readJson');
    assert.ok(effects, 'Expected effects-db entry for fs-extra readJson');
    assert.ok(effects.includes('IO'), `Expected IO, got: ${effects}`);
    assert.ok(effects.includes('IO:FILE:READ'), `Expected IO:FILE:READ, got: ${effects}`);
    assert.ok(effects.includes('ASYNC'), `Expected ASYNC, got: ${effects}`);
    assert.ok(effects.includes('THROW'), `Expected THROW (parse), got: ${effects}`);
  });

  it('readJsonSync is synchronous: IO:FILE:READ + THROW, no ASYNC', () => {
    const effects = lookup.lookup('fs-extra', 'readJsonSync');
    assert.ok(effects, 'Expected effects-db entry for fs-extra readJsonSync');
    assert.ok(effects.includes('IO:FILE:READ'), `Expected IO:FILE:READ, got: ${effects}`);
    assert.ok(effects.includes('THROW'), `Expected THROW, got: ${effects}`);
    assert.ok(!effects.includes('ASYNC'), `Sync method must NOT be ASYNC, got: ${effects}`);
  });

  it('writeJson writes a file: IO:FILE:WRITE + ASYNC + MUTATION', () => {
    const effects = lookup.lookup('fs-extra', 'writeJson');
    assert.ok(effects, 'Expected effects-db entry for fs-extra writeJson');
    assert.ok(effects.includes('IO:FILE:WRITE'), `Expected IO:FILE:WRITE, got: ${effects}`);
    assert.ok(effects.includes('ASYNC'), `Expected ASYNC, got: ${effects}`);
    assert.ok(effects.includes('MUTATION'), `Expected MUTATION, got: ${effects}`);
  });

  it('outputFile fills the file-ipc bridge sender side: IO:FILE:WRITE', () => {
    const effects = lookup.lookup('fs-extra', 'outputFile');
    assert.ok(effects, 'Expected effects-db entry for fs-extra outputFile');
    assert.ok(effects.includes('IO:FILE:WRITE'), `Expected IO:FILE:WRITE, got: ${effects}`);
  });

  it('copy reads source AND writes dest: both IO:FILE:READ and IO:FILE:WRITE', () => {
    const effects = lookup.lookup('fs-extra', 'copy');
    assert.ok(effects, 'Expected effects-db entry for fs-extra copy');
    assert.ok(effects.includes('IO:FILE:READ'), `Expected IO:FILE:READ, got: ${effects}`);
    assert.ok(effects.includes('IO:FILE:WRITE'), `Expected IO:FILE:WRITE, got: ${effects}`);
    assert.ok(effects.includes('ASYNC'), `Expected ASYNC, got: ${effects}`);
  });

  it('ensureDir creates directories: IO + MUTATION, no file-content subtype', () => {
    const effects = lookup.lookup('fs-extra', 'ensureDir');
    assert.ok(effects, 'Expected effects-db entry for fs-extra ensureDir');
    assert.ok(effects.includes('IO'), `Expected IO, got: ${effects}`);
    assert.ok(effects.includes('MUTATION'), `Expected MUTATION, got: ${effects}`);
    assert.ok(!effects.includes('IO:FILE:WRITE'), `Dir create is not file-content write, got: ${effects}`);
  });

  it('pathExists is read-only IO + ASYNC (no MUTATION)', () => {
    const effects = lookup.lookup('fs-extra', 'pathExists');
    assert.ok(effects, 'Expected effects-db entry for fs-extra pathExists');
    assert.ok(effects.includes('IO'), `Expected IO, got: ${effects}`);
    assert.ok(effects.includes('ASYNC'), `Expected ASYNC, got: ${effects}`);
    assert.ok(!effects.includes('MUTATION'), `pathExists must not MUTATE, got: ${effects}`);
  });

  it('uppercase JSON aliases (readJSON/writeJSON) mirror their lowercase forms', () => {
    assert.ok(lookup.lookup('fs-extra', 'readJSON'), 'Expected entry for readJSON alias');
    assert.ok(lookup.lookup('fs-extra', 'writeJSON'), 'Expected entry for writeJSON alias');
    assert.deepEqual(
      lookup.lookup('fs-extra', 'readJSON'),
      lookup.lookup('fs-extra', 'readJson'),
      'readJSON alias must equal readJson',
    );
    assert.deepEqual(
      lookup.lookup('fs-extra', 'writeJSON'),
      lookup.lookup('fs-extra', 'writeJson'),
      'writeJSON alias must equal writeJson',
    );
  });

  it('re-exported node:fs methods carry file-content subtypes (readFile/writeFile)', () => {
    const read = lookup.lookup('fs-extra', 'readFile');
    const write = lookup.lookup('fs-extra', 'writeFile');
    assert.ok(read?.includes('IO:FILE:READ'), `readFile expected IO:FILE:READ, got: ${read}`);
    assert.ok(write?.includes('IO:FILE:WRITE'), `writeFile expected IO:FILE:WRITE, got: ${write}`);
  });
});
