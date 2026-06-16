// Effects-db annotation coverage for the `glob` npm package.
//
// `glob` is a primary IO:FILE:READ effect carrier (~tens of millions of weekly
// downloads). Its companion `minimatch` (the pattern matcher) is already covered
// as a pure library; `glob` adds the actual filesystem walk on top, so without
// this entry the effect tracer treats every glob() call as UNKNOWN and loses the
// filesystem-read signal that should propagate through callers.
//
// Effects were derived empirically against glob v13.0.6 (real exported API +
// behaviour probes), not from memory:
//   - glob/globSync/stream/iterate variants read the filesystem  → IO, IO:FILE:READ
//   - async variants return a Promise / async iterator            → ASYNC
//   - every entry point validates the pattern via the Glob ctor   → THROW (TypeError
//     on non-string pattern, verified)
//   - the Glob constructor is lazy: it builds matchers but does NOT walk the FS,
//     so it carries THROW only (the walk/stream/iterate methods carry the IO)
//   - escape/unescape are pure string transforms                  → PURE
//   - hasMagic is deterministic pattern inspection that may throw → THROW
//   - Ignore.add mutates the instance; ignored/childrenIgnored are pure matchers
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EffectsLookup } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

describe('effects-db: glob', () => {
  const lookup = EffectsLookup.load(EFFECTS_DB_PATH);

  const get = (fn) => {
    const effects = lookup.lookup('glob', fn);
    assert.ok(effects, `Expected effects for glob ${fn}, got null (entry missing)`);
    return effects;
  };

  it('globSync reads the filesystem synchronously (IO:FILE:READ, THROW, no ASYNC)', () => {
    const e = get('globSync');
    assert.ok(e.includes('IO'), `Expected IO, got: ${e}`);
    assert.ok(e.includes('IO:FILE:READ'), `Expected IO:FILE:READ, got: ${e}`);
    assert.ok(e.includes('THROW'), `Expected THROW, got: ${e}`);
    assert.ok(!e.includes('ASYNC'), `Expected no ASYNC on sync call, got: ${e}`);
  });

  it('glob is the async filesystem walk (IO:FILE:READ, ASYNC, THROW)', () => {
    const e = get('glob');
    assert.ok(e.includes('IO:FILE:READ'), `Expected IO:FILE:READ, got: ${e}`);
    assert.ok(e.includes('ASYNC'), `Expected ASYNC, got: ${e}`);
    assert.ok(e.includes('THROW'), `Expected THROW, got: ${e}`);
  });

  it('sync alias has the same effects as globSync', () => {
    assert.deepEqual(get('sync'), get('globSync'));
  });

  it('stream/iterate aliases match their glob-prefixed originals', () => {
    assert.deepEqual(get('stream'), get('globStream'));
    assert.deepEqual(get('streamSync'), get('globStreamSync'));
    assert.deepEqual(get('iterate'), get('globIterate'));
    assert.deepEqual(get('iterateSync'), get('globIterateSync'));
  });

  it('globStreamSync reads the filesystem (IO:FILE:READ, no ASYNC)', () => {
    const e = get('globStreamSync');
    assert.ok(e.includes('IO:FILE:READ'), `Expected IO:FILE:READ, got: ${e}`);
    assert.ok(!e.includes('ASYNC'), `Expected no ASYNC, got: ${e}`);
  });

  it('escape and unescape are pure string transforms', () => {
    assert.deepEqual(get('escape'), ['PURE']);
    assert.deepEqual(get('unescape'), ['PURE']);
  });

  it('hasMagic is deterministic pattern inspection that may throw (THROW, no IO)', () => {
    const e = get('hasMagic');
    assert.ok(e.includes('THROW'), `Expected THROW, got: ${e}`);
    assert.ok(!e.some((x) => x.startsWith('IO')), `Expected no IO, got: ${e}`);
  });

  it('Glob constructor is lazy — validates but does not walk the FS (THROW, no IO)', () => {
    const e = get('Glob.new');
    assert.ok(e.includes('THROW'), `Expected THROW, got: ${e}`);
    assert.ok(!e.some((x) => x.startsWith('IO')), `Expected no IO on lazy ctor, got: ${e}`);
  });

  it('Glob.walk performs the async filesystem walk (IO:FILE:READ, ASYNC)', () => {
    const e = get('Glob.walk');
    assert.ok(e.includes('IO:FILE:READ'), `Expected IO:FILE:READ, got: ${e}`);
    assert.ok(e.includes('ASYNC'), `Expected ASYNC, got: ${e}`);
  });

  it('Glob.walkSync performs the sync filesystem walk (IO:FILE:READ, no ASYNC)', () => {
    const e = get('Glob.walkSync');
    assert.ok(e.includes('IO:FILE:READ'), `Expected IO:FILE:READ, got: ${e}`);
    assert.ok(!e.includes('ASYNC'), `Expected no ASYNC, got: ${e}`);
  });

  it('Glob.iterate is the async iterator over filesystem matches (IO:FILE:READ, ASYNC)', () => {
    const e = get('Glob.iterate');
    assert.ok(e.includes('IO:FILE:READ'), `Expected IO:FILE:READ, got: ${e}`);
    assert.ok(e.includes('ASYNC'), `Expected ASYNC, got: ${e}`);
  });

  it('Ignore.add mutates the matcher instance', () => {
    assert.ok(get('Ignore.add').includes('MUTATION'), 'Expected MUTATION on Ignore.add');
  });

  it('Ignore.ignored is a pure path matcher', () => {
    assert.deepEqual(get('Ignore.ignored'), ['PURE']);
  });
});
