// Monte-Carlo layout refinement on the hex lattice.
//
// STATUS: research artifact, optional refinement — NOT the main layout path.
//
// Greedy `runPackingAssembly` in pack.js is authoritative for all cold-start
// layouts. This module is a ~7% Σlink refinement layer on top of greedy,
// triggered by pressing M in the sandbox. It does not scale well:
// cold-start from a ring reaches ~55% reduction in 15 minutes on 1.5k
// nodes, extrapolated ~25 hours to match greedy's output. For million-node
// targets use greedy directly (or its Rust port once available) and skip
// this refinement layer entirely.
//
// Kept in-tree because the nucleation / force-directed / bent-chain-drag
// machinery is an interesting research substrate. If you come back later
// with fresh ideas (adj-aware forces, parallel tempering, better move set
// for the glassy regime), start from here.
//
// Alternative placement algorithm — complements the greedy `runPackingAssembly`
// in pack.js. This one takes WHATEVER initial placement is currently in the
// map (greedy output, ring, hand-placed) and refines it via Metropolis MC
// with accumulated topology invariants.
//
// Design summary:
//   * Moves: single-atom relocation, two-atom swap, whole-folder drift.
//   * Energy: Σ link length × weight (Chebyshev/cube distance on axial hex).
//   * Temperature: geometric cool from T₀ to T₁, both auto-estimated from a
//     short single-move sample of |ΔE|.
//   * Metropolis acceptance: always for ΔE ≤ 0, else with probability exp(-ΔE/T).
//   * Invariants (append-only):
//       - connected(F): all atoms of folder F form a BFS-connected region
//         on the hex lattice. Registered the moment it first holds; any
//         future move that would break it is rejected.
//       - adj(F, G) for sibling folders F, G at the same tree level:
//         their atoms share at least one hex edge AND cross-folder link flux
//         between them is above a threshold. Once registered, both invariants
//         act as hard constraints on future moves.
//   * Periodic rescan nucleates new invariants when configuration naturally
//     satisfies them — no scheduled/forced snaps, emergence only.
//
// Greedy pack stays authoritative for cold-start; this is the refinement
// layer you run on top when you want to push toward the optimum.

import { HEX_DIRS, hexKey, hexDistance } from './hex.js';

/**
 * @typedef {{ name:string, level:number, description:string,
 *             coords:Map<string,{q:number,r:number}>, hullLayers:any[]|null }} Snapshot
 */

/**
 * Run Monte-Carlo refinement. Returns a snapshot list compatible with
 * the pack.js stepper — demo.js can drop this in place of packSnaps.
 *
 * @param {import('./map.js').HexMap} map
 * @param {{ leaves: Array<{path:string, folder:string}> }} _tree  unused, kept for signature symmetry
 * @param {{
 *   iterations?: number,
 *   adjFluxThreshold?: number,
 *   adjRescanEvery?: number,
 *   connRescanEvery?: number,
 *   snapCount?: number,
 *   seed?: number | null,
 *   onProgress?: (msg: string) => void,
 * }} [opts]
 * @returns {Promise<Snapshot[]>}
 */
export async function runMonteCarloLayout(map, _tree, opts = {}) {
  const {
    // Wall-clock budget for the whole anneal. The loop runs in epochs and
    // stops on whichever comes first: convergence detector or this cap.
    wallClockMs = 15_000,
    // Iterations per epoch. At the boundary we compute acceptance rate
    // and ΔE/iter, decide convergence/reheat, then continue.
    epochSize = null,
    // Hard iteration cap as a safety net; null disables.
    iterations = null,
    adjFluxThreshold = 2,
    adjRescanEvery = 500,
    connRescanEvery = 250,
    snapCount = 80,
    seed = null,
    onProgress = () => {},
    // Hot-path cap: skip BFS connectedness check on folders bigger than
    // this on every move. Big folders stay coherent through the energy
    // function (cross-links penalise islands), and the full check would
    // dominate the inner loop. The initial scan still registers them
    // so their connectedness gets verified periodically in the rescan.
    connCheckMaxSize = 200,
  } = opts;

  const yieldFrame = () => new Promise((r) => setTimeout(r, 0));
  const rng = seed != null ? mulberry32(seed) : Math.random;

  // ── Folder membership ──────────────────────────────────────────
  // Each atom lives in a leaf folder (last '/' segment) and transitively
  // in every ancestor up to the root '.'. We need membership for three
  // things: invariant checks, link-flux LCA calculation, and move
  // proposals (folder drift picks a random folder).
  const { folderAtoms, ancestorsOf, childrenOf } = buildFolderMembership(map);

  // ── Sibling pair index + link flux ──────────────────────────────
  // Sibling pairs = two folders sharing the same parent. Per-link flux
  // is credited to the LCA sibling pair — i.e. the pair of ancestors at
  // the level where source and target diverge. Intra-folder links and
  // self-loops don't contribute.
  const siblingPairs = buildSiblingPairs(childrenOf);
  const linkFlux = computeLinkFlux(map, ancestorsOf);

  // ── Atom-indexed link list ─────────────────────────────────────
  // Delta-E on a move only touches links incident to the moved atom(s),
  // so indexing by atom turns cost computation from O(|L|) to O(degree).
  /** @type {Map<string, Array<import('./link.js').Link>>} */
  const linksByAtom = new Map();
  for (const a of map.nodes.values()) linksByAtom.set(a.id, []);
  for (const l of map.links) {
    linksByAtom.get(l.source.id)?.push(l);
    linksByAtom.get(l.target.id)?.push(l);
  }

  // ── Occupancy index ────────────────────────────────────────────
  // Map from hexKey to atom id. Kept in sync with atom coords on every
  // accepted move; rebuilt once at the end. We maintain it locally
  // rather than using map._byCoord because we skip moveNode's
  // occupancy-check overhead and want plain string keys.
  /** @type {Map<string, string>} */
  const occupancy = new Map();
  for (const a of map.nodes.values()) {
    occupancy.set(hexKey(a.coord.q, a.coord.r), a.id);
  }

  // ── Initial invariant scan ─────────────────────────────────────
  // Whatever's already true on entry is registered immediately — this
  // is the "warm start" property: moving from greedy-pack output to
  // MC refinement inherits all topological structure greedy produced.
  //
  // We only register `connected(F)` for folders whose size is under
  // `connCheckMaxSize`. Large folders' internal connectedness is an
  // emergent consequence of (a) their children being connected and
  // (b) sibling adjacencies chaining them together — no direct BFS
  // needed, and skipping them keeps the hot loop cheap.
  /** @type {Set<string>} */  const connected = new Set();
  /** @type {Set<string>} */  const adj = new Set();
  for (const [fp, ids] of folderAtoms) {
    if (ids.size > connCheckMaxSize) continue;
    if (isFolderConnected(ids, map, occupancy)) connected.add(fp);
  }
  for (const [fpA, fpB] of siblingPairs) {
    const key = adjKey(fpA, fpB);
    const flux = linkFlux.get(key) ?? 0;
    if (flux < adjFluxThreshold) continue;
    if (hasHexContact(folderAtoms.get(fpA), folderAtoms.get(fpB), map, occupancy)) {
      adj.add(key);
    }
  }

  // ── Initial energy ─────────────────────────────────────────────
  let energy = 0;
  for (const l of map.links) {
    energy += hexDistance(l.source.coord, l.target.coord) * (l.weight ?? 1);
  }
  const initialEnergy = energy;

  // ── Temperature auto-estimate ──────────────────────────────────
  // Sample ~300 adjacency-swap ΔE magnitudes and set T₀ so typical bad
  // moves have acceptance prob ~0.3, T₁ so only near-zero-cost moves
  // survive the final cooling. Sampling swaps (not single moves) gives
  // a representative distribution for dense packs: single-atom moves
  // almost always hit an occupied cell and skip, leaving the sample
  // dominated by edge-of-blob atoms with tiny ΔE.
  const atomIds = [...map.nodes.keys()];
  if (atomIds.length === 0) return [];
  let sampleSum = 0, sampleCnt = 0;
  for (let trial = 0; trial < 600 && sampleCnt < 300; trial++) {
    const a = map.nodes.get(atomIds[Math.floor(rng() * atomIds.length)]);
    if (!a) continue;
    const dir = HEX_DIRS[Math.floor(rng() * 6)];
    const nq = a.coord.q + dir.q, nr = a.coord.r + dir.r;
    const occId = occupancy.get(hexKey(nq, nr));
    if (!occId || occId === a.id) continue;
    const b = map.nodes.get(occId);
    if (!b) continue;
    let d = 0;
    for (const l of linksByAtom.get(a.id) ?? []) {
      const other = l.source.id === a.id ? l.target : l.source;
      if (other.id === b.id) continue;
      d += (hexDistance(b.coord, other.coord) - hexDistance(a.coord, other.coord)) * (l.weight ?? 1);
    }
    for (const l of linksByAtom.get(b.id) ?? []) {
      const other = l.source.id === b.id ? l.target : l.source;
      if (other.id === a.id) continue;
      d += (hexDistance(a.coord, other.coord) - hexDistance(b.coord, other.coord)) * (l.weight ?? 1);
    }
    sampleSum += Math.abs(d); sampleCnt++;
  }
  const avgDelta = sampleCnt > 0 ? sampleSum / sampleCnt : 5;
  // T₀: typical bad move accepted with prob e^-3 ≈ 5% to e^-1 ≈ 37%.
  // Start at roughly 2× avgDelta so half of bad moves pass at t=0.
  const T0 = Math.max(1, avgDelta * 2);
  const T1 = Math.max(0.05, avgDelta * 0.01);

  // ── Iteration / epoch / snapshot setup ─────────────────────────
  const N = map.nodes.size;
  const effEpoch = epochSize ?? Math.max(2000, Math.floor(N * 2));
  const hardIterCap = iterations ?? Number.POSITIVE_INFINITY;
  // Snapshots spaced by wall-clock: emit roughly `snapCount` over the
  // whole anneal regardless of how many iterations end up running.
  const snapEveryMs = wallClockMs / Math.max(1, snapCount - 1);
  /** @type {Snapshot[]} */
  const snaps = [];
  const captureSnap = (label, iter, T) => {
    const coords = new Map();
    for (const [id, n] of map.nodes) coords.set(id, { q: n.coord.q, r: n.coord.r });
    snaps.push({
      name: label,
      level: 0,
      description: `mc ${iter} T=${T.toFixed(2)} E=${energy.toFixed(0)} conn=${connected.size}/${folderAtoms.size} adj=${adj.size}`,
      coords,
      hullLayers: null,
    });
  };
  captureSnap('mc.init', 0, T0);

  // Folder list for drift proposals.
  //   driftableFolders  — cheap random-direction drift; capped at 120 atoms.
  //   allNonRootFolders — candidate pool for force-directed drift; at
  //                       proposal time we also gate on `connected.has(fp)`,
  //                       because dragging a folder as a unit only makes
  //                       sense after it has nucleated.
  const driftableFolders = [...folderAtoms.keys()].filter(
    (fp) => fp !== '.' && (folderAtoms.get(fp)?.size ?? 0) <= 120,
  );
  const allNonRootFolders = [...folderAtoms.keys()].filter((fp) => fp !== '.');

  // ── Move-proposal helpers ──────────────────────────────────────
  // All helpers close over the outer state (map, occupancy, folderAtoms,
  // linksByAtom) and return a ready-to-apply move object or null.

  const emptyNeighbourCount = (coord) => {
    let n = 0;
    for (const d of HEX_DIRS) {
      if (!occupancy.has(hexKey(coord.q + d.q, coord.r + d.r))) n++;
    }
    return n;
  };

  /** Random swap between atom `a` and whatever atom sits at a.coord + dir. */
  const tryAdjacencySwap = (a, dir) => {
    const nq = a.coord.q + dir.q, nr = a.coord.r + dir.r;
    const occId = occupancy.get(hexKey(nq, nr));
    if (!occId || occId === a.id) return null;
    const b = map.nodes.get(occId);
    if (!b) return null;
    return {
      kind: 'swap', a, b,
      coordA: { q: a.coord.q, r: a.coord.r },
      coordB: { q: b.coord.q, r: b.coord.r },
    };
  };

  /** Hop atom `a` into empty neighbour in direction `dir` (hole-guarded). */
  const tryHoleSafeHop = (a, dir) => {
    const nq = a.coord.q + dir.q, nr = a.coord.r + dir.r;
    if (occupancy.has(hexKey(nq, nr))) return null;
    if (emptyNeighbourCount(a.coord) < 2) return null;
    return {
      kind: 'single', atom: a,
      oldCoord: { q: a.coord.q, r: a.coord.r },
      newCoord: { q: nq, r: nr },
    };
  };

  /** Drift folder `fp` by direction `dir`. Returns null if any destination
   *  cell is occupied by an atom outside the folder. */
  const tryFolderDrift = (fp, dir) => {
    const ids = folderAtoms.get(fp);
    if (!ids) return null;
    /** @type {import('./node.js').Node[]} */
    const fAtoms = [];
    for (const id of ids) {
      const n = map.nodes.get(id);
      if (n) fAtoms.push(n);
    }
    for (const n of fAtoms) {
      const tq = n.coord.q + dir.q, tr = n.coord.r + dir.r;
      const occ = occupancy.get(hexKey(tq, tr));
      if (occ && !ids.has(occ)) return null;
    }
    return { kind: 'drift', fp, ids, fAtoms, dir };
  };

  /** Hierarchical link-force on atom `a`.
   *
   *  The force source depends on which level of the folder hierarchy
   *  has yet to nucleate ("snap"). Starting from the leaf folder and
   *  walking up the ancestor chain, the first folder NOT yet registered
   *  in the `connected` set becomes the active folder for this atom.
   *
   *  - Before the leaf nucleates: pull toward the leaf folder itself
   *    (intra-leaf links if any; otherwise leaf centroid). Goal:
   *    crystallise the leaf.
   *  - After the leaf nucleates but parent hasn't: pull toward parent's
   *    atoms (sibling leaves of this atom's leaf). Goal: crystallise
   *    the parent by gathering its children.
   *  - Recursively up until the root, then fall through to "external"
   *    = all links outside the atom's leaf folder.
   *
   *  This matches the user's nucleation semantics: "before snap force
   *  toward own folder, after snap toward external neighbours", applied
   *  hierarchically so each level self-assembles before the next one up
   *  starts caring about cross-level relationships. */
  const computeAtomForce = (a) => {
    const ancestors = ancestorsOf.get(a.id);
    if (!ancestors) return { q: 0, r: 0 };

    // Deepest ancestor that is NOT yet connected. Ancestors above the
    // size cap (connCheckMaxSize) never enter the `connected` set because
    // we skip their BFS check for cost reasons — but they're not a
    // barrier to hierarchy progress either, so we TREAT them as virtually
    // nucleated and walk past them looking for a trackable smaller level.
    /** @type {string | null} */
    let activeFolder = null;
    for (const fp of ancestors) {
      if (connected.has(fp)) continue;
      const size = folderAtoms.get(fp)?.size ?? 0;
      if (size > connCheckMaxSize) continue; // can't track → assume done
      activeFolder = fp;
      break;
    }

    if (activeFolder === null) {
      // Fully nucleated hierarchy — pull by all external-to-leaf links.
      const leaf = ancestors[0];
      const leafIds = folderAtoms.get(leaf);
      let fq = 0, fr = 0;
      const links = linksByAtom.get(a.id);
      if (!links) return { q: 0, r: 0 };
      for (const l of links) {
        const other = l.source.id === a.id ? l.target : l.source;
        if (leafIds?.has(other.id)) continue;
        const w = l.weight ?? 1;
        fq += (other.coord.q - a.coord.q) * w;
        fr += (other.coord.r - a.coord.r) * w;
      }
      return { q: fq, r: fr };
    }

    // Pre-snap of `activeFolder`: pull toward atoms inside it.
    const activeIds = folderAtoms.get(activeFolder);
    if (!activeIds) return { q: 0, r: 0 };

    // Prefer link-based force if intra-active links exist — they carry
    // weight + direction information the centroid average throws away.
    let fq = 0, fr = 0;
    const links = linksByAtom.get(a.id);
    if (links) {
      for (const l of links) {
        const other = l.source.id === a.id ? l.target : l.source;
        if (!activeIds.has(other.id)) continue;
        const w = l.weight ?? 1;
        fq += (other.coord.q - a.coord.q) * w;
        fr += (other.coord.r - a.coord.r) * w;
      }
    }
    if (fq !== 0 || fr !== 0) return { q: fq, r: fr };

    // No intra-active links (very common for small leaves in real trees
    // where files import across folders, not within). Fall back to the
    // folder's centroid so lone atoms still get dragged toward their
    // group mass.
    let cq = 0, cr = 0, n = 0;
    for (const id of activeIds) {
      if (id === a.id) continue;
      const sib = map.nodes.get(id);
      if (sib) { cq += sib.coord.q; cr += sib.coord.r; n++; }
    }
    if (n === 0) return { q: 0, r: 0 };
    return { q: cq / n - a.coord.q, r: cr / n - a.coord.r };
  };

  /** Compute net EXTERNAL force on folder `fp` — only links crossing the
   *  folder boundary contribute, since internal links are drift-invariant. */
  const computeFolderForce = (fp) => {
    const ids = folderAtoms.get(fp);
    if (!ids) return { q: 0, r: 0 };
    let fq = 0, fr = 0;
    for (const id of ids) {
      const a = map.nodes.get(id);
      if (!a) continue;
      const links = linksByAtom.get(id);
      if (!links) continue;
      for (const l of links) {
        const other = l.source.id === id ? l.target : l.source;
        if (ids.has(other.id)) continue; // internal — drift preserves length
        const w = l.weight ?? 1;
        fq += (other.coord.q - a.coord.q) * w;
        fr += (other.coord.r - a.coord.r) * w;
      }
    }
    return { q: fq, r: fr };
  };

  /** Given a force vector, return [bestDir, leftFlank, rightFlank] where
   *  the two flanks are the ±60° neighbours of the best direction. Letting
   *  the caller "try forward then flank" is how atoms get around blockers
   *  instead of just stalling. Returns null for zero-force. */
  const topFlankDirs = (force) => {
    if (force.q === 0 && force.r === 0) return null;
    let bestIdx = 0, bestDot = -Infinity;
    for (let i = 0; i < 6; i++) {
      const d = HEX_DIRS[i];
      const dot = d.q * force.q + d.r * force.r;
      if (dot > bestDot) { bestDot = dot; bestIdx = i; }
    }
    return [
      HEX_DIRS[bestIdx],
      HEX_DIRS[(bestIdx + 5) % 6], // −60°
      HEX_DIRS[(bestIdx + 1) % 6], // +60°
    ];
  };

  /** Bent chain drag via BFS vacancy routing.
   *
   *  Atom `a` wants to move one hex in force direction `dir` — so we need
   *  to free up the cell at `a.coord + dir`. If that cell is already empty,
   *  tryHoleSafeHop handles it. If it's occupied, we route a "vacancy" to
   *  it by BFS-searching for the nearest empty cell, stepping through
   *  occupied cells. The path can bend freely.
   *
   *  When the BFS finds an empty cell, we reconstruct the path from target
   *  back to empty, and each atom along the path shifts by one hex toward
   *  the empty end (directions differ per step — that's the bending).
   *  Atom `a` then moves into `target` (which is now empty).
   *
   *  Net occupancy change: `a.coord` becomes empty (hole-guarded below),
   *  the old empty cell becomes occupied. Number of vacancies preserved. */
  const CHAIN_BFS_MAX_DEPTH = 6;
  const tryChainDrag = (a, dir) => {
    const targetQ = a.coord.q + dir.q, targetR = a.coord.r + dir.r;
    const targetKey = hexKey(targetQ, targetR);
    if (!occupancy.has(targetKey)) return null; // no chain needed
    if (emptyNeighbourCount(a.coord) < 2) return null; // hole-guard at source
    const aKey = hexKey(a.coord.q, a.coord.r);

    // BFS from target cell toward any empty cell. parent map lets us
    // reconstruct the actual path after finding an empty.
    /** @type {Map<string, {q:number,r:number} | null>} */
    const parentCoord = new Map();
    parentCoord.set(targetKey, null);
    /** @type {Array<{q:number,r:number,depth:number}>} */
    const queue = [{ q: targetQ, r: targetR, depth: 0 }];
    /** @type {null | {q:number, r:number}} */
    let emptyFound = null;
    while (queue.length > 0 && !emptyFound) {
      const c = queue.shift();
      if (c.depth >= CHAIN_BFS_MAX_DEPTH) continue;
      for (const d of HEX_DIRS) {
        const nq = c.q + d.q, nr = c.r + d.r;
        const key = hexKey(nq, nr);
        if (parentCoord.has(key)) continue;
        // Don't route the vacancy back through atom `a` itself.
        if (key === aKey) continue;
        parentCoord.set(key, { q: c.q, r: c.r });
        if (!occupancy.has(key)) {
          emptyFound = { q: nq, r: nr };
          break;
        }
        queue.push({ q: nq, r: nr, depth: c.depth + 1 });
      }
    }
    if (!emptyFound) return null;

    // Reconstruct path: [target, ..., empty]
    /** @type {Array<{q:number,r:number}>} */
    const pathCoords = [emptyFound];
    let cur = parentCoord.get(hexKey(emptyFound.q, emptyFound.r));
    while (cur) {
      pathCoords.unshift({ q: cur.q, r: cur.r });
      cur = parentCoord.get(hexKey(cur.q, cur.r));
    }
    // pathCoords now: [target (occupied), c1 (occ), ..., ck (occ), empty]
    // Atoms to shift: occupants of pathCoords[0..n-2]. Each moves to pathCoords[i+1].
    // After all shifts, pathCoords[0] is empty. Then `a` moves from a.coord to pathCoords[0].

    /** @type {Array<{atom: import('./node.js').Node, oldCoord:{q:number,r:number}, newCoord:{q:number,r:number}}>} */
    const moved = [];
    for (let i = 0; i < pathCoords.length - 1; i++) {
      const cellKey = hexKey(pathCoords[i].q, pathCoords[i].r);
      const occId = occupancy.get(cellKey);
      if (!occId) return null; // sanity — path should be occupied through i
      const node = map.nodes.get(occId);
      if (!node) return null;
      moved.push({
        atom: node,
        oldCoord: { q: pathCoords[i].q, r: pathCoords[i].r },
        newCoord: { q: pathCoords[i + 1].q, r: pathCoords[i + 1].r },
      });
    }
    // Atom `a` itself: from its current coord to the now-freed target cell
    moved.push({
      atom: a,
      oldCoord: { q: a.coord.q, r: a.coord.r },
      newCoord: { q: targetQ, r: targetR },
    });

    return { kind: 'chain', moved };
  };

  // ── MC main loop ───────────────────────────────────────────────
  let accepted = 0, rejected = 0, invariantRejects = 0;
  onProgress(`MC starting (${N} nodes, ≤${(wallClockMs / 1000).toFixed(0)}s budget)…`);
  await yieldFrame();

  // Temperature follows wall-clock, not iteration index. `tStart` is a
  // *virtual* clock origin — reheat pushes it forward to rewind T back
  // toward T0 without actually rolling back any work done so far.
  let tStart = performance.now();
  const getT = () => {
    const elapsed = performance.now() - tStart;
    const frac = Math.min(1, Math.max(0, elapsed / wallClockMs));
    return T0 * Math.pow(T1 / T0, frac);
  };

  // Epoch + convergence/reheat state
  let epochStartEnergy = energy;
  let epochStartAccepted = 0;
  let quietEpochs = 0;
  let reheats = 0;
  const QUIET_ACCEPT_THRESHOLD = 0.015;  // <1.5% acceptance = quiet
  const QUIET_DELTA_THRESHOLD = 0.05;    // <0.05 E-units/iter = quiet
  const CONVERGED_QUIET_EPOCHS = 3;      // N consecutive quiet → done
  const REHEAT_ROLLBACK_FRAC = 0.18;     // push clock back by 18% of cap

  // Snapshot cadence (wall-clock driven)
  let lastSnapWallMs = -Infinity;

  for (let i = 0; ; i++) {
    if (i >= hardIterCap) break;
    const T = getT();

    // ── Propose a move ───────────────────────────────────────────
    // Mix:
    //   20% — random adjacency swap (neighbour is another atom, random dir)
    //    8% — random hole-safe hop (atom → empty neighbour, random dir)
    //   12% — long-distance swap (two random atoms) — escape moves
    //    5% — random folder drift
    //   30% — FORCE-directed atom move (link-weighted direction, top-3 flanks)
    //   20% — FORCE-directed folder drift (no size cap)
    //    5% — CHAIN drag (force direction, sequential row push through
    //         adjacent atoms until the chain hits an empty cell)
    const roll = rng();
    /** @type {null | any} */
    let move = null;

    if (roll < 0.20) {
      // Random adjacency swap
      const a = map.nodes.get(atomIds[Math.floor(rng() * atomIds.length)]);
      if (a) {
        const dir = HEX_DIRS[Math.floor(rng() * 6)];
        move = tryAdjacencySwap(a, dir);
      }
    } else if (roll < 0.28) {
      // Random hole-safe hop
      const a = map.nodes.get(atomIds[Math.floor(rng() * atomIds.length)]);
      if (a) {
        const dir = HEX_DIRS[Math.floor(rng() * 6)];
        move = tryHoleSafeHop(a, dir);
      }
    } else if (roll < 0.40) {
      // Long-distance random swap
      const a = map.nodes.get(atomIds[Math.floor(rng() * atomIds.length)]);
      const b = map.nodes.get(atomIds[Math.floor(rng() * atomIds.length)]);
      if (a && b && a !== b) {
        move = {
          kind: 'swap', a, b,
          coordA: { q: a.coord.q, r: a.coord.r },
          coordB: { q: b.coord.q, r: b.coord.r },
        };
      }
    } else if (roll < 0.45) {
      // Random folder drift
      if (driftableFolders.length > 0) {
        const fp = driftableFolders[Math.floor(rng() * driftableFolders.length)];
        const dir = HEX_DIRS[Math.floor(rng() * 6)];
        move = tryFolderDrift(fp, dir);
      }
    } else if (roll < 0.75) {
      // Force-directed atom move — try top-3 flanking dirs
      const a = map.nodes.get(atomIds[Math.floor(rng() * atomIds.length)]);
      if (a) {
        const dirs = topFlankDirs(computeAtomForce(a));
        if (dirs) {
          for (const dir of dirs) {
            move = tryAdjacencySwap(a, dir) ?? tryHoleSafeHop(a, dir);
            if (move) break;
          }
        }
      }
    } else if (roll < 0.95) {
      // Force-directed folder drift — only for nucleated folders.
      // Try up to 5 random picks to find one that's in the connected set.
      // Before nucleation the folder isn't a coherent object yet, so
      // there's no point dragging it as a unit.
      if (allNonRootFolders.length > 0) {
        for (let attempt = 0; attempt < 5 && !move; attempt++) {
          const fp = allNonRootFolders[Math.floor(rng() * allNonRootFolders.length)];
          if (!connected.has(fp)) continue;
          const force = computeFolderForce(fp);
          const dirs = topFlankDirs(force);
          if (!dirs) continue;
          for (const dir of dirs) {
            move = tryFolderDrift(fp, dir);
            if (move) break;
          }
        }
      }
    } else {
      // Chain drag: walk forward through adjacent atoms in force direction
      // until we hit an empty cell, then shift the whole chain by one hex.
      // If the walk exceeds CHAIN_MAX before finding empty space, abort.
      const a = map.nodes.get(atomIds[Math.floor(rng() * atomIds.length)]);
      if (a) {
        const dirs = topFlankDirs(computeAtomForce(a));
        if (dirs) {
          for (const dir of dirs) {
            move = tryChainDrag(a, dir);
            if (move) break;
          }
        }
      }
    }

    if (!move) {
      rejected++;
      await maybeEmit(i, T);
      continue;
    }

    // ── ΔE: only count links whose length actually changes ───────
    let deltaE = 0;
    if (move.kind === 'single') {
      for (const l of linksByAtom.get(move.atom.id) ?? []) {
        const other = l.source.id === move.atom.id ? l.target : l.source;
        const w = l.weight ?? 1;
        deltaE += (hexDistance(move.newCoord, other.coord) - hexDistance(move.oldCoord, other.coord)) * w;
      }
    } else if (move.kind === 'swap') {
      const { a, b, coordA, coordB } = move;
      // A's external links: endpoint moves coordA → coordB
      for (const l of linksByAtom.get(a.id) ?? []) {
        const other = l.source.id === a.id ? l.target : l.source;
        if (other.id === b.id) continue; // symmetric internal bond
        const w = l.weight ?? 1;
        deltaE += (hexDistance(coordB, other.coord) - hexDistance(coordA, other.coord)) * w;
      }
      // B's external links: endpoint moves coordB → coordA
      for (const l of linksByAtom.get(b.id) ?? []) {
        const other = l.source.id === b.id ? l.target : l.source;
        if (other.id === a.id) continue;
        const w = l.weight ?? 1;
        deltaE += (hexDistance(coordA, other.coord) - hexDistance(coordB, other.coord)) * w;
      }
    } else if (move.kind === 'chain') {
      // Bent chain drag: every entry in `move.moved` has its own oldCoord
      // and newCoord (different step directions per atom). Links between
      // two moved atoms are counted exactly once using their new positions;
      // links from a moved atom to a static atom use the static atom's
      // current coord (which equals its old position since we haven't
      // applied yet).
      /** @type {Map<string, {q:number,r:number}>} */
      const newCoordById = new Map();
      for (const m of move.moved) newCoordById.set(m.atom.id, m.newCoord);
      for (const m of move.moved) {
        const links = linksByAtom.get(m.atom.id) ?? [];
        for (const l of links) {
          const other = l.source.id === m.atom.id ? l.target : l.source;
          const w = l.weight ?? 1;
          const otherNew = newCoordById.get(other.id);
          if (otherNew !== undefined) {
            // Both moved — count once (lower id wins).
            if (other.id < m.atom.id) continue;
            const oldDist = hexDistance(m.oldCoord, other.coord);
            const newDist = hexDistance(m.newCoord, otherNew);
            deltaE += (newDist - oldDist) * w;
          } else {
            // Other is stationary — its .coord is authoritative.
            const oldDist = hexDistance(m.oldCoord, other.coord);
            const newDist = hexDistance(m.newCoord, other.coord);
            deltaE += (newDist - oldDist) * w;
          }
        }
      }
    } else if (move.kind === 'drift') {
      // Internal links (both ends inside the drifted folder) keep their
      // length — both endpoints shift by dir, so distance is preserved.
      // Only external links contribute to ΔE.
      const ids = move.ids;
      const dq = move.dir.q, dr = move.dir.r;
      for (const n of move.fAtoms) {
        for (const l of linksByAtom.get(n.id) ?? []) {
          const other = l.source.id === n.id ? l.target : l.source;
          if (ids.has(other.id)) continue;
          const w = l.weight ?? 1;
          const oldD = hexDistance(n.coord, other.coord);
          const newD = hexDistance({ q: n.coord.q + dq, r: n.coord.r + dr }, other.coord);
          deltaE += (newD - oldD) * w;
        }
      }
    }

    // ── Metropolis acceptance ────────────────────────────────────
    if (deltaE > 0 && rng() >= Math.exp(-deltaE / T)) {
      rejected++;
      await maybeEmit(i, T);
      continue;
    }

    // ── Apply move (mutates atom coords + occupancy in place) ────
    applyMove(move, occupancy);

    // ── Invariant check; revert if any active invariant broken ──
    const affected = collectAffectedFolders(move, ancestorsOf);
    const ok = checkInvariants(affected, connected, adj, folderAtoms, map, occupancy, connCheckMaxSize);
    if (!ok) {
      undoMove(move, occupancy);
      rejected++; invariantRejects++;
      await maybeEmit(i, T);
      continue;
    }

    energy += deltaE;
    accepted++;

    // ── Nucleation: periodically rescan for NEW invariants ───────
    // Append-only — never removes anything. An invariant that just
    // became true is registered from now on as a hard constraint.
    if (i > 0 && i % connRescanEvery === 0) {
      for (const [fp, ids] of folderAtoms) {
        if (connected.has(fp)) continue;
        if (ids.size > connCheckMaxSize) continue;
        if (isFolderConnected(ids, map, occupancy)) connected.add(fp);
      }
    }
    if (i > 0 && i % adjRescanEvery === 0) {
      for (const [fpA, fpB] of siblingPairs) {
        const key = adjKey(fpA, fpB);
        if (adj.has(key)) continue;
        const flux = linkFlux.get(key) ?? 0;
        if (flux < adjFluxThreshold) continue;
        if (hasHexContact(folderAtoms.get(fpA), folderAtoms.get(fpB), map, occupancy)) {
          adj.add(key);
        }
      }
    }

    // ── Snapshot + yield (runs on every iteration, accept or reject) ──
    await maybeEmit(i, T);

    // ── Epoch boundary: convergence / reheat / wall-clock cap ────
    if (i > 0 && i % effEpoch === 0) {
      const now = performance.now();
      const elapsed = now - tStart;
      const epochAccepted = accepted - epochStartAccepted;
      const epochAcceptRate = epochAccepted / effEpoch;
      const epochDelta = epochStartEnergy - energy;
      const deltaPerIter = epochDelta / effEpoch;

      const quiet = epochAcceptRate < QUIET_ACCEPT_THRESHOLD && deltaPerIter < QUIET_DELTA_THRESHOLD;
      if (quiet) {
        quietEpochs++;
        // Converged: enough consecutive quiet epochs late in the schedule.
        if (quietEpochs >= CONVERGED_QUIET_EPOCHS && elapsed > wallClockMs * 0.5) {
          console.log(`[MC] converged @${i} after ${(elapsed / 1000).toFixed(1)}s`);
          epochStartEnergy = energy;
          epochStartAccepted = accepted;
          break;
        }
        // Reheat: only before the late-cooling phase, else we'd undo the
        // final polish. Pushes tStart forward so getT() rewinds higher.
        if (elapsed > wallClockMs * 0.15 && elapsed < wallClockMs * 0.8) {
          const rollback = wallClockMs * REHEAT_ROLLBACK_FRAC;
          tStart += rollback;
          reheats++;
          console.log(`[MC] reheat #${reheats} @${i}: ΔE/iter=${deltaPerIter.toFixed(3)} accept=${(epochAcceptRate * 100).toFixed(1)}%, rolled clock back ${(rollback / 1000).toFixed(1)}s`);
          quietEpochs = 0;
        }
      } else {
        quietEpochs = 0;
      }

      // Wall-clock hard cap
      if (elapsed > wallClockMs) {
        console.log(`[MC] wall cap @${i} after ${(elapsed / 1000).toFixed(1)}s`);
        epochStartEnergy = energy;
        epochStartAccepted = accepted;
        break;
      }

      // Reset epoch accumulators
      epochStartEnergy = energy;
      epochStartAccepted = accepted;
    }
  }

  async function maybeEmit(iter, T) {
    const now = performance.now();
    if (snaps.length >= snapCount) return;
    if (now - lastSnapWallMs < snapEveryMs) return;
    lastSnapWallMs = now;
    captureSnap(`mc.${iter}`, iter, T);
    const elapsed = now - tStart;
    onProgress(`MC iter=${iter} T=${T.toFixed(1)} E=${energy.toFixed(0)} conn=${connected.size}/${folderAtoms.size} adj=${adj.size} ${(elapsed / 1000).toFixed(1)}s`);
    await yieldFrame();
  }

  // Final snapshot
  captureSnap('mc.done', accepted + rejected, T1);

  const elapsed = performance.now() - tStart;
  const total = accepted + rejected;
  console.log(
    `MC: ${total} iter in ${elapsed.toFixed(0)}ms (${reheats} reheats), ` +
    `accepted ${accepted}/${total} (${(100 * accepted / Math.max(1, total)).toFixed(1)}%), ` +
    `inv-rejects ${invariantRejects}, ` +
    `E: ${initialEnergy.toFixed(0)} → ${energy.toFixed(0)} (ΔE=${(energy - initialEnergy).toFixed(0)}), ` +
    `conn ${connected.size}/${folderAtoms.size}, adj ${adj.size}/${siblingPairs.length}`,
  );
  // Push accumulated mutations back into the map's spatial index.
  map._rebuildSpatialIndex();
  onProgress('');
  return snaps;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Build per-folder atom sets and per-atom ancestor chains from node IDs.
 * Node IDs are file paths (e.g. "packages/util/src/index.ts"), so the
 * folder tree is derivable by splitting on '/'.
 */
function buildFolderMembership(map) {
  /** @type {Map<string, Set<string>>} */
  const folderAtoms = new Map();
  /** @type {Map<string, string[]>} */
  const ancestorsOf = new Map();
  /** @type {Map<string, string | null>} */
  const parentOf = new Map();
  /** @type {Map<string, Set<string>>} */
  const childrenOf = new Map();
  parentOf.set('.', null);
  const addToFolder = (fp, id) => {
    let s = folderAtoms.get(fp);
    if (!s) { s = new Set(); folderAtoms.set(fp, s); }
    s.add(id);
  };
  for (const atom of map.nodes.values()) {
    const path = atom.id;
    const slash = path.lastIndexOf('/');
    const leafFolder = slash < 0 ? '.' : path.slice(0, slash);
    /** @type {string[]} */
    const ancs = [];
    let cur = leafFolder;
    while (cur && cur !== '.') {
      addToFolder(cur, atom.id);
      ancs.push(cur);
      const s = cur.lastIndexOf('/');
      cur = s < 0 ? '.' : cur.slice(0, s);
    }
    addToFolder('.', atom.id);
    ancs.push('.');
    ancestorsOf.set(atom.id, ancs);
  }
  for (const fp of folderAtoms.keys()) {
    if (fp === '.') continue;
    const s = fp.lastIndexOf('/');
    const par = s < 0 ? '.' : fp.slice(0, s);
    parentOf.set(fp, par);
    let ch = childrenOf.get(par);
    if (!ch) { ch = new Set(); childrenOf.set(par, ch); }
    ch.add(fp);
  }
  return { folderAtoms, ancestorsOf, parentOf, childrenOf };
}

/** All unordered sibling pairs — O(Σ childrenCount²). */
function buildSiblingPairs(childrenOf) {
  /** @type {Array<[string, string]>} */
  const pairs = [];
  for (const children of childrenOf.values()) {
    const arr = [...children];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        pairs.push([arr[i], arr[j]]);
      }
    }
  }
  return pairs;
}

/**
 * Credit each link to the sibling-pair at the level where source and
 * target diverge (the two ancestors sitting immediately below their LCA).
 * Intra-folder links (source and target in the same leaf folder) and
 * self-loops contribute nothing.
 */
function computeLinkFlux(map, ancestorsOf) {
  /** @type {Map<string, number>} */
  const fluxMap = new Map();
  for (const l of map.links) {
    const srcAnc = ancestorsOf.get(l.source.id);
    const tgtAnc = ancestorsOf.get(l.target.id);
    if (!srcAnc || !tgtAnc) continue;
    const tgtSet = new Set(tgtAnc);
    let lcaIdx = -1;
    for (let i = 0; i < srcAnc.length; i++) {
      if (tgtSet.has(srcAnc[i])) { lcaIdx = i; break; }
    }
    if (lcaIdx <= 0) continue; // same leaf folder — nothing to credit
    const lca = srcAnc[lcaIdx];
    const tgtLcaIdx = tgtAnc.indexOf(lca);
    if (tgtLcaIdx <= 0) continue;
    const sibA = srcAnc[lcaIdx - 1];
    const sibB = tgtAnc[tgtLcaIdx - 1];
    if (sibA === sibB) continue;
    const key = adjKey(sibA, sibB);
    fluxMap.set(key, (fluxMap.get(key) ?? 0) + (l.weight ?? 1));
  }
  return fluxMap;
}

const adjKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function applyMove(move, occupancy) {
  if (move.kind === 'single') {
    occupancy.delete(hexKey(move.oldCoord.q, move.oldCoord.r));
    occupancy.set(hexKey(move.newCoord.q, move.newCoord.r), move.atom.id);
    move.atom.coord.q = move.newCoord.q;
    move.atom.coord.r = move.newCoord.r;
  } else if (move.kind === 'swap') {
    occupancy.set(hexKey(move.coordA.q, move.coordA.r), move.b.id);
    occupancy.set(hexKey(move.coordB.q, move.coordB.r), move.a.id);
    move.a.coord.q = move.coordB.q; move.a.coord.r = move.coordB.r;
    move.b.coord.q = move.coordA.q; move.b.coord.r = move.coordA.r;
  } else if (move.kind === 'chain') {
    // Two-phase: clear all old positions from occupancy, then set all new
    // positions. The moved list has per-atom oldCoord/newCoord because the
    // chain can bend — each atom has its own step direction.
    for (const m of move.moved) occupancy.delete(hexKey(m.oldCoord.q, m.oldCoord.r));
    for (const m of move.moved) {
      m.atom.coord.q = m.newCoord.q;
      m.atom.coord.r = m.newCoord.r;
    }
    for (const m of move.moved) occupancy.set(hexKey(m.newCoord.q, m.newCoord.r), m.atom.id);
  } else if (move.kind === 'drift') {
    // Two-phase: clear all current keys first so intra-folder moves
    // between now-vacated cells don't collide with still-occupied keys.
    for (const n of move.fAtoms) occupancy.delete(hexKey(n.coord.q, n.coord.r));
    for (const n of move.fAtoms) {
      n.coord.q += move.dir.q;
      n.coord.r += move.dir.r;
    }
    for (const n of move.fAtoms) occupancy.set(hexKey(n.coord.q, n.coord.r), n.id);
  }
}

function undoMove(move, occupancy) {
  if (move.kind === 'single') {
    occupancy.delete(hexKey(move.newCoord.q, move.newCoord.r));
    occupancy.set(hexKey(move.oldCoord.q, move.oldCoord.r), move.atom.id);
    move.atom.coord.q = move.oldCoord.q;
    move.atom.coord.r = move.oldCoord.r;
  } else if (move.kind === 'swap') {
    occupancy.set(hexKey(move.coordA.q, move.coordA.r), move.a.id);
    occupancy.set(hexKey(move.coordB.q, move.coordB.r), move.b.id);
    move.a.coord.q = move.coordA.q; move.a.coord.r = move.coordA.r;
    move.b.coord.q = move.coordB.q; move.b.coord.r = move.coordB.r;
  } else if (move.kind === 'chain') {
    for (const m of move.moved) occupancy.delete(hexKey(m.newCoord.q, m.newCoord.r));
    for (const m of move.moved) {
      m.atom.coord.q = m.oldCoord.q;
      m.atom.coord.r = m.oldCoord.r;
    }
    for (const m of move.moved) occupancy.set(hexKey(m.oldCoord.q, m.oldCoord.r), m.atom.id);
  } else if (move.kind === 'drift') {
    for (const n of move.fAtoms) occupancy.delete(hexKey(n.coord.q, n.coord.r));
    for (const n of move.fAtoms) {
      n.coord.q -= move.dir.q;
      n.coord.r -= move.dir.r;
    }
    for (const n of move.fAtoms) occupancy.set(hexKey(n.coord.q, n.coord.r), n.id);
  }
}

/** All folders whose invariants could have been affected by this move. */
function collectAffectedFolders(move, ancestorsOf) {
  const affected = new Set();
  const addFor = (id) => {
    const ancs = ancestorsOf.get(id);
    if (!ancs) return;
    for (const fp of ancs) affected.add(fp);
  };
  if (move.kind === 'single') addFor(move.atom.id);
  else if (move.kind === 'swap') { addFor(move.a.id); addFor(move.b.id); }
  else if (move.kind === 'chain') { for (const m of move.moved) addFor(m.atom.id); }
  else if (move.kind === 'drift') { for (const n of move.fAtoms) addFor(n.id); }
  return affected;
}

function checkInvariants(affectedFolders, connected, adj, folderAtoms, map, occupancy, connCheckMaxSize) {
  for (const fp of affectedFolders) {
    if (!connected.has(fp)) continue;
    const ids = folderAtoms.get(fp);
    if (!ids) continue;
    if (ids.size > connCheckMaxSize) continue; // big folders: physics keeps them, rescan verifies
    if (!isFolderConnected(ids, map, occupancy)) return false;
  }
  if (adj.size === 0) return true;
  for (const adjStr of adj) {
    const sep = adjStr.indexOf('|');
    const f1 = adjStr.slice(0, sep);
    const f2 = adjStr.slice(sep + 1);
    if (!affectedFolders.has(f1) && !affectedFolders.has(f2)) continue;
    const a1 = folderAtoms.get(f1);
    const a2 = folderAtoms.get(f2);
    if (!a1 || !a2) continue;
    if (!hasHexContact(a1, a2, map, occupancy)) return false;
  }
  return true;
}

/** BFS over hex-neighbours, traversing only cells occupied by atoms in `ids`. */
function isFolderConnected(ids, map, occupancy) {
  const size = ids.size;
  if (size <= 1) return true;
  const iter = ids.values();
  const startId = iter.next().value;
  const start = map.nodes.get(startId);
  if (!start) return false;
  const seen = new Set([hexKey(start.coord.q, start.coord.r)]);
  /** @type {Array<{q:number, r:number}>} */
  const stack = [{ q: start.coord.q, r: start.coord.r }];
  while (stack.length) {
    const c = stack.pop();
    for (const d of HEX_DIRS) {
      const nq = c.q + d.q, nr = c.r + d.r;
      const k = hexKey(nq, nr);
      if (seen.has(k)) continue;
      const occId = occupancy.get(k);
      if (!occId || !ids.has(occId)) continue;
      seen.add(k);
      stack.push({ q: nq, r: nr });
    }
  }
  return seen.size === size;
}

/** Do any two atoms from opposing sets share a hex edge? */
function hasHexContact(idsA, idsB, map, occupancy) {
  const [small, big] = idsA.size <= idsB.size ? [idsA, idsB] : [idsB, idsA];
  for (const id of small) {
    const a = map.nodes.get(id);
    if (!a) continue;
    for (const d of HEX_DIRS) {
      const k = hexKey(a.coord.q + d.q, a.coord.r + d.r);
      const occId = occupancy.get(k);
      if (occId && big.has(occId)) return true;
    }
  }
  return false;
}

/** Deterministic tiny PRNG — used when caller passes a seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
