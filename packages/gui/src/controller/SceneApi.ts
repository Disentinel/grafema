/**
 * SceneApi — the renderer-agnostic imperative surface that panels and the
 * MapController call when they need to push state into the active scene.
 *
 * Why an interface and not a class?
 *  - The concrete implementation lives inside Canvas.tsx (closes over
 *    SceneManager + all Three.js Layer instances) and is exposed via
 *    React context. Tests and non-Three.js callers (headless, storybook)
 *    can implement this interface with stubs.
 *  - Adding a method is a deliberate plan-level decision (see
 *    `_tasks/REG-1100/004-plan-revised.md` §1). No "extended as needed".
 *
 * The interface enumerates only operations that cross the imperative
 * boundary (non-Zustand state, non-React render). Anything reflecting
 * Zustand state (selection, lens, pins...) must continue to flow through
 * the stores; SceneApi is for commands the render loop must observe
 * directly (camera moves, scene mode swap, flow recolor, ...).
 */

import type * as THREE from 'three';
import type { SceneMode } from '../three/types';
import type { CameraView } from './lod';

export interface SceneApi {
  // --- Mode ---------------------------------------------------------------
  /** Swap camera / lighting / layer params to the given mode. Idempotent. */
  setMode(mode: SceneMode): void;
  /** Current mode (identity-stable between setMode calls). */
  getMode(): SceneMode;
  /** Camera-kind-aware view; feeds LOD math in `lodFromView`. */
  getView(): CameraView;
  /** Project a world-space point onto viewport NDC through the active
   *  camera. `out.x/y` are in [-1, 1]; `out.z` is the normalized depth
   *  (> 1 or < -1 means behind/past clip planes — caller should skip).
   *  Used by the toponym overlay to position HTML labels at hull
   *  centroids per frame without reaching into SceneManager internals. */
  projectWorldToNdc(wx: number, wy: number, wz: number): { x: number; y: number; z: number };
  /** Direct access to the live `THREE.Scene`. Used by overlay layers
   *  (ToponymsLayer) that need to add/remove their own `THREE.Object3D`
   *  group so the labels render in the same pipeline as the hex/hull
   *  meshes — i.e. they tilt with the camera in 3D mode and follow
   *  the same depth-buffer ordering. Tests stub this with a fresh
   *  empty Scene. */
  getScene(): THREE.Scene;

  // --- Camera -------------------------------------------------------------
  /** Animate camera to world (x, z); ms optional (default chosen by impl). */
  flyTo(x: number, z: number, ms?: number): void;
  /** Reframe camera to encompass the entire scene. */
  fitToScene(): void;

  // --- Sidebar / toolbar --------------------------------------------------
  setShowCoords(visible: boolean): void;

  // --- FlowPanel ----------------------------------------------------------
  setFlowVisible(name: string, visible: boolean): void;
  /** Recolor active flows; pass null to reset to preset defaults. */
  recolorFlowsByNodes(colorFn: ((nodeIdx: number) => number) | null): void;

  // --- LensPanel ----------------------------------------------------------
  applyLens(lensName: string): void;

  // --- RoutePanel ---------------------------------------------------------
  addRoute(id: string, nodeIndices: number[], color: number, label: string): void;
  removeRoute(id: string): void;
  setRouteVisible(id: string, visible: boolean): void;

  // --- PinPanel -----------------------------------------------------------
  pin(nodeIdx: number, color: number, label: string): void;
  unpin(nodeIdx: number): void;

  // --- DiffPanel ----------------------------------------------------------
  enterDiff(removed: Set<number>, changed: Map<number, unknown>): void;
  exitDiff(): void;

  // --- Live layout (replaces the former setHexLayerRef singleton) --------
  setTargetPositions(x: Float32Array, z: Float32Array): void;

  // --- Lifecycle ----------------------------------------------------------
  /** Dispose underlying Three.js resources. Idempotent. */
  dispose(): void;
}
