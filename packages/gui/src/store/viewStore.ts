import { create } from 'zustand';
import { DEFAULT_3D_MODE, sceneModesEqual, type SceneMode } from '../three/types';

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
  /**
   * Current scene mode (3D/perspective vs 2D/orthographic).
   *
   * Mirrors SceneManager's source of truth so React components can
   * drive conditional rendering (e.g., Sidebar's distance vs zoom
   * readout) without reaching into the Three.js layer.
   */
  mode: SceneMode;

  setLens: (name: string) => void;
  toggleFlow: (name: string) => void;
  setHoveredTile: (idx: number) => void;
  addPin: (id: string, color: string, label: string) => void;
  removePin: (id: string) => void;
  setSelection: (indices: Set<number>) => void;
  clearSelection: () => void;
  /**
   * Swap the current SceneMode.
   *
   * Idempotent: if `next` is deep-equal to the current mode, the call
   * is a complete no-op (no Zustand notification). This matches the
   * short-circuit contract in SceneManager.setMode — both layers must
   * agree on equality so wiring identical modes through viewStore
   * does not thrash subscribers.
   */
  setMode: (mode: SceneMode) => void;
}

export const useViewStore = create<ViewState>((set, get) => ({
  lens: 'default',
  enabledFlows: new Set(['bridges']),
  hoveredTile: -1,
  pins: new Map(),
  selection: new Set(),
  mode: DEFAULT_3D_MODE,

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
  setMode: (mode) => {
    if (sceneModesEqual(get().mode, mode)) return;
    set({ mode });
  },
}));

/**
 * Derive the active selection index (mirrors Canvas.tsx's legacy
 * `selectedIdx: number`). Returns:
 *   - null when the selection Set is empty
 *   - the first iteration element (insertion order) when non-empty
 *
 * Selectors do not trigger re-renders on their own; pair with
 * `useViewStore(selectSelectedIdx)` at call sites. Kept as a plain
 * function (not a hook) so unit tests and non-React call sites can
 * read the same value.
 */
export function selectSelectedIdx(state: Pick<ViewState, 'selection'>): number | null {
  const it = state.selection.values().next();
  return it.done ? null : it.value;
}
