import { create } from 'zustand';

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
  region: string;
  /** World position on hex grid */
  x: number;
  z: number;
  /** Degree (total edge count) */
  degree: number;
  /** Metrics for lenses */
  metrics?: Record<string, number>;
  /**
   * The visibility-lifted index the server emitted for this node (the
   * `i` field on `node` frames). Edges from /api/edges and the bootstrap
   * stream are keyed against this same index space, so lazy edge fetches
   * can map server `s`/`d` back to client `nodes[]` positions.
   */
  serverIdx: number;
}

export interface GraphEdge {
  source: number;
  target: number;
  type: string;
}

export interface Region {
  path: string;
  depth: number;
  tileCount: number;
  border: [number, number][];
  centroid: { x: number; z: number };
}

/**
 * Progress snapshot for the streaming UI.
 *
 * `phase`:
 *   - `idle` — no fetch in flight (initial state and after `done`).
 *   - `connecting` — fetch issued, no totals frame yet.
 *   - `streaming` — totals received, frames flowing.
 *   - `done` — final `done` frame parsed.
 *
 * Counts are 0 in `idle`/`connecting` and held at the final values in
 * `done` so progress UIs can read either while-streaming or post-done
 * stats from the same shape.
 */
export interface LoadProgress {
  phase: 'idle' | 'connecting' | 'streaming' | 'done';
  nodesLoaded: number;
  nodesTotal: number;
  edgesLoaded: number;
  edgesTotal: number;
}

export interface DataState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  regions: Region[];
  typeTable: string[];
  edgeTypeTable: string[];
  loaded: boolean;
  loading: boolean;
  progress: LoadProgress;

  setGraphData: (data: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    regions: Region[];
    typeTable: string[];
    edgeTypeTable: string[];
  }) => void;
  setLoading: (v: boolean) => void;
  setProgress: (next: Partial<LoadProgress>) => void;
}

const INITIAL_PROGRESS: LoadProgress = {
  phase: 'idle',
  nodesLoaded: 0,
  nodesTotal: 0,
  edgesLoaded: 0,
  edgesTotal: 0,
};

export const useDataStore = create<DataState>((set) => ({
  nodes: [],
  edges: [],
  regions: [],
  typeTable: [],
  edgeTypeTable: [],
  loaded: false,
  loading: false,
  progress: { ...INITIAL_PROGRESS },

  setGraphData: (data) => set((s) => ({
    ...data,
    loaded: true,
    loading: false,
    // Hold the final counts in `progress`; flip phase to `done` so the
    // UI can switch from a progress bar to a static "X loaded" line
    // without losing the denominators.
    progress: { ...s.progress, phase: 'done' },
  })),
  setLoading: (v) => set({ loading: v }),
  setProgress: (next) => set((s) => ({ progress: { ...s.progress, ...next } })),
}));
