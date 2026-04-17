/**
 * Shared easing curves for camera fly animations, tile property tweens,
 * and any other time-normalized interpolation across the GUI.
 *
 * Kept in `three/` because every current caller (SceneManager.flyTo,
 * HexLayer animation) is a Three.js-adjacent module. The helper is
 * math-only — no Three imports — so nothing stops non-Three callers
 * from importing it later.
 */

/**
 * Quadratic ease-in-out on t ∈ [0, 1]. Symmetric, zero velocity at
 * both endpoints. Cheapest curve that avoids linear-tween feel.
 */
export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
