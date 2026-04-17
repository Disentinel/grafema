/**
 * Shared string → color helpers.
 *
 * HullLayer, lenses.ts, RegionLayer, and any future layer that colors
 * things by a stable identifier (region path, type name, file path)
 * all need the same 32-bit rolling hash → 0..360° hue mapping. Keeping
 * one copy prevents drift — changing the hash here recolors every
 * consumer consistently.
 */

/**
 * Stable 32-bit rolling string hash folded into 0..360°.
 *
 * Deterministic across runs and platforms (no Math.random, no locale).
 * Collisions are OK — we only need the mapping to be *stable*, not
 * injective.
 */
export function hueFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}
