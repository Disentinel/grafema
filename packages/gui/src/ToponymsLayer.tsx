/**
 * Hull toponyms — HTML overlay that renders one text label per visible
 * REGION at its hull centroid, projected through the active camera.
 *
 * Performance note (DAI-22): prior impl triggered a React re-render on
 * every RAF tick via `setTick(t => t+1)`. With ~500 candidates that
 * thrashed the reconciler — visible as lag on pan/zoom. This version
 * renders the container div ONCE via React, then a plain RAF loop
 * mutates `style.transform` / `style.display` / `style.fontSize` on
 * pre-created DOM nodes in a shared pool. Zero reconciliation in the
 * hot path; React only rebuilds the pool when candidates change
 * (regionTree or hullCache identity).
 *
 * Sandbox parity (sandbox/hex-sandbox/src/render.js §3.5):
 *   - centroid-anchored, depth-scaled font
 *   - bigger-wins overlap culling via AABB
 *   - map-convention LOD: shallow visible at far zoom, deep at close
 */

import { createElement, useEffect, useMemo, useRef } from 'react';
import { useLayoutStore, type LayoutMeta, type RegionInfo, type RegionTree } from './store/layoutStore';
import { useDataStore } from './store/dataStore';
import type { HullGeometry, Polygon } from './hulls/computeHulls';
import { DEFAULT_LOD_POLICY, visibleAtZoom } from './lod/visibility';
import type { SceneApi } from './controller/SceneApi';
import { computeDMax, normalizeZoom } from './lod/render';

interface LabelCandidate {
  regionId: string;
  text: string;
  cx: number;
  cz: number;
  area: number;
  depth: number;
}

function computeCentroid(polygons: readonly Polygon[]): { cx: number; cz: number } {
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (const loop of polygons) {
    for (let i = 0; i < loop.length - 1; i++) {
      sx += loop[i].x;
      sz += loop[i].y;
      n++;
    }
  }
  if (n === 0) return { cx: 0, cz: 0 };
  return { cx: sx / n, cz: sz / n };
}

export function buildCandidates(
  tree: RegionTree,
  hullCache: Map<string, HullGeometry>,
  layoutMeta: LayoutMeta | null,
): LabelCandidate[] {
  const out: LabelCandidate[] = [];
  const workspaceName = layoutMeta?.workspace_name ?? null;
  for (const [id, hull] of hullCache) {
    const region = tree.byId.get(id) as RegionInfo | undefined;
    if (!region) continue;
    if (region.kind === 'file') continue;
    const { cx, cz } = computeCentroid(hull.polygons);
    // Root label: server-emitted `region.name` for depth-0 is "/" or "." —
    // not useful. Use the workspace folder name from `layout_meta` instead;
    // if the server couldn't derive one, skip the root entirely so the
    // centre of the map doesn't show a meaningless slash.
    let text: string;
    if (region.depth === 0) {
      if (!workspaceName) continue;
      text = workspaceName;
    } else {
      text = region.name;
    }
    if (!text) continue;
    out.push({ regionId: id, text, cx, cz, area: hull.area, depth: region.depth });
  }
  return out;
}

interface PooledLabel {
  cand: LabelCandidate;
  el: HTMLDivElement;
}

function makeLabelDom(cand: LabelCandidate): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = cand.text;
  el.style.position = 'absolute';
  el.style.left = '0';
  el.style.top = '0';
  el.style.fontFamily = 'ui-monospace, Menlo, Monaco, monospace';
  el.style.fontWeight = '700';
  el.style.color = 'rgba(210, 220, 235, 0.85)';
  el.style.textShadow = '0 0 4px rgba(0,0,0,0.85), 0 0 10px rgba(0,0,0,0.6)';
  el.style.whiteSpace = 'nowrap';
  el.style.letterSpacing = '0.02em';
  el.style.userSelect = 'none';
  el.style.willChange = 'transform, font-size, opacity';
  el.style.display = 'none';
  el.dataset.regionId = cand.regionId;
  return el;
}

/** Update pooled labels in-place: compute projection, font size, LOD
 *  gate, overlap cull, then mutate `display` + `transform` + `fontSize`
 *  without touching React. */
function updatePool(
  pool: PooledLabel[],
  api: SceneApi,
  canvasRect: { left: number; top: number; width: number; height: number },
  dMax: number,
): void {
  const zoom01 = normalizeZoom(api.getView());
  const w = canvasRect.width;
  const h = canvasRect.height;
  const ox = canvasRect.left;
  const oy = canvasRect.top;

  // Pass 1: project + font size + gate, producing candidates-in-view.
  interface Projected {
    i: number;
    px: number;
    py: number;
    fontPx: number;
    text: string;
    aabb: { x: number; y: number; w: number; h: number };
  }
  const projected: Projected[] = [];
  for (let i = 0; i < pool.length; i++) {
    const c = pool[i].cand;
    const like = { depth: c.depth, leafCount: c.area };
    if (!visibleAtZoom(like, zoom01, dMax, DEFAULT_LOD_POLICY)) continue;
    const ndc = api.projectWorldToNdc(c.cx, 0.5, c.cz);
    if (ndc.z > 1 || ndc.z < -1) continue;
    const px = ox + (ndc.x + 1) * 0.5 * w;
    const py = oy + (1 - (ndc.y + 1) * 0.5) * h;
    if (px < ox - 200 || py < oy - 40 || px > ox + w + 200 || py > oy + h + 40) continue;
    const areaScale = Math.sqrt(Math.max(1, c.area));
    const depthFactor = 1 - c.depth * 0.08;
    const fontPx = Math.max(10, Math.min(48, areaScale * 0.55 * depthFactor));
    const tw = Math.max(20, c.text.length * fontPx * 0.55);
    const th = fontPx * 1.1;
    projected.push({
      i,
      px,
      py,
      fontPx,
      text: c.text,
      aabb: { x: px - tw / 2, y: py - th / 2, w: tw, h: th },
    });
  }

  // Pass 2: greedy overlap cull — bigger fonts win.
  projected.sort((a, b) => b.fontPx - a.fontPx);
  const kept = new Set<number>();
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  for (const p of projected) {
    let collide = false;
    for (const q of placed) {
      if (p.aabb.x < q.x + q.w && p.aabb.x + p.aabb.w > q.x &&
          p.aabb.y < q.y + q.h && p.aabb.y + p.aabb.h > q.y) {
        collide = true;
        break;
      }
    }
    if (!collide) {
      placed.push(p.aabb);
      kept.add(p.i);
    }
  }

  // Pass 3: mutate DOM. Hide everything, then show + position winners.
  for (let i = 0; i < pool.length; i++) {
    const el = pool[i].el;
    if (!kept.has(i)) {
      if (el.style.display !== 'none') el.style.display = 'none';
    }
  }
  for (const p of projected) {
    if (!kept.has(p.i)) continue;
    const el = pool[p.i].el;
    el.style.display = '';
    el.style.fontSize = `${p.fontPx}px`;
    el.style.transform = `translate3d(${p.px - 9999}px, ${p.py}px, 0)`;
    // Extra nudge via left for transform-origin stability with translate
    el.style.left = '9999px';
    el.style.top = '0px';
    el.style.transform = `translate3d(${p.px - 9999}px, ${p.py}px, 0) translate(-50%, -50%)`;
  }
}

export function ToponymsLayer({ api }: { api: SceneApi | null }) {
  const regionTree = useLayoutStore((s) => s.regionTree);
  const hullCache = useLayoutStore((s) => s.hullCache);
  const layoutMeta = useLayoutStore((s) => s.layoutMeta);
  const loaded = useDataStore((s) => s.loaded);
  const containerRef = useRef<HTMLDivElement>(null);
  const poolRef = useRef<PooledLabel[]>([]);

  const candidates = useMemo(
    () => (loaded ? buildCandidates(regionTree, hullCache, layoutMeta) : []),
    [loaded, regionTree, hullCache, layoutMeta],
  );

  // (Re)build the DOM pool when candidates change — rare (stream load
  // or hull recompute). Cheap: one createElement per region.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Drop the old pool
    for (const p of poolRef.current) p.el.remove();
    const next: PooledLabel[] = candidates.map((c) => {
      const el = makeLabelDom(c);
      container.appendChild(el);
      return { cand: c, el };
    });
    poolRef.current = next;
    return () => {
      for (const p of next) p.el.remove();
    };
  }, [candidates]);

  // Hot-path RAF loop: pure DOM mutation, zero React. Skip work
  // entirely when camera + canvas-rect haven't changed since last
  // tick — labels are deterministic from those inputs.
  useEffect(() => {
    if (!api) return;
    let live = true;
    let raf = 0;
    let lastViewKey = '';
    let lastRectKey = '';
    let workTotal = 0;
    let workFrames = 0;
    let windowStart = performance.now();
    const loop = () => {
      if (!live) return;
      raf = requestAnimationFrame(loop);
      // Camera-state hash via NDC-projecting a few sentinel points —
      // catches pan, zoom, rotate uniformly without leaning on
      // projection-specific CameraView fields.
      const a = api.projectWorldToNdc(0, 0, 0);
      const b = api.projectWorldToNdc(50, 0, 50);
      const viewKey = `${a.x.toFixed(3)},${a.y.toFixed(3)},${a.z.toFixed(3)}|${b.x.toFixed(3)},${b.y.toFixed(3)}`;
      const canvasEl = document.querySelector('.canvas-container canvas') as HTMLCanvasElement | null;
      const rect = canvasEl?.getBoundingClientRect();
      const rectKey = rect ? `${rect.left.toFixed(1)}x${rect.top.toFixed(1)}|${rect.width.toFixed(1)}x${rect.height.toFixed(1)}` : '';
      if (viewKey === lastViewKey && rectKey === lastRectKey) return;
      lastViewKey = viewKey;
      lastRectKey = rectKey;
      if (!rect || poolRef.current.length === 0) return;
      const tStart = performance.now();
      const dMax = computeDMax(useLayoutStore.getState().regionTree);
      updatePool(poolRef.current, api, rect, dMax);
      const dt = performance.now() - tStart;
      workTotal += dt;
      workFrames++;
      if (dt > 8) console.warn(`[perf] toponyms.RAF ${dt.toFixed(1)}ms (pool ${poolRef.current.length})`);
      if (tStart - windowStart > 1000) {
        if (workFrames > 0) console.warn(`[perf] toponyms.RAF ${workFrames} active frames in ${((tStart - windowStart)/1000).toFixed(1)}s window, avg ${(workTotal / workFrames).toFixed(2)}ms/frame, total ${workTotal.toFixed(1)}ms`);
        workTotal = 0;
        workFrames = 0;
        windowStart = tStart;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      live = false;
      cancelAnimationFrame(raf);
    };
  }, [api]);

  return createElement('div', {
    ref: containerRef,
    style: {
      position: 'fixed',
      inset: 0,
      pointerEvents: 'none',
      zIndex: 20,
    },
  });
}

export default ToponymsLayer;
