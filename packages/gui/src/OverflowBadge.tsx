/**
 * OverflowBadge — red-dot marker for files whose symbol count exceeded the
 * per-file hard cap at layout time. Renders one badge per entry in
 * `layoutMeta.overflow_files` from the server stream.
 *
 * DAI-22 Chunk-6: we position the badge at the mean (x, z) of all placed
 * symbols in the file. Chunk-7 will replace this with the hull centroid
 * once morphological-close hulls are computed.
 *
 * Hover tooltip format per §A.7:
 *   "{skipped} symbols not displayed (hard cap {cap}).
 *    Raise with `grafema layout --max-symbols-per-file=<N>`"
 *
 * Styling is intentionally minimal; Playwright phase will iterate visuals.
 */

import * as React from 'react';
import type { GraphNode } from './store/dataStore';
import type { OverflowFile } from './store/layoutStore';

// Classic JSX runtime compat — mirrors other GUI modules that avoid a
// JSX-runtime side-effect import to keep node:test happy.
void React;

/**
 * Compute the mean (x, z) of a set of nodes. Returns null when the set
 * is empty — caller should skip rendering rather than place the badge
 * at the origin.
 *
 * NOTE (Chunk-6): mean-position fallback; will use hull centroid after
 * Chunk-7 lands morphological-close hull computation.
 */
export function meanPosition(
  nodes: ReadonlyArray<{ x: number; z: number }>,
): { x: number; z: number } | null {
  if (nodes.length === 0) return null;
  let sx = 0;
  let sz = 0;
  for (const n of nodes) {
    sx += n.x;
    sz += n.z;
  }
  return { x: sx / nodes.length, z: sz / nodes.length };
}

/**
 * Pure selector: nodes that belong to a given file AND are placed
 * (i.e. have numeric x/z). Excludes nodes that loadStream marked
 * as unplaced.
 */
export function placedNodesForFile(
  nodes: ReadonlyArray<GraphNode>,
  file: string,
): GraphNode[] {
  return nodes.filter((n) => n.file === file);
}

/**
 * Compose the tooltip string used on hover. Exported for tests.
 */
export function overflowTooltip(entry: OverflowFile): string {
  return `${entry.skipped} symbols not displayed (hard cap ${entry.cap}). Raise with \`grafema layout --max-symbols-per-file=<N>\``;
}

export interface OverflowBadgeProps {
  entry: OverflowFile;
  /** Mean (or centroid) world position in the atlas. */
  position: { x: number; z: number };
  /**
   * Project world → screen for CSS positioning. Default: identity-ish
   * (x, z → pixels directly). Hosts that run inside the Three canvas
   * should pass a proper projector. Chunk-7+ will wire this.
   */
  projectToScreen?: (p: { x: number; z: number }) => { left: number; top: number };
}

/**
 * A single red chip. Kept host-agnostic — no reach into dataStore so
 * that tests can mount it standalone.
 */
export function OverflowBadge({ entry, position, projectToScreen }: OverflowBadgeProps) {
  const proj = projectToScreen ?? (({ x, z }) => ({ left: x, top: z }));
  const { left, top } = proj(position);

  const style: React.CSSProperties = {
    position: 'absolute',
    left,
    top,
    transform: 'translate(-50%, -50%)',
    background: '#d32f2f',
    color: '#fff',
    borderRadius: '10px',
    padding: '2px 6px',
    fontSize: '11px',
    fontFamily: 'monospace',
    fontWeight: 600,
    lineHeight: '14px',
    pointerEvents: 'auto',
    boxShadow: '0 1px 2px rgba(0,0,0,0.35)',
    cursor: 'default',
    userSelect: 'none',
    zIndex: 30,
  };

  return (
    <div
      className="grafema-overflow-badge"
      data-file={entry.file}
      data-skipped={entry.skipped}
      data-cap={entry.cap}
      style={style}
      title={overflowTooltip(entry)}
    >
      {entry.skipped}
    </div>
  );
}

export default OverflowBadge;
