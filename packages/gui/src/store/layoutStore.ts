/**
 * layoutStore — client-side state for the DAI-22 per-symbol layout protocol.
 *
 * Holds two slices consumed by HexAtlas + the overflow badge:
 *   - `layoutMeta` — the `layout_meta` frame from /api/graph-stream. Drives
 *     the "Layout not computed" empty-layout overlay (source === "missing")
 *     and the red overflow badges per file (overflow_files[]).
 *   - `regionTree` — a flattened in-memory index over the nested regions
 *     tree emitted in the header frame. Provides O(1) id lookup, ancestor
 *     chain traversal, and a "region for this file" helper used to position
 *     the overflow badge.
 *
 * We intentionally keep this store small and independent of dataStore —
 * the layout frames are metadata about the graph, not the graph payload.
 * loadStream writes both slices; consumers (HexAtlas, OverflowBadge) read.
 *
 * See _tasks/DAI-22-tectonic-collision/004-plan-revised.md §B.3 + §A.7.
 */

import { create } from 'zustand';
import type { HullGeometry } from '../hulls/computeHulls.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single per-file overflow entry. Emitted by the server when the hard-cap
 * `--max-symbols-per-file` truncated the symbol set for that file during
 * layout commit.
 */
export interface OverflowFile {
  file: string;
  skipped: number;
  cap: number;
}

/**
 * layout_meta frame payload (header-adjacent). `source` indicates whether
 * the server found committed LAYOUT_POSITION edges; "missing" triggers the
 * empty-layout overlay.
 */
export interface LayoutMeta {
  source: 'missing' | 'committed';
  symbol_count: number;
  committed_at: string | null;
  overflow_files: OverflowFile[];
  /**
   * Display name of the workspace that owns this database (e.g. `"grafema"`,
   * `"my-project"`). Derived server-side from the db path's grandparent so
   * the GUI can render the correct root region label instead of the
   * meaningless `"/"` the layout pipeline emits for depth 0.
   *
   * `null` when the server can't derive a useful name (db at filesystem
   * root, anonymous temp dir, etc.) — consumers should fall back to hiding
   * the root label in that case.
   */
  workspace_name: string | null;
}

/**
 * Raw region node as emitted by the server — recursive.
 */
export interface RegionNodeRaw {
  id: string;
  depth: number;
  path: string;
  kind: string;
  name: string;
  children?: RegionNodeRaw[];
}

/**
 * Flattened region info stored in the index. `parentId` is null for roots.
 * `childIds` is kept for O(1) descent when needed.
 */
export interface RegionInfo {
  id: string;
  depth: number;
  path: string;
  kind: string;
  name: string;
  parentId: string | null;
  childIds: string[];
}

/**
 * O(1) lookup index built from a raw region tree.
 */
export interface RegionTree {
  roots: string[];
  byId: Map<string, RegionInfo>;
  /**
   * Files-to-region lookup — region whose `path` equals the file's path.
   * Built so OverflowBadge.positionFor(file) does not scan the map.
   * Region kind === "file" is preferred; falls back to path equality.
   */
  byFile: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Flatten raw tree into RegionTree index
// ---------------------------------------------------------------------------

/**
 * Build a flattened O(1)-lookup index from the nested regions array emitted
 * in the stream header.
 *
 * Duplicate ids are ignored (first write wins) with a console warning; the
 * server is authoritative so we fail soft rather than throw during a live
 * stream parse.
 */
export function buildRegionTree(rawRoots: RegionNodeRaw[]): RegionTree {
  const byId = new Map<string, RegionInfo>();
  const byFile = new Map<string, string>();
  const roots: string[] = [];

  const walk = (node: RegionNodeRaw, parentId: string | null): void => {
    if (byId.has(node.id)) {
      if (typeof console !== 'undefined') {
        console.warn(`[layoutStore] duplicate region id: ${node.id}`);
      }
      return;
    }
    const childIds = (node.children ?? []).map((c) => c.id);
    byId.set(node.id, {
      id: node.id,
      depth: node.depth,
      path: node.path,
      kind: node.kind,
      name: node.name,
      parentId,
      childIds,
    });
    // "file" regions are the primary badge anchors; keep a path index.
    // If two entries share a path, prefer kind === "file".
    const existing = byFile.get(node.path);
    if (existing === undefined) {
      byFile.set(node.path, node.id);
    } else if (node.kind === 'file') {
      byFile.set(node.path, node.id);
    }
    for (const child of node.children ?? []) {
      walk(child, node.id);
    }
  };

  for (const root of rawRoots) {
    roots.push(root.id);
    walk(root, null);
  }

  return { roots, byId, byFile };
}

// ---------------------------------------------------------------------------
// Zustand store
// ---------------------------------------------------------------------------

export interface LayoutStoreState {
  layoutMeta: LayoutMeta | null;
  regionTree: RegionTree;
  /**
   * DAI-22 Chunk-8 — per-region hull geometry cache. Populated by
   * `computeHullsForRegions` once the stream completes (see loadStream).
   * Renderers read this map to draw hull polygons without recomputing.
   * Empty map when hulls have not been computed yet.
   */
  hullCache: Map<string, HullGeometry>;

  setLayoutMeta: (meta: LayoutMeta | null) => void;
  setRegionTree: (tree: RegionTree) => void;
  setHullCache: (cache: Map<string, HullGeometry>) => void;
  /** Reset to initial state (used when a new stream load starts). */
  reset: () => void;
}

const emptyTree = (): RegionTree => ({
  roots: [],
  byId: new Map(),
  byFile: new Map(),
});

export const useLayoutStore = create<LayoutStoreState>((set) => ({
  layoutMeta: null,
  regionTree: emptyTree(),
  hullCache: new Map(),

  setLayoutMeta: (meta) => set({ layoutMeta: meta }),
  setRegionTree: (tree) => set({ regionTree: tree }),
  setHullCache: (cache) => set({ hullCache: cache }),
  reset: () =>
    set({ layoutMeta: null, regionTree: emptyTree(), hullCache: new Map() }),
}));

// ---------------------------------------------------------------------------
// Pure selector helpers (callable from tests + components without hooks)
// ---------------------------------------------------------------------------

export function getRegionById(tree: RegionTree, id: string): RegionInfo | undefined {
  return tree.byId.get(id);
}

/**
 * Return the ancestor chain for a region, nearest parent first, root last.
 * The region itself is NOT included. Missing parent edges are silently
 * truncated (defensive against malformed trees).
 */
export function getAncestors(tree: RegionTree, regionId: string): RegionInfo[] {
  const out: RegionInfo[] = [];
  let current = tree.byId.get(regionId);
  if (current === undefined) return out;
  const seen = new Set<string>([regionId]);
  while (current.parentId !== null) {
    if (seen.has(current.parentId)) break; // cycle guard
    seen.add(current.parentId);
    const parent = tree.byId.get(current.parentId);
    if (parent === undefined) break;
    out.push(parent);
    current = parent;
  }
  return out;
}

/**
 * Lookup the region that represents a given file path. Preference order:
 *   1. byFile index (kind === "file" wins on collision, see buildRegionTree).
 *   2. undefined when no region matches.
 */
export function getRegionForFile(
  tree: RegionTree,
  filePath: string,
): RegionInfo | undefined {
  const id = tree.byFile.get(filePath);
  if (id === undefined) return undefined;
  return tree.byId.get(id);
}
