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
  /**
   * Heightmap multiplier — per-tile elevation = sqrt(node.degree) * multiplier.
   * sqrt compresses the power-law degree distribution so a few high-degree
   * hubs don't dwarf everything else. 0 = flat map (heightmap off).
   */
  heightMultiplier: number;

  setLens: (name: string) => void;
  toggleFlow: (name: string) => void;
  /** Replace the enabled-flows set wholesale (for "Show all" / "Hide all"
   *  buttons in FlowPanel). Pass an empty Set to hide every flow. */
  setEnabledFlows: (next: Set<string>) => void;
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
  setHeightMultiplier: (mult: number) => void;
}

export const useViewStore = create<ViewState>((set, get) => ({
  lens: 'default',
  enabledFlows: new Set(['data', 'calls', 'deps', 'bridges']),
  hoveredTile: -1,
  pins: new Map(),
  selection: new Set(),
  mode: DEFAULT_3D_MODE,
  heightMultiplier: 1.5,

  setLens: (name) => set({ lens: name }),
  toggleFlow: (name) =>
    set((s) => {
      const next = new Set(s.enabledFlows);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { enabledFlows: next };
    }),
  setEnabledFlows: (next) => set({ enabledFlows: new Set(next) }),
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
  setHeightMultiplier: (mult) => {
    const clamped = Math.max(0, Math.min(10, mult));
    if (get().heightMultiplier === clamped) return;
    set({ heightMultiplier: clamped });
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
