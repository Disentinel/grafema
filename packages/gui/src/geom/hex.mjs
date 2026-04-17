// Shared hex-grid geometry helpers.
//
// Kept as plain ESM JS (`.mjs`) so the same source can be consumed by:
//   - the TypeScript browser bundle (via src/geom/hex.ts re-export)
//   - the Node.js dev server (packages/gui/server.js) — no transpile needed
//   - stand-alone parity scripts (scripts/test-cubeToWorld-parity.mjs)
//
// The math matches sandbox/hex-sandbox/src/hex.js (flat-top axial).
// `cubeToWorld` is structurally identical to `axialToPixel` — same
// coefficients, renamed axis for the 3-D world convention where Y is up
// and the hex-plane uses X / Z.

/**
 * @typedef {{ q: number, r: number }} HexCoord
 */

/**
 * Six neighbour offsets in axial coords. Clockwise from east.
 * Order matches sandbox/hex-sandbox/src/hex.js exactly — consumers
 * (e.g. hull.ts) rely on this ordering for their `EDGE_TO_DIR` table.
 * @type {ReadonlyArray<{ q: number, r: number }>}
 */
export const HEX_DIRS = [
  { q: 1, r: 0 },   // E
  { q: 1, r: -1 },  // NE
  { q: 0, r: -1 },  // NW
  { q: -1, r: 0 },  // W
  { q: -1, r: 1 },  // SW
  { q: 0, r: 1 },   // SE
];

/**
 * Stable string key for a coord. Cheap hash-map access.
 * @param {number} q
 * @param {number} r
 * @returns {string}
 */
export function hexKey(q, r) {
  return `${q},${r}`;
}

/**
 * Axial → world (x, z). Flat-top hex.
 * Matches legacy `cubeToWorld` from src/store/loadFixture.ts (algebraically
 * identical: size*(3/2)*q for x, size*(sqrt(3)/2*q + sqrt(3)*r) for z,
 * which factors to size*sqrt(3)*(r + q/2)).
 *
 * @param {number} q
 * @param {number} r
 * @param {number} size  hex radius (centre → corner)
 * @returns {{ x: number, z: number }}
 */
export function cubeToWorld(q, r, size) {
  const x = size * 1.5 * q;
  const z = size * Math.sqrt(3) * (r + q / 2);
  return { x, z };
}

/**
 * Axial → pixel (x, y). Flat-top hex.
 * Same math as `cubeToWorld`, exposed for 2-D (canvas / hull) callers.
 *
 * @param {HexCoord} hex
 * @param {number} size  hex radius
 * @returns {{ x: number, y: number }}
 */
export function axialToPixel(hex, size) {
  const x = size * 1.5 * hex.q;
  const y = size * Math.sqrt(3) * (hex.r + hex.q / 2);
  return { x, y };
}
