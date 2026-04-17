import { create } from 'zustand';

/**
 * SSR-safe initial viewport.
 *
 * `window` is undefined in Node / SSR. Previously this module read
 * `window.innerWidth` at import time, throwing ReferenceError when
 * bundled into an SSR path or loaded into a test harness before any
 * window stub was installed. The fallback size matches a typical
 * desktop viewport — it is overwritten by `setViewport(...)` as soon
 * as the real browser window reports its size.
 */
const initialViewport =
  typeof window === 'undefined'
    ? { width: 1280, height: 720 }
    : { width: window.innerWidth, height: window.innerHeight };

export interface MapState {
  /** Current camera distance to target (perspective/3D only) */
  cameraDistance: number;
  /** Computed LOD level: 0=package, 1=directory, 2=file, 3=function */
  lodLevel: number;
  /** Camera target position */
  target: { x: number; z: number };
  /** Viewport size */
  viewport: { width: number; height: number };
  /**
   * Orthographic zoom factor (2D only). 1.0 = default; higher =
   * zoomed in. Updated by SceneManager on ortho-mode camera changes.
   * Stays at 1.0 in 3D mode (Sidebar reads it only when mode is 2D).
   */
  zoom: number;

  setCameraDistance: (d: number) => void;
  setLodLevel: (l: number) => void;
  setTarget: (x: number, z: number) => void;
  setViewport: (w: number, h: number) => void;
  setZoom: (z: number) => void;
}

export const useMapStore = create<MapState>((set) => ({
  cameraDistance: 300,
  lodLevel: 0,
  target: { x: 0, z: 0 },
  viewport: initialViewport,
  zoom: 1,

  setCameraDistance: (d) => set({ cameraDistance: d }),
  setLodLevel: (l) => set({ lodLevel: l }),
  setTarget: (x, z) => set({ target: { x, z } }),
  setViewport: (w, h) => set({ viewport: { width: w, height: h } }),
  setZoom: (z) => set({ zoom: z }),
}));
