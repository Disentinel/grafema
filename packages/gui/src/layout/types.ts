/**
 * Unified data contract for the layout subsystem.
 *
 * `fetchLayout(opts, signal?)` returns a `LayoutResult` — its shape is
 * intentionally identical to `DataState.setGraphData`'s input so the
 * host can call `useDataStore.getState().setGraphData(await fetchLayout(...))`
 * with no reshaping.
 *
 * Transport primitives (parseFixture, parseStream) MUST NOT touch
 * `useDataStore`. Store writes are the host's responsibility.
 */

import type { GraphNode, GraphEdge, Region } from '../store/dataStore';

/** Input: what source to load from + options. */
export type LayoutSource =
  | { kind: 'fixture'; path: string }   // static JSON (legacy fixture)
  | { kind: 'stream'; url: string };    // NDJSON stream from rfdb-server

export interface LayoutOptions {
  source: LayoutSource;
  maxNodes?: number;
  packages?: string;
}

/** Output: exactly matches DataState.setGraphData input. */
export interface LayoutResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  regions: Region[];
  typeTable: string[];
  edgeTypeTable: string[];
}
