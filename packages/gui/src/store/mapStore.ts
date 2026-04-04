import { create } from 'zustand';

export interface MapState {
  /** Current camera distance to target */
  cameraDistance: number;
  /** Computed LOD level: 0=package, 1=directory, 2=file, 3=function */
  lodLevel: number;
  /** Camera target position */
  target: { x: number; z: number };
  /** Viewport size */
  viewport: { width: number; height: number };

  setCameraDistance: (d: number) => void;
  setLodLevel: (l: number) => void;
  setTarget: (x: number, z: number) => void;
  setViewport: (w: number, h: number) => void;
}

export const useMapStore = create<MapState>((set) => ({
  cameraDistance: 300,
  lodLevel: 0,
  target: { x: 0, z: 0 },
  viewport: { width: window.innerWidth, height: window.innerHeight },

  setCameraDistance: (d) => set({ cameraDistance: d }),
  setLodLevel: (l) => set({ lodLevel: l }),
  setTarget: (x, z) => set({ target: { x, z } }),
  setViewport: (w, h) => set({ viewport: { width: w, height: h } }),
}));
