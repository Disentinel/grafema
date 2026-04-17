// Bottom-up recursive assembly: leaves-ring → nested hierarchical cluster.
//
// Input state: every leaf node is placed on the initial ring with regionId
// set to its immediate parent folder. The folder tree is derived from
// `tree.leaves[*].path`.
//
// Algorithm, per level L from maxDepth down to 0:
//   For each folder F at depth L that has member leaves:
//     Per-node drift loop over F's members. Each iteration:
//       - pick a node n
//       - compute desire vector (members centroid + linked-members centroid)
//       - try to step n in that direction via move-to-empty or swap
//       - reject if any frozen (already-assembled) ancestor region of
//         either affected node would be disconnected afterwards
//       - reject if cost (link length + centroid distance) doesn't strictly
//         improve
//     Terminate when: (a) F's member tiles form one connected hex region,
//     (b) no improving move found for a full pass, or (c) iter cap.
//     Mark F assembled and emit a snapshot.
//   All folders at level L assemble before moving to L-1.
//
// Cross-level link filtering: at level L, only links whose BOTH endpoints
// lie inside F are considered. Higher-level cross-folder links are dormant.
//
// Snapshots: one per folder assembly + one per level boundary. Snapshot
// carries `hullLayers` — the list of folders already assembled (innermost
// first), drawn as hull polygons stacked over the raw hex grid.

import { HEX_DIRS, axialToPixel, pixelToAxial, hexKey } from './hex.js';

/** @typedef {import('./map.js').HexMap} HexMap */
/** @typedef {import('./node.js').Node} HexNode */

/**
 * Snapshot shape — what the debug stepper consumes.
 * @typedef {{
 *   name: string,
 *   level: number,
 *   description: string,
 *   coords: Map<string, {q:number, r:number}>,
 *   hullLayers: Array<{ coords: Array<{q:number,r:number}>, fillColor: string, strokeColor: string, lineWidth?: number }>,
 * }} RingSnapshot
 */

/**
 * Derive the folder tree from `tree.leaves[*].path`. Every intermediate
 * path segment becomes a folder; each folder knows its direct children
 * (both sub-folders and leaf nodes) and transitive leaf set.
 *
 * @param {{ leaves: Array<{path:string, folder:string}> }} tree
 * @param {HexMap} map
 */
function buildFolderTree(tree, map) {
  /** @type {Map<string, { path: string, depth: number, parent: string|null, childFolders: Set<string>, directLeaves: HexNode[], transitiveLeaves: HexNode[] }>} */
  const folders = new Map();
  const ensure = (path, depth, parent) => {
    if (!folders.has(path)) {
      folders.set(path, {
        path, depth, parent,
        childFolders: new Set(),
        directLeaves: [],
        transitiveLeaves: [],
      });
    }
    return folders.get(path);
  };
  ensure('.', 0, null);

  for (const leaf of tree.leaves) {
    const node = map.nodes.get(leaf.path);
    if (!node) continue;
    // Walk the ancestor chain of leaf.folder, creating folder entries.
    const parts = leaf.folder === '.' ? [] : leaf.folder.split('/');
    let parent = '.';
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join('/');
      const folder = ensure(path, i + 1, parent);
      folders.get(parent).childFolders.add(path);
      parent = path;
    }
    folders.get(parent).directLeaves.push(node);
  }

  // Fill transitiveLeaves by bottom-up aggregation.
  const byDepth = [...folders.values()].sort((a, b) => b.depth - a.depth);
  for (const f of byDepth) {
    f.transitiveLeaves = [...f.directLeaves];
    for (const childPath of f.childFolders) {
      f.transitiveLeaves.push(...folders.get(childPath).transitiveLeaves);
    }
  }

  const maxDepth = Math.max(...[...folders.values()].map((f) => f.depth));
  return { folders, maxDepth };
}

/** Deterministic HSL colour from a folder path. */
function folderColor(path, alpha = 0.25) {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsla(${hue}, 70%, 55%, ${alpha})`;
}
function folderStroke(path) {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue}, 80%, 70%)`;
}

/**
 * BFS on a set of coords over the 6-neighbour hex grid. Returns true iff
 * every coord in the set is reachable from the first one.
 * @param {Array<{q:number,r:number}>} coords
 */
function isConnectedCoords(coords) {
  if (coords.length <= 1) return true;
  const set = new Set(coords.map((c) => hexKey(c.q, c.r)));
  const start = coords[0];
  const queue = [start];
  const seen = new Set([hexKey(start.q, start.r)]);
  while (queue.length > 0) {
    const c = queue.pop();
    for (const d of HEX_DIRS) {
      const nq = c.q + d.q, nr = c.r + d.r;
      const k = hexKey(nq, nr);
      if (set.has(k) && !seen.has(k)) {
        seen.add(k);
        queue.push({ q: nq, r: nr });
      }
    }
  }
  return seen.size === set.size;
}

/** Member tile coords after a hypothetical swap of (a, b). */
function tilesAfterSwap(members, a, b) {
  // For each member node, substitute its coord if it's a or b.
  const memberSet = new Set(members.map((m) => m.id));
  const coords = [];
  for (const m of members) {
    if (m === a)      coords.push({ q: b.coord.q, r: b.coord.r });
    else if (m === b) coords.push({ q: a.coord.q, r: a.coord.r });
    else              coords.push({ q: m.coord.q, r: m.coord.r });
  }
  // b may not be in members — then swapping moves b's coord into the set
  // in place of a's (a takes b's old coord). Handled above.
  // Also if only one of the pair is a member, that's the interesting case:
  // we lose a's old tile from the set and gain b's old tile.
  return coords;
}

/** Member tile coords after hypothetical move of `node` to (q, r). */
function tilesAfterMove(members, node, q, r) {
  const coords = [];
  for (const m of members) {
    if (m === node) coords.push({ q, r });
    else            coords.push({ q: m.coord.q, r: m.coord.r });
  }
  return coords;
}

/**
 * Cost to minimise within a folder F:
 *   sum(pixel distance from each member to members centroid)
 *   + sum(hex length of intra-F links)
 * Centroid is computed in pixel space at the caller-supplied hexSize.
 */
function folderCost(members, intraLinks, hexSize) {
  if (members.length === 0) return 0;
  let cx = 0, cy = 0;
  for (const m of members) {
    const p = axialToPixel(m.coord, hexSize);
    cx += p.x; cy += p.y;
  }
  cx /= members.length; cy /= members.length;
  let cost = 0;
  for (const m of members) {
    const p = axialToPixel(m.coord, hexSize);
    cost += Math.hypot(p.x - cx, p.y - cy);
  }
  // Intra-folder links — weighted hex length. Scaled to pixel units so it
  // lives in the same ballpark as centroid distance.
  const linkScale = hexSize * 1.5;
  for (const l of intraLinks) cost += l.length() * linkScale;
  return cost;
}

/**
 * Try to find an improving single-node move for `node` within folder F.
 * Candidate moves: step into one of the 6 neighbouring hexes, either
 * empty (moveNode) or swap with the occupant (if the occupant is NOT
 * locked by a frozen region with a connectivity constraint we can't
 * satisfy).
 *
 * @returns {{ kind: 'move', q: number, r: number } | { kind: 'swap', with: HexNode } | null}
 */
function findBetterMove(map, node, cx, cy, frozen, hexSize) {
  // `cx, cy` is the folder centroid in pixel space — precomputed once
  // per outer iteration by the caller so we don't scan members here.
  const np = axialToPixel(node.coord, hexSize);
  const dx = cx - np.x, dy = cy - np.y;
  if (dx * dx + dy * dy < 0.01) return null; // already at centroid

  // Pick the single hex direction with the highest dot product against
  // the desire vector. Evaluate inline to avoid allocation.
  let bestDot = -Infinity, bestD = null;
  for (const d of HEX_DIRS) {
    const pp = axialToPixel({ q: d.q, r: d.r }, hexSize);
    const dot = pp.x * dx + pp.y * dy;
    if (dot > bestDot) { bestDot = dot; bestD = d; }
  }
  if (!bestD || bestDot <= 0) return null;

  const tq = node.coord.q + bestD.q;
  const tr = node.coord.r + bestD.r;
  const occupant = map.nodeAt(tq, tr);
  if (!occupant) {
    if (!checkFrozenOnMove(node, tq, tr, frozen)) return null;
    map.moveNode(node, tq, tr);
    return { kind: 'move' };
  }
  if (occupant === node) return null;
  if (!checkFrozenOnSwap(node, occupant, frozen)) return null;
  map.swap(node, occupant);
  return { kind: 'swap' };
}

/**
 * Check whether moving `node` to (q, r) preserves connectivity of every
 * frozen region that contains either (a) `node` itself or (b) owns the
 * destination coord (no — destination is empty in the move case).
 * For each such region F: its new tile set = current tile set minus
 * node's old coord plus (q, r) — but (q, r) is empty, so only removal
 * matters.
 */
function checkFrozenOnMove(node, q, r, frozen) {
  for (const f of frozen) {
    if (!f.memberSet.has(node)) continue;
    // Simulate: remove old coord, add new one.
    const coords = [];
    for (const m of f.members) {
      if (m === node) coords.push({ q, r });
      else            coords.push({ q: m.coord.q, r: m.coord.r });
    }
    if (!isConnectedCoords(coords)) return false;
  }
  return true;
}

/** Same but for swap: both coords of (a, b) change, both frozen regions
 *  they belong to must remain connected afterwards. */
function checkFrozenOnSwap(a, b, frozen) {
  for (const f of frozen) {
    const hasA = f.memberSet.has(a);
    const hasB = f.memberSet.has(b);
    if (!hasA && !hasB) continue;
    const coords = [];
    for (const m of f.members) {
      if (m === a)      coords.push({ q: b.coord.q, r: b.coord.r });
      else if (m === b) coords.push({ q: a.coord.q, r: a.coord.r });
      else              coords.push({ q: m.coord.q, r: m.coord.r });
    }
    if (!isConnectedCoords(coords)) return false;
  }
  return true;
}

/**
 * Rigid shift: translate every member of `group` by (dq, dr) simultaneously.
 * Legal iff every destination cell is either empty or occupied by another
 * member of the same group (they slide past each other inside the group).
 * Returns true on success, false if blocked.
 *
 * Intra-group collisions are fine — swapping two group members by delta
 * produces a valid permutation of the same tile set since the shift is
 * uniform. Inter-group collisions block the shift.
 *
 * The shift is atomic: the spatial index is rebuilt around the new coords.
 */
function rigidShift(group, dq, dr, map) {
  const memberSet = new Set(group);
  for (const m of group) {
    const nq = m.coord.q + dq, nr = m.coord.r + dr;
    const occupant = map.nodeAt(nq, nr);
    if (occupant && !memberSet.has(occupant)) return false;
  }
  // Apply: remove all old keys, update coords, insert new keys.
  for (const m of group) map._byCoord.delete(hexKey(m.coord.q, m.coord.r));
  for (const m of group) { m.coord.q += dq; m.coord.r += dr; }
  for (const m of group) map._byCoord.set(hexKey(m.coord.q, m.coord.r), m);
  map._regionAdjDirty = true;
  return true;
}

/**
 * At level L > maxDepth (i.e. above the leaves), try to pull each already-
 * assembled child folder of F toward F's centroid via one-hex rigid shifts.
 * Runs until no child can shift — i.e. every child is blocked by a sibling
 * child or F is as compact as possible.
 */
function rigidDriftChildren(map, F, folders, hexSize) {
  const children = [...F.childFolders].map((p) => folders.get(p)).filter((c) => c && c.transitiveLeaves.length > 0);
  if (children.length < 2) return 0;
  let totalShifts = 0;

  // Loop until no net progress. Metric = sum of distances from each
  // child centroid to F's centroid. Break when it stops decreasing for
  // a few consecutive iters (oscillation detection) or a batch plans
  // zero shifts (everyone's already at F's centroid).
  let prevMetric = Infinity;
  let stagnant = 0;
  // Safety cap against oscillation bugs — not a tuning knob, just a bound
  // large enough that it's irrelevant in practice.
  const safetyCap = 2000;
  for (let safety = 0; safety < safetyCap; safety++) {
    // F's centroid in pixel space.
    let cx = 0, cy = 0, n = 0;
    for (const c of children) {
      for (const m of c.transitiveLeaves) {
        const p = axialToPixel(m.coord, hexSize);
        cx += p.x; cy += p.y; n++;
      }
    }
    if (n === 0) return totalShifts;
    cx /= n; cy /= n;

    // Progress metric: sum of Euclidean distance from child centroid to F.
    let metric = 0;
    for (const c of children) {
      let ccx = 0, ccy = 0;
      for (const m of c.transitiveLeaves) {
        const p = axialToPixel(m.coord, hexSize);
        ccx += p.x; ccy += p.y;
      }
      ccx /= c.transitiveLeaves.length;
      ccy /= c.transitiveLeaves.length;
      metric += Math.hypot(cx - ccx, cy - ccy);
    }
    if (metric + 0.5 >= prevMetric) stagnant++; else stagnant = 0;
    prevMetric = metric;
    if (stagnant >= 20) break;

    // Compute each child's CANDIDATE directions — every hex dir with
    // positive dot against the desire vector, sorted best first. Lets
    // the per-plan validator try alternatives when the best dir is
    // blocked by a sibling that can't get out of the way.
    /** @type {Array<{ child: any, cands: Array<{dq:number,dr:number}> }>} */
    const plans = [];
    for (const c of children) {
      let ccx = 0, ccy = 0;
      for (const m of c.transitiveLeaves) {
        const p = axialToPixel(m.coord, hexSize);
        ccx += p.x; ccy += p.y;
      }
      ccx /= c.transitiveLeaves.length;
      ccy /= c.transitiveLeaves.length;
      const dx = cx - ccx, dy = cy - ccy;
      if (dx * dx + dy * dy < 1) continue;

      // Adaptive step: proportional to distance from F's centroid.
      const dist = Math.hypot(dx, dy);
      const stride = Math.max(1, Math.floor(dist / (hexSize * 3)));

      const ranked = [];
      for (const d of HEX_DIRS) {
        const pp = axialToPixel({ q: d.q, r: d.r }, hexSize);
        const dot = pp.x * dx + pp.y * dy;
        if (dot > 0) ranked.push({ d, dot });
      }
      if (ranked.length === 0) continue;
      ranked.sort((a, b) => b.dot - a.dot);
      const cands = ranked.map(({ d }) => ({ dq: d.q * stride, dr: d.r * stride }));
      plans.push({ child: c, cands });
    }
    if (plans.length === 0) break;

    // Per-plan validation: accept plans greedily, skipping ones that
    // collide with already-accepted plans or with nodes outside any
    // plan. Skipped plans' members stay in place and become immovable
    // for the rest of this batch — so later plans see them as static.
    //
    // This is a single pass; a rejected plan doesn't retroactively
    // invalidate an earlier-accepted plan that counted on it moving.
    // In practice the error is small: the earlier plan "shifted into"
    // cells the later plan now occupies, but since the later plan
    // stays put and the earlier plan already moved, the only risk is
    // collision — which we check explicitly below.
    const allMoving = new Set();
    for (const p of plans) for (const m of p.child.transitiveLeaves) allMoving.add(m.id);

    // `claimed` tracks cells that will be occupied by an already-
    // accepted plan's NEW positions. `frozenAside` tracks cells that
    // are occupied by nodes NOT moving this iteration — either
    // genuinely static nodes or members of rejected plans.
    const claimed = new Map(); // cellKey → node
    const frozenAside = new Set();
    for (const [key, n] of map._byCoord) {
      if (!allMoving.has(n.id)) frozenAside.add(key);
    }

    /** @type {Array<{child:any, dq:number, dr:number}>} */
    const accepted = [];
    for (const p of plans) {
      // Try each candidate direction in order; first non-colliding wins.
      let chosen = null;
      /** @type {string[]} */
      let chosenDests = [];
      for (const cand of p.cands) {
        /** @type {string[]} */
        const planDests = [];
        let conflict = false;
        for (const m of p.child.transitiveLeaves) {
          const nq = m.coord.q + cand.dq;
          const nr = m.coord.r + cand.dr;
          const key = hexKey(nq, nr);
          if (frozenAside.has(key) || claimed.has(key)) { conflict = true; break; }
          planDests.push(key);
        }
        if (!conflict) { chosen = cand; chosenDests = planDests; break; }
      }
      if (!chosen) {
        for (const m of p.child.transitiveLeaves) {
          frozenAside.add(hexKey(m.coord.q, m.coord.r));
        }
        continue;
      }
      for (let i = 0; i < chosenDests.length; i++) {
        claimed.set(chosenDests[i], p.child.transitiveLeaves[i]);
      }
      accepted.push({ child: p.child, dq: chosen.dq, dr: chosen.dr });
    }

    if (accepted.length === 0) break;

    // Apply accepted plans atomically. Remove old cells first, then
    // install new ones — prevents transient collisions during rewrite.
    for (const p of accepted) {
      for (const m of p.child.transitiveLeaves) {
        map._byCoord.delete(hexKey(m.coord.q, m.coord.r));
      }
    }
    for (const p of accepted) {
      for (const m of p.child.transitiveLeaves) {
        m.coord.q += p.dq; m.coord.r += p.dr;
      }
    }
    for (const p of accepted) {
      for (const m of p.child.transitiveLeaves) {
        map._byCoord.set(hexKey(m.coord.q, m.coord.r), m);
      }
    }
    map._regionAdjDirty = true;
    totalShifts += accepted.length;
  }
  return totalShifts;
}

/**
 * Teleport-to-free-space: given a frozen group G stuck far from the
 * global centroid, search for a translation delta such that all of
 * G's new coords are empty cells, and apply it. Candidate deltas are
 * tested in order of target proximity to (cx, cy) — expanding hex
 * rings outward from the current global centroid. Shape is preserved
 * by virtue of being a rigid translation, so connectivity is maintained.
 *
 * Returns true if the teleport succeeded.
 */
function teleportToFreeSpace(map, group, cx, cy, hexSize, maxRing = 80) {
  const currentCenter = axialToPixel({
    q: group.reduce((s, m) => s + m.coord.q, 0) / group.length,
    r: group.reduce((s, m) => s + m.coord.r, 0) / group.length,
  }, hexSize);
  const memberCoords = group.map((m) => ({ q: m.coord.q, r: m.coord.r }));

  // Target center expressed in axial-ish form — pick the hex at (cx, cy).
  // Then walk rings outward; for each candidate cell, compute the delta
  // that would move current center to that cell, and check if every
  // translated member lands on an empty cell.
  const targetHex = pixelToAxial(cx, cy, hexSize);
  const currentHex = pixelToAxial(currentCenter.x, currentCenter.y, hexSize);

  for (let ring = 0; ring <= maxRing; ring++) {
    // Enumerate cells at hex-distance exactly `ring` from targetHex.
    for (let dq = -ring; dq <= ring; dq++) {
      for (let dr = -ring; dr <= ring; dr++) {
        const dist = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
        if (dist !== ring) continue;
        const cq = targetHex.q + dq;
        const cr = targetHex.r + dr;
        // Translation that moves current centroid to this cell.
        const tdq = cq - currentHex.q;
        const tdr = cr - currentHex.r;
        // Check every translated member lands on an empty cell.
        // Allow collision with another member of the SAME group (intra-
        // group permutation is a no-op anyway).
        const memberSet = new Set(group);
        let ok = true;
        for (const m of group) {
          const nq = m.coord.q + tdq, nr = m.coord.r + tdr;
          const occ = map.nodeAt(nq, nr);
          if (occ && !memberSet.has(occ)) { ok = false; break; }
        }
        if (!ok) continue;
        // Apply the translation.
        for (const m of group) map._byCoord.delete(hexKey(m.coord.q, m.coord.r));
        for (const m of group) { m.coord.q += tdq; m.coord.r += tdr; }
        for (const m of group) map._byCoord.set(hexKey(m.coord.q, m.coord.r), m);
        map._regionAdjDirty = true;
        return true;
      }
    }
  }
  return false;
}

/** Collect all intra-F links (both endpoints in F's transitive members). */
function intraFolderLinks(map, memberSet) {
  const out = [];
  for (const l of map.links) {
    if (memberSet.has(l.source) && memberSet.has(l.target)) out.push(l);
  }
  return out;
}

/** Snapshot factory — captures coords + the current accumulated hull stack. */
function makeSnapshot(map, level, name, description, frozenHullStack) {
  const coords = new Map();
  for (const [id, n] of map.nodes) coords.set(id, { q: n.coord.q, r: n.coord.r });
  // Hull layers: innermost (deepest) first so parent hulls draw under them
  // when filled with alpha. We push in assembly order (L0 → L1 → ...)
  // which already gives depth-decreasing order.
  const hullLayers = frozenHullStack.map((f) => ({
    coords: f.members.map((m) => ({ q: m.coord.q, r: m.coord.r })),
    fillColor: folderColor(f.path, 0.22),
    strokeColor: folderStroke(f.path),
    lineWidth: Math.max(1, 3 - f.depth * 0.4),
  }));
  return { name, level, description, coords, hullLayers };
}

/**
 * Main entry point.
 *
 * @param {HexMap} map
 * @param {{ leaves: Array<{path:string, folder:string}> }} tree
 * @param {{ hexSize?: number, maxIterPerFolder?: number, maxFolderSize?: number }} [opts]
 * @returns {RingSnapshot[]}
 */
export function runRingAssembly(map, tree, opts = {}) {
  const hexSize = opts.hexSize ?? 22;
  // Keep a big-but-finite safety cap to prevent pathological loops; the
  // natural termination is "no move accepted in an entire pass".
  const maxFolderSize = opts.maxFolderSize ?? 10000;

  const { folders, maxDepth } = buildFolderTree(tree, map);

  /** @type {RingSnapshot[]} */
  const snaps = [];
  /** Stack of assembled folders, innermost first. Each entry carries
   *  its member Node[] + memberSet for quick lookup by frozen checks. */
  const frozenHullStack = [];

  snaps.push(makeSnapshot(map, maxDepth, 'ring.start', 'initial leaves-ring', frozenHullStack));
  const stats = { trivial: 0, drifted: 0, skipped: 0, totalMoves: 0 };

  // Process levels bottom-up. At each level, every folder at that depth
  // whose transitive leaf set has ≥ 2 members tries to assemble.
  for (let L = maxDepth; L >= 0; L--) {
    const atLevel = [...folders.values()]
      .filter((f) => f.depth === L && f.transitiveLeaves.length > 0)
      .sort((a, b) => a.path.localeCompare(b.path));
    if (atLevel.length === 0) continue;

    const t0 = performance.now();
    snaps.push(makeSnapshot(map, L, `L${L}.level_start`, `level ${L}: ${atLevel.length} folders`, frozenHullStack));

    for (const F of atLevel) {
      const frozenMembers = F.transitiveLeaves;
      const directMembers = F.directLeaves;
      if (frozenMembers.length === 0) continue;

      // Trivial: singleton transitive leaf is already assembled.
      if (frozenMembers.length === 1) {
        frozenHullStack.push({ path: F.path, depth: F.depth, members: frozenMembers, memberSet: new Set(frozenMembers) });
        stats.trivial++;
        continue;
      }

      // Rigid-shift phase: pull each already-assembled child subfolder
      // toward F's centroid. This is the only way to move frozen groups
      // as a whole — individual node drift would break their connectivity.
      if (F.childFolders.size > 0) {
        const shifts = rigidDriftChildren(map, F, folders, hexSize);
        if (shifts > 0) {
          snaps.push(makeSnapshot(map, L, `L${L}.${F.path}.rigid_shift`, `rigid-shifted ${shifts}× children of ${F.path}`, frozenHullStack));
        }
      }

      // Per-node drift phase — operates ONLY on F's direct leaves (the
      // leaves that belong to F itself, not to any already-frozen child).
      // Leaves of frozen children cannot move individually — their region
      // would tear — so including them is pure wasted work.
      const members = directMembers;
      const memberSet = new Set(members);
      const intraLinks = intraFolderLinks(map, memberSet);

      if (members.length > maxFolderSize) {
        frozenHullStack.push({ path: F.path, depth: F.depth, members: frozenMembers, memberSet: new Set(frozenMembers) });
        stats.skipped++;
        snaps.push(makeSnapshot(map, L, `L${L}.${F.path}.skipped`, `folder ${F.path} skipped (${members.length} direct > ${maxFolderSize})`, frozenHullStack));
        continue;
      }
      if (members.length < 2) {
        // No direct leaves to drift — freeze as-is and move on.
        frozenHullStack.push({ path: F.path, depth: F.depth, members: frozenMembers, memberSet: new Set(frozenMembers) });
        stats.trivial++;
        continue;
      }
      stats.drifted++;

      let prevSpread = Infinity;
      let nodeStagnant = 0;
      const perNodeSafety = members.length * 50 + 100;
      for (let safety = 0; safety < perNodeSafety; safety++) {
        let cx = 0, cy = 0;
        for (const m of members) {
          const p = axialToPixel(m.coord, hexSize);
          cx += p.x; cy += p.y;
        }
        cx /= members.length; cy /= members.length;

        // Metric: sum of squared distances from centroid. Strictly
        // decreasing under true attractive drift; flatlines on oscillation.
        let spread = 0;
        for (const m of members) {
          const p = axialToPixel(m.coord, hexSize);
          const dxm = p.x - cx, dym = p.y - cy;
          spread += dxm * dxm + dym * dym;
        }
        if (spread + 1 >= prevSpread) nodeStagnant++; else nodeStagnant = 0;
        prevSpread = spread;
        if (nodeStagnant >= 3) break;

        let anyProgress = false;
        for (const n of members) {
          const mv = findBetterMove(map, n, cx, cy, frozenHullStack, hexSize);
          if (mv) { anyProgress = true; stats.totalMoves++; }
        }
        if (!anyProgress) break;
      }

      frozenHullStack.push({ path: F.path, depth: F.depth, members: frozenMembers, memberSet: new Set(frozenMembers) });
      snaps.push(makeSnapshot(map, L, `L${L}.${F.path}.assembled`, `folder ${F.path} (${frozenMembers.length} nodes)`, frozenHullStack));
    }

    console.log(`L${L}: ${atLevel.length} folders in ${(performance.now() - t0).toFixed(0)}ms, Σlinks=${map.totalLinkLength()}`);
    snaps.push(makeSnapshot(map, L, `L${L}.level_done`, `level ${L} complete`, frozenHullStack));
  }

  console.log('entering straggler teleport phase');
  // ── Straggler teleport ───────────────────────────────────────
  // Any frozen TOP-LEVEL group whose centroid is still far from the
  // global centroid at this point is a genuine outlier — the rigid-drift
  // couldn't reach it through the crowded middle. For each, find any
  // empty translation near the global centroid and teleport it there.
  // Shape is preserved (pure translation) so connectivity holds.
  {
    // Global centroid in pixel space.
    let gcx = 0, gcy = 0;
    for (const n of map.nodes.values()) {
      const p = axialToPixel(n.coord, hexSize);
      gcx += p.x; gcy += p.y;
    }
    gcx /= map.nodes.size; gcy /= map.nodes.size;

    // Straggler threshold: spread of the densest core. Cheap proxy:
    // median distance from centroid × 3.
    const dists = [];
    for (const n of map.nodes.values()) {
      const p = axialToPixel(n.coord, hexSize);
      dists.push(Math.hypot(p.x - gcx, p.y - gcy));
    }
    dists.sort((a, b) => a - b);
    const median = dists[Math.floor(dists.length / 2)];
    const threshold = Math.max(median * 3, hexSize * 20);

    // Walk ALL frozen folders and teleport any whose centroid is still
    // far from the global centroid. Smaller groups first so they fit
    // into any gap the larger ones left open. We iterate deepest-first
    // so a stuck leaf folder is teleported as a unit rather than its
    // parent dragging it to a wrong location.
    // Any folder whose DIRECT leaves (the files that actually belong
    // to F itself, not to subfolders) form a stuck cluster. Process
    // deepest first so the most specific group is picked up, and
    // intermediate parents (with mixed in-blob / out-of-blob children)
    // are handled on their own merit without pulling already-landed
    // descendants along for the ride.
    const topLevel = [...folders.values()]
      .filter((f) => f.directLeaves.length > 0 && f.directLeaves.length <= 200)
      .sort((a, b) => b.depth - a.depth || a.directLeaves.length - b.directLeaves.length);

    let teleported = 0;
    const t0Tp = performance.now();
    for (const F of topLevel) {
      let ccx = 0, ccy = 0;
      for (const m of F.directLeaves) {
        const p = axialToPixel(m.coord, hexSize);
        ccx += p.x; ccy += p.y;
      }
      ccx /= F.directLeaves.length;
      ccy /= F.directLeaves.length;
      const d = Math.hypot(ccx - gcx, ccy - gcy);
      if (d < threshold) continue;
      if (teleportToFreeSpace(map, F.directLeaves, gcx, gcy, hexSize)) {
        teleported++;
        snaps.push(makeSnapshot(map, 0, `teleport.${F.path}`, `teleported ${F.path} (${F.directLeaves.length}n) from ${d.toFixed(0)}px`, frozenHullStack));
      }
    }
    console.log(`straggler teleport: ${teleported} groups in ${(performance.now() - t0Tp).toFixed(0)}ms, Σlinks=${map.totalLinkLength()}`);
  }

  snaps.push(makeSnapshot(map, 0, 'ring.done', 'assembly complete', frozenHullStack));
  console.log('ring stats:', stats);

  // ── Validation pass ──────────────────────────────────────────
  validateLayout(map, folders, hexSize);

  return snaps;
}

/**
 * Post-run validator. Checks three invariants the algorithm is supposed
 * to uphold:
 *   1. Every folder's tile set is hex-connected (no torn regions).
 *   2. Every pair of SIBLING folders (same parent) is hex-adjacent —
 *      i.e. some tile of A borders some tile of B. The assembly is
 *      supposed to keep siblings physically neighbouring.
 *   3. Nothing left far from the global centroid ("straggler census").
 *
 * Results are logged to the console; the function returns a summary
 * object for programmatic consumption.
 */
function validateLayout(map, folders, hexSize) {
  const torn = [];
  const disconnectedSiblings = [];
  const stragglers = [];

  // Invariant 1 — connectivity.
  for (const f of folders.values()) {
    if (f.transitiveLeaves.length <= 1) continue;
    const coords = f.transitiveLeaves.map((m) => ({ q: m.coord.q, r: m.coord.r }));
    const parts = countConnectedComponents(coords);
    if (parts > 1) torn.push({ path: f.path, size: coords.length, parts });
  }

  // Invariant 2 — sibling adjacency. Build a lookup: for each folder,
  // set of tile keys it owns. For each pair of siblings with the same
  // parent, check if their tile sets are adjacent via hex neighbours.
  for (const parent of folders.values()) {
    const children = [...parent.childFolders]
      .map((p) => folders.get(p))
      .filter((c) => c && c.transitiveLeaves.length > 0);
    if (children.length < 2) continue;
    const tiles = children.map((c) => {
      const s = new Set();
      for (const m of c.transitiveLeaves) s.add(hexKey(m.coord.q, m.coord.r));
      return { child: c, set: s };
    });
    for (let i = 0; i < tiles.length; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        if (!tileSetsAdjacent(tiles[i].set, tiles[j].set)) {
          disconnectedSiblings.push({
            parent: parent.path,
            a: tiles[i].child.path,
            b: tiles[j].child.path,
          });
        }
      }
    }
  }

  // Invariant 3 — straggler census.
  let gcx = 0, gcy = 0;
  for (const n of map.nodes.values()) {
    const p = axialToPixel(n.coord, hexSize);
    gcx += p.x; gcy += p.y;
  }
  gcx /= map.nodes.size; gcy /= map.nodes.size;

  const dists = [];
  for (const n of map.nodes.values()) {
    const p = axialToPixel(n.coord, hexSize);
    dists.push(Math.hypot(p.x - gcx, p.y - gcy));
  }
  dists.sort((a, b) => a - b);
  const median = dists[Math.floor(dists.length / 2)];
  const threshold = Math.max(median * 5, hexSize * 40);
  for (const n of map.nodes.values()) {
    const p = axialToPixel(n.coord, hexSize);
    const d = Math.hypot(p.x - gcx, p.y - gcy);
    if (d > threshold) stragglers.push({ id: n.id, dist: Math.round(d), region: n.regionId });
  }
  stragglers.sort((a, b) => b.dist - a.dist);

  console.log('─── validation ───');
  console.log(`torn folders: ${torn.length}`);
  if (torn.length > 0) {
    for (const t of torn.slice(0, 20)) console.log(`  ${t.path} (${t.size}n → ${t.parts} pieces)`);
    if (torn.length > 20) console.log(`  … ${torn.length - 20} more`);
  }
  console.log(`sibling pairs not adjacent: ${disconnectedSiblings.length}`);
  if (disconnectedSiblings.length > 0) {
    for (const p of disconnectedSiblings.slice(0, 10)) console.log(`  ${p.parent}: ${p.a} ↔ ${p.b}`);
    if (disconnectedSiblings.length > 10) console.log(`  … ${disconnectedSiblings.length - 10} more`);
  }
  console.log(`stragglers (>${Math.round(threshold)}px from centroid): ${stragglers.length}`);
  for (const s of stragglers.slice(0, 20)) console.log(`  ${s.id} @ ${s.dist}px (region: ${s.region})`);
  if (stragglers.length > 20) console.log(`  … ${stragglers.length - 20} more`);

  return { torn, disconnectedSiblings, stragglers };
}

/** Count connected components in a coord set via BFS. */
function countConnectedComponents(coords) {
  const set = new Set(coords.map((c) => hexKey(c.q, c.r)));
  const seen = new Set();
  let components = 0;
  for (const key of set) {
    if (seen.has(key)) continue;
    components++;
    const [q0, r0] = key.split(',').map(Number);
    const stack = [{ q: q0, r: r0 }];
    seen.add(key);
    while (stack.length > 0) {
      const c = stack.pop();
      for (const d of HEX_DIRS) {
        const nq = c.q + d.q, nr = c.r + d.r;
        const nk = hexKey(nq, nr);
        if (set.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          stack.push({ q: nq, r: nr });
        }
      }
    }
  }
  return components;
}

/** Do two hex tile sets share a border (any tile of A has a neighbour in B)? */
function tileSetsAdjacent(a, b) {
  for (const key of a) {
    const [q, r] = key.split(',').map(Number);
    for (const d of HEX_DIRS) {
      if (b.has(hexKey(q + d.q, r + d.r))) return true;
    }
  }
  return false;
}
