// Axial hex coordinates. Flat-top convention.
// Neighbours: +q = right, +r = down-right, +s = up-right (where s = -q-r).

/** @typedef {{ q: number, r: number }} HexCoord */

/** Six neighbour offsets in axial coords. Clockwise from east. */
export const HEX_DIRS = /** @type {const} */ ([
  { q: 1,  r: 0  },  // E
  { q: 1,  r: -1 },  // NE
  { q: 0,  r: -1 },  // NW
  { q: -1, r: 0  },  // W
  { q: -1, r: 1  },  // SW
  { q: 0,  r: 1  },  // SE
]);

/**
 * Stable string key for a coord. Cheap hash-map access.
 * @param {number} q
 * @param {number} r
 */
export function hexKey(q, r) {
  return `${q},${r}`;
}

/**
 * Cube-distance between two axial hexes.
 * @param {HexCoord} a
 * @param {HexCoord} b
 */
export function hexDistance(a, b) {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  const ds = dq + dr;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
}

/**
 * Axial → pixel. Flat-top hex.
 * @param {HexCoord} c
 * @param {number} size  hex radius (centre to corner)
 */
export function axialToPixel(c, size) {
  const x = size * 1.5 * c.q;
  const y = size * Math.sqrt(3) * (c.r + c.q / 2);
  return { x, y };
}

/**
 * Pixel → axial, rounded to nearest hex.
 * @param {number} x
 * @param {number} y
 * @param {number} size
 */
export function pixelToAxial(x, y, size) {
  const q = (2 / 3) * x / size;
  const r = (-1 / 3 * x + Math.sqrt(3) / 3 * y) / size;
  return axialRound(q, r);
}

/** Round fractional axial to the nearest integer hex (cube rounding). */
function axialRound(qf, rf) {
  const sf = -qf - rf;
  let rq = Math.round(qf);
  let rr = Math.round(rf);
  let rs = Math.round(sf);
  const dq = Math.abs(rq - qf);
  const dr = Math.abs(rr - rf);
  const ds = Math.abs(rs - sf);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds)       rr = -rq - rs;
  return { q: rq, r: rr };
}

/** Iterate the 6 neighbours of a coord. */
export function* neighbourCoords(c) {
  for (const d of HEX_DIRS) yield { q: c.q + d.q, r: c.r + d.r };
}
