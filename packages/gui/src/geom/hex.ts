/**
 * TypeScript surface for shared hex-grid geometry helpers.
 *
 * All runtime logic lives in `./hex.mjs` (plain ESM JS so the Node dev
 * server can consume it without transpilation). Types come from the
 * co-located `./hex.d.mts` — no duplication of math here.
 */
export type { HexCoord } from './hex.mjs';
export {
  HEX_DIRS,
  hexKey,
  cubeToWorld,
  axialToPixel,
} from './hex.mjs';
