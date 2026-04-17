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

export interface DataState {
  nodes: GraphNode[];
  edges: GraphEdge[];
  regions: Region[];
  typeTable: string[];
  edgeTypeTable: string[];
  loaded: boolean;
  loading: boolean;

  setGraphData: (data: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    regions: Region[];
    typeTable: string[];
    edgeTypeTable: string[];
  }) => void;
  setLoading: (v: boolean) => void;
}

export const useDataStore = create<DataState>((set) => ({
  nodes: [],
  edges: [],
  regions: [],
  typeTable: [],
  edgeTypeTable: [],
  loaded: false,
  loading: false,

  setGraphData: (data) => set({ ...data, loaded: true, loading: false }),
  setLoading: (v) => set({ loading: v }),
}));
