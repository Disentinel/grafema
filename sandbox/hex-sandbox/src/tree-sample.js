// Build a HexMap from a scanned Grafema tree (public/tree.json).
//
// Layout strategy — "leaves linear order on a ring":
//   1. Sort leaves by path (DFS/alphabetical — siblings end up adjacent).
//   2. Place each leaf at angle i × 2π / N on a circle whose
//      circumference ≈ SPACING × N hexes → radius = SPACING × N / (2π).
//   3. Convert polar (R, θ) → pixel → nearest axial hex. On collision
//      (two leaves rounding to the same cell), spiral outward until free.
//
// Regions are immediate parent folders. A huge repo therefore produces
// hundreds of tiny regions — exactly the hierarchy we want to feed the
// recursive SA later.

import { Node } from './node.js';
import { Link } from './link.js';
import { Region } from './region.js';
import { pixelToAxial, hexKey, HEX_DIRS } from './hex.js';

/** Load and decode public/tree.json. */
export async function loadTree(url = './public/tree.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`);
  return res.json();
}

/** Optional — load public/links-real.json if present. Returns null on 404
 *  so callers can fall back to synthetic link generation. */
export async function loadRealLinks(url = './public/links-real.json') {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * @param {import('./map.js').HexMap} m
 * @param {{ leaves: Array<{path:string, folder:string, ext:string, size:number, name:string}> }} tree
 * @param {{
 *   hexSize?: number,
 *   spacing?: number,        // target hex distance between adjacent ring slots
 *   linkRatio?: number,      // links per leaf
 *   seed?: number,
 * }} [opts]
 */
export function buildSampleFromTree(m, tree, opts = {}) {
  const hexSize = opts.hexSize ?? 22;
  const spacing = opts.spacing ?? 2.2;
  const linkRatio = opts.linkRatio ?? 1.5;
  const realLinks = opts.realLinks ?? null;
  let seed = opts.seed ?? 1;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  const leaves = [...tree.leaves].sort((a, b) => a.path.localeCompare(b.path));
  const N = leaves.length;
  if (N === 0) return;

  // Radius so arc-length between neighbours ≈ spacing × hexSize pixels.
  // axialToPixel uses horizontal step = hexSize × 1.5, so one "hex hop"
  // pixel-wise ≈ hexSize × √3 ≈ 1.73 hexSize. Use 1.7 as average.
  const stepPx = spacing * hexSize * 1.7;
  const radiusPx = (stepPx * N) / (2 * Math.PI);

  // Group leaves by region (immediate folder) and create regions lazily.
  const regionMap = new Map();
  const regionForFolder = (folder) => {
    if (!regionMap.has(folder)) {
      const r = new Region(folder || '.');
      m.addRegion(r);
      regionMap.set(folder, r);
    }
    return regionMap.get(folder);
  };

  // Place each leaf at its ring slot; on collision, spiral outward using
  // HEX_DIRS until a free cell is found. At huge N the ring is sparse
  // enough that collisions are rare but small radii still need this.
  const leafToNode = new Map();
  for (let i = 0; i < N; i++) {
    const leaf = leaves[i];
    const theta = (i / N) * Math.PI * 2;
    const px = radiusPx * Math.cos(theta);
    const py = radiusPx * Math.sin(theta);
    let { q, r } = pixelToAxial(px, py, hexSize);

    // Collision resolution: if cell taken, probe neighbours in a
    // deterministic expanding ring.
    if (m.nodeAt(q, r)) {
      let found = false;
      outer: for (let ring = 1; ring <= 20; ring++) {
        // Enumerate cells at hex-distance exactly `ring` around (q, r).
        for (let dq = -ring; dq <= ring; dq++) {
          for (let dr = -ring; dr <= ring; dr++) {
            const dist = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
            if (dist !== ring) continue;
            const nq = q + dq, nr = r + dr;
            if (!m.nodeAt(nq, nr)) { q = nq; r = nr; found = true; break outer; }
          }
        }
      }
      if (!found) continue; // give up — shouldn't happen
    }

    const node = new Node(leaf.path, { q, r }, { ext: leaf.ext, size: leaf.size });
    m.addNode(node);
    const region = regionForFolder(leaf.folder);
    region.add(node);
    leafToNode.set(leaf.path, node);
  }

  // ── Link generation ─────────────────────────────────────────
  // If real links were provided (via scripts/scan-links.mjs), use them
  // instead of the synthetic biased random generator. This makes layout
  // benchmarks reflect actual project topology.
  if (realLinks?.edges?.length) {
    let added = 0;
    for (const e of realLinks.edges) {
      const a = leafToNode.get(e.source);
      const b = leafToNode.get(e.target);
      if (!a || !b || a === b) continue;
      m.addLink(new Link(a, b, e.weight ?? 1, 'import'));
      added++;
    }
    // eslint-disable-next-line no-console
    console.log(`real links: ${added} / ${realLinks.edges.length} matched into map`);
    return;
  }

  // Biased random linking: most edges stay within a folder (the
  // "import-like" tier), some cross to nearby folders (call-like),
  // and a small tail is globally random (ref-like).
  const nodes = [...m.nodes.values()];
  const byFolder = new Map();
  for (const leaf of leaves) {
    if (!leafToNode.has(leaf.path)) continue;
    if (!byFolder.has(leaf.folder)) byFolder.set(leaf.folder, []);
    byFolder.get(leaf.folder).push(leafToNode.get(leaf.path));
  }

  // Precompute folder list sorted — "nearby folder" = a neighbour in this list.
  const folderList = [...byFolder.keys()].sort();
  const folderIdx = new Map(folderList.map((f, i) => [f, i]));

  const linkCount = Math.floor(N * linkRatio);
  let added = 0;
  let attempts = 0;
  const seen = new Set(); // dedupe (a.id + '→' + b.id)
  while (added < linkCount && attempts < linkCount * 6) {
    attempts++;
    const a = nodes[Math.floor(rand() * nodes.length)];
    const roll = rand();
    let b;
    if (roll < 0.7) {
      // import-like: same folder
      const bucket = byFolder.get(a.regionId);
      if (!bucket || bucket.length < 2) continue;
      b = bucket[Math.floor(rand() * bucket.length)];
    } else if (roll < 0.9) {
      // call-like: nearby folder in sorted order (±1..±4)
      const idx = folderIdx.get(a.regionId) ?? 0;
      const offset = (1 + Math.floor(rand() * 4)) * (rand() < 0.5 ? -1 : 1);
      const targetFolder = folderList[((idx + offset) % folderList.length + folderList.length) % folderList.length];
      const bucket = byFolder.get(targetFolder);
      if (!bucket || bucket.length === 0) continue;
      b = bucket[Math.floor(rand() * bucket.length)];
    } else {
      // ref-like: anywhere
      b = nodes[Math.floor(rand() * nodes.length)];
    }
    if (!b || b === a) continue;
    const key = a.id + '→' + b.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const type = roll < 0.7 ? 'import' : roll < 0.9 ? 'call' : 'ref';
    const weight = 1 + Math.floor(rand() * 3);
    m.addLink(new Link(a, b, weight, type));
    added++;
  }
}
