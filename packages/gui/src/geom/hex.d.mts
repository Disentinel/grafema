/**
 * Type declarations for `./hex.mjs`. Co-located so TypeScript can resolve
 * the `.mjs` runtime module with full types under `moduleResolution: bundler`.
 */
export interface HexCoord {
  q: number;
  r: number;
}

export const HEX_DIRS: ReadonlyArray<HexCoord>;

export function hexKey(q: number, r: number): string;

export function cubeToWorld(
  q: number,
  r: number,
  size: number,
): { x: number; z: number };

export function axialToPixel(
  hex: HexCoord,
  size: number,
): { x: number; y: number };
