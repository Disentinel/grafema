/**
 * Shared Three.js-level type definitions.
 *
 * Kept outside `controller/` so both the renderer-agnostic SceneApi
 * interface and the concrete SceneManager can depend on the same
 * `SceneMode` shape without a circular dependency.
 *
 * `SceneMode` is version-discriminated to keep future fields additive
 * without silent drift across bundled code and persisted state. Bumping
 * `version` is a breaking change; add fields with safe defaults at the
 * same time as consumers learn to read them.
 */

export interface SceneMode {
  version: 1;
  kind: '2d' | '3d';

  // Camera
  /** Perspective 3D, orthographic 2D. */
  projection: 'perspective' | 'orthographic';
  /** World-space "up" axis. 3D: (0,1,0). Top-down 2D: (0,0,-1). */
  cameraUp: [number, number, number];
  /** Orthographic half-extent in world units. Ignored for perspective. */
  frustumSize: number;

  // Tiles
  /** `'on'` uses elevation metrics; `'flat'` forces all tiles to y=0. */
  tileElevation: 'on' | 'flat';
  /** Extra Y offset applied to the hovered tile (0 when flat). */
  hoverLift: number;

  // Edges (flows)
  /** Tube geometry in 3D; thin Line2 in 2D. */
  flowStyle: 'tube' | 'line';
  /** Maximum number of flow edges rendered simultaneously. */
  flowDensityCap: number;

  // Overlays
  /** Hulls drawn as Line2 overlays in both modes (or hidden). */
  hullStyle: 'line' | 'hidden';
  /** Which label tiers remain visible when zoomed out. */
  labelTier: 'package+region+file' | 'package+region';

  // Lighting / background
  /** Hex RGB. Darker in 3D, brighter in 2D. */
  background: number;
  /** `true` disables directional lights and shadows (2D default). */
  ambientOnly: boolean;
  /** Linear distance fog for depth cueing, or off. */
  fog: 'linear' | 'off';
}

/**
 * Baseline 3D mode used by SceneManager until the ModeToggle ships. Values
 * chosen to match the pre-refactor look: dark background, perspective
 * camera, tube flows, elevated tiles with a small hover pop.
 */
export const DEFAULT_3D_MODE: SceneMode = {
  version: 1,
  kind: '3d',
  projection: 'perspective',
  cameraUp: [0, 1, 0],
  frustumSize: 200,
  tileElevation: 'on',
  hoverLift: 0.4,
  flowStyle: 'tube',
  flowDensityCap: 20000,
  hullStyle: 'line',
  labelTier: 'package+region+file',
  background: 0x0a0a12,
  ambientOnly: false,
  fog: 'linear',
};

/**
 * Baseline 2D mode — top-down orthographic, flat tiles, thin lines.
 * Keeps hulls and two label tiers (package + region) for legibility at
 * low zoom; fog is disabled because distance no longer carries meaning.
 */
export const DEFAULT_2D_MODE: SceneMode = {
  version: 1,
  kind: '2d',
  projection: 'orthographic',
  cameraUp: [0, 0, -1],
  frustumSize: 200,
  tileElevation: 'flat',
  hoverLift: 0,
  flowStyle: 'line',
  flowDensityCap: 200,
  hullStyle: 'line',
  labelTier: 'package+region',
  background: 0xf4f4f4,
  ambientOnly: true,
  fog: 'off',
};

/**
 * Structural equality for SceneMode — walks every primitive field and the
 * cameraUp tuple. Small enough to inline without a deep-equal dependency;
 * additive changes to SceneMode require a matching field here, which is
 * intentional (forces both to stay in sync).
 *
 * Consolidated here (DAI-13) so SceneManager and viewStore share the same
 * idempotent-guard implementation — two copies drifted apart historically
 * and caused subtle mode-thrash bugs.
 */
export function sceneModesEqual(a: SceneMode, b: SceneMode): boolean {
  if (a.version !== b.version) return false;
  if (a.kind !== b.kind) return false;
  if (a.projection !== b.projection) return false;
  if (a.frustumSize !== b.frustumSize) return false;
  if (a.tileElevation !== b.tileElevation) return false;
  if (a.hoverLift !== b.hoverLift) return false;
  if (a.flowStyle !== b.flowStyle) return false;
  if (a.flowDensityCap !== b.flowDensityCap) return false;
  if (a.hullStyle !== b.hullStyle) return false;
  if (a.labelTier !== b.labelTier) return false;
  if (a.background !== b.background) return false;
  if (a.ambientOnly !== b.ambientOnly) return false;
  if (a.fog !== b.fog) return false;
  if (a.cameraUp.length !== b.cameraUp.length) return false;
  for (let i = 0; i < a.cameraUp.length; i++) {
    if (a.cameraUp[i] !== b.cameraUp[i]) return false;
  }
  return true;
}
