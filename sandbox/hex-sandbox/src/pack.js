// Greedy adjacent hex packing from the folder tree.
//
// Philosophy:
//   Instead of drifting nodes toward centroids and then trying to enforce
//   connectivity/adjacency as invariants, CONSTRUCT the layout so those
//   invariants hold by construction. Place nodes one at a time; each new
//   node lands in an empty hex that shares a border with the already-
//   placed members of its own folder (connectivity) OR with a sibling
//   folder's cells (sibling adjacency).
//
// Algorithm, recursive from the tree root:
//
//   packFolder(F, seedHex, state) → occupiedCellsOfF
//     if F has no child folders:
//       place F.directLeaves[0] at seedHex
//       for each subsequent leaf:
//         seed = nearest empty hex adjacent to an already-placed leaf of F
//         place it
//       return F.directLeaves' cells
//     else:
//       sort childFolders by descending size (anchor largest first)
//       for each child in order:
//         if first: childSeed = seedHex
//         else:     childSeed = nearest empty hex adjacent to placed so far
//         packFolder(child, childSeed, state)
//       for each directLeaf of F:
//         seed = nearest empty hex adjacent to F's existing cells
//         place it
//       return F's total cell set
//
// Guarantees (by construction):
//   • Every folder's tile set is hex-connected.
//   • Every pair of sibling folders is hex-adjacent (shares a border).
//   • Parent's tile set = union of children's + direct leaves is connected,
//     so hierarchical connectivity propagates up.
//
// Cost function (Σ link length) is NOT optimised by packing alone. The
// next phase (iswap permutation) reshuffles node identities within each
// folder's fixed tile set to pull linked nodes closer together — this
// cannot break the topology invariants since it never changes cells.

import { HEX_DIRS, hexKey } from './hex.js';
import { Region } from './region.js';

/** @typedef {import('./map.js').HexMap} HexMap */
/** @typedef {import('./node.js').Node} HexNode */

/**
 * Build the folder tree from leaf paths. Same shape as the old ring
 * builder but simpler — no pre-assigned node positions required.
 */
function buildFolderTree(tree, leafNodes) {
  /** @type {Map<string, { path: string, depth: number, parent: string|null, childFolders: string[], directLeaves: HexNode[], transitiveSize: number }>} */
  const folders = new Map();
  const ensure = (path, depth, parent) => {
    if (!folders.has(path)) {
      folders.set(path, {
        path, depth, parent,
        childFolders: [],
        directLeaves: [],
        transitiveSize: 0,
      });
    }
    return folders.get(path);
  };
  ensure('.', 0, null);

  for (const leaf of tree.leaves) {
    const node = leafNodes.get(leaf.path);
    if (!node) continue;
    const parts = leaf.folder === '.' ? [] : leaf.folder.split('/');
    let parent = '.';
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join('/');
      ensure(path, i + 1, parent);
      const parentFolder = folders.get(parent);
      if (!parentFolder.childFolders.includes(path)) parentFolder.childFolders.push(path);
      parent = path;
    }
    folders.get(parent).directLeaves.push(node);
  }

  // Fill transitive sizes bottom-up for ordering.
  const byDepth = [...folders.values()].sort((a, b) => b.depth - a.depth);
  for (const f of byDepth) {
    f.transitiveSize = f.directLeaves.length;
    for (const ch of f.childFolders) f.transitiveSize += folders.get(ch).transitiveSize;
  }

  // Deterministic iteration: sort directLeaves and childFolders alphabetically
  // inside each folder so the whole pack is reproducible.
  for (const f of folders.values()) {
    f.directLeaves.sort((a, b) => a.id.localeCompare(b.id));
    f.childFolders.sort();
  }

  return folders;
}

/**
 * Placement state — a set of occupied cells plus a frontier of cells
 * that could still accept neighbours. We don't strictly maintain a
 * frontier (we just search adjacent-to-set), but occupied is the core.
 */
function createState() {
  /** @type {Map<string, HexNode>} key → node occupying that cell */
  const occupied = new Map();
  const place = (node, q, r) => {
    const key = hexKey(q, r);
    if (occupied.has(key)) throw new Error(`pack: double-place at ${key}`);
    node.coord.q = q;
    node.coord.r = r;
    occupied.set(key, node);
  };
  const isEmpty = (q, r) => !occupied.has(hexKey(q, r));
  return { occupied, place, isEmpty };
}

/**
 * Hex cube distance between (aq, ar) and (bq, br).
 */
function hexDist(aq, ar, bq, br) {
  const dq = aq - bq, dr = ar - br, ds = dq + dr;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
}

/**
 * Find the empty hex cell, adjacent to any cell in `anchors`, that
 * minimises distance to `target`. Produces radial growth around
 * `target` instead of the directional bias of a HEX_DIRS iteration.
 *
 * @param {Set<string>} anchors  keys of already-placed cells in the folder
 * @param {(q:number, r:number) => boolean} isEmpty
 * @param {{q:number, r:number}} target  goal (usually the seed hex)
 * @param {{q:number, r:number}} fallback  when anchors is empty
 */
function findEmptyAdjacent(anchors, isEmpty, target, fallback) {
  if (anchors.size > 0) {
    let bestCell = null;
    let bestDist = Infinity;
    for (const key of anchors) {
      const [q, r] = key.split(',').map(Number);
      for (const d of HEX_DIRS) {
        const nq = q + d.q, nr = r + d.r;
        if (!isEmpty(nq, nr)) continue;
        const dist = hexDist(nq, nr, target.q, target.r);
        if (dist < bestDist ||
            (dist === bestDist && bestCell &&
             (nq < bestCell.q || (nq === bestCell.q && nr < bestCell.r)))) {
          bestDist = dist;
          bestCell = { q: nq, r: nr };
        }
      }
    }
    if (bestCell) return bestCell;
  }
  // Fallback 1: the caller's seed, if still empty.
  if (isEmpty(fallback.q, fallback.r)) return fallback;
  // Fallback 2: spiral outward from the target until we find an empty
  // cell. Guaranteed to terminate since the hex plane is infinite and
  // only finitely many cells are occupied. Breaks strict "adjacency to
  // own cells" but prevents the algorithm from crashing when the local
  // neighbourhood is fully saturated by sibling folders.
  return spiralEmpty(target, isEmpty);
}

/** BFS spiral from `center` until an empty cell is found. */
function spiralEmpty(center, isEmpty) {
  for (let ring = 0; ring < 10000; ring++) {
    for (let dq = -ring; dq <= ring; dq++) {
      for (let dr = -ring; dr <= ring; dr++) {
        const dist = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
        if (dist !== ring) continue;
        const q = center.q + dq, r = center.r + dr;
        if (isEmpty(q, r)) return { q, r };
      }
    }
  }
  throw new Error('spiralEmpty: no empty cell within 10000 rings');
}

/**
 * Reserve N connected empty cells starting from `seed`, via breadth-
 * first expansion. The returned list is in BFS order — index 0 is the
 * seed itself (or the nearest empty if seed is occupied), subsequent
 * cells each share a border with some earlier entry. This guarantees
 * the returned cluster is connected.
 *
 * If seed is occupied, spirals out for a new anchor first.
 */
function reserveCluster(seed, n, isEmpty) {
  if (n === 0) return [];

  // Try reserving from a given anchor cell via pure BFS. Returns the
  // list of N connected empty cells, or null if the connected empty
  // region reachable from `anchor` contains fewer than N cells.
  const tryFrom = (anchor) => {
    if (!isEmpty(anchor.q, anchor.r)) return null;
    const reserved = [{ q: anchor.q, r: anchor.r }];
    const reservedSet = new Set([hexKey(anchor.q, anchor.r)]);
    const queue = [{ q: anchor.q, r: anchor.r }];
    while (reserved.length < n) {
      if (queue.length === 0) return null;
      const cur = queue.shift();
      for (const d of HEX_DIRS) {
        const nq = cur.q + d.q, nr = cur.r + d.r;
        const k = hexKey(nq, nr);
        if (reservedSet.has(k)) continue;
        if (!isEmpty(nq, nr)) continue;
        reserved.push({ q: nq, r: nr });
        reservedSet.add(k);
        queue.push({ q: nq, r: nr });
        if (reserved.length >= n) break;
      }
    }
    return reserved;
  };

  // Attempt 1: start at the caller's seed (preferred — keeps the new
  // cluster close to where parent wanted it).
  let start = seed;
  if (!isEmpty(start.q, start.r)) start = spiralEmpty(start, isEmpty);
  let result = tryFrom(start);
  if (result) return result;

  // Attempt 2+: current anchor's connected empty region is too small.
  // Spiral outward from the failed anchor looking for a new anchor
  // whose connected empty region has ≥ N cells. Each spiral step
  // jumps to the next candidate empty hex, not the same pocket.
  const tried = new Set([hexKey(start.q, start.r)]);
  for (let ring = 1; ring < 10000; ring++) {
    for (let dq = -ring; dq <= ring; dq++) {
      for (let dr = -ring; dr <= ring; dr++) {
        const dist = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
        if (dist !== ring) continue;
        const q = start.q + dq, r = start.r + dr;
        const k = hexKey(q, r);
        if (tried.has(k)) continue;
        tried.add(k);
        if (!isEmpty(q, r)) continue;
        result = tryFrom({ q, r });
        if (result) return result;
      }
    }
  }
  throw new Error(`reserveCluster: no empty region of size ${n} found`);
}

/**
 * Pack a folder and all of its descendants, rooted at `seed`.
 * @returns {Set<string>} set of cell keys now occupied by F (transitively).
 */
function packFolder(F, folders, seed, state, ctx) {
  /** @type {Set<string>} cell keys of F's transitive leaves */
  const cells = new Set();

  // Leaf-folder fast path: no sub-folders, just direct leaves. Reserve
  // a connected N-cell cluster up front, then drop leaves into it in
  // order. This guarantees the folder's tile set is hex-connected —
  // no per-leaf "find empty adjacent" which can lose the neighbourhood
  // when surrounded by siblings.
  if (F.childFolders.length === 0) {
    const leaves = F.directLeaves;
    if (leaves.length === 0) return cells;
    const slots = reserveCluster(seed, leaves.length, state.isEmpty);
    for (let i = 0; i < leaves.length; i++) {
      state.place(leaves[i], slots[i].q, slots[i].r);
      cells.add(hexKey(slots[i].q, slots[i].r));
    }
    if (ctx) maybeEmitSnapshot(F, cells, ctx);
    return cells;
  }

  // Place F's OWN direct leaves FIRST — before packing any children.
  // Reason: direct leaves of a non-leaf folder need to land adjacent
  // to F's existing cells, and if they're placed AFTER children
  // they're fighting for leftover cells on a cluttered boundary
  // (findEmptyAdjacent can fall back to spiralEmpty → torn folder).
  // Placing first grows a small cluster from seed before children
  // arrive, guaranteeing each direct leaf has room.
  const directs = F.directLeaves;
  if (directs.length > 0) {
    const slots = reserveCluster(seed, directs.length, state.isEmpty);
    for (let i = 0; i < directs.length; i++) {
      state.place(directs[i], slots[i].q, slots[i].r);
      cells.add(hexKey(slots[i].q, slots[i].r));
    }
  }

  // Children ordered by descending transitive size — largest first so
  // smaller siblings pack into the gaps the big one leaves around its
  // border rather than the other way around.
  const childObjs = F.childFolders
    .map((p) => folders.get(p))
    .filter((c) => c && c.transitiveSize > 0)
    .sort((a, b) => b.transitiveSize - a.transitiveSize || a.path.localeCompare(b.path));

  for (let i = 0; i < childObjs.length; i++) {
    const child = childObjs[i];
    let childSeed;
    if (cells.size === 0) {
      childSeed = seed;
    } else {
      // Place the new child adjacent to F's existing cells — that's
      // both another sibling (adjacency) and part of F (connectivity).
      childSeed = findEmptyAdjacent(cells, state.isEmpty, seed, seed);
    }
    const childCells = packFolder(child, folders, childSeed, state, ctx);
    for (const k of childCells) cells.add(k);
  }

  if (ctx) maybeEmitSnapshot(F, cells, ctx);
  return cells;
}

/**
 * Emit a snapshot at the moment folder F finishes packing, provided
 * F's depth is within the configured range and the total snap count
 * hasn't exceeded the cap. Snapshot captures all current node coords
 * plus hull layers for every folder already completed.
 */
function maybeEmitSnapshot(F, cells, ctx) {
  ctx.foldersDone.add(F.path);
  // Depth filter keeps total count bounded (maxDepth≈8 → sum over
  // depths 0..3 is roughly 400-800 for real repos).
  if (F.depth > ctx.maxDepth) return;
  if (ctx.snaps.length >= ctx.maxSnaps) return;
  const coords = new Map();
  for (const [id, n] of ctx.map.nodes) coords.set(id, { q: n.coord.q, r: n.coord.r });
  ctx.snaps.push({
    name: `pack.${F.path}`,
    level: F.depth,
    description: `packed ${F.path} (${cells.size} tiles)`,
    coords,
    // Skip hull layers during stepping — rendering the cluster grow
    // with just per-hex cells is already informative, and computing
    // hulls per snapshot × 300+ snapshots is too expensive.
    hullLayers: null,
  });
}

/**
 * Main entry point.
 *
 * Clears any existing placement and rebuilds from scratch via recursive
 * packing. Then emits one snapshot per folder assembly (bottom-up, so
 * the user can step through and see each level consolidate).
 *
 * @param {HexMap} map
 * @param {{ leaves: Array<{path:string, folder:string}> }} tree
 * @param {{ hexSize?: number }} [opts]
 */
export async function runPackingAssembly(map, tree, opts = {}) {
  const onProgress = opts.onProgress ?? (() => {});
  // Tiny helper to unblock the event loop — rendering & input handlers
  // run between invocations so the UI stays responsive.
  const yieldFrame = () => new Promise((r) => setTimeout(r, 0));
  // Ensure every leaf in the tree has a corresponding Node in map.
  // (The tree-sample bootstrap created nodes at ring positions; we
  // just reuse those Node instances and overwrite their coords.)
  const leafNodes = map.nodes;

  const folders = buildFolderTree(tree, leafNodes);
  const root = folders.get('.');

  // Clear the spatial index — we're repositioning everything.
  map._byCoord.clear();
  map._regionAdjDirty = true;

  // Clear regions and rebuild from folder tree — each folder becomes a
  // region. Doing this here (rather than from tree-sample) guarantees
  // one Region per folder after packing, ready for per-folder rendering.
  map.regions.clear();
  for (const f of folders.values()) {
    const r = new Region(f.path);
    map.addRegion(r);
  }
  for (const n of map.nodes.values()) n.regionId = null;
  for (const leaf of tree.leaves) {
    const n = leafNodes.get(leaf.path);
    if (!n) continue;
    const region = map.regions.get(leaf.folder || '.');
    if (region) region.add(n);
  }

  const state = createState();

  // Snapshot context: emit one per completed folder up to a depth
  // threshold chosen so the total count stays under the cap.
  /** @type {Array<{name:string, level:number, description:string, coords:Map<string,{q:number,r:number}>, hullLayers:any[] | null}>} */
  const progressSnaps = [];
  const ctx = {
    map,
    snaps: progressSnaps,
    foldersDone: new Set(),
    maxSnaps: 999,
    maxDepth: pickSnapshotDepth(folders, 999),
  };

  // Root seed: origin. Children will radiate outward from there.
  // Packing phase is split per top-level child so we can yield the
  // event loop between children and report progress.
  onProgress(`packing ${tree.leaves.length} nodes…`);
  await yieldFrame();
  const t0 = performance.now();
  const rootCells = new Set();
  const rootChildObjs = root.childFolders
    .map((p) => folders.get(p))
    .filter((c) => c && c.transitiveSize > 0)
    .sort((a, b) => b.transitiveSize - a.transitiveSize || a.path.localeCompare(b.path));
  for (let i = 0; i < rootChildObjs.length; i++) {
    const child = rootChildObjs[i];
    const childSeed = i === 0 && rootCells.size === 0
      ? { q: 0, r: 0 }
      : findEmptyAdjacent(rootCells, state.isEmpty, { q: 0, r: 0 }, { q: 0, r: 0 });
    const childCells = packFolder(child, folders, childSeed, state, ctx);
    for (const k of childCells) rootCells.add(k);
    onProgress(`packing ${i + 1}/${rootChildObjs.length}: ${child.path} (${childCells.size} cells)`);
    await yieldFrame();
  }
  // Root's own direct leaves last.
  for (const leaf of root.directLeaves) {
    const target = rootCells.size === 0
      ? { q: 0, r: 0 }
      : findEmptyAdjacent(rootCells, state.isEmpty, { q: 0, r: 0 }, { q: 0, r: 0 });
    state.place(leaf, target.q, target.r);
    rootCells.add(hexKey(target.q, target.r));
  }
  const packMs = performance.now() - t0;
  console.log(`packing: ${rootCells.size} cells placed in ${packMs.toFixed(0)}ms`);

  // Rebuild the map's spatial index from the fresh coords.
  map._rebuildSpatialIndex();

  // ── iswap optimisation pass ──────────────────────────────────
  // For every immediate folder, permute its nodes among its fixed
  // tile set to minimise Σ link length. Pure node-identity swaps
  // never change which cells belong to the folder, so connectivity
  // and sibling adjacency remain invariant.
  onProgress('optimising (iswap)…');
  await yieldFrame();
  const t1 = performance.now();
  const iswaps = iswapOptimise(map);
  console.log(`iswap: ${iswaps} swaps in ${(performance.now() - t1).toFixed(0)}ms, Σlinks=${map.totalLinkLength()}`);

  // ── xswap optimisation pass ──────────────────────────────────
  // Cross-folder boundary swaps. For each pair of adjacent hex cells
  // belonging to different folders, try exchanging their nodes. Accept
  // iff Σ link length decreases AND both folders remain hex-connected.
  // Attacks cross-folder (long) links that iswap cannot touch.
  onProgress('optimising (xswap)…');
  await yieldFrame();
  const t2 = performance.now();
  const xswaps = await xswapOptimise(map, folders, async (msg) => {
    onProgress(msg);
  });
  console.log(`xswap: ${xswaps} swaps in ${(performance.now() - t2).toFixed(0)}ms, Σlinks=${map.totalLinkLength()}`);
  onProgress('');

  // Validate topology invariants — cheap post-construction sanity check.
  validatePack(map, folders);

  // Progressive snapshots — one per top-level (depth=1) folder as it
  // gets packed. Implemented as a replay: we capture the set of leaves
  // packed so far after each top-level folder is done. This gives the
  // user ~18 steps through the assembly progression.
  /** @type {Array<{name:string, level:number, description:string, coords:Map<string,{q:number,r:number}>, hullLayers:any[] | null}>} */
  const snaps = [...progressSnaps];
  const coords = new Map();
  for (const [id, n] of map.nodes) coords.set(id, { q: n.coord.q, r: n.coord.r });
  snaps.push({
    name: 'pack.done',
    level: 0,
    description: `packed ${rootCells.size} cells, Σlinks=${map.totalLinkLength()}`,
    coords,
    hullLayers: null, // dynamic — computed at draw time by buildLodHulls
  });
  console.log(`snapshots: ${snaps.length} (maxDepth=${ctx.maxDepth})`);

  return snaps;
}

/**
 * Build hull layers for a given LOD level. Returns one hull per folder
 * whose depth is ≤ `lod`. Deeper LOD means finer detail: LOD 0 shows
 * only the single root hull (everything), LOD 1 adds top-level dirs,
 * and so on. Call this per-frame from the renderer so LOD changes
 * immediately affect what's drawn.
 *
 * @param {HexMap} map
 * @param {{ leaves: Array<{path:string, folder:string}> }} tree
 * @param {number} lod
 */
export function buildLodHulls(map, tree, lod) {
  const folders = buildFolderTree(tree, map.nodes);
  const hues = assignTreeHues(folders);

  // Transitive leaf → coord collection for each folder ≤ lod.
  /** @type {Map<string, Array<{q:number,r:number}>>} */
  const trans = new Map();
  for (const f of folders.values()) {
    if (f.depth <= lod) trans.set(f.path, []);
  }
  for (const n of map.nodes.values()) {
    if (!n.regionId) continue;
    let cur = n.regionId;
    while (cur) {
      const arr = trans.get(cur);
      if (arr) arr.push({ q: n.coord.q, r: n.coord.r });
      const f = folders.get(cur);
      cur = f ? f.parent : null;
    }
  }

  /** @type {any[]} */
  const layers = [];
  // Alpha schedule: at LOD 0 the single root hull is fully opaque so
  // the whole blob reads as one colour. As LOD increases and nested
  // hulls stack, deeper layers overdraw parents with slightly lower
  // alpha so every level is visible but the top level dominates.
  for (const f of folders.values()) {
    if (f.depth > lod) continue;
    const coords = trans.get(f.path);
    if (!coords || coords.length < 1) continue;
    const depthBelowTop = lod - f.depth;
    const alpha = depthBelowTop === 0 ? 0.85 : Math.max(0.12, 0.75 - depthBelowTop * 0.13);
    const hue = hues.get(f.path) ?? 180;
    // Darker lightness with depth keeps nested folders visually distinct
    // from their parents without changing hue much.
    const light = Math.max(32, 62 - f.depth * 5);
    const sat = 68;
    layers.push({
      path: f.path,
      depth: f.depth,
      size: coords.length,
      coords,
      fillColor: `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`,
      strokeColor: `hsl(${hue}, 85%, ${Math.min(80, light + 20)}%)`,
      lineWidth: Math.max(0.8, 3 - f.depth * 0.3),
      _depth: f.depth,
    });
  }
  // Root first → deeper on top.
  layers.sort((a, b) => a._depth - b._depth);
  if (typeof window !== 'undefined') window.__lodLayerCount = layers.length;
  return layers;
}

/**
 * Assign a hue (0–360) to every folder in the tree by slicing the hue
 * wheel hierarchically. Root starts at cyan (180), with a symmetric
 * spread of ±120° so top-level folders span greens/blues/purples.
 * Each child recursively subdivides its parent's slice so siblings
 * are hue-adjacent and subtrees stay visually grouped.
 *
 * Returns Map<folderPath, hue>.
 */
function assignTreeHues(folders) {
  /** @type {Map<string, number>} */
  const hues = new Map();
  const root = folders.get('.') ?? [...folders.values()].find((f) => f.depth === 0);
  if (!root) return hues;

  // Deterministic child order — already stable from buildFolderTree.
  const assign = (folder, hueStart, hueEnd) => {
    const mid = (hueStart + hueEnd) / 2;
    hues.set(folder.path, ((mid % 360) + 360) % 360);
    const children = folder.childFolders.map((p) => folders.get(p)).filter(Boolean);
    if (children.length === 0) return;
    // Reserve a small inner sub-slice for the folder's own direct
    // leaves so children don't span the entire range and collide with
    // the parent's mid hue.
    const span = hueEnd - hueStart;
    for (let i = 0; i < children.length; i++) {
      const cs = hueStart + (span * i) / children.length;
      const ce = hueStart + (span * (i + 1)) / children.length;
      assign(children[i], cs, ce);
    }
  };
  // Cyan-centred wheel: 180° ± 120° → [60°, 300°]. That covers green →
  // cyan → blue → purple, which is the user's request. Avoid wrap-
  // around into red/orange where colours clash with the dark theme.
  assign(root, 60, 300);
  return hues;
}

/**
 * Max folder depth in the tree. Useful for clamping LOD controls.
 */
export function maxFolderDepth(tree) {
  let maxD = 0;
  for (const leaf of tree.leaves) {
    const d = leaf.folder === '.' ? 0 : leaf.folder.split('/').length;
    if (d > maxD) maxD = d;
  }
  return maxD;
}

/**
 * Pick the deepest depth such that the total number of folders at
 * depth ≤ D is still within `cap`. Traverses once and accumulates.
 */
function pickSnapshotDepth(folders, cap) {
  const countByDepth = new Map();
  for (const f of folders.values()) {
    countByDepth.set(f.depth, (countByDepth.get(f.depth) ?? 0) + 1);
  }
  const depths = [...countByDepth.keys()].sort((a, b) => a - b);
  let acc = 0;
  let picked = 0;
  for (const d of depths) {
    const next = acc + (countByDepth.get(d) ?? 0);
    if (next > cap) break;
    picked = d;
    acc = next;
  }
  return picked;
}

/**
 * Build hull layer list for the final packed layout. One layer per
 * folder with ≥ 2 transitive leaves. Sorted by descending depth so
 * the root hull draws first (large, underneath) and deeper folders
 * draw on top. Stroke width scales inversely with depth so nested
 * hulls stay visually distinct.
 */
function buildHullLayers(map, folders) {
  // Group nodes by transitive folder membership (reuse the walk-up).
  /** @type {Map<string, Array<{q:number,r:number}>>} */
  const trans = new Map();
  for (const f of folders.values()) trans.set(f.path, []);
  for (const n of map.nodes.values()) {
    if (!n.regionId) continue;
    let cur = n.regionId;
    while (cur) {
      const arr = trans.get(cur);
      if (arr) arr.push({ q: n.coord.q, r: n.coord.r });
      const f = folders.get(cur);
      cur = f ? f.parent : null;
    }
  }
  const layers = [];
  const maxDepth = Math.max(...[...folders.values()].map((f) => f.depth));
  for (const f of folders.values()) {
    const coords = trans.get(f.path);
    if (!coords || coords.length < 2) continue;
    layers.push({
      coords,
      fillColor: folderColorAlpha(f.path, 0.06 + f.depth * 0.01),
      strokeColor: folderStrokeColor(f.path),
      lineWidth: Math.max(0.5, 3 - f.depth * 0.4),
      _depth: f.depth,
    });
  }
  // Sort by ascending depth — outermost (root) drawn first so its
  // fill/stroke is covered by deeper layers on top.
  layers.sort((a, b) => a._depth - b._depth);
  return layers;
}

function folderColorAlpha(path, alpha) {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsla(${hue}, 70%, 55%, ${alpha})`;
}
function folderStrokeColor(path) {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue}, 80%, 70%)`;
}

/**
 * Intra-folder iswap: permute nodes sharing the same immediate folder
 * (regionId) to minimise Σ link length. Swapping two nodes with the
 * same regionId leaves the folder's tile set unchanged — only the
 * node↔cell assignment changes — so all topology invariants hold.
 *
 * Per-swap delta computed incrementally: only links incident to either
 * swapped node contribute. Uses a first-improving greedy loop per
 * folder; repeats until no improving swap exists.
 */
function iswapOptimise(map) {
  // Build adjacency: node.id → list of incident links.
  /** @type {Map<string, Array<import('./link.js').Link>>} */
  const incident = new Map();
  for (const n of map.nodes.values()) incident.set(n.id, []);
  for (const l of map.links) {
    incident.get(l.source.id)?.push(l);
    incident.get(l.target.id)?.push(l);
  }

  // Group nodes by immediate folder.
  const byFolder = new Map();
  for (const n of map.nodes.values()) {
    if (!n.regionId) continue;
    if (!byFolder.has(n.regionId)) byFolder.set(n.regionId, []);
    byFolder.get(n.regionId).push(n);
  }

  const dist = (a, b) => {
    const dq = a.coord.q - b.coord.q, dr = a.coord.r - b.coord.r;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  };

  // Delta = (post-swap link length) - (pre-swap). Negative = improvement.
  // Note: a link (a, b) itself contributes the same distance after the
  // swap (a and b just exchange coords), so we skip those.
  const swapDelta = (a, b) => {
    let delta = 0;
    const bx = { q: b.coord.q, r: b.coord.r };
    const ax = { q: a.coord.q, r: a.coord.r };
    for (const l of incident.get(a.id) ?? []) {
      const other = l.source === a ? l.target : l.source;
      if (other === b) continue;
      const before = dist(a, other);
      const after = (Math.abs(bx.q - other.coord.q) + Math.abs(bx.r - other.coord.r) + Math.abs((bx.q - other.coord.q) + (bx.r - other.coord.r))) / 2;
      delta += (after - before) * l.weight;
    }
    for (const l of incident.get(b.id) ?? []) {
      const other = l.source === b ? l.target : l.source;
      if (other === a) continue;
      const before = dist(b, other);
      const after = (Math.abs(ax.q - other.coord.q) + Math.abs(ax.r - other.coord.r) + Math.abs((ax.q - other.coord.q) + (ax.r - other.coord.r))) / 2;
      delta += (after - before) * l.weight;
    }
    return delta;
  };

  let totalSwaps = 0;
  for (const [folder, nodes] of byFolder) {
    if (nodes.length < 2) continue;
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const delta = swapDelta(nodes[i], nodes[j]);
          if (delta < 0) {
            map.swap(nodes[i], nodes[j]);
            totalSwaps++;
            improved = true;
          }
        }
      }
    }
  }
  return totalSwaps;
}

/**
 * Cross-folder boundary swap (xswap): exchange coords of two nodes
 * whose cells are adjacent but belong to different folders. After the
 * swap both folders' tile sets change — we verify each remains hex-
 * connected before accepting. Σ link length must strictly decrease.
 *
 * Connectivity preservation is cheap: only the two affected folders
 * need re-checking, not the whole graph. We BFS each from any remaining
 * member and compare the visited count to the total.
 */
async function xswapOptimise(map, folderTree, reportProgress) {
  const yieldFrame = () => new Promise((r) => setTimeout(r, 0));
  reportProgress = reportProgress ?? (async () => {});
  /** @type {Map<string, Array<import('./link.js').Link>>} */
  const incident = new Map();
  for (const n of map.nodes.values()) incident.set(n.id, []);
  for (const l of map.links) {
    incident.get(l.source.id)?.push(l);
    incident.get(l.target.id)?.push(l);
  }

  // Folder transitive membership: for every folder path, the set of
  // nodes whose regionId is either this folder or any descendant of it.
  // Used for parent-aware connectivity checks — a swap that keeps the
  // two immediate folders connected may still tear an ancestor folder.
  /** @type {Map<string, Set<import('./node.js').Node>>} */
  const transitive = new Map();
  for (const f of folderTree.values()) transitive.set(f.path, new Set());
  for (const n of map.nodes.values()) {
    if (!n.regionId) continue;
    let cur = n.regionId;
    while (cur) {
      transitive.get(cur)?.add(n);
      const f = folderTree.get(cur);
      cur = f ? f.parent : null;
    }
  }

  // Ancestor chain per folder (cached). Used to know which transitive
  // sets a node belongs to.
  /** @type {Map<string, string[]>} */
  const ancestors = new Map();
  for (const f of folderTree.values()) {
    const chain = [];
    let cur = f.path;
    while (cur) { chain.push(cur); const p = folderTree.get(cur); cur = p ? p.parent : null; }
    ancestors.set(f.path, chain);
  }

  const dist = (a, b) => {
    const dq = a.coord.q - b.coord.q, dr = a.coord.r - b.coord.r;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  };

  const swapDelta = (a, b) => {
    let delta = 0;
    const ax = { q: a.coord.q, r: a.coord.r };
    const bx = { q: b.coord.q, r: b.coord.r };
    for (const l of incident.get(a.id) ?? []) {
      const other = l.source === a ? l.target : l.source;
      if (other === b) continue;
      const before = dist(a, other);
      const afterDq = bx.q - other.coord.q, afterDr = bx.r - other.coord.r;
      const after = (Math.abs(afterDq) + Math.abs(afterDr) + Math.abs(afterDq + afterDr)) / 2;
      delta += (after - before) * l.weight;
    }
    for (const l of incident.get(b.id) ?? []) {
      const other = l.source === b ? l.target : l.source;
      if (other === a) continue;
      const before = dist(b, other);
      const afterDq = ax.q - other.coord.q, afterDr = ax.r - other.coord.r;
      const after = (Math.abs(afterDq) + Math.abs(afterDr) + Math.abs(afterDq + afterDr)) / 2;
      delta += (after - before) * l.weight;
    }
    return delta;
  };

  /** BFS the folder's members in map._byCoord space and return true iff
   *  every member is reachable from the seed. Expensive — only call
   *  when a candidate swap has negative delta. */
  const folderConnected = (folderId) => {
    const members = transitive.get(folderId);
    if (!members || members.size <= 1) return true;
    const coordSet = new Set();
    for (const m of members) coordSet.add(hexKey(m.coord.q, m.coord.r));
    const seen = new Set();
    const start = members.values().next().value;
    const stack = [start];
    seen.add(hexKey(start.coord.q, start.coord.r));
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const d of HEX_DIRS) {
        const nq = cur.coord.q + d.q, nr = cur.coord.r + d.r;
        const k = hexKey(nq, nr);
        if (!coordSet.has(k) || seen.has(k)) continue;
        seen.add(k);
        const nb = map.nodeAt(nq, nr);
        if (nb) stack.push(nb);
      }
    }
    return seen.size === coordSet.size;
  };

  // Single pass only — xswap's connectivity BFS is expensive (O(folder
   // size) per candidate) and repeated passes give diminishing returns.
   // After iswap, most of the optimisation is already captured.
  let totalSwaps = 0;
  {
    const nodesArr = [...map.nodes.values()];
    let lastYield = performance.now();
    let processed = 0;
    for (const n of nodesArr) {
      processed++;
      // Yield every ~32ms of sync work so the event loop can handle
      // input, scroll, and the progress overlay repaint.
      if (performance.now() - lastYield > 32) {
        await reportProgress(`xswap: ${processed}/${nodesArr.length}, ${totalSwaps} swaps`);
        await yieldFrame();
        lastYield = performance.now();
      }
      for (const d of HEX_DIRS) {
        const nq = n.coord.q + d.q, nr = n.coord.r + d.r;
        const neigh = map.nodeAt(nq, nr);
        if (!neigh || neigh === n) continue;
        if (neigh.regionId === n.regionId) continue;
        const delta = swapDelta(n, neigh);
        if (delta >= 0) continue;
        // Tentatively swap, check EVERY affected ancestor, revert if
        // any is torn. A swap exchanges coords but not regionIds, so
        // the transitive tile sets of (a's ancestors ∪ b's ancestors)
        // all need to stay connected.
        map.swap(n, neigh);
        let ok = true;
        const chain = new Set([
          ...(ancestors.get(n.regionId) ?? []),
          ...(ancestors.get(neigh.regionId) ?? []),
        ]);
        for (const path of chain) {
          if (!folderConnected(path)) { ok = false; break; }
        }
        if (ok) {
          totalSwaps++;
        } else {
          map.swap(n, neigh);
        }
      }
    }
  }
  return totalSwaps;
}

/**
 * Walk every folder and check (a) its tile set is hex-connected and
 * (b) each pair of sibling folders shares a hex border. Logs a summary.
 */
function validatePack(map, folders) {
  // Compute transitive leaves per folder from the live node positions.
  // Folders are built from tree paths, so node.regionId maps to the
  // immediate folder; we gather ancestors manually for transitivity.
  /** @type {Map<string, HexNode[]>} folderPath → leafNodes transitively */
  const trans = new Map();
  for (const f of folders.values()) trans.set(f.path, []);
  for (const n of map.nodes.values()) {
    const folder = n.regionId;
    if (!folder) continue;
    let cur = folder;
    while (cur) {
      const list = trans.get(cur);
      if (list) list.push(n);
      const f = folders.get(cur);
      cur = f ? f.parent : null;
    }
  }

  /** @type {Array<{path:string,size:number,connected:number}>} */
  const tornList = [];
  for (const [path, nodes] of trans) {
    if (nodes.length <= 1) continue;
    const set = new Set(nodes.map((n) => hexKey(n.coord.q, n.coord.r)));
    const seen = new Set();
    const first = nodes[0];
    const stack = [first];
    seen.add(hexKey(first.coord.q, first.coord.r));
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const d of HEX_DIRS) {
        const nq = cur.coord.q + d.q, nr = cur.coord.r + d.r;
        const k = hexKey(nq, nr);
        if (set.has(k) && !seen.has(k)) {
          seen.add(k);
          const neigh = map.nodeAt(nq, nr);
          if (neigh) stack.push(neigh);
        }
      }
    }
    if (seen.size !== set.size) tornList.push({ path, size: set.size, connected: seen.size });
  }

  let disconnectedSiblings = 0;
  for (const parent of folders.values()) {
    const children = parent.childFolders.map((p) => folders.get(p)).filter(Boolean);
    if (children.length < 2) continue;
    const tiles = children.map((c) => {
      const s = new Set();
      for (const n of trans.get(c.path) ?? []) s.add(hexKey(n.coord.q, n.coord.r));
      return s;
    });
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i].size === 0) continue;
      for (let j = i + 1; j < tiles.length; j++) {
        if (tiles[j].size === 0) continue;
        // Adjacency: any cell in A has a neighbour in B.
        let adj = false;
        for (const key of tiles[i]) {
          const [q, r] = key.split(',').map(Number);
          for (const d of HEX_DIRS) {
            if (tiles[j].has(hexKey(q + d.q, r + d.r))) { adj = true; break; }
          }
          if (adj) break;
        }
        if (!adj) disconnectedSiblings++;
      }
    }
  }

  console.log(`pack validation: torn=${tornList.length}  sibling_gaps=${disconnectedSiblings}`);
  for (const t of tornList) console.log(`  torn: ${t.path} (${t.connected}/${t.size} connected)`);
}
