/**
 * Hull toponyms — text labels rendered as flat Three.js meshes lying
 * directly on the hex-atlas plane. Each label is a `PlaneGeometry`
 * with a `CanvasTexture` carrying the rendered text; the plane is
 * rotated to lie in the XZ ground plane and turned around its Y axis
 * by the region's PCA principal-axis angle so the text "stretches
 * along" the long side of the hull.
 *
 * Why mesh, not HTML overlay (changed 2026-04-26)
 * -----------------------------------------------
 * The HTML overlay approach kept labels flat-to-screen — fine in 2D
 * top-down mode, wrong in 3D (camera tilt → labels still face the
 * viewport instead of the ground). Mesh-based rendering ties labels
 * to the same projection pipeline as the hex tiles and hulls, so
 * tilting the camera literally tilts the text along with the map.
 *
 * Hierarchical LOD mutex
 * ----------------------
 * Sandbox `lod` integer model: only ONE depth-band is drawn at any
 * given zoom. Translated here as: a region's label is shown only when
 * its zoom band matches the current camera zoom AND none of its
 * descendant regions are also shown at this zoom. Result — when the
 * user zooms past a folder boundary, the parent's name fades out and
 * the children's names fade in.
 *
 * Lifecycle
 * ---------
 * - When `regionTree` / `hullCache` identity flips (new stream), build
 *   a per-region LabelMesh{ mesh, texture, visibilityBand } and add
 *   to the scene's overlay group. Cheap canvas-text rasterisation,
 *   ~700 entries on the grafema corpus.
 * - Per RAF: walk regions in depth order, mark `mesh.visible` based on
 *   the LOD-mutex rule. Three.js handles frustum culling.
 */

import { createElement, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useLayoutStore, type LayoutMeta, type RegionInfo, type RegionTree } from './store/layoutStore';
import { useDataStore } from './store/dataStore';
import type { HullGeometry, Polygon } from './hulls/computeHulls';
import { DEFAULT_LOD_POLICY, visibleAtZoom } from './lod/visibility';
import type { SceneApi } from './controller/SceneApi';
import { computeDMax, normalizeZoom } from './lod/render';

interface LabelCandidate {
  regionId: string;
  text: string;
  /** Centroid in world XZ. */
  cx: number;
  cz: number;
  area: number;
  depth: number;
  /** PCA principal-axis angle in world XZ (radians, clamped to ±π/2
   *  so text stays upright). */
  angleWorld: number;
  /** Oriented-bbox extents in world units along the principal axis
   *  (text length budget) and perpendicular axis (text height budget). */
  alongLen: number;
  perpLen: number;
  /** Hull polygons (world XZ — Polygon.x, Polygon.y where y == world Z).
   *  Used for the strict polygon-fit test that shrinks the label until
   *  all four rotated corners sit inside the hull, not just inside the
   *  oriented bbox. Concave / branched hulls have a much larger
   *  oriented bbox than actual surface area; the bbox-only check let
   *  labels visibly bleed past the hull outline. */
  polygons: readonly Polygon[];
}

/** Point-in-polygon (Jordan curve) for a single closed loop. `loop` is
 *  expected to be closed (first vertex repeated at the end), in
 *  world XZ where vertex.x is world X and vertex.y is world Z. */
function pointInLoop(px: number, pz: number, loop: readonly { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const xi = loop[i].x, zi = loop[i].y;
    const xj = loop[j].x, zj = loop[j].y;
    const intersects = ((zi > pz) !== (zj > pz)) &&
      (px < ((xj - xi) * (pz - zi)) / (zj - zi || 1e-9) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Point-in-region: any polygon loop contains the point (multi-loop
 *  hulls — disjoint islands or holes — both supported). */
function pointInPolygons(
  px: number,
  pz: number,
  polygons: readonly { x: number; y: number }[][],
): boolean {
  for (const loop of polygons) if (pointInLoop(px, pz, loop)) return true;
  return false;
}

/** PCA + oriented bbox over a polygon vertex set. Same algorithm as
 *  `sandbox/hex-sandbox/src/render.js §3.5` but in world XZ instead of
 *  pixel XY. */
function computeCentroidAndPca(
  polygons: readonly Polygon[],
  hexSize: number,
): {
  cx: number;
  cz: number;
  angleWorld: number;
  alongLen: number;
  perpLen: number;
} {
  const pts: { x: number; z: number }[] = [];
  for (const loop of polygons) {
    for (let i = 0; i < loop.length - 1; i++) {
      pts.push({ x: loop[i].x, z: loop[i].y });
    }
  }
  if (pts.length === 0) {
    return { cx: 0, cz: 0, angleWorld: 0, alongLen: 0, perpLen: 0 };
  }
  let cx = 0;
  let cz = 0;
  for (const p of pts) {
    cx += p.x;
    cz += p.z;
  }
  cx /= pts.length;
  cz /= pts.length;
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  for (const p of pts) {
    const dx = p.x - cx;
    const dz = p.z - cz;
    sxx += dx * dx;
    szz += dz * dz;
    sxz += dx * dz;
  }
  sxx /= pts.length;
  szz /= pts.length;
  sxz /= pts.length;
  let angle = pts.length > 1 ? 0.5 * Math.atan2(2 * sxz, sxx - szz) : 0;
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  const ax = Math.cos(angle);
  const az = Math.sin(angle);
  const bx = -az;
  const bz = ax;
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;
  for (const p of pts) {
    const dx = p.x - cx;
    const dz = p.z - cz;
    const pa = dx * ax + dz * az;
    const pb = dx * bx + dz * bz;
    if (pa < minA) minA = pa;
    if (pa > maxA) maxA = pa;
    if (pb < minB) minB = pb;
    if (pb > maxB) maxB = pb;
  }
  const alongLen = (maxA - minA) + hexSize * 1.7;
  const perpLen = (maxB - minB) + hexSize * 1.7;
  return { cx, cz, angleWorld: angle, alongLen, perpLen };
}

/** Edge-case heuristic: when two or more sibling-ish regions share the
 *  same `name` (`src`, `lib`, `Rules`, `index`, etc. — common in JS/Rust
 *  monorepos), drawing a dozen identical labels conveys nothing about
 *  WHICH `src` you're looking at. Disambiguate by prefixing the closest
 *  non-colliding ancestor name (e.g. `api/src`, `util/src`). Names that
 *  occur once stay bare.
 *
 *  Decision is global across the candidate set, computed at build time
 *  in one pass. */
function disambiguateName(
  region: RegionInfo,
  tree: RegionTree,
  collidingNames: Set<string>,
  fallbackRoot: string | null,
): string | null {
  if (!collidingNames.has(region.name)) return region.name;
  // Walk up looking for an ancestor whose own name is NOT also a
  // colliding bare name. That ancestor disambiguates.
  let pid = region.parentId;
  while (pid) {
    const p = tree.byId.get(pid);
    if (!p) break;
    if (p.depth === 0) {
      // Hit the workspace root — use it as the disambiguator if we
      // have one; otherwise fall back to the bare colliding name
      // (better than dropping the label entirely).
      return fallbackRoot ? `${fallbackRoot}/${region.name}` : region.name;
    }
    if (!collidingNames.has(p.name)) {
      return `${p.name}/${region.name}`;
    }
    pid = p.parentId;
  }
  return region.name;
}

export function buildCandidates(
  tree: RegionTree,
  hullCache: Map<string, HullGeometry>,
  layoutMeta: LayoutMeta | null,
): LabelCandidate[] {
  const workspaceName = layoutMeta?.workspace_name ?? null;
  const HEX_SIZE = 3.0;

  // Pre-pass: collect every candidate region's bare name to find
  // collisions. A name colliding with itself anywhere in the tree
  // (count ≥ 2) triggers the parent-prefix disambiguation —
  // single-occurrence names stay bare. Names are derived from
  // RegionInfo.name (which already strips parent path), so we only
  // touch the actual displayed string.
  const nameCount = new Map<string, number>();
  type Stub = { region: RegionInfo; hull: HullGeometry };
  const stubs: Stub[] = [];
  for (const [id, hull] of hullCache) {
    const region = tree.byId.get(id) as RegionInfo | undefined;
    if (!region) continue;
    // Earlier we skipped `kind === 'file'` regions entirely — that left
    // individual file hulls unnamed even at the deepest zoom. The
    // LOD-mutex hides folder-level labels in their area when file
    // labels become visible, so showing them is safe.
    if (region.depth === 0) continue; // root handled separately below
    stubs.push({ region, hull });
    nameCount.set(region.name, (nameCount.get(region.name) ?? 0) + 1);
  }
  const collidingNames = new Set<string>();
  for (const [name, count] of nameCount) {
    if (count >= 2) collidingNames.add(name);
  }

  const out: LabelCandidate[] = [];
  // Root region first (depth 0 → workspace name).
  for (const [id, hull] of hullCache) {
    const region = tree.byId.get(id) as RegionInfo | undefined;
    if (!region) continue;
    if (region.depth !== 0) continue;
    if (!workspaceName) continue;
    const pca = computeCentroidAndPca(hull.polygons, HEX_SIZE);
    out.push({
      regionId: id,
      text: workspaceName,
      cx: pca.cx,
      cz: pca.cz,
      area: hull.area,
      depth: region.depth,
      angleWorld: pca.angleWorld,
      alongLen: pca.alongLen,
      perpLen: pca.perpLen,
      polygons: hull.polygons,
    });
  }
  // Non-root regions, with collision-driven disambiguation.
  for (const { region, hull } of stubs) {
    const text = disambiguateName(region, tree, collidingNames, workspaceName);
    if (!text) continue;
    const pca = computeCentroidAndPca(hull.polygons, HEX_SIZE);
    out.push({
      regionId: region.id,
      text,
      cx: pca.cx,
      cz: pca.cz,
      area: hull.area,
      depth: region.depth,
      angleWorld: pca.angleWorld,
      alongLen: pca.alongLen,
      perpLen: pca.perpLen,
      polygons: hull.polygons,
    });
  }
  return out;
}

// ── Mesh-backed label pool ──────────────────────────────────────────

interface LabelMesh {
  cand: LabelCandidate;
  mesh: THREE.Mesh;
  texture: THREE.CanvasTexture;
  /** `mesh.visible` mirror — avoids touching Three's setter when the
   *  state hasn't actually changed (cheap idempotency on the hot path). */
  visible: boolean;
}

/** Render text into a power-of-two canvas at a fixed display height
 *  (we use 64 logical CSS pixels). The plane mesh is sized in WORLD
 *  units so the canvas resolution only controls glyph crispness; the
 *  texture is filtered with linear sampling.
 *
 *  Returns the canvas (so the caller can derive an aspect ratio for
 *  the plane geometry) and the rendered glyph width in canvas pixels. */
function renderLabelToCanvas(text: string): { canvas: HTMLCanvasElement; glyphWidth: number } {
  const FONT_PX = 64;
  // Probe canvas to measure text width.
  const probe = document.createElement('canvas');
  const probeCtx = probe.getContext('2d');
  if (!probeCtx) throw new Error('toponym: cannot get 2D context');
  probeCtx.font = `700 ${FONT_PX}px ui-monospace, Menlo, Monaco, monospace`;
  const measured = probeCtx.measureText(text);
  // Pad horizontally for the soft glow + a touch of safety against
  // browser font-metric jitter.
  const pad = 16;
  const w = Math.max(64, Math.ceil(measured.width + pad * 2));
  const h = FONT_PX + pad * 2;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('toponym: cannot get 2D context');
  ctx.font = `700 ${FONT_PX}px ui-monospace, Menlo, Monaco, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 10;
  ctx.fillStyle = 'rgba(210,220,235,0.92)';
  ctx.fillText(text, w / 2, h / 2);
  return { canvas, glyphWidth: measured.width };
}

function makeLabelMesh(cand: LabelCandidate): LabelMesh | null {
  const { canvas, glyphWidth } = renderLabelToCanvas(cand.text);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  // Plane size in WORLD units. Fit width to occupy 92% of the
  // oriented bbox along the principal axis (initial guess); height
  // follows aspect from the canvas.
  const aspect = canvas.width / canvas.height;
  const widthBudget = cand.alongLen * 0.92;
  const heightBudget = cand.perpLen * 0.92;
  const glyphFraction = glyphWidth / canvas.width;
  let worldW = widthBudget / Math.max(0.01, glyphFraction);
  let worldH = worldW / aspect;
  if (worldH > heightBudget) {
    worldH = heightBudget;
    worldW = worldH * aspect;
  }
  // Strict polygon-fit: the four ROTATED corners of the glyph
  // rectangle (text width × height, oriented along PCA angle, anchored
  // at centroid) must all sit inside a hull polygon. Concave or
  // branched hulls have an oriented bbox much bigger than their
  // surface area, and the bbox-only check let labels visibly bleed
  // past the outline. Shrink until they fit, drop if we hit the
  // minimum without success.
  const ax = Math.cos(cand.angleWorld);
  const az = Math.sin(cand.angleWorld);
  const bx = -az;
  const bz = ax;
  const cornersFit = (w: number, h: number): boolean => {
    const hx = (w * glyphFraction) / 2; // half width of the visible glyph extent
    const hz = h / 2;
    // Sample the rectangle perimeter, not just 4 corners — long thin
    // labels can punch the polygon between two distant corners. 8
    // points per side (32 total) catches concave nibbles cheaply.
    const SAMPLES_PER_SIDE = 8;
    for (let edge = 0; edge < 4; edge++) {
      const [sx0, sz0, sx1, sz1] =
        edge === 0 ? [-hx, -hz, hx, -hz] :
        edge === 1 ? [hx, -hz, hx, hz] :
        edge === 2 ? [hx, hz, -hx, hz] :
                     [-hx, hz, -hx, -hz];
      for (let s = 0; s <= SAMPLES_PER_SIDE; s++) {
        const t = s / SAMPLES_PER_SIDE;
        const lx = sx0 + (sx1 - sx0) * t;
        const lz = sz0 + (sz1 - sz0) * t;
        // rotate (lx, lz) by PCA, translate to centroid
        const wx = cand.cx + lx * ax + lz * bx;
        const wz = cand.cz + lx * az + lz * bz;
        if (!pointInPolygons(wx, wz, cand.polygons)) return false;
      }
    }
    return true;
  };
  // Shrink loop — start at initial guess, shrink by 0.85 each iter,
  // give up after 8 attempts (worldH ~ 0.27× original ≈ unreadable).
  let shrinkIters = 0;
  while (!cornersFit(worldW, worldH)) {
    worldW *= 0.85;
    worldH *= 0.85;
    shrinkIters++;
    if (shrinkIters > 8) return null; // can't fit even at 27% — drop
  }
  // Soft floor: 1 world-unit-tall labels become unreadable; below
  // that just drop. (Per-frame LOD gate normally hides these but a
  // direct render call without LOD wouldn't.)
  if (worldH < 1) return null;
  const geo = new THREE.PlaneGeometry(worldW, worldH);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    // Always render on top of hulls and tiles — labels are UI, not
    // geometry, so the depth test would drop them when they sit
    // exactly on a hull-fill plane at the same y.
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // Plane default normal is +Z — rotate -π/2 around X so the normal
  // ends up +Y (lying flat on the XZ ground). Then rotate around Y
  // by `-angleWorld` to align with the region's PCA axis.
  // (Sign flip: PCA angle is in world XZ; Y rotation is right-handed
  // around the up vector, opposite of XZ angle convention.)
  mesh.rotation.set(-Math.PI / 2, 0, 0);
  mesh.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), -cand.angleWorld);
  mesh.position.set(cand.cx, 0.5, cand.cz);
  // Render order above hulls so labels never get z-eaten by hull fill.
  mesh.renderOrder = 200;
  mesh.visible = false;
  return { cand, mesh, texture, visible: false };
}

/** Per-frame visibility update: respects LOD policy AND the parent-
 *  hides-when-child-is-shown rule. `visibleSet` lists the regionIds
 *  whose own zoom band matches the current zoom — children are
 *  preferred over parents. */
function updateVisibility(
  pool: LabelMesh[],
  api: SceneApi,
  dMax: number,
  tree: RegionTree,
): void {
  const zoom01 = normalizeZoom(api.getView());
  // Step 1: which regions pass their own LOD band?
  const passes: Set<string> = new Set();
  for (const lm of pool) {
    const c = lm.cand;
    const like = { depth: c.depth, leafCount: c.area };
    if (visibleAtZoom(like, zoom01, dMax, DEFAULT_LOD_POLICY)) {
      passes.add(c.regionId);
    }
  }
  // Step 2: parent-hides-when-child-shown. Walk every passing region
  // up the tree; if any ancestor also passes, hide the ancestor.
  // (Algorithm: ancestor that has at least one passing descendant
  // gets removed from the visible set.)
  const hidden: Set<string> = new Set();
  for (const rid of passes) {
    let cur = tree.byId.get(rid);
    if (!cur) continue;
    let pid = cur.parentId;
    while (pid) {
      if (passes.has(pid)) hidden.add(pid);
      const p = tree.byId.get(pid);
      pid = p?.parentId ?? null;
    }
  }
  // Step 3: write `mesh.visible` only when state actually flips.
  for (const lm of pool) {
    const want = passes.has(lm.cand.regionId) && !hidden.has(lm.cand.regionId);
    if (want !== lm.visible) {
      lm.mesh.visible = want;
      lm.visible = want;
    }
  }
}

export function ToponymsLayer({ api }: { api: SceneApi | null }) {
  const regionTree = useLayoutStore((s) => s.regionTree);
  const hullCache = useLayoutStore((s) => s.hullCache);
  const layoutMeta = useLayoutStore((s) => s.layoutMeta);
  const loaded = useDataStore((s) => s.loaded);
  const containerRef = useRef<HTMLDivElement>(null);
  const poolRef = useRef<LabelMesh[]>([]);
  const groupRef = useRef<THREE.Group | null>(null);

  const candidates = useMemo(
    () => (loaded ? buildCandidates(regionTree, hullCache, layoutMeta) : []),
    [loaded, regionTree, hullCache, layoutMeta],
  );

  // Build / rebuild the mesh pool when candidates change.
  useEffect(() => {
    if (!api) return;
    const scene = api.getScene();
    // Tear down any previous group + mesh resources.
    if (groupRef.current) {
      scene.remove(groupRef.current);
      for (const lm of poolRef.current) {
        lm.mesh.geometry.dispose();
        (lm.mesh.material as THREE.Material).dispose();
        lm.texture.dispose();
      }
    }
    const group = new THREE.Group();
    group.name = 'toponyms';
    scene.add(group);
    groupRef.current = group;
    const pool: LabelMesh[] = [];
    for (const cand of candidates) {
      const lm = makeLabelMesh(cand);
      if (!lm) continue; // text doesn't fit even at minimum size
      group.add(lm.mesh);
      pool.push(lm);
    }
    poolRef.current = pool;
    return () => {
      if (groupRef.current) {
        scene.remove(groupRef.current);
        for (const lm of pool) {
          lm.mesh.geometry.dispose();
          (lm.mesh.material as THREE.Material).dispose();
          lm.texture.dispose();
        }
        groupRef.current = null;
      }
      poolRef.current = [];
    };
  }, [candidates, api]);

  // Per-frame LOD-mutex visibility.
  useEffect(() => {
    if (!api) return;
    let live = true;
    let raf = 0;
    let lastViewKey = '';
    const loop = () => {
      if (!live) return;
      raf = requestAnimationFrame(loop);
      const a = api.projectWorldToNdc(0, 0, 0);
      const b = api.projectWorldToNdc(50, 0, 50);
      const viewKey = `${a.x.toFixed(3)},${a.y.toFixed(3)},${a.z.toFixed(3)}|${b.x.toFixed(3)},${b.y.toFixed(3)}`;
      if (viewKey === lastViewKey) return;
      lastViewKey = viewKey;
      if (poolRef.current.length === 0) return;
      const dMax = computeDMax(useLayoutStore.getState().regionTree);
      updateVisibility(poolRef.current, api, dMax, regionTree);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      live = false;
      cancelAnimationFrame(raf);
    };
  }, [api, regionTree]);

  // The container div is now redundant (we render straight into the
  // Three.js scene), but kept as a stable mount point so the React
  // tree shape doesn't change. Costs nothing.
  return createElement('div', {
    ref: containerRef,
    style: {
      position: 'fixed',
      inset: 0,
      pointerEvents: 'none',
      zIndex: 20,
      width: 0,
      height: 0,
    },
  });
}

export default ToponymsLayer;
