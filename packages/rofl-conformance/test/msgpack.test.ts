// msgpack round-trip tests incl. i64 edges and nested structures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, type MpValue } from '../src/msgpack.ts';

function rt(v: MpValue): MpValue {
  return decode(encode(v));
}

test('scalars round-trip', () => {
  for (const v of [null, true, false, 0, 1, 127, 128, 255, 256, 65535, 65536, -1, -31, -32, -33, -128, -129, -32768, -2147483648, 3.14, -2.5]) {
    assert.deepEqual(rt(v), v, String(v));
  }
});

test('safe-integer edges round-trip', () => {
  for (const v of [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 2 ** 32, 2 ** 40, -(2 ** 40)]) {
    assert.equal(rt(v), v);
  }
});

test('strings round-trip incl. fixstr/str8/str16 boundaries and unicode', () => {
  for (const v of ['', 'a', 'x'.repeat(31), 'x'.repeat(32), 'x'.repeat(255), 'x'.repeat(256), 'x'.repeat(70000), 'приветπ🎯']) {
    assert.equal(rt(v), v);
  }
});

test('arrays and maps round-trip incl. fix boundaries and nesting', () => {
  const arr15 = Array.from({ length: 15 }, (_, i) => i);
  const arr16 = Array.from({ length: 16 }, (_, i) => i);
  assert.deepEqual(rt(arr15), arr15);
  assert.deepEqual(rt(arr16), arr16);
  const map: MpValue = { cmd: 'executeDatalog', source: 'p("a").', explain: false, nested: { a: [1, 'two', null, { deep: true }] } };
  assert.deepEqual(rt(map), map);
  const big: { [k: string]: MpValue } = {};
  for (let i = 0; i < 20; i++) big[`k${i}`] = i;
  assert.deepEqual(rt(big), big);
});

test('bin round-trips as Uint8Array', () => {
  const b = new Uint8Array([0, 1, 2, 255]);
  assert.deepEqual(rt(b), b);
});

test('decode rejects trailing bytes', () => {
  const buf = new Uint8Array([...encode('x'), 0x01]);
  assert.throws(() => decode(buf), /trailing/);
});

test('decode rejects u64 beyond safe range', () => {
  // 0xcf + 2^63 (9223372036854775808)
  const buf = new Uint8Array([0xcf, 0x80, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => decode(buf), /safe range/);
});
