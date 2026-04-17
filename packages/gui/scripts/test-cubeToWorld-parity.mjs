/**
 * Parity test: the shared `cubeToWorld` in src/geom/hex.mjs must produce
 * the *exact same* coordinates as a pinned reference implementation.
 *
 * Float32 tolerance 1e-6 sweeping q,r ∈ [-250, 250] step 17 (≈ 30×30
 * grid, includes negatives, and is independent of the production step).
 *
 * Runs under `node --test` so the whole GUI unit-test entry point
 * covers this too.
 *
 * Plus a single-source assertion: no other file in src/ may re-define
 * `cubeToWorld` — the shared module is the only home for the math.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { cubeToWorld } from '../src/geom/hex.mjs';

/**
 * Legacy reference — inlined verbatim from the current
 * `packages/gui/src/store/loadFixture.ts` implementation.  Must NOT
 * import the shared module; we want a separate source of truth so a
 * regression in the shared module is caught here rather than propagated
 * silently.
 */
function legacyCubeToWorld(q, r, size) {
  const x = size * (3 / 2) * q;
  const z = size * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
  return { x, z };
}

test('cubeToWorld parity sweep q,r ∈ [-250,250] step 17, size=3', () => {
  const SIZE = 3;
  const TOL = 1e-6;
  let count = 0;
  for (let q = -250; q <= 250; q += 17) {
    for (let r = -250; r <= 250; r += 17) {
      const a = cubeToWorld(q, r, SIZE);
      const b = legacyCubeToWorld(q, r, SIZE);
      if (Math.abs(a.x - b.x) > TOL || Math.abs(a.z - b.z) > TOL) {
        assert.fail(
          `First mismatch at q=${q}, r=${r}: ` +
          `shared={x:${a.x}, z:${a.z}} legacy={x:${b.x}, z:${b.z}}`,
        );
      }
      count++;
    }
  }
  assert.ok(count >= 900, `expected ~900 samples, got ${count}`);
});

test('cubeToWorld parity at edge sizes (1 and 16)', () => {
  const TOL = 1e-6;
  for (const size of [1, 16]) {
    for (const [q, r] of [[0, 0], [1, 0], [0, 1], [7, -5], [-3, 11]]) {
      const a = cubeToWorld(q, r, size);
      const b = legacyCubeToWorld(q, r, size);
      assert.ok(
        Math.abs(a.x - b.x) <= TOL && Math.abs(a.z - b.z) <= TOL,
        `size=${size} q=${q} r=${r}: shared={${a.x},${a.z}} legacy={${b.x},${b.z}}`,
      );
    }
  }
});

test('cubeToWorld single-source: only geom/hex.{ts,mjs,d.mts} defines the function', () => {
  // Scan src/ for any local re-definition of cubeToWorld. Re-exports
  // via `export { cubeToWorld } from '…'` are OK (they reference the
  // shared module). Scanned forms: `function cubeToWorld(` and
  // `const cubeToWorld = (…) =>` / `export function cubeToWorld(`.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const srcRoot = path.resolve(__dirname, '..', 'src');

  /** @type {string[]} */
  const offenders = [];

  /** @param {string} dir */
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mjs|mts|js|jsx)$/.test(entry)) continue;
      const rel = path.relative(srcRoot, full).split(path.sep).join('/');
      const text = readFileSync(full, 'utf8');

      // Whitelist: the canonical home for the math.
      if (rel === 'geom/hex.mjs' || rel === 'geom/hex.ts' || rel === 'geom/hex.d.mts') continue;

      // Function definition — rules out `import`, re-export, call-site.
      const funcDef = /(?:^|\n)\s*(?:export\s+)?function\s+cubeToWorld\s*\(/;
      const constDef = /(?:^|\n)\s*(?:export\s+)?const\s+cubeToWorld\s*=/;
      if (funcDef.test(text) || constDef.test(text)) {
        offenders.push(rel);
      }
    }
  }
  walk(srcRoot);

  assert.deepEqual(
    offenders,
    [],
    `cubeToWorld must only be defined in geom/hex.*. Found re-definition in: ${offenders.join(', ')}`,
  );
});
