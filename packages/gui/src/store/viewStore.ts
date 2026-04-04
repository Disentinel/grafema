import { create } from 'zustand';

export interface ViewState {
  /** Active lens name */
  lens: string;
  /** Enabled flow presets */
  enabledFlows: Set<string>;
  /** Hovered tile index (-1 = none) */
  hoveredTile: number;
  /** Pinned node ids */
  pins: Map<string, { color: string; label: string }>;
  /** Active selection (node indices) */
  selection: Set<number>;

  setLens: (name: string) => void;
  toggleFlow: (name: string) => void;
  setHoveredTile: (idx: number) => void;
  addPin: (id: string, color: string, label: string) => void;
  removePin: (id: string) => void;
  setSelection: (indices: Set<number>) => void;
  clearSelection: () => void;
}

export const useViewStore = create<ViewState>((set) => ({
  lens: 'default',
  enabledFlows: new Set(['bridges']),
  hoveredTile: -1,
  pins: new Map(),
  selection: new Set(),

  setLens: (name) => set({ lens: name }),
  toggleFlow: (name) =>
    set((s) => {
      const next = new Set(s.enabledFlows);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { enabledFlows: next };
    }),
  setHoveredTile: (idx) => set({ hoveredTile: idx }),
  addPin: (id, color, label) =>
    set((s) => {
      const next = new Map(s.pins);
      next.set(id, { color, label });
      return { pins: next };
    }),
  removePin: (id) =>
    set((s) => {
      const next = new Map(s.pins);
      next.delete(id);
      return { pins: next };
    }),
  setSelection: (indices) => set({ selection: indices }),
  clearSelection: () => set({ selection: new Set() }),
}));
