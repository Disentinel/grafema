/**
 * DAI-22 Chunk-9 — per-frame route gating by LOD visibility.
 *
 * §C.5 rules:
 *   - Both endpoints visible AND all intermediates visible → draw route.
 *   - Any node on the route collapsed → hide route entirely.
 *     (No hull-centroid stub, no straight-line shortcut — honest hiding.)
 *
 * A node counts as "collapsed" when:
 *   (a) its `pos` is null/absent (excluded / unplaced / missing layout), OR
 *   (b) its containing file-region isn't in the currently-visible region set
 *       (LOD depth band or pixel-area threshold hid it).
 *
 * Pure helpers — no store access, no Three.js. Consumer (`setupRoutes`)
 * reads stores per frame and passes snapshots in.
 */

import type { GraphNode } from '../store/dataStore';
import type { Route } from '../store/routeStore';

/**
 * Decide if a single route should render at the current LOD.
 *
 * `visibleRegionIds` is the set of region ids visible at the current zoom
 * (from `deriveLodVisibility(...).visibleHulls`).
 * `fileToRegionId(file)` resolves a node's file path to its innermost
 * (file-level) REGION id.
 */
export function isRouteVisibleAtZoom(
  route: Route,
  nodes: GraphNode[],
  visibleRegionIds: ReadonlySet<string>,
  fileToRegionId: (file: string) => string | undefined,
): boolean {
  if (!route.visible) return false;
  if (route.nodeIndices.length < 2) return false;

  for (const idx of route.nodeIndices) {
    const n = nodes[idx];
    if (!n) return false;
    const pos = (n as { pos?: { q: number; r: number } | null }).pos;
    if (!pos) return false;
    const file = (n as { file?: string }).file;
    if (!file) return false;
    const rid = fileToRegionId(file);
    if (!rid) return false;
    if (!visibleRegionIds.has(rid)) return false;
  }
  return true;
}

/**
 * Filter a batch of routes by the LOD gate. Order preserved.
 * Deterministic tiebreak (equal shortest path) is owned by the route
 * *producer* (search / graph-walk code), not the renderer — this helper
 * only gates the already-chosen paths.
 */
export function filterVisibleRoutes(
  routes: readonly Route[],
  nodes: GraphNode[],
  visibleRegionIds: ReadonlySet<string>,
  fileToRegionId: (file: string) => string | undefined,
): Route[] {
  return routes.filter((r) =>
    isRouteVisibleAtZoom(r, nodes, visibleRegionIds, fileToRegionId),
  );
}
