/**
 * Tests for shared hex geometry helpers (REG-XXX C6).
 *
 * The helpers live in `src/geom/hex.mjs` (plain ESM JS so they can be
 * `import`ed by both the browser TS bundle and the Node dev server) and
 * are re-exported with TypeScript types from `src/geom/hex.ts`.
 *
 * We only import the `.ts` wrapper here — that's the public surface
 * everything TS-side should use.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEX_DIRS,
  hexKey,
  cubeToWorld,
  axialToPixel,
} from '../../../src/geom/hex.js';

describe('hex: HEX_DIRS', () => {
  it('has exactly 6 directions', () => {
    assert.equal(HEX_DIRS.length, 6);
  });

  it('each direction has integer q and r offsets with |q|+|r| >= 1', () => {
    for (const d of HEX_DIRS) {
      assert.equal(typeof d.q, 'number');
      assert.equal(typeof d.r, 'number');
      assert.ok(Number.isInteger(d.q), `q is int: ${d.q}`);
      assert.ok(Number.isInteger(d.r), `r is int: ${d.r}`);
      assert.ok(Math.abs(d.q) + Math.abs(d.r) >= 1, 'non-zero direction');
    }
  });

  it('opposite pairs sum to {q:0, r:0} — [0]↔[3], [1]↔[4], [2]↔[5]', () => {
    for (let i = 0; i < 3; i++) {
      const a = HEX_DIRS[i];
      const b = HEX_DIRS[i + 3];
      assert.equal(a.q + b.q, 0, `pair ${i}: q sum`);
      assert.equal(a.r + b.r, 0, `pair ${i}: r sum`);
    }
  });

  it('matches sandbox hex.js direction order exactly (E, NE, NW, W, SW, SE)', () => {
    // Freeze: E=+q, NE=+q-r, NW=-r, W=-q, SW=-q+r, SE=+r
    assert.deepEqual(HEX_DIRS[0], { q: 1, r: 0 });
    assert.deepEqual(HEX_DIRS[1], { q: 1, r: -1 });
    assert.deepEqual(HEX_DIRS[2], { q: 0, r: -1 });
    assert.deepEqual(HEX_DIRS[3], { q: -1, r: 0 });
    assert.deepEqual(HEX_DIRS[4], { q: -1, r: 1 });
    assert.deepEqual(HEX_DIRS[5], { q: 0, r: 1 });
  });
});

describe('hex: hexKey', () => {
  it('produces "q,r" form', () => {
    assert.equal(hexKey(1, 2), '1,2');
    assert.equal(hexKey(0, 0), '0,0');
    assert.equal(hexKey(-3, 4), '-3,4');
  });

  it('different coords → different keys', () => {
    assert.notEqual(hexKey(1, 2), hexKey(2, 1));
    assert.notEqual(hexKey(0, 0), hexKey(0, 1));
  });
});

describe('hex: cubeToWorld', () => {
  it('origin (0,0) is at world origin', () => {
    const { x, z } = cubeToWorld(0, 0, 3);
    assert.equal(x, 0);
    assert.equal(z, 0);
  });

  it('matches reference math exactly: x = size*1.5*q, z = size*sqrt(3)*(r + q/2)', () => {
    const size = 3;
    const cases: Array<[number, number]> = [
      [1, 0], [0, 1], [1, 1], [2, -1], [-1, 2], [5, -3],
    ];
    for (const [q, r] of cases) {
      const { x, z } = cubeToWorld(q, r, size);
      const expectedX = size * 1.5 * q;
      const expectedZ = size * Math.sqrt(3) * (r + q / 2);
      assert.ok(Math.abs(x - expectedX) < 1e-9, `x for (${q},${r})`);
      assert.ok(Math.abs(z - expectedZ) < 1e-9, `z for (${q},${r})`);
    }
  });

  it('monotonic in q: stepping q by +1 adds size*1.5 to x (and constant r-dependent z step)', () => {
    const size = 3;
    const a = cubeToWorld(0, 0, size);
    const b = cubeToWorld(1, 0, size);
    assert.ok(Math.abs((b.x - a.x) - size * 1.5) < 1e-9);
  });

  it('monotonic in r: stepping r by +1 adds size*sqrt(3) to z, no change to x', () => {
    const size = 3;
    const a = cubeToWorld(2, 0, size);
    const b = cubeToWorld(2, 1, size);
    assert.equal(b.x, a.x);
    assert.ok(Math.abs((b.z - a.z) - size * Math.sqrt(3)) < 1e-9);
  });

  it('scales linearly with size', () => {
    const a = cubeToWorld(3, 2, 1);
    const b = cubeToWorld(3, 2, 4);
    assert.ok(Math.abs(b.x - a.x * 4) < 1e-9);
    assert.ok(Math.abs(b.z - a.z * 4) < 1e-9);
  });
});

describe('hex: axialToPixel', () => {
  it('origin (0,0) is at pixel origin', () => {
    const { x, y } = axialToPixel({ q: 0, r: 0 }, 3);
    assert.equal(x, 0);
    assert.equal(y, 0);
  });

  it('matches sandbox hex.js math exactly: x = size*1.5*q, y = size*sqrt(3)*(r + q/2)', () => {
    const size = 4;
    const cases: Array<[number, number]> = [
      [1, 0], [0, 1], [2, 3], [-2, 5],
    ];
    for (const [q, r] of cases) {
      const { x, y } = axialToPixel({ q, r }, size);
      assert.ok(Math.abs(x - size * 1.5 * q) < 1e-9, `x for (${q},${r})`);
      assert.ok(Math.abs(y - size * Math.sqrt(3) * (r + q / 2)) < 1e-9, `y for (${q},${r})`);
    }
  });

  it('parity with cubeToWorld: axialToPixel({q,r}).x = cubeToWorld(q,r).x and .y = .z', () => {
    const size = 3;
    for (const [q, r] of [[1, 2], [-3, 4], [7, -5]] as const) {
      const p = axialToPixel({ q, r }, size);
      const w = cubeToWorld(q, r, size);
      assert.ok(Math.abs(p.x - w.x) < 1e-9);
      assert.ok(Math.abs(p.y - w.z) < 1e-9);
    }
  });
});
