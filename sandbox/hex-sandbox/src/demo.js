// Minimal bootstrap demo.
// Creates three regions of hexes, a handful of links, one route,
// and prints basic metrics. Uses keyboard controls:
//   [S] swap two random nodes from different regions
//   [R] reset
//   [L] toggle link rendering
//   [T] toggle labels

import { HexMap } from './map.js';
import { Node } from './node.js';
import { Link } from './link.js';
import { Region } from './region.js';
import { Route } from './route.js';
import { render, linkColor } from './render.js';
import { axialToPixel, pixelToAxial } from './hex.js';
import { computeHullPolygons } from './hull.js';
import { runRingAssembly } from './ring.js';
import { runPackingAssembly, buildLodHulls, maxFolderDepth, folderHslForPath } from './pack.js';
import { runMonteCarloLayout } from './pack-mc.js';
import { loadTree, buildSampleFromTree, loadRealLinks, loadRustLayout, applyRustLayout } from './tree-sample.js';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('cv'));
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('no 2d context');

const hud = /** @type {HTMLDivElement} */ (document.getElementById('hud'));

// Size canvas to window.
function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resize();
window.addEventListener('resize', () => { resize(); draw(); });

// ── Build a sample map ──────────────────────────────────────────
const map = new HexMap();
// Try to load the real Grafema tree; fall back to the synthetic sample
// if public/tree.json isn't available (e.g. scan script not run yet).
/** @type {any} */
let loadedTree = null;
let cachedRealLinks = null;
/** Cached pack snapshots from the initial run — used by the stepper. */
let packSnaps = null;
try {
  loadedTree = await loadTree();
  cachedRealLinks = await loadRealLinks();
  buildSampleFromTree(map, loadedTree, { hexSize: 22, realLinks: cachedRealLinks });
  const realLinks = cachedRealLinks;
  map.lodMax = maxFolderDepth(loadedTree) + 1;
  map.lod = map.lodMax;
  const linkSource = realLinks ? `real (${realLinks.edges.length} edges scanned)` : 'synthetic';
  console.log(`loaded ${loadedTree.leaves.length} leaves, ${loadedTree.folders.length} folders, lodMax=${map.lodMax}, links=${linkSource}`);
} catch (err) {
  console.warn('tree.json not available, using synthetic sample:', err.message);
  buildSample(map);
}

// ── Rendering ───────────────────────────────────────────────────
const HEX = 22;
let showLinks = false;
/** Node currently under the mouse (hover-highlight its links). */
/** @type {import('./node.js').Node | null} */
let hoveredNode = null;
/** Nodes pinned via click — their links stay drawn until un-pinned. */
/** @type {Set<string>} */
const pinnedNodes = new Set();
let showLabels = true;  // hull-toponym labels on by default
let showRoutes = true;
let fillRegions = false; // ring mode draws individual hexes + assembled hulls on top

// ── View state (pan / zoom) ─────────────────────────────────────
// panX/panY are pixel offsets added to the canvas centre when the
// renderer places the origin. zoom multiplies hexSize so links,
// hulls, tiles and overlays all scale uniformly.
const view = { panX: 0, panY: 0, zoom: 1 };

function effectiveHex() { return HEX * view.zoom; }
function originX() { return canvas.width / 2 + view.panX; }
function originY() { return canvas.height / 2 + view.panY; }
/** Convert a screen-pixel mouse coord to scene-pixel coord. */
function screenToScene(mx, my) {
  return { sx: mx - originX(), sy: my - originY() };
}

// ── Tectonic debug stepper ──────────────────────────────────────
/** @type {import('./tectonic.js').Snapshot[] | null} */
let tectonicSteps = null;
let tectonicIdx = 0;
/** Saved state before entering tectonic mode — restored on Esc. */
let tectonicOriginal = null;

// ── Region palette ──────────────────────────────────────────────
// Build a maximally-spaced HSL palette by region ORDINAL rather
// than string hash, so adjacent ordinals get hue separation of
// 360/N degrees regardless of region count. String-hash buckets
// produced near-collisions (hue-wise) for 12+ regions.
const regionPalette = new Map();
function rebuildPalette() {
  regionPalette.clear();
  const ids = [...map.regions.keys()].sort();
  ids.forEach((id, i) => {
    const N = Math.max(ids.length, 1);
    // Slight golden-ratio offset breaks visual rhythm so similar
    // hues don't end up side by side after region sorting.
    const hue = ((i * 360 / N) + (i % 2 ? 30 : 0)) % 360;
    // Alternate lightness/saturation per region for extra contrast.
    const sat = 65 + (i % 3) * 10;          // 65, 75, 85
    const light = 45 + ((i + 1) % 3) * 8;   // 45, 53, 61
    regionPalette.set(id, `hsl(${hue} ${sat}% ${light}%)`);
  });
}
function regionColor(id) {
  if (!id) return '#22272d';
  // When the tree is loaded, use the same hierarchical hue function
  // the LOD hull layers use — node colour then matches its immediate
  // folder's hull at every LOD level.
  if (loadedTree) return folderHslForPath(loadedTree, id);
  return regionPalette.get(id) ?? '#22272d';
}

function draw() {
  const currentSnap = tectonicSteps ? tectonicSteps[tectonicIdx] : null;
  if (regionPalette.size !== map.regions.size) rebuildPalette();
  // Hull layers: LOD-aware and computed at draw time so ↑/↓ re-renders
  // immediately. If a snapshot carries an explicit overlay (tectonic
  // debug stepper), prefer that. Otherwise build hulls from the tree
  // at the current LOD.
  let hullLayers = currentSnap?.hullLayers ?? null;
  let hullsOutlineOnly = false;
  const useLod = loadedTree && map.lod < map.lodMax;
  if (!hullLayers && loadedTree) {
    // At LOD max (per-hex), still draw the deepest folder hulls as
    // OUTLINES ONLY so the user keeps orientation when the colour
    // flood goes away. Fills and labels drop out; only the stroke
    // remains. Hit-test ignores these outlines (tooltip prefers the
    // per-hex node at the pointer).
    const targetLod = useLod ? map.lod : Math.max(0, map.lodMax - 1);
    hullsOutlineOnly = !useLod;
    try { hullLayers = buildLodHulls(map, loadedTree, targetLod); }
    catch (e) { console.warn('hull build failed:', e.message); }
  }
  // Cache current layers for the mousemove hit-test — only used when
  // hulls are the primary view (i.e. not outline-only).
  window.__currentHullLayers = hullsOutlineOnly ? null : hullLayers;
  // Link visibility filter: union of hovered + pinned nodes. Null when
  // nothing is hovered or pinned — in that case, `showLinks` alone decides.
  /** @type {Set<string> | null} */
  let linkVisibleAtoms = null;
  if (hoveredNode || pinnedNodes.size > 0) {
    linkVisibleAtoms = new Set(pinnedNodes);
    if (hoveredNode) linkVisibleAtoms.add(hoveredNode.id);
  }
  render(ctx, map, {
    hexSize: effectiveHex(),
    origin: { x: originX(), y: originY() },
    showLinks,
    showRoutes,
    fillRegions,
    regionColor,
    nodeLabels: showLabels && !hullsOutlineOnly ? true : undefined,
    overlay: currentSnap?.overlay ?? null,
    hullLayers,
    hullsOutlineOnly,
    hideHexes: useLod,
    nodeShortLabels: !useLod && !!loadedTree && showLabels,
    linkVisibleAtoms,
    pinnedAtoms: pinnedNodes.size > 0 ? pinnedNodes : null,
  });
  updateHud();
  updateTectonicPanel();
}

function updateTectonicPanel() {
  const panel = /** @type {HTMLDivElement} */ (document.getElementById('tectonic-panel'));
  if (!tectonicSteps || tectonicSteps.length === 0) {
    panel.style.display = 'none';
    return;
  }
  const s = tectonicSteps[tectonicIdx];
  panel.style.display = 'block';
  panel.innerHTML = `
    <b style="color:#fc6">PACK · step ${tectonicIdx + 1} / ${tectonicSteps.length}</b><br>
    <div style="margin-top:4px"><b style="color:#6ac">${s.phaseLabel}</b></div>
    <div style="color:#9ab; font-size:10px; margin-top:2px">
      name: <code style="color:#fc6">${s.name}</code>
    </div>
    <div style="margin-top:6px; color:#d0d6dc">${s.description}</div>
    <div style="margin-top:8px; color:#6a7480; font-size:10px">
      [←/→] step · [Home/End] jump · [Esc] exit
    </div>
  `;
}

function updateHud() {
  const regions = [...map.regions.values()].filter(r => r.nodes.size > 0);
  // O(R²) — skip the count when there are too many regions (real tree data).
  const adjPairs = regions.length <= 50 ? countRegionAdjacencies() : '—';
  const routeWps = [...map.routes.values()]
    .reduce((sum, r) => sum + r.segments.reduce((s, seg) => s + seg.length, 0), 0);
  const tectonicLine = tectonicSteps
    ? `<b style="color:#fc6">pack:</b> ${tectonicSteps[tectonicIdx].name} (${tectonicIdx + 1}/${tectonicSteps.length})<br>`
    : '';
  hud.innerHTML = `
    <b>hex-sandbox</b><br>
    nodes: ${map.nodes.size}<br>
    links: ${map.links.length}<br>
    regions: ${regions.length}<br>
    region adjacencies: ${adjPairs}<br>
    routes: ${map.routes.size} (${routeWps} waypoints)<br>
    Σ link length: ${map.totalLinkLength()}<br>
    mode: ${fillRegions ? 'hull fill' : 'per-hex'}<br>
    <b style="color:#fc6">LOD: ${map.lod} / ${map.lodMax}</b><br>
    ${tectonicLine}<br>
    <small>drag = pan · wheel = zoom · [0] reset view<br>
    [P] pack step · [M] MC refine · [F] fit · [↑/↓] LOD · [L] all links · [O] routes · [T] labels · [←/→] step · [R] reset<br>
    hover = show node links · click = pin/unpin</small>
  `;
}

function countRegionAdjacencies() {
  const regions = [...map.regions.values()];
  let pairs = 0;
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      if (map.regionsAdjacent(regions[i], regions[j])) pairs++;
    }
  }
  return pairs;
}

// ── Keyboard ────────────────────────────────────────────────────
/** Run packing once at startup so the first view is the final layout. */
async function initialPack() {
  if (!loadedTree) return;
  console.log('running packing assembly on', map.nodes.size, 'nodes…');
  const t0 = performance.now();
  showProgress('starting…');
  try {
    packSnaps = await runPackingAssembly(map, loadedTree, {
      hexSize: HEX,
      onProgress: (msg) => showProgress(msg),
    });
    console.log(`pack done in ${(performance.now() - t0).toFixed(0)}ms → ${packSnaps.length} snapshots`);
  } catch (err) {
    console.error('pack crashed:', err.stack || err.message);
    packSnaps = [];
  }
  hideProgress();
  window.__ringDone = true;
}

/**
 * M key — run the Monte-Carlo refinement pass on the current layout.
 * Uses whatever's currently placed as the warm start: right after boot
 * that's the greedy pack result, but you can M → M → M to chain refinement
 * rounds, or press R first and then M to refine from a fresh pack. Leaves
 * the resulting snapshots in the stepper so the user can scrub through
 * the MC trajectory with Left/Right.
 */
async function runMcRefine() {
  if (tectonicSteps) stopTectonic();
  if (map.nodes.size === 0) {
    console.warn('MC: no nodes to refine');
    return;
  }
  // Capture the pre-MC state so Escape can restore it verbatim.
  const preMc = map.takeSnapshot();
  const t0 = performance.now();
  /** @type {Array<any> | null} */
  let mcSnaps = null;
  try {
    mcSnaps = await runMonteCarloLayout(map, loadedTree, {
      onProgress: (msg) => { if (msg) showProgress(msg); else hideProgress(); },
    });
  } catch (err) {
    console.error('mc crashed:', err.stack || err.message);
  } finally {
    hideProgress();
  }
  console.log(`mc done in ${(performance.now() - t0).toFixed(0)}ms → ${mcSnaps?.length ?? 0} snapshots`);
  if (mcSnaps && mcSnaps.length > 0) {
    packSnaps = mcSnaps;
    tectonicOriginal = preMc;
    tectonicSteps = mcSnaps;
    tectonicIdx = mcSnaps.length - 1;
    map.restoreSnapshot(mcSnaps[tectonicIdx].coords);
  }
  draw();
}

/**
 * P key now enters a step-through DEMO of the packing process. The
 * actual pack already ran at startup — this just re-exposes the cached
 * snapshots as a stepper so the user can watch the blob grow.
 */
function startTectonic() {
  if (!packSnaps || packSnaps.length === 0) {
    console.warn('no pack snapshots available — pack may not have run yet');
    return;
  }
  tectonicOriginal = map.takeSnapshot();
  tectonicSteps = packSnaps;
  tectonicIdx = 0;
  map.restoreSnapshot(tectonicSteps[0].coords);
  draw();
}

function showProgress(msg) {
  let el = document.getElementById('progress');
  if (!el) {
    el = document.createElement('div');
    el.id = 'progress';
    el.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);' +
      'padding:10px 18px;background:rgba(10,15,20,0.95);border:1px solid #4a6070;' +
      'color:#9cf;font-family:ui-monospace,monospace;font-size:12px;z-index:100;' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.5);pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent = '⟳ ' + msg;
  el.style.display = 'block';
}
function hideProgress() {
  const el = document.getElementById('progress');
  if (el) el.style.display = 'none';
}

function stopTectonic() {
  if (tectonicOriginal) map.restoreSnapshot(tectonicOriginal);
  tectonicOriginal = null;
  tectonicSteps = null;
  tectonicIdx = 0;
  draw();
}

function stepTectonic(delta) {
  if (!tectonicSteps) return;
  tectonicIdx = Math.max(0, Math.min(tectonicSteps.length - 1, tectonicIdx + delta));
  map.restoreSnapshot(tectonicSteps[tectonicIdx].coords);
  draw();
}

function jumpTectonic(toIdx) {
  if (!tectonicSteps) return;
  tectonicIdx = Math.max(0, Math.min(tectonicSteps.length - 1, toIdx));
  map.restoreSnapshot(tectonicSteps[tectonicIdx].coords);
  draw();
}

window.addEventListener('keydown', (e) => {
  // Tectonic navigation takes priority when active.
  if (tectonicSteps) {
    if (e.key === 'ArrowLeft')  { e.preventDefault(); stepTectonic(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); stepTectonic(+1); return; }
    if (e.key === 'Home')       { e.preventDefault(); jumpTectonic(0); return; }
    if (e.key === 'End')        { e.preventDefault(); jumpTectonic(tectonicSteps.length - 1); return; }
    if (e.key === 'Escape')     { stopTectonic(); return; }
  }

  if (e.key === '0') {
    view.panX = 0; view.panY = 0; view.zoom = 1; draw();
  }
  else if (e.key === 'f' || e.key === 'F') { fitView(); draw(); }
  else if (e.key === 'p' || e.key === 'P') startTectonic();
  else if (e.key === 's' || e.key === 'S') swapRandom();
  else if (e.key === 'm' || e.key === 'M') runMcRefine();
  // [H] was the old per-region hull toggle; LOD now drives that. Keep
  // the key unbound so it's available for something else.
  else if (e.key === 'l' || e.key === 'L') { showLinks = !showLinks; draw(); }
  else if (e.key === 'o' || e.key === 'O') { showRoutes = !showRoutes; draw(); }
  else if (e.key === 't' || e.key === 'T') { showLabels = !showLabels; draw(); }
  else if (e.key === 'ArrowUp')   { e.preventDefault(); map.incLod(); draw(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); map.decLod(); draw(); }
  else if (e.key === 'r' || e.key === 'R') {
    if (tectonicSteps) stopTectonic();
    map.nodes.clear(); map.links.length = 0; map.regions.clear(); map.routes.clear();
    // @ts-ignore — private field reset for demo
    map._byCoord.clear(); map._regionAdjDirty = true;
    if (loadedTree) buildSampleFromTree(map, loadedTree, { hexSize: 22, realLinks: cachedRealLinks });
    else buildSample(map);
    draw();
  }
});

/**
 * Compute the pixel-space bounding box of all nodes at hexSize=HEX
 * (i.e. at zoom=1) and set zoom/pan so the bbox fits the viewport
 * with ~5% margin. Works for any N — handles the huge leaves-ring.
 */
function fitView() {
  if (map.nodes.size === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of map.nodes.values()) {
    const p = axialToPixel(n.coord, HEX);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX, h = maxY - minY;
  if (w < 1 || h < 1) return;
  const margin = 0.9;
  const zx = (canvas.width  * margin) / w;
  const zy = (canvas.height * margin) / h;
  view.zoom = Math.max(0.005, Math.min(6, Math.min(zx, zy)));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  view.panX = -cx * view.zoom;
  view.panY = -cy * view.zoom;
}

function swapRandom() {
  const ns = [...map.nodes.values()];
  if (ns.length < 2) return;
  const a = ns[Math.floor(Math.random() * ns.length)];
  const candidates = ns.filter(n => n.regionId !== a.regionId);
  if (candidates.length === 0) return;
  const b = candidates[Math.floor(Math.random() * candidates.length)];
  map.swap(a, b);
  draw();
}

// ── Sample data ─────────────────────────────────────────────────
function buildSample(m, opts = {}) {
  // Larger demo: ~12 regions, 14-32 nodes each, ~180 links.
  // All randomness is seeded so each reload shows the same graph;
  // pass `seed: N` to vary.
  const N_REGIONS = opts.regions ?? 12;
  const MIN_SIZE  = opts.minSize ?? 14;
  const MAX_SIZE  = opts.maxSize ?? 32;
  const N_LINKS   = opts.linkCount ?? 180;
  const SPACING   = opts.spacing ?? 16;
  const seedInit  = opts.seed ?? 1;

  let seed = seedInit;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  // Initial cluster offsets: a square-ish grid of region centres
  // spaced far enough apart that the spiral clusters don't collide.
  // Phase 1 of tectonic will overwrite these positions anyway.
  const cols = Math.ceil(Math.sqrt(N_REGIONS));
  const rows = Math.ceil(N_REGIONS / cols);
  /** @type {{q:number,r:number}[]} */
  const offsets = [];
  for (let i = 0; i < N_REGIONS; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    offsets.push({
      q: Math.round((col - (cols - 1) / 2) * SPACING),
      r: Math.round((row - (rows - 1) / 2) * SPACING),
    });
  }

  // Regions
  const regions = [];
  for (let i = 0; i < N_REGIONS; i++) {
    const region = new Region(`pkg${i + 1}`);
    m.addRegion(region);
    regions.push(region);
  }

  // Vary sizes deterministically
  const sizes = regions.map(() =>
    MIN_SIZE + Math.floor(rand() * (MAX_SIZE - MIN_SIZE + 1)),
  );

  // Place nodes via compact spiral around each cluster offset
  const nodes = [];
  regions.forEach((region, ri) => {
    const { q: oq, r: or } = offsets[ri];
    const cells = spiralCells(sizes[ri]);
    cells.forEach((c, i) => {
      const n = new Node(`${region.id}-${i}`, { q: oq + c.q, r: or + c.r });
      m.addNode(n);
      region.add(n);
      nodes.push(n);
    });
  });

  // Links: 3 types, deterministic picks. Skew the distribution so
  // there are LOTS of cross-region links between clusters that need
  // to find each other → drift has work to do.
  const types = /** @type {const} */ (['call', 'import', 'ref']);
  let kept = 0;
  let attempts = 0;
  while (kept < N_LINKS && attempts < N_LINKS * 4) {
    attempts++;
    const a = nodes[Math.floor(rand() * nodes.length)];
    const b = nodes[Math.floor(rand() * nodes.length)];
    if (a === b) continue;
    const type = types[Math.floor(rand() * types.length)];
    const weight = 1 + Math.floor(rand() * 4);
    m.addLink(new Link(a, b, weight, type));
    kept++;
  }

  // Demo route across several regions
  const pick = (i) => nodes[Math.min(i, nodes.length - 1)];
  m.addRoute(new Route('demo-route', [
    [pick(0), pick(20), pick(60), pick(110), pick(160)],
    [pick(50), pick(90), pick(140), pick(190)],
  ], '#ffcc00'));
}

/**
 * First N cells of a compact hex cluster around origin, ordered by
 * hex-distance then (q, r) for determinism. Brute-force (O(R²)) but
 * correct — the earlier spiral walker produced duplicates at ring
 * transitions which broke addNode invariants.
 */
function spiralCells(n) {
  const R = Math.ceil(Math.sqrt(n)) + 2;
  /** @type {{q:number,r:number,d:number}[]} */
  const all = [];
  for (let q = -R; q <= R; q++) {
    for (let r = -R; r <= R; r++) {
      const d = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
      if (d <= R) all.push({ q, r, d });
    }
  }
  all.sort((a, b) => a.d - b.d || a.q - b.q || a.r - b.r);
  return all.slice(0, n).map((c) => ({ q: c.q, r: c.r }));
}

// ── Hit-testing + tooltip ───────────────────────────────────────
// Priority: link (thin target wins first), then node/hull depending
// on current render mode. Scene → pixel conversion accounts for the
// renderer's origin translation.
const tooltip = /** @type {HTMLDivElement} */ (document.getElementById('tooltip'));

/** Distance from point P to segment AB in pixel space. O(1). */
function pointToSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/**
 * Point-in-polygon via ray casting. `poly` is a closed loop of
 * {x, y} points. Odd/even parity → inside. For multi-loop regions
 * (holes/disjoint islands), XOR the per-loop results.
 */
function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const hits = (yi > py) !== (yj > py) &&
                 px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (hits) inside = !inside;
  }
  return inside;
}

function pointInLoops(px, py, loops) {
  let inside = false;
  for (const loop of loops) if (pointInPoly(px, py, loop)) inside = !inside;
  return inside;
}

function showTooltipAt(html, mx, my) {
  tooltip.innerHTML = html;
  tooltip.style.display = 'block';
  tooltip.style.left = (mx + 14) + 'px';
  tooltip.style.top = (my + 14) + 'px';
}

function hideTooltip() {
  tooltip.style.display = 'none';
}

// ── Pan / zoom ──────────────────────────────────────────────────
let dragging = false;
let dragStart = null;

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // left button only
  dragging = true;
  dragStart = { mx: e.clientX, my: e.clientY, panX: view.panX, panY: view.panY };
  canvas.style.cursor = 'grabbing';
});
window.addEventListener('mouseup', (e) => {
  // Distinguish click from drag: if the cursor hardly moved (≤4 px) from
  // mousedown position, treat as a click. Click over a node toggles its
  // pinned state — pinned nodes keep their links drawn after the mouse
  // leaves them.
  if (dragStart) {
    const dx = e.clientX - dragStart.mx;
    const dy = e.clientY - dragStart.my;
    if (dx * dx + dy * dy <= 16) {
      // It was a click, not a drag
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { sx, sy } = screenToScene(mx, my);
      const eHex = effectiveHex();
      const { q, r } = pixelToAxial(sx, sy, eHex);
      const clicked = map.nodeAt(q, r);
      if (clicked) {
        if (pinnedNodes.has(clicked.id)) pinnedNodes.delete(clicked.id);
        else pinnedNodes.add(clicked.id);
        draw();
      }
    }
  }
  dragging = false;
  dragStart = null;
  canvas.style.cursor = '';
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const beforeSx = mx - originX();
  const beforeSy = my - originY();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newZoom = Math.max(0.005, Math.min(6, view.zoom * factor));
  const ratio = newZoom / view.zoom;
  view.zoom = newZoom;
  view.panX = (mx - beforeSx * ratio) - canvas.width / 2;
  view.panY = (my - beforeSy * ratio) - canvas.height / 2;
  recomputeLodFromZoom();
  draw();
}, { passive: false });

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  if (dragging && dragStart) {
    view.panX = dragStart.panX + (e.clientX - dragStart.mx);
    view.panY = dragStart.panY + (e.clientY - dragStart.my);
    draw();
    hideTooltip();
    return;
  }

  // Hit-tests use scene-pixel coords (origin-relative) and the
  // current effective hex size so they match what render drew.
  const { sx, sy } = screenToScene(mx, my);
  const eHex = effectiveHex();

  // Hover-for-links: always track which node is under the pointer so
  // the renderer can draw only its incident links. Pin set is untouched
  // here — that's click-driven. Redraw only when hovered node changes
  // to avoid flooding the frame loop.
  {
    const { q, r } = pixelToAxial(sx, sy, eHex);
    const under = map.nodeAt(q, r) ?? null;
    if (under !== hoveredNode) {
      hoveredNode = under;
      draw();
    }
  }

  // 1. Link hit — only when links are actually rendered.
  let linkHit = null;
  let best = 8;
  if (showLinks) for (const l of map.links) {
    const a = axialToPixel(l.source.coord, eHex);
    const b = axialToPixel(l.target.coord, eHex);
    const d = pointToSegDist(sx, sy, a.x, a.y, b.x, b.y);
    if (d < best) { best = d; linkHit = l; }
  }
  if (linkHit) {
    const color = linkColor(linkHit.type);
    showTooltipAt(`
      <b style="color:${color}">${linkHit.type}</b>
      &nbsp;<span style="color:#8a99a8">w=${linkHit.weight}</span>
      &nbsp;<span style="color:#8a99a8">len=${linkHit.length()}</span><br>
      ${linkHit.source.id} <span style="color:${color}">→</span> ${linkHit.target.id}
    `, mx, my);
    return;
  }

  // 1.5 LOD-hull hit: when LOD overlays are active, find the deepest
  // folder hull containing the pointer. Polygons are computed from the
  // layer's coord list via the same hull tracer the renderer uses, so
  // the visible outline is exactly what we hit-test against.
  if (loadedTree && map.lod < map.lodMax && window.__currentHullLayers) {
    const layers = window.__currentHullLayers;
    let hit = null;
    // Iterate deepest first so the most specific folder wins.
    const sorted = [...layers].sort((a, b) => b._depth - a._depth);
    for (const layer of sorted) {
      if (!layer.coords || layer.coords.length === 0) continue;
      const loops = computeHullPolygons(layer.coords, eHex);
      if (pointInLoops(sx, sy, loops)) { hit = layer; break; }
    }
    if (hit) {
      showTooltipAt(`
        <b style="color:${hit.strokeColor}">${hit.path}</b><br>
        depth: ${hit.depth} · tiles: ${hit.size}
      `, mx, my);
      return;
    }
  }

  // 2. Mode-dependent hit:
  //    - hull mode   → point-in-polygon on each region's hull loops
  //    - per-hex mode → axial round of mouse, then spatial-index lookup
  if (fillRegions) {
    for (const region of map.regions.values()) {
      if (region.nodes.size === 0) continue;
      const coords = [];
      for (const n of region.nodes) coords.push(n.coord);
      const loops = computeHullPolygons(coords, eHex);
      if (loops.length === 0) continue;
      if (pointInLoops(sx, sy, loops)) {
        const adj = map.adjacentRegions(region);
        const color = regionColor(region.id);
        showTooltipAt(`
          <b style="color:${color}">region · ${region.id}</b><br>
          nodes: ${region.nodes.size}<br>
          adjacent: ${adj.size}
          ${adj.size ? '(' + [...adj].join(', ') + ')' : ''}
        `, mx, my);
        return;
      }
    }
  } else {
    // Axial round: pixelToAxial gives the nearest hex cell directly.
    const { q, r } = pixelToAxial(sx, sy, eHex);
    const node = map.nodeAt(q, r);
    if (node) {
      const color = node.regionId ? regionColor(node.regionId) : '#8a99a8';
      const inRegion = node.regionId ?? '<i>unassigned</i>';
      showTooltipAt(`
        <b style="color:${color}">node · ${node.id}</b><br>
        region: ${inRegion}<br>
        coord: (${node.coord.q}, ${node.coord.r})
      `, mx, my);
      return;
    }
  }

  hideTooltip();
});
canvas.addEventListener('mouseleave', () => {
  hideTooltip();
  if (hoveredNode) {
    hoveredNode = null;
    draw();
  }
});

// ── Go ──────────────────────────────────────────────────────────
// Immediate first draw so the progress overlay has something behind
// it while packing runs.
if (map.nodes.size > 500) fitView();
draw();
// Kick off packing. The initial ring placement is the "before" state
// we show for ~300ms while the pack progress overlay updates; once
// pack finishes we fitView again to the compact blob and redraw.
if (loadedTree) {
  initialPack().then(async () => {
    fitView();
    // Start at the coarsest LOD that fits the blob on screen — the
    // zoom→LOD map will pick a sensible default for the current view.
    recomputeLodFromZoom();
    draw();
    // After initialPack() completes, optionally swap in the Rust-produced
    // layout. Useful for verifying parity between the JS and Rust ports
    // without rebuilding the sandbox to consume Rust-as-default.
    const rustLayout = await loadRustLayout();
    if (rustLayout) {
      const updated = applyRustLayout(map, rustLayout);
      console.log(`applied Rust layout: ${updated} / ${map.nodes.size} nodes positioned from layout-rust.json`);
      console.log(`  stats: pack ${rustLayout.stats?.pack_ms}ms, iswap ${rustLayout.stats?.iswap_ms}ms (${rustLayout.stats?.iswap_swaps} swaps), xswap ${rustLayout.stats?.xswap_ms}ms (${rustLayout.stats?.xswap_swaps} swaps)`);
      fitView();
      draw();
    }
  });
}

/**
 * Map `view.zoom` to a LOD level based on what the viewer can actually
 * SEE, not raw zoom scalar. Two anchor points:
 *
 *   • Min LOD (0 — root hull): blob's display height occupies ≤ 20%
 *     of viewport. Zooming out past that point already shows "too
 *     much" — coarsest grouping is appropriate.
 *   • Max LOD (lodMax — per-hex): viewport fits ≤ 20 hex rows
 *     vertically. Anything denser than that would make per-hex
 *     rendering illegible.
 *
 * Between the two anchors, LOD is log-linearly interpolated so each
 * mouse-wheel notch (which is a constant zoom RATIO) moves LOD by a
 * similar fraction regardless of where you are in the range.
 */
function recomputeLodFromZoom() {
  if (!loadedTree) return;
  // Blob pixel height at zoom = 1 (from current node positions).
  let minY = Infinity, maxY = -Infinity;
  for (const n of map.nodes.values()) {
    const y = axialToPixel(n.coord, HEX).y;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const bboxH = maxY - minY;
  if (bboxH < 1) return;

  const zoomMinLod = (canvas.height * 0.2) / bboxH;
  const zoomMaxLod = canvas.height / (20 * Math.sqrt(3) * HEX);
  const logZ = Math.log(view.zoom);
  const logMin = Math.log(zoomMinLod);
  const logMax = Math.log(zoomMaxLod);
  // Guard against degenerate range (tiny viewport, huge HEX, etc).
  if (logMax <= logMin) { map.lod = map.lodMax; return; }
  const t = (logZ - logMin) / (logMax - logMin);
  map.lod = Math.max(0, Math.min(map.lodMax, Math.round(t * map.lodMax)));
}
// Expose for REPL/debugging in DevTools
window.map = map;
window.redraw = draw;
window.runMonteCarloLayout = runMonteCarloLayout;
window.__tree = () => loadedTree;
window.__view = view;
window.__canvas = canvas;
window.__hover = () => hoveredNode?.id ?? null;
window.__pinned = () => [...pinnedNodes];
