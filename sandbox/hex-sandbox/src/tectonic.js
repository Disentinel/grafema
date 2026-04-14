import { HEX_DIRS, hexKey, axialToPixel } from './hex.js';

/**
 * TectonicMap layout — didactic/debug implementation.
 *
 * Runs the five classical phases on a HexMap and returns an ordered
 * list of Snapshot objects. The caller uses them to scrub forward
 * and backward through the algorithm in a debug stepper UI.
 *
 * Every snapshot carries:
 *   - `name`     — short unique id like "p1.s2.place_beta". Stable
 *                  across reruns on the same input. Use this to
 *                  refer to a specific step in a bug report.
 *   - `phase`    — machine id (phase0..phase4)
 *   - `phaseLabel` — human-readable phase label
 *   - `step`     — global step index (0-based)
 *   - `localStep` — step index within this phase (0-based)
 *   - `description` — one-line explanation
 *   - `coords`   — full node-coord snapshot for restore
 *
 * @typedef {{
 *   name: string,
 *   phase: 'phase0' | 'phase1' | 'phase2' | 'phase3' | 'phase4',
 *   phaseLabel: string,
 *   step: number,
 *   localStep: number,
 *   description: string,
 *   coords: Map<string, { q: number, r: number }>,
 * }} Snapshot
 */

/**
 * @param {import('./map.js').HexMap} map
 * @param {{ hexSize?: number }} [opts]  hexSize is used to build
 *   world-space overlays (desire vectors) that the renderer can
 *   draw without re-doing the math. Defaults to 22 to match demo.js.
 * @returns {Snapshot[]}
 */
export function runTectonic(map, opts = {}) {
  const hexSize = opts.hexSize ?? 22;
  // Hand the helpers a reference so they can count phase3 snapshots
  // without an extra closure parameter.
  _stepsRef = null;
  /** @type {Snapshot[]} */
  const steps = [];
  _stepsRef = steps;
  /** Normalise a tag fragment into an identifier-safe string. */
  const tag = (s) => String(s).replace(/[^A-Za-z0-9_]+/g, '_').slice(0, 32);
  const snap = (phase, phaseLabel, localStep, description, tagSuffix = '', overlay = null) => {
    const phaseKey = phase.replace('phase', 'p');
    const name = tagSuffix
      ? `${phaseKey}.s${localStep}.${tag(tagSuffix)}`
      : `${phaseKey}.s${localStep}`;
    steps.push({
      name,
      phase,
      phaseLabel,
      step: steps.length,
      localStep,
      description,
      coords: map.takeSnapshot(),
      overlay,
    });
  };

  /**
   * Build a Phase 3 overlay: every region's centroid in WORLD pixel
   * space, the raw desire vector (before hex snap), and the chosen
   * hex direction for the region that just moved.
   *
   * @param {number} hexSize  pixel size used by the renderer
   * @param {string | null} actingRegionId  region that just moved
   * @param {{q:number, r:number} | null} chosenDir  the hex step taken
   * @returns {{ desires: Array<{
   *   regionId: string,
   *   cx: number, cy: number,
   *   rawDx: number, rawDy: number,
   *   chosenDx?: number, chosenDy?: number,
   * }> }}
   */
  function buildPhase3Overlay(hexSize, actingRegionId, chosenDir) {
    /** @type {any[]} */
    const desires = [];
    for (const region of sorted) {
      // Compute current centroid in world pixel space
      const centAxial = regionCentroid(region);
      const { x: cx, y: cy } = axialToPixel(centAxial, hexSize);

      // Recompute desire vector from scratch in pixel space:
      //   Σ affinity × unit(other_centroid_pixel − own_centroid_pixel)
      // The renderer draws arrows in pixel units, so the overlay has
      // to match that frame rather than the axial frame.
      let dx = 0, dy = 0;
      for (const other of sorted) {
        if (other.id === region.id) continue;
        const k = region.id < other.id
          ? `${region.id}|${other.id}`
          : `${other.id}|${region.id}`;
        const w = affinity.get(k) ?? 0;
        if (w === 0) continue;
        const oAxial = regionCentroid(other);
        const { x: ox, y: oy } = axialToPixel(oAxial, hexSize);
        const vx = ox - cx, vy = oy - cy;
        const mag = Math.hypot(vx, vy);
        if (mag < 0.01) continue;
        dx += w * vx / mag;
        dy += w * vy / mag;
      }

      const entry = {
        regionId: region.id,
        cx, cy,
        rawDx: dx,
        rawDy: dy,
      };
      if (region.id === actingRegionId && chosenDir) {
        // Hex step in pixel space = vector from origin to the
        // neighbouring hex center in that direction.
        const stepPx = axialToPixel(chosenDir, hexSize);
        entry.chosenDx = stepPx.x;
        entry.chosenDy = stepPx.y;
      }
      desires.push(entry);
    }
    // hexSize at build time — the renderer will scale by
    // (currentHexSize / overlay.hexSize) when drawing under zoom.
    return { desires, hexSize };
  }

  const regions = [...map.regions.values()].filter(r => r.nodes.size > 0);

  // ── Phase 0 — Preprocessing ──────────────────────────────────
  const L0 = 'Phase 0 — Preprocessing';
  snap('phase0', L0, 0,
    `Initial state · ${regions.length} regions, ${map.nodes.size} nodes`,
    'initial');

  // Cross-affinity: sum of link weights between each pair of regions.
  const affinity = new Map();
  for (const l of map.links) {
    const ra = l.source.regionId, rb = l.target.regionId;
    if (!ra || !rb || ra === rb) continue;
    const key = ra < rb ? `${ra}|${rb}` : `${rb}|${ra}`;
    affinity.set(key, (affinity.get(key) ?? 0) + l.weight);
  }
  snap('phase0', L0, 1,
    `Cross-affinity computed: ${affinity.size} region pairs`,
    'affinity');

  // ── Phase 1 — Coarse placement (top-down) ───────────────────
  // Largest region at origin, then place each next region in a hex
  // direction chosen deterministically, at a distance proportional
  // to its size. Nodes within a region are snapped to a compact
  // cluster via compactCluster().
  const L1 = 'Phase 1 — Coarse placement';
  const sorted = [...regions].sort((a, b) => b.nodes.size - a.nodes.size || a.id.localeCompare(b.id));
  /** @type {Map<string, {q:number, r:number}>} */
  const centroids = new Map();

  // Ring placement: largest region at origin, the rest distributed
  // evenly around a circle whose radius scales with the total node
  // count. This handles arbitrary N regions; the previous strategy
  // (HEX_DIRS[(ri*2) % 6]) collapsed multiple regions onto the same
  // direction once N > 6.
  const totalNodes = sorted.reduce((s, r) => s + r.nodes.size, 0);
  const ringRadius = Math.max(15, Math.ceil(Math.sqrt(totalNodes) * 1.6));

  sorted.forEach((region, ri) => {
    let target;
    if (centroids.size === 0) {
      target = { q: 0, r: 0 };
    } else if (sorted.length === 2) {
      target = { q: ringRadius, r: 0 };
    } else {
      // Distribute regions 1..N-1 around a circle. Treating axial
      // coords as Cartesian gives slightly elliptical spacing but
      // it's good enough for an initial placement that drift will
      // refine anyway.
      const angle = (2 * Math.PI * (ri - 1)) / (sorted.length - 1);
      target = {
        q: Math.round(ringRadius * Math.cos(angle)),
        r: Math.round(ringRadius * Math.sin(angle)),
      };
    }
    centroids.set(region.id, target);

    // Reposition nodes to a compact cluster around target.
    const offsets = compactCluster(region.nodes.size);
    const list = [...region.nodes];
    for (let i = 0; i < list.length; i++) {
      list[i].coord.q = target.q + offsets[i].q;
      list[i].coord.r = target.r + offsets[i].r;
    }
    map._rebuildSpatialIndex();

    snap('phase1', L1, ri,
      `Placed '${region.id}' at (${target.q}, ${target.r}) · ${region.nodes.size} tiles`,
      `place_${region.id}`);
  });

  // ── Phase 2 — Flood fill ─────────────────────────────────────
  // For sandbox-scale data, Phase 1 already places regions in a
  // compact cluster shape, so Phase 2 is an identity pass — shown
  // as a single step for completeness.
  const L2 = 'Phase 2 — Flood fill';
  snap('phase2', L2, 0,
    'Regions already compact after coarse placement (identity pass in sandbox)',
    'noop');

  // ── Phase 3 — Drift ──────────────────────────────────────────
  // Each region gets a desire vector = Σ (affinity × unit-toward-
  // other-centroid). Compute it in PIXEL space (axial coordinates
  // are not orthogonal, so axial-space angles are wrong; using
  // pixel-space here matches `buildPhase3Overlay`).
  //
  // Then try to step in the hex direction with the highest dot
  // product to the desire. If that direction is blocked, fall back
  // to the next-best (sidestep). Only directions with a NON-NEGATIVE
  // dot are allowed — never move directly away from the goal.
  //
  // This sidestep behaviour lets a region flow AROUND an obstacle
  // (e.g. another region) without needing simulated annealing. The
  // multi-direction fallback is purely greedy/deterministic.
  //
  // Termination criteria (in priority order):
  //   1. No region moved this outer iter → fixed point: every region
  //      is either at target or fully boxed in (no admissible dir).
  //   2. Per-region move cap (oscillation guard).
  //   3. Hard safety cap on outer iterations.
  const L3 = 'Phase 3 — Drift';
  const MAX_OUTER = 500;
  const PER_REGION_MOVE_CAP = 200;
  const FP_RING = 6;        // recent fingerprints kept per region
  const LEAP_DISTANCES = [3, 5, 8]; // try these jumps when oscillating
  /** @type {Map<string, number>} */
  const moveCount = new Map();
  /** @type {Map<string, number[]>}  Per-region ring buffer of recent
   *  position fingerprints. A proposed move that would land on a
   *  previously-seen fingerprint is treated as oscillation. */
  const driftFp = new Map();
  for (const r of sorted) {
    moveCount.set(r.id, 0);
    driftFp.set(r.id, []);
  }

  /** Compute the fingerprint of a region IF every leaf shifted by (dq, dr).
   *  Sort+FNV-1a-32 of axial coords; cheap and order-stable. */
  function shiftedFingerprint(region, dq, dr) {
    /** @type {number[]} */
    const coords = [];
    for (const n of region.nodes) {
      coords.push((n.coord.q + dq) * 100003 + (n.coord.r + dr));
    }
    coords.sort((a, b) => a - b);
    let h = 0x811c9dc5;
    for (const c of coords) {
      h = Math.imul(h ^ (c & 0xffff), 16777619);
      h = Math.imul(h ^ ((c >>> 16) & 0xffff), 16777619);
    }
    return h >>> 0;
  }

  let phase3Seen = false;
  let terminationReason = '';
  let outerCompleted = 0;
  let intoptCount = 0;
  for (let outer = 0; outer < MAX_OUTER; outer++) {
    outerCompleted = outer + 1;
    let anyMoved = false;
    let anyBlocked = false;
    let anyNoDesire = false;
    /** Regions that moved this outer iter — eligible for post-iter
     *  internal optimization (free nodes shuffled out of the way). */
    const movedThisOuter = new Set();
    for (const region of sorted) {
      if ((moveCount.get(region.id) ?? 0) >= PER_REGION_MOVE_CAP) continue;

      // Compute desire in PIXEL space (consistent with overlay math)
      const ownAxial = regionCentroid(region);
      const ownPx = axialToPixel(ownAxial, hexSize);
      let dx = 0, dy = 0;
      for (const [pid, pc] of centroids) {
        if (pid === region.id) continue;
        const k = region.id < pid ? `${region.id}|${pid}` : `${pid}|${region.id}`;
        const w = affinity.get(k) ?? 0;
        if (w === 0) continue;
        const otherPx = axialToPixel(pc, hexSize);
        const vx = otherPx.x - ownPx.x;
        const vy = otherPx.y - ownPx.y;
        const mag = Math.hypot(vx, vy);
        if (mag < 0.01) continue;
        dx += w * vx / mag;
        dy += w * vy / mag;
      }
      const desireMag = Math.hypot(dx, dy);
      if (desireMag < 0.01) { anyNoDesire = true; continue; }

      // Try each hex direction in order of dot product to desire.
      // Skip directions with negative dot (would move backward).
      // Also reject any move whose prospective state fingerprint
      // matches a recently-seen one for this region — that's an
      // oscillation cycle.
      const ranked = rankedHexDirs(dx, dy, hexSize);
      const mem = driftFp.get(region.id) ?? [];
      let chosen = null;
      let sidestepRank = 0;
      let leapDistance = 1;
      let oscillationSeen = false;

      // Pass 1: single-step sidesteps with fingerprint check
      for (let i = 0; i < ranked.length; i++) {
        const cand = ranked[i];
        if (cand.dot <= 0) break;
        if (!canShiftRegion(map, region, cand.dir)) continue;
        const fp = shiftedFingerprint(region, cand.dir.q, cand.dir.r);
        if (mem.includes(fp)) { oscillationSeen = true; continue; }
        chosen = cand.dir;
        sidestepRank = i;
        break;
      }

      // Pass 2: big-leap fallback if all single steps were blocked
      // or oscillating. Try jumping 3/5/8 hexes in each ranked
      // direction. The leap must clear the obstacle entirely (every
      // intermediate destination tile must be free OR same-region).
      if (!chosen && oscillationSeen) {
        outer_leap: for (const cand of ranked) {
          if (cand.dot <= 0) break;
          for (const L of LEAP_DISTANCES) {
            const big = { q: cand.dir.q * L, r: cand.dir.r * L };
            if (!canShiftRegion(map, region, big)) continue;
            const fp = shiftedFingerprint(region, big.q, big.r);
            if (mem.includes(fp)) continue;
            chosen = big;
            leapDistance = L;
            sidestepRank = 0; // it's a leap, not a sidestep
            break outer_leap;
          }
        }
      }

      if (!chosen) { anyBlocked = true; continue; }

      for (const n of region.nodes) {
        n.coord.q += chosen.q;
        n.coord.r += chosen.r;
      }
      map._rebuildSpatialIndex();
      centroids.set(region.id, regionCentroid(region));
      anyMoved = true;
      phase3Seen = true;
      moveCount.set(region.id, (moveCount.get(region.id) ?? 0) + 1);
      movedThisOuter.add(region.id);

      // Record the new fingerprint in the ring buffer
      const newFp = shiftedFingerprint(region, 0, 0);
      mem.push(newFp);
      if (mem.length > FP_RING) mem.shift();
      driftFp.set(region.id, mem);

      const localIdx = steps.filter(s => s.phase === 'phase3').length;
      const overlay = buildPhase3Overlay(hexSize, region.id, {
        q: Math.sign(chosen.q),
        r: Math.sign(chosen.r),
      });
      const opLabel = leapDistance > 1
        ? `LEAP ×${leapDistance}`
        : sidestepRank === 0
          ? 'preferred'
          : `sidestep #${sidestepRank}`;
      const tagSuffix = leapDistance > 1
        ? `leap_${region.id}_x${leapDistance}`
        : `drift_${region.id}_iter${outer + 1}${sidestepRank > 0 ? '_sidestep' : ''}`;
      snap('phase3', L3, localIdx,
        `Drift '${region.id}' by (${chosen.q}, ${chosen.r}) · ${opLabel} · len=${map.totalLinkLength()}`,
        tagSuffix,
        overlay);
    }
    // ── Post-iter internal optimization ──────────────────
    // For every region that moved this outer iter, run a greedy
    // intra-region swap loop. This rearranges nodes WITHIN the
    // region (no tile set / shape / centroid change) so that
    // externally-connected nodes drift to the boundary side
    // facing their partners, and free / interior nodes get pushed
    // into the middle. After intopt, drift's fingerprint memory
    // for that region is cleared — the layout has materially
    // changed, so old fingerprints aren't oscillation evidence.
    for (const region of sorted) {
      if (!movedThisOuter.has(region.id)) continue;
      const swapsApplied = runInternalOpt(map, region, snap, hexSize, outer + 1);
      if (swapsApplied > 0) {
        intoptCount += swapsApplied;
        driftFp.set(region.id, []); // reset oscillation memory
        centroids.set(region.id, regionCentroid(region)); // unchanged but explicit
      }
    }

    if (!anyMoved) {
      terminationReason = anyBlocked
        ? `${anyNoDesire ? 'some regions satisfied, others blocked' : 'all regions blocked by collisions'}`
        : 'all regions satisfied (no desire)';
      break;
    }
  }
  if (phase3Seen) {
    // A final snapshot explaining WHY drift stopped. Useful for
    // debugging "did it reach the collision state or give up early".
    const reason = terminationReason || `hit MAX_OUTER safety cap (${MAX_OUTER})`;
    const localIdx = steps.filter(s => s.phase === 'phase3').length;
    snap('phase3', L3, localIdx,
      `Drift settled after ${outerCompleted} outer iters · ${intoptCount} internal swaps · reason: ${reason}`,
      'settled',
      buildPhase3Overlay(hexSize, null, null));
  } else {
    snap('phase3', L3, 0,
      'No drift moves accepted (layout already satisfies affinity)',
      'noop',
      buildPhase3Overlay(hexSize, null, null));
  }

  // ── Phase 4 — Boundary refinement ────────────────────────────
  // Two kinds of operations are considered each pass:
  //   • SWAP — exchange coords of two nodes from different regions
  //            that are hex-adjacent. Region membership stays put,
  //            only physical positions change.
  //   • MOVE — move a single node into a free hex that is adjacent
  //            to at least one OTHER same-region tile (so the new
  //            position stays connected to the rest of the region).
  //
  // Both kinds are accepted iff:
  //   1. totalLinkLength strictly decreases AND
  //   2. every region involved remains spatially connected after
  //      the operation (BFS reachability == region size).
  //
  // The connectivity guard is critical: a boundary node may be the
  // only bridge between two halves of its region; without the BFS
  // check, accepting a swap or move that removes that bridge tears
  // the region into pieces.
  //
  // Greedy: each pass scans candidates and applies the FIRST
  // accepting one, then restarts (positions changed, the rest of
  // the candidate list is stale). Loops until no candidate improves.
  // Lex cost = [totalLinkLength, centroidAttractionPenalty]. Phase 4
  // accepts a move if primary strictly improves OR primary is tied
  // and secondary improves. The secondary term lets free / degree-0
  // nodes deform region boundaries into "approach zone" gaps when
  // doing so brings region centroids closer along affinity edges,
  // even if the link-length cost doesn't budge.
  const sortedRegions = sorted; // alias used below
  const lexCost = () => {
    const linkLen = map.totalLinkLength();
    let pen = 0;
    const cs = sortedRegions.map(r => regionCentroid(r));
    for (let i = 0; i < sortedRegions.length; i++) {
      for (let j = i + 1; j < sortedRegions.length; j++) {
        const ri = sortedRegions[i].id;
        const rj = sortedRegions[j].id;
        const k = ri < rj ? `${ri}|${rj}` : `${rj}|${ri}`;
        const w = affinity.get(k) ?? 0;
        if (w === 0) continue;
        const dq = cs[i].q - cs[j].q;
        const dr = cs[i].r - cs[j].r;
        pen += w * Math.sqrt(dq * dq + dr * dr);
      }
    }
    return [linkLen, pen];
  };
  const lexLess = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

  const L4 = 'Phase 4 — Boundary refinement';
  const MAX_OPS = 200;
  let opCount = 0;
  let rejectedConnectivity = 0;
  let rejectedNoGain = 0;
  let acceptedXSwaps = 0;
  let acceptedISwaps = 0;
  let acceptedMoves = 0;

  for (let pass = 0; pass < 30; pass++) {
    let accepted = false;

    // ── 1. Cross-region swap candidates ────────────────────
    // Highest-leverage op: changes inter-region link distances.
    for (const [a, b] of boundaryPairs(map)) {
      if (opCount >= MAX_OPS) break;
      const regionA = map.regions.get(a.regionId);
      const regionB = map.regions.get(b.regionId);
      if (!regionA || !regionB) continue;

      const before = lexCost();
      swapCoordsInPlace(a, b);
      const after = lexCost();

      const okCost = lexLess(after, before);
      const okConnA = okCost && regionConnected(regionA);
      const okConnB = okConnA && regionConnected(regionB);

      if (okConnB) {
        map._rebuildSpatialIndex();
        opCount++;
        acceptedXSwaps++;
        accepted = true;
        snap('phase4', L4, opCount - 1,
          `XSwap '${a.id}' ↔ '${b.id}' · len ${before[0]} → ${after[0]}`,
          `xswap_${a.id}_${b.id}`);
        break;
      } else {
        if (okCost) rejectedConnectivity++;
        else        rejectedNoGain++;
        swapCoordsInPlace(a, b);
      }
    }
    if (accepted) continue;

    // ── 2. Intra-region swap candidates ────────────────────
    // Same region, swap two nodes' positions. Useful when a free
    // (degree-0) node sits in the path of a linked node — the swap
    // moves the linked node toward its connected partners and the
    // free node into the vacated interior slot. Connectivity is
    // automatically preserved (region's tile set is unchanged).
    for (const [a, b] of intraRegionSwapCandidates(map)) {
      if (opCount >= MAX_OPS) break;
      const before = map.totalLinkLength();
      swapCoordsInPlace(a, b);
      const after = map.totalLinkLength();
      if (after < before) {
        // Tile set didn't change → no connectivity check needed.
        map._rebuildSpatialIndex();
        opCount++;
        acceptedISwaps++;
        accepted = true;
        snap('phase4', L4, opCount - 1,
          `ISwap '${a.id}' ↔ '${b.id}' (same region '${a.regionId}') · ${before} → ${after} (-${before - after})`,
          `iswap_${a.id}_${b.id}`);
        break;
      } else {
        rejectedNoGain++;
        swapCoordsInPlace(a, b);
      }
    }
    if (accepted) continue;

    // ── 3. Move-to-empty candidates (with lex cost) ───────
    // This is the path that closes inter-region gaps: a free node
    // shifts into an empty hex in the "approach zone" toward a
    // partner region. Link length may be unchanged, but centroid
    // penalty drops → lex acceptance allows it.
    for (const move of emptyMoveCandidates(map)) {
      if (opCount >= MAX_OPS) break;
      const { node, newQ, newR } = move;
      const region = map.regions.get(node.regionId);
      if (!region) continue;

      const oldQ = node.coord.q;
      const oldR = node.coord.r;
      const before = lexCost();
      node.coord.q = newQ;
      node.coord.r = newR;
      const after = lexCost();

      const okCost = lexLess(after, before);
      const okConn = okCost && regionConnected(region);

      if (okConn) {
        map._rebuildSpatialIndex();
        opCount++;
        acceptedMoves++;
        accepted = true;
        const tieBreak = after[0] === before[0] ? ' (centroid)' : '';
        snap('phase4', L4, opCount - 1,
          `Move '${node.id}' to (${newQ}, ${newR}) · len ${before[0]} → ${after[0]}${tieBreak}`,
          `move_${node.id}_to_${newQ}_${newR}`);
        break;
      } else {
        if (okCost) rejectedConnectivity++;
        else        rejectedNoGain++;
        node.coord.q = oldQ;
        node.coord.r = oldR;
      }
    }

    if (!accepted) break;
  }

  if (opCount === 0) {
    snap('phase4', L4, 0,
      `No improving ops · ${rejectedConnectivity} rejected for connectivity, ${rejectedNoGain} gave no length gain`,
      'noop');
  } else {
    snap('phase4', L4, opCount,
      `Phase 4 done: ${acceptedXSwaps} xswaps + ${acceptedISwaps} iswaps + ${acceptedMoves} moves · ${rejectedConnectivity} split-rejected · ${rejectedNoGain} no-gain rejected`,
      'summary');
  }

  return steps;
}

/**
 * Enumerate intra-region node pairs. O(N²) — fine for sandbox sizes.
 * Sorted deterministically by id pair so reruns produce the same
 * stepper sequence on the same input.
 *
 * No filtering by degree: the improvement check `after < before` in
 * the caller naturally rejects useless swaps. Swap pairs that don't
 * help (both degree 0, or both already-optimal) get rejected as
 * `no-gain` and we move on.
 */
function* intraRegionSwapCandidates(map) {
  const ordered = [...map.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    if (!a.regionId) continue;
    for (let j = i + 1; j < ordered.length; j++) {
      const b = ordered[j];
      if (b.regionId !== a.regionId) continue;
      yield [a, b];
    }
  }
}

/**
 * Enumerate "move into empty adjacent hex" candidates. For every
 * occupied node, look at each of its 6 hex neighbours; if one is
 * empty AND at least one of THAT empty hex's other neighbours is
 * a same-region tile, yield a candidate move.
 *
 * Why the "at least one same-region neighbour" filter? Because a
 * move into a fully-isolated empty hex would create an orphan
 * tile of the region — the BFS connectivity check would reject it
 * anyway, but eliminating obviously-bad candidates upfront saves
 * a totalLinkLength pass per skip.
 */
function* emptyMoveCandidates(map) {
  for (const node of map.nodes.values()) {
    if (!node.regionId) continue;
    for (const d of HEX_DIRS) {
      const newQ = node.coord.q + d.q;
      const newR = node.coord.r + d.r;
      const newK = hexKey(newQ, newR);
      if (map._byCoord.has(newK)) continue;          // not empty
      // Probe the empty hex's own neighbours for same-region tiles
      // OTHER than `node` itself (which is leaving).
      let touchesSame = false;
      for (const d2 of HEX_DIRS) {
        const nb = map._byCoord.get(hexKey(newQ + d2.q, newR + d2.r));
        if (nb && nb !== node && nb.regionId === node.regionId) {
          touchesSame = true;
          break;
        }
      }
      if (!touchesSame) continue;
      yield { node, newQ, newR };
    }
  }
}

/**
 * Check that the tiles of `region` form a single connected component
 * under hex adjacency. BFS from any tile, count reachable members.
 * O(|region|).
 */
function regionConnected(region) {
  if (region.nodes.size <= 1) return true;
  /** @type {Map<string, import('./node.js').Node>} */
  const tileMap = new Map();
  for (const n of region.nodes) tileMap.set(hexKey(n.coord.q, n.coord.r), n);
  const start = region.nodes.values().next().value;
  const visited = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    for (const d of HEX_DIRS) {
      const k = hexKey(cur.coord.q + d.q, cur.coord.r + d.r);
      const nb = tileMap.get(k);
      if (nb && !visited.has(nb)) {
        visited.add(nb);
        queue.push(nb);
      }
    }
  }
  return visited.size === region.nodes.size;
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Greedy intra-region swap loop. Rearranges nodes WITHIN a region
 * so that externally-connected ones gravitate toward boundary tiles
 * facing their partner regions, while free / less-connected nodes
 * get pushed into the interior.
 *
 * The region's tile SET is unchanged → shape is unchanged → centroid
 * is unchanged. Only "which node sits on which tile" rotates.
 *
 * Greedy first-fit: scan all (a, b) pairs in deterministic id order,
 * accept the first swap that strictly reduces totalLinkLength,
 * restart the scan. Stops when no pair improves cost.
 *
 * Each accepted swap emits its own snapshot tagged `intopt_<region>_<a>_<b>`,
 * so the stepper can show the rearrangement step by step.
 *
 * @returns {number}  count of accepted swaps
 */
function runInternalOpt(map, region, snapFn, hexSize, outerIter) {
  const L = 'Phase 3 — Internal reorganization';
  const MAX_PASSES = 12;
  let count = 0;
  const before0 = map.totalLinkLength();

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let accepted = false;
    const ordered = [...region.nodes].sort((a, b) => a.id.localeCompare(b.id));

    outer_loop: for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i];
        const b = ordered[j];
        const before = map.totalLinkLength();
        swapCoordsInPlace(a, b);
        const after = map.totalLinkLength();
        if (after < before) {
          // No connectivity check needed: tile set unchanged.
          map._rebuildSpatialIndex();
          count++;
          accepted = true;
          break outer_loop;
        } else {
          swapCoordsInPlace(a, b);
        }
      }
    }
    if (!accepted) break;
  }

  // Collapse the whole intopt invocation into a SINGLE snapshot.
  // Per-swap snapshots blow up the stepper at 12-region scale —
  // a 25-node region can do ~10 swaps per invocation, ×12 regions
  // ×100 outer iters = thousands of snapshots no one wants to
  // scrub through. The tag carries the count so the stepper line
  // is still informative.
  if (count > 0) {
    const after0 = map.totalLinkLength();
    const localIdx = countPhase3Snaps();
    snapFn('phase3', L, localIdx,
      `Internal opt '${region.id}': ${count} swaps · ${before0} → ${after0} (-${before0 - after0}) · outer ${outerIter}`,
      `intopt_${region.id}_${count}swaps`,
      null);
  }
  return count;
}

// Counts existing phase3 snapshots — used by runInternalOpt to assign
// a localStep without hard-coding `steps` reference. The closure inside
// `runTectonic` injects this; for clean separation we look at the
// parent scope via a closure variable. See runTectonic below.
let _stepsRef = null;
function countPhase3Snaps() {
  if (!_stepsRef) return 0;
  let n = 0;
  for (const s of _stepsRef) if (s.phase === 'phase3') n++;
  return n;
}


/** Centroid of a region's current node positions as {q, r} floats. */
function regionCentroid(region) {
  let sq = 0, sr = 0, n = 0;
  for (const node of region.nodes) {
    sq += node.coord.q;
    sr += node.coord.r;
    n++;
  }
  return n === 0 ? { q: 0, r: 0 } : { q: sq / n, r: sr / n };
}

/** Nearest of the 6 axial hex directions to a 2D vector (qf, rf). */
function nearestHexDir(qf, rf) {
  if (Math.abs(qf) + Math.abs(rf) < 0.01) return null;
  let best = null;
  let bestDot = -Infinity;
  const mag = Math.hypot(qf, rf) || 1;
  const uq = qf / mag, ur = rf / mag;
  for (const d of HEX_DIRS) {
    const dm = Math.hypot(d.q, d.r);
    const du = d.q / dm, dv = d.r / dm;
    const dot = uq * du + ur * dv;
    if (dot > bestDot) { bestDot = dot; best = d; }
  }
  return best;
}

/**
 * Rank ALL six hex directions by their dot product to a pixel-space
 * desire vector (descending). Used by drift to fall back from the
 * preferred direction to the next-best when the preferred is blocked.
 *
 * Comparison is done in pixel space via axialToPixel — axial space
 * is not orthogonal, so axial dot products give wrong angles.
 *
 * @param {number} desireDx  pixel-space x of desire vector
 * @param {number} desireDy  pixel-space y of desire vector
 * @param {number} hexSize   used to rank directions in the same units
 * @returns {Array<{ dir: {q:number, r:number}, dot: number }>}
 */
function rankedHexDirs(desireDx, desireDy, hexSize) {
  const m = Math.hypot(desireDx, desireDy);
  if (m < 1e-6) return [];
  const ux = desireDx / m;
  const uy = desireDy / m;
  return HEX_DIRS
    .map((d) => {
      const px = axialToPixel(d, hexSize);
      const dm = Math.hypot(px.x, px.y);
      const dot = (px.x / dm) * ux + (px.y / dm) * uy;
      return { dir: d, dot };
    })
    .sort((a, b) => b.dot - a.dot);
}

/**
 * Can every leaf of `region` shift by `dir` without colliding with
 * a tile owned by any other region? O(|region.nodes|).
 */
function canShiftRegion(map, region, dir) {
  for (const n of region.nodes) {
    const k = hexKey(n.coord.q + dir.q, n.coord.r + dir.r);
    const owner = map._byCoord.get(k);
    if (owner && !region.nodes.has(owner)) return false;
  }
  return true;
}

/**
 * Enumerate distinct pairs of nodes from different regions that are
 * hex-adjacent on the current grid. Deterministic order by node ids.
 */
function boundaryPairs(map) {
  const out = [];
  const seen = new Set();
  const ordered = [...map.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const n of ordered) {
    if (!n.regionId) continue;
    for (const d of HEX_DIRS) {
      const nb = map._byCoord.get(hexKey(n.coord.q + d.q, n.coord.r + d.r));
      if (!nb || !nb.regionId || nb.regionId === n.regionId) continue;
      const k = n.id < nb.id ? `${n.id}|${nb.id}` : `${nb.id}|${n.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([n, nb]);
    }
  }
  return out;
}

/** In-place coord swap, no spatial-index update (caller rebuilds). */
function swapCoordsInPlace(a, b) {
  const tq = a.coord.q, tr = a.coord.r;
  a.coord.q = b.coord.q; a.coord.r = b.coord.r;
  b.coord.q = tq;        b.coord.r = tr;
}

/**
 * First N cells of a compact hex cluster around origin, ordered by
 * hex-distance then (q, r) for determinism. Same algo as demo.js
 * spiralCells, duplicated locally to keep tectonic.js self-contained.
 */
function compactCluster(n) {
  const R = Math.ceil(Math.sqrt(n)) + 2;
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
