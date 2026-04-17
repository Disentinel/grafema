import { create } from 'zustand';

export interface NodeChange {
  field: string;
  from: number;
  to: number;
}

export interface DiffState {
  active: boolean;
  added: Set<number>;      // node indices
  removed: Set<number>;    // node indices (ghost tiles)
  changed: Map<number, NodeChange[]>;  // node index → changes

  enterDiff: (added: number[], removed: number[], changed: Map<number, NodeChange[]>) => void;
  exitDiff: () => void;
}

export const useDiffStore = create<DiffState>((set) => ({
  active: false,
  added: new Set(),
  removed: new Set(),
  changed: new Map(),

  enterDiff: (added, removed, changed) => set({
    active: true,
    added: new Set(added),
    removed: new Set(removed),
    changed,
  }),

  exitDiff: () => set({
    active: false,
    added: new Set(),
    removed: new Set(),
    changed: new Map(),
  }),
}));
