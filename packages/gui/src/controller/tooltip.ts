/**
 * Pure tooltip routing.
 *
 * Given a hover target (node / edge / route / empty) plus the node table
 * and optional edge accessor, computes a semantic TooltipContent. The
 * function has no DOM or React dependencies — the caller decides how to
 * render (title, subtitle, rows, footer) into whatever surface it owns.
 *
 * This makes tooltip semantics testable without a browser and shareable
 * between renderers (Canvas HUD, EdgeLabels, future overlays).
 */

/** What the user is hovering over. */
export type HoverTarget =
  | { kind: 'node'; nodeIdx: number }
  | { kind: 'edge'; srcIdx: number; dstIdx: number; edgeType: string }
  | { kind: 'route'; routeId: string; waypointIdx: number }
  | { kind: 'hull'; regionId: string; path: string; name: string; depth: number; tileCount: number }
  | { kind: 'empty' };

/** Minimal view of a graph node needed to build a tooltip. */
export interface NodeDatum {
  id: string;
  name: string;
  type: string;
  region: string;
  file: string;
  line?: number;
}

/** Minimal view of a graph edge needed to build a tooltip. */
export interface EdgeDatum {
  type: string;
}

/** Structured tooltip content — semantic, renderer-agnostic. */
export interface TooltipContent {
  title: string;
  subtitle?: string;
  rows: { label: string; value: string }[];
  footer?: string;
}

/**
 * Resolve a hover target into renderable tooltip content.
 *
 * Returns `null` when there's nothing to show — either target.kind is
 * 'empty' or a referenced node index is out of range. Graceful degradation
 * is preferred over throwing; the caller just hides the tooltip.
 *
 * @param target         What the pointer is over.
 * @param nodes          Read-only node table indexed by numeric id.
 * @param edgeAccessor   Optional lookup to resolve the canonical edge type
 *                       (overrides `target.edgeType` when provided and non-null).
 */
export function routeTooltip(
  target: HoverTarget,
  nodes: readonly NodeDatum[],
  edgeAccessor?: (src: number, dst: number) => EdgeDatum | null,
): TooltipContent | null {
  switch (target.kind) {
    case 'empty':
      return null;

    case 'node': {
      const node = nodes[target.nodeIdx];
      if (!node) return null;
      const rows: TooltipContent['rows'] = [
        { label: 'region', value: node.region },
        // File row added unconditionally — `node.region` can be a
        // symbol-self slug for overflow nodes (server fallback), so the
        // file path is the most reliable "where am I" anchor.
        { label: 'file', value: node.file },
      ];
      if (node.line !== undefined) {
        rows.push({ label: 'line', value: String(node.line) });
      }
      return {
        title: node.name,
        subtitle: node.type,
        rows,
      };
    }

    case 'edge': {
      const src = nodes[target.srcIdx];
      const dst = nodes[target.dstIdx];
      if (!src || !dst) return null;
      const edgeType = edgeAccessor?.(target.srcIdx, target.dstIdx)?.type ?? target.edgeType;
      return {
        title: edgeType,
        subtitle: `${src.name} \u2192 ${dst.name}`,
        rows: [
          { label: 'from', value: `${src.region} — ${src.file}` },
          { label: 'to', value: `${dst.region} — ${dst.file}` },
        ],
      };
    }

    case 'hull': {
      // Hull / folder hover (sandbox parity §B.5). Title = leaf folder
      // name; subtitle = full path so the user can locate the folder
      // even when the toponym renders only the short name; rows expose
      // the tree-fact triple (depth / leaf files / direct sub-folders).
      const rows: TooltipContent['rows'] = [
        { label: 'files', value: String(target.tileCount) },
        { label: 'depth', value: String(target.depth) },
      ];
      return {
        title: target.name || target.path || target.regionId,
        subtitle: target.path && target.path !== target.name ? target.path : 'folder',
        rows,
      };
    }

    case 'route': {
      const waypoint = nodes[target.waypointIdx];
      if (!waypoint) return null;
      const location = waypoint.line !== undefined
        ? `${waypoint.file}:${waypoint.line}`
        : waypoint.file;
      return {
        title: target.routeId,
        subtitle: `waypoint ${target.waypointIdx + 1}`,
        rows: [
          { label: 'waypoint', value: `${waypoint.name} — ${location}` },
        ],
      };
    }
  }
}
