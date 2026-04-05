/**
 * Hex layout via simulated annealing.
 *
 * Single algorithm that organically satisfies all constraints:
 * 1. Region connectivity (hard constraint — always enforced)
 * 2. Minimal total edge length (primary cost)
 * 3. Per-node proximity to specific neighbors (embedded in cost)
 * 4. Compactness (secondary cost term)
 * 5. Organic shapes (emergent from optimization)
 */

import type { GraphEdge } from './dataStore';

export interface LayoutNode {
  id: string;
  type: string;
  name: string;
  file: string;
  region: string;
  degree: number;
}

export interface LayoutResult {
  tileCoords: Map<number, { q: number; r: number }>;
  cost: number;
  iterations: number;
}

const CUBE_DIRS = [
  { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 },
  { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 },
];

function tileKey(q: number, r: number): string { return `${q},${r}`; }

function cubeDistance(a: { q: number; r: number }, b: { q: number; r: number }): number {
  return Math.max(
    Math.abs(a.q - b.q),
    Math.abs(a.r - b.r),
    Math.abs((a.q + a.r) - (b.q + b.r)),
  );
}

/**
 * Deterministic PRNG (mulberry32).
 * Same seed → same sequence → same layout every time.
 */
function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function _hexSpiral(count: number): { q: number; r: number }[] {
  const tiles: { q: number; r: number }[] = [{ q: 0, r: 0 }];
  let radius = 1;
  while (tiles.length < count) {
    let q = radius * CUBE_DIRS[4].q;
    let r = radius * CUBE_DIRS[4].r;
    for (let side = 0; side < 6; side++) {
      for (let step = 0; step < radius; step++) {
        if (tiles.length >= count) break;
        tiles.push({ q, r });
        q += CUBE_DIRS[side].q;
        r += CUBE_DIRS[side].r;
      }
    }
    radius++;
  }
  return tiles.slice(0, count);
}

/**
 * Simulated annealing layout for hex grid.
 */
export function annealingLayout(
  nodes: LayoutNode[],
  edges: GraphEdge[],
  regionNames: string[],
): LayoutResult {
  const N = nodes.length;

  // --- Build adjacency ---
  const nodeEdges = new Map<number, number[]>();
  for (const e of edges) {
    if (!nodeEdges.has(e.source)) nodeEdges.set(e.source, []);
    if (!nodeEdges.has(e.target)) nodeEdges.set(e.target, []);
    nodeEdges.get(e.source)!.push(e.target);
    nodeEdges.get(e.target)!.push(e.source);
  }

  // --- Region membership ---
  const regionIndices = new Map<string, number[]>();
  for (let i = 0; i < N; i++) {
    const r = nodes[i].region;
    if (!regionIndices.has(r)) regionIndices.set(r, []);
    regionIndices.get(r)!.push(i);
  }

  // --- Cross-region edge weights for initial seed placement ---
  const pairWeight = new Map<string, number>();
  for (const e of edges) {
    const r1 = nodes[e.source]?.region;
    const r2 = nodes[e.target]?.region;
    if (!r1 || !r2 || r1 === r2) continue;
    const key = [r1, r2].sort().join('|');
    pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1);
  }

  // --- Initial placement: competitive flood fill (simple, fast) ---
  const tileCoords = new Map<number, { q: number; r: number }>();
  const claimed = new Map<string, string>(); // tileKey → region
  const tileToNode = new Map<string, number>(); // tileKey → nodeIdx

  // Place region seeds: biggest first at origin, others near connected
  const sorted = [...regionNames].sort((a, b) =>
    (regionIndices.get(b)?.length ?? 0) - (regionIndices.get(a)?.length ?? 0),
  );

  const seeds = new Map<string, { q: number; r: number }>();
  seeds.set(sorted[0], { q: 0, r: 0 });
  claimed.set(tileKey(0, 0), sorted[0]);

  for (let i = 1; i < sorted.length; i++) {
    const region = sorted[i];
    let bestTarget: { q: number; r: number } = { q: 0, r: 0 };
    let bestWeight = 0;
    for (const [placed] of seeds) {
      const key = [region, placed].sort().join('|');
      const w = pairWeight.get(key) ?? 0;
      if (w > bestWeight) { bestWeight = w; bestTarget = seeds.get(placed)!; }
    }
    const searchStart = bestWeight > 0 ? 3 : 6; // wider for gap buffer
    let placed = false;
    for (let rad = searchStart; rad < 20 && !placed; rad++) {
      let rq = bestTarget.q + rad * CUBE_DIRS[4].q;
      let rr = bestTarget.r + rad * CUBE_DIRS[4].r;
      for (let side = 0; side < 6 && !placed; side++) {
        for (let step = 0; step < rad && !placed; step++) {
          const k = tileKey(rq, rr);
          if (!claimed.has(k)) {
            seeds.set(region, { q: rq, r: rr });
            claimed.set(k, region);
            placed = true;
          }
          rq += CUBE_DIRS[side].q;
          rr += CUBE_DIRS[side].r;
        }
      }
    }
  }

  // Gap enforcement: 1 empty tile between regions.
  function canClaim(q: number, r: number, region: string): boolean {
    for (const dir of CUBE_DIRS) {
      const nk = tileKey(q + dir.q, r + dir.r);
      const owner = claimed.get(nk);
      if (owner && owner !== region) return false;
    }
    return true;
  }

  // Flood fill
  const frontiers = new Map<string, Set<string>>();
  const remaining = new Map<string, number>();
  for (const region of regionNames) {
    remaining.set(region, (regionIndices.get(region)?.length ?? 1) - 1);
    const seed = seeds.get(region)!;
    const frontier = new Set<string>();
    for (const dir of CUBE_DIRS) {
      const k = tileKey(seed.q + dir.q, seed.r + dir.r);
      if (!claimed.has(k)) frontier.add(k);
    }
    frontiers.set(region, frontier);
  }

  for (let iter = 0; iter < 500; iter++) {
    let any = false;
    for (const region of regionNames) {
      const need = remaining.get(region) ?? 0;
      if (need <= 0) continue;
      const frontier = frontiers.get(region)!;
      for (const k of frontier) { if (claimed.has(k)) frontier.delete(k); }
      if (frontier.size === 0) continue;

      // Pick tile: most same-region neighbors, break ties by proximity to seed.
      // This fills inward before outward, preventing ring-shaped holes.
      const regionSeed = seeds.get(region) ?? { q: 0, r: 0 };
      let bestTile: string | null = null;
      let bestScore = -1;
      let bestDist = Infinity;
      for (const k of frontier) {
        const [q, r] = k.split(',').map(Number);
        if (!canClaim(q, r, region)) continue;
        let score = 0;
        for (const dir of CUBE_DIRS) {
          if (claimed.get(tileKey(q + dir.q, r + dir.r)) === region) score++;
        }
        const dist = cubeDistance({ q, r }, regionSeed);
        if (score > bestScore || (score === bestScore && dist < bestDist)) {
          bestScore = score;
          bestDist = dist;
          bestTile = k;
        }
      }
      if (!bestTile) continue;
      claimed.set(bestTile, region);
      frontier.delete(bestTile);
      remaining.set(region, need - 1);
      any = true;
      const [q, r] = bestTile.split(',').map(Number);
      for (const dir of CUBE_DIRS) {
        const nk = tileKey(q + dir.q, r + dir.r);
        if (!claimed.has(nk)) frontier.add(nk);
      }
    }
    if (!any) break;
  }

  // Assign nodes to tiles: by degree (important near center)
  for (const region of regionNames) {
    const indices = regionIndices.get(region) ?? [];
    const tiles: { q: number; r: number }[] = [];
    for (const [k, r] of claimed) {
      if (r === region) { const [q, rr] = k.split(',').map(Number); tiles.push({ q, r: rr }); }
    }
    const seed = seeds.get(region) ?? { q: 0, r: 0 };
    tiles.sort((a, b) => cubeDistance(a, seed) - cubeDistance(b, seed));
    const sortedIdx = [...indices].sort((a, b) => nodes[b].degree - nodes[a].degree);
    for (let j = 0; j < sortedIdx.length && j < tiles.length; j++) {
      tileCoords.set(sortedIdx[j], tiles[j]);
      tileToNode.set(tileKey(tiles[j].q, tiles[j].r), sortedIdx[j]);
    }
  }

  // Place any unplaced nodes in overflow spiral
  let overflowRadius = 0;
  for (const [k] of claimed) {
    const [q, r] = k.split(',').map(Number);
    overflowRadius = Math.max(overflowRadius, Math.abs(q), Math.abs(r));
  }
  overflowRadius += 3;
  for (let i = 0; i < N; i++) {
    if (!tileCoords.has(i)) {
      // Find next unclaimed tile in overflow area
      for (let rad = overflowRadius; rad < overflowRadius + N; rad++) {
        let placed = false;
        let rq = rad * CUBE_DIRS[4].q;
        let rr = rad * CUBE_DIRS[4].r;
        for (let side = 0; side < 6 && !placed; side++) {
          for (let step = 0; step < rad && !placed; step++) {
            const k = tileKey(rq, rr);
            if (!claimed.has(k)) {
              const region = nodes[i].region;
              claimed.set(k, region);
              tileCoords.set(i, { q: rq, r: rr });
              tileToNode.set(k, i);
              placed = true;
            }
            rq += CUBE_DIRS[side].q;
            rr += CUBE_DIRS[side].r;
          }
        }
        if (placed) break;
      }
    }
  }

  // Structural edge types — excluded from layout cost
  // (they exist for hierarchy/LOD, not for spatial proximity)
  const STRUCTURAL_EDGES = new Set(['CONTAINS', 'HAS_SCOPE', 'HAS_BODY', 'DECLARES']);

  // Precompute semantic adjacency (exclude structural edges)
  const semanticNodeEdges = new Map<number, { target: number; weight: number }[]>();
  for (const e of edges) {
    if (STRUCTURAL_EDGES.has(e.type)) continue;
    if (!semanticNodeEdges.has(e.source)) semanticNodeEdges.set(e.source, []);
    if (!semanticNodeEdges.has(e.target)) semanticNodeEdges.set(e.target, []);
    semanticNodeEdges.get(e.source)!.push({ target: e.target, weight: 1 });
    semanticNodeEdges.get(e.target)!.push({ target: e.source, weight: 1 });
  }

  // --- Cost function ---
  function totalCost(): number {
    let cost = 0;
    for (const e of edges) {
      if (STRUCTURAL_EDGES.has(e.type)) continue;
      const a = tileCoords.get(e.source);
      const b = tileCoords.get(e.target);
      if (a && b) cost += cubeDistance(a, b);
    }
    return cost;
  }

  // Node-local cost: semantic edge distances + compactness penalty.
  // Compactness: penalize exposed sides (neighbors not owned by same region).
  // This prevents "tentacles" and fills holes.
  function nodeCost(ni: number): number {
    let cost = 0;
    const coord = tileCoords.get(ni);
    if (!coord) return 0;

    // Edge distance cost
    for (const { target } of (semanticNodeEdges.get(ni) ?? [])) {
      const oc = tileCoords.get(target);
      if (oc) cost += cubeDistance(coord, oc);
    }

    // Compactness: each exposed side adds penalty
    const region = nodes[ni].region;
    let exposed = 0;
    for (const dir of CUBE_DIRS) {
      const nk = tileKey(coord.q + dir.q, coord.r + dir.r);
      if (claimed.get(nk) !== region) exposed++;
    }
    cost += exposed; // 0-6 penalty, same scale as edge distances

    return cost;
  }

  // O(1) connectivity check using local hex topology only.
  // Local connectivity check: would removing this tile split its region?
  // BFS from first same-region neighbor, limited to radius 3 around vacated tile.
  // Checks if all other same-region neighbors are reachable without going through
  // the vacated tile. O(~36) worst case, not O(N).
  function wouldDisconnect(vacatedQ: number, vacatedR: number, region: string): boolean {
    const neighbors: string[] = [];
    for (const dir of CUBE_DIRS) {
      const nk = tileKey(vacatedQ + dir.q, vacatedR + dir.r);
      if (claimed.get(nk) === region) neighbors.push(nk);
    }
    if (neighbors.length <= 1) return false;

    // BFS from first neighbor, excluding vacated tile
    const vacatedKey = tileKey(vacatedQ, vacatedR);
    const visited = new Set<string>();
    const queue = [neighbors[0]];
    visited.add(neighbors[0]);

    while (queue.length > 0) {
      const cur = queue.shift()!;
      const [cq, cr] = cur.split(',').map(Number);
      if (cubeDistance({ q: cq, r: cr }, { q: vacatedQ, r: vacatedR }) > 3) continue;
      for (const dir of CUBE_DIRS) {
        const nk = tileKey(cq + dir.q, cr + dir.r);
        if (nk === vacatedKey || visited.has(nk)) continue;
        if (claimed.get(nk) === region) {
          visited.add(nk);
          queue.push(nk);
        }
      }
    }

    for (const nk of neighbors) {
      if (!visited.has(nk)) return true;
    }
    return false;
  }

  // --- Simulated Annealing ---
  // Deterministic seed from graph structure (node count + edge count + region count)
  const rngSeed = N * 31 + edges.length * 37 + regionNames.length * 41;
  const rand = createRng(rngSeed);

  // Scale iterations: 3000/node for small graphs, cap for larger ones.
  // Target: <3s SA on main thread. ~100k iter/s in browser.
  // 26 nodes → 78k, 100 nodes → 200k, 200+ nodes → 200k
  const ITERATIONS = Math.min(N * 3000, 200_000);
  const T_START = 8.0;
  const T_END = 0.01;
  const COOL = Math.pow(T_END / T_START, 1 / ITERATIONS);

  let T = T_START;
  let currentCost = totalCost();
  let bestCost = currentCost;
  let bestSnapshot = new Map(tileCoords);
  let accepted = 0;
  const allNodeIndices = Array.from({ length: N }, (_, i) => i);

  for (let iter = 0; iter < ITERATIONS; iter++) {
    T *= COOL;

    // Pick random move type
    const moveType = rand();

    if (moveType < 0.5) {
      // --- Move A: swap two nodes in same region ---
      const regionName = regionNames[Math.floor(rand() * regionNames.length)];
      const indices = regionIndices.get(regionName)!;
      if (indices.length < 2) continue;
      const i = indices[Math.floor(rand() * indices.length)];
      const j = indices[Math.floor(rand() * indices.length)];
      if (i === j) continue;

      const ci = tileCoords.get(i)!;
      const cj = tileCoords.get(j)!;
      const costBefore = nodeCost(i) + nodeCost(j);

      // Swap
      tileCoords.set(i, cj);
      tileCoords.set(j, ci);
      const costAfter = nodeCost(i) + nodeCost(j);
      const delta = costAfter - costBefore;

      if (delta < 0 || rand() < Math.exp(-delta / T)) {
        // Accept
        tileToNode.set(tileKey(cj.q, cj.r), i);
        tileToNode.set(tileKey(ci.q, ci.r), j);
        currentCost += delta;
        accepted++;
      } else {
        // Reject
        tileCoords.set(i, ci);
        tileCoords.set(j, cj);
      }

    } else {
      // --- Move B: migrate node to adjacent unclaimed tile ---
      const ni = allNodeIndices[Math.floor(rand() * N)];
      const region = nodes[ni].region;
      const curTile = tileCoords.get(ni)!;
      const curKey = tileKey(curTile.q, curTile.r);

      // Find unclaimed neighbor tiles
      const candidates: { q: number; r: number }[] = [];
      for (const dir of CUBE_DIRS) {
        const nq = curTile.q + dir.q;
        const nr = curTile.r + dir.r;
        if (!claimed.has(tileKey(nq, nr))) candidates.push({ q: nq, r: nr });
      }
      if (candidates.length === 0) continue;

      // Pick random candidate
      const target = candidates[Math.floor(rand() * candidates.length)];
      const targetKey = tileKey(target.q, target.r);

      // Must be adjacent to at least one other tile from same region
      let hasAdj = false;
      for (const dir of CUBE_DIRS) {
        const nk = tileKey(target.q + dir.q, target.r + dir.r);
        if (nk !== curKey && claimed.get(nk) === region) { hasAdj = true; break; }
      }
      if (!hasAdj) continue;

      // Gap enforcement: target must not be adjacent to a different region
      // (temporarily remove current tile to check — it's being vacated)
      claimed.delete(curKey);
      const gapOk = canClaim(target.q, target.r, region);
      claimed.set(curKey, region);
      if (!gapOk) continue;

      // Local connectivity check: would vacating this tile split the region?
      if (wouldDisconnect(curTile.q, curTile.r, region)) continue;

      const costBefore = nodeCost(ni);

      // Tentative move
      tileCoords.set(ni, target);
      claimed.delete(curKey);
      claimed.set(targetKey, region);
      tileToNode.delete(curKey);
      tileToNode.set(targetKey, ni);

      const costAfter = nodeCost(ni);
      const delta = costAfter - costBefore;

      if (delta < 0 || rand() < Math.exp(-delta / T)) {
        currentCost += delta;
        accepted++;
      } else {
        // Revert
        tileCoords.set(ni, curTile);
        claimed.delete(targetKey);
        claimed.set(curKey, region);
        tileToNode.delete(targetKey);
        tileToNode.set(curKey, ni);
      }
    }

    // Track best
    if (currentCost < bestCost) {
      bestCost = currentCost;
      bestSnapshot = new Map(tileCoords);
    }
  }

  // Restore best found
  for (const [ni, coord] of bestSnapshot) {
    tileCoords.set(ni, coord);
  }

  console.log(`[SA] ${ITERATIONS} iterations, ${accepted} accepted, cost: ${totalCost()} (best: ${bestCost})`);

  return { tileCoords, cost: bestCost, iterations: ITERATIONS };
}

/**
 * Incremental layout engine: flood fill → instant render → SA refinement in batches.
 *
 * Usage:
 *   const engine = new IncrementalLayout(nodes, edges, regionNames);
 *   // Immediately render flood fill positions:
 *   engine.tileCoords; // Map<number, {q, r}>
 *   // Then refine in animation frames:
 *   engine.refineBatch(10000); // returns true when settled
 */
export class IncrementalLayout {
  readonly tileCoords: Map<number, { q: number; r: number }>;
  private _claimed: Map<string, string>;
  private _tileToNode: Map<string, number>;
  private _nodes: LayoutNode[];
  private _semanticNodeEdges: Map<number, { target: number; weight: number }[]>;
  private _regionIndices: Map<string, number[]>;
  private _regionNames: string[];
  private _rand: () => number;
  private _T: number;
  private _cool: number;
  private _maxIter: number;
  private _totalIter = 0;
  private _bestCost: number;
  private _bestSnapshot: Map<number, { q: number; r: number }>;

  constructor(nodes: LayoutNode[], edges: GraphEdge[], regionNames: string[]) {
    this._nodes = nodes;
    this._regionNames = regionNames;
    const N = nodes.length;

    // Build semantic adjacency
    const STRUCTURAL = new Set(['CONTAINS', 'HAS_SCOPE', 'HAS_BODY', 'DECLARES']);
    this._semanticNodeEdges = new Map();
    for (const e of edges) {
      if (STRUCTURAL.has(e.type)) continue;
      if (!this._semanticNodeEdges.has(e.source)) this._semanticNodeEdges.set(e.source, []);
      if (!this._semanticNodeEdges.has(e.target)) this._semanticNodeEdges.set(e.target, []);
      this._semanticNodeEdges.get(e.source)!.push({ target: e.target, weight: 1 });
      this._semanticNodeEdges.get(e.target)!.push({ target: e.source, weight: 1 });
    }

    // Region membership
    this._regionIndices = new Map();
    for (let i = 0; i < N; i++) {
      const r = nodes[i].region;
      if (!this._regionIndices.has(r)) this._regionIndices.set(r, []);
      this._regionIndices.get(r)!.push(i);
    }

    // Run flood fill (reuse the same logic as annealingLayout)
    // This is the "instant render" part
    this.tileCoords = new Map();
    this._claimed = new Map();
    this._tileToNode = new Map();
    this._floodFill(nodes, edges, regionNames);

    // SA parameters
    this._maxIter = Math.min(N * 3000, 200_000);
    const rngSeed = N * 31 + edges.length * 37 + regionNames.length * 41;
    this._rand = createRng(rngSeed);
    this._T = 8.0;
    this._cool = Math.pow(0.01 / 8.0, 1 / this._maxIter);

    this._bestCost = this._totalCost();
    this._bestSnapshot = new Map(this.tileCoords);
  }

  get settled(): boolean { return this._totalIter >= this._maxIter; }
  get progress(): number { return Math.min(this._totalIter / this._maxIter, 1); }
  get cost(): number { return this._bestCost; }
  get iterations(): number { return this._totalIter; }

  /** Run a batch of SA iterations. Returns true when settled. */
  refineBatch(batchSize: number): boolean {
    if (this.settled) return true;
    const N = this._nodes.length;
    const numRegions = this._regionNames.length;
    let accepted = 0;

    for (let i = 0; i < batchSize && this._totalIter < this._maxIter; i++, this._totalIter++) {
      this._T *= this._cool;
      const moveType = this._rand();

      if (moveType < 0.5) {
        // Swap two nodes in same region
        const ri = Math.floor(this._rand() * numRegions) % numRegions;
        const members = this._regionIndices.get(this._regionNames[ri]);
        if (!members || members.length < 2) continue;
        const ia = Math.floor(this._rand() * members.length) % members.length;
        const ib = Math.floor(this._rand() * members.length) % members.length;
        if (ia === ib) continue;
        const ni = members[ia], nj = members[ib];
        const ci = this.tileCoords.get(ni)!, cj = this.tileCoords.get(nj)!;
        const costBefore = this._nodeCost(ni) + this._nodeCost(nj);
        this.tileCoords.set(ni, cj);
        this.tileCoords.set(nj, ci);
        const costAfter = this._nodeCost(ni) + this._nodeCost(nj);
        const delta = costAfter - costBefore;
        if (delta < 0 || this._rand() < Math.exp(-delta / this._T)) {
          this._tileToNode.set(tileKey(cj.q, cj.r), ni);
          this._tileToNode.set(tileKey(ci.q, ci.r), nj);
          accepted++;
        } else {
          this.tileCoords.set(ni, ci);
          this.tileCoords.set(nj, cj);
        }
      } else {
        // Migrate to adjacent unclaimed tile
        const ni = Math.floor(this._rand() * N) % N;
        const region = this._nodes[ni].region;
        const curTile = this.tileCoords.get(ni)!;
        const curKey = tileKey(curTile.q, curTile.r);
        const candidates: { q: number; r: number }[] = [];
        for (const dir of CUBE_DIRS) {
          const nq = curTile.q + dir.q, nr = curTile.r + dir.r;
          if (!this._claimed.has(tileKey(nq, nr))) candidates.push({ q: nq, r: nr });
        }
        if (candidates.length === 0) continue;
        const target = candidates[Math.floor(this._rand() * candidates.length) % candidates.length];
        const targetKey = tileKey(target.q, target.r);

        let hasAdj = false;
        for (const dir of CUBE_DIRS) {
          const nk = tileKey(target.q + dir.q, target.r + dir.r);
          if (nk !== curKey && this._claimed.get(nk) === region) { hasAdj = true; break; }
        }
        if (!hasAdj) continue;

        this._claimed.delete(curKey);
        const gapOk = this._canClaim(target.q, target.r, region);
        this._claimed.set(curKey, region);
        if (!gapOk) continue;

        if (this._wouldDisconnect(curTile.q, curTile.r, region)) continue;

        const costBefore = this._nodeCost(ni);
        this.tileCoords.set(ni, target);
        this._claimed.delete(curKey);
        this._claimed.set(targetKey, region);
        this._tileToNode.delete(curKey);
        this._tileToNode.set(targetKey, ni);
        const costAfter = this._nodeCost(ni);
        const delta = costAfter - costBefore;
        if (delta < 0 || this._rand() < Math.exp(-delta / this._T)) {
          accepted++;
        } else {
          this.tileCoords.set(ni, curTile);
          this._claimed.delete(targetKey);
          this._claimed.set(curKey, region);
          this._tileToNode.delete(targetKey);
          this._tileToNode.set(curKey, ni);
        }
      }

      const curCost = this._totalCost();
      if (curCost < this._bestCost) {
        this._bestCost = curCost;
        this._bestSnapshot = new Map(this.tileCoords);
      }
    }

    if (this.settled) {
      for (const [ni, coord] of this._bestSnapshot) this.tileCoords.set(ni, coord);
      console.log(`[SA] ${this._totalIter} iterations, cost: ${this._bestCost}`);
    }

    return this.settled;
  }

  private _nodeCost(ni: number): number {
    let cost = 0;
    const coord = this.tileCoords.get(ni);
    if (!coord) return 0;
    for (const { target } of (this._semanticNodeEdges.get(ni) ?? [])) {
      const oc = this.tileCoords.get(target);
      if (oc) cost += cubeDistance(coord, oc);
    }
    const region = this._nodes[ni].region;
    for (const dir of CUBE_DIRS) {
      if (this._claimed.get(tileKey(coord.q + dir.q, coord.r + dir.r)) !== region) cost++;
    }
    return cost;
  }

  private _totalCost(): number {
    let cost = 0;
    for (let i = 0; i < this._nodes.length; i++) cost += this._nodeCost(i);
    return cost;
  }

  private _canClaim(q: number, r: number, region: string): boolean {
    for (const dir of CUBE_DIRS) {
      const nk = tileKey(q + dir.q, r + dir.r);
      const owner = this._claimed.get(nk);
      if (owner && owner !== region) return false;
    }
    return true;
  }

  private _wouldDisconnect(vq: number, vr: number, region: string): boolean {
    const neighbors: string[] = [];
    for (const dir of CUBE_DIRS) {
      const nk = tileKey(vq + dir.q, vr + dir.r);
      if (this._claimed.get(nk) === region) neighbors.push(nk);
    }
    if (neighbors.length <= 1) return false;
    const vacatedKey = tileKey(vq, vr);
    const visited = new Set<string>([neighbors[0]]);
    const queue = [neighbors[0]];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const [cq, cr] = cur.split(',').map(Number);
      if (cubeDistance({ q: cq, r: cr }, { q: vq, r: vr }) > 3) continue;
      for (const dir of CUBE_DIRS) {
        const nk = tileKey(cq + dir.q, cr + dir.r);
        if (nk !== vacatedKey && !visited.has(nk) && this._claimed.get(nk) === region) {
          visited.add(nk); queue.push(nk);
        }
      }
    }
    return neighbors.some(nk => !visited.has(nk));
  }

  private _floodFill(nodes: LayoutNode[], edges: GraphEdge[], regionNames: string[]) {
    const N = nodes.length;

    // Cross-region weights for seed placement
    const pairWeight = new Map<string, number>();
    for (const e of edges) {
      const r1 = nodes[e.source]?.region, r2 = nodes[e.target]?.region;
      if (!r1 || !r2 || r1 === r2) continue;
      const key = [r1, r2].sort().join('|');
      pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1);
    }

    // Place seeds
    const sorted = [...regionNames].sort((a, b) =>
      (this._regionIndices.get(b)?.length ?? 0) - (this._regionIndices.get(a)?.length ?? 0));
    const seeds = new Map<string, { q: number; r: number }>();
    if (sorted.length > 0) {
      seeds.set(sorted[0], { q: 0, r: 0 });
      this._claimed.set(tileKey(0, 0), sorted[0]);
    }
    for (let i = 1; i < sorted.length; i++) {
      const region = sorted[i];
      let bestTarget = { q: 0, r: 0 }, bestWeight = 0;
      for (const [placed] of seeds) {
        const key = [region, placed].sort().join('|');
        const w = pairWeight.get(key) ?? 0;
        if (w > bestWeight) { bestWeight = w; bestTarget = seeds.get(placed)!; }
      }
      const searchStart = bestWeight > 0 ? 3 : 6;
      let placed = false;
      for (let rad = searchStart; rad < 20 && !placed; rad++) {
        let rq = bestTarget.q + rad * CUBE_DIRS[4].q, rr = bestTarget.r + rad * CUBE_DIRS[4].r;
        for (let side = 0; side < 6 && !placed; side++) {
          for (let step = 0; step < rad && !placed; step++) {
            const k = tileKey(rq, rr);
            if (!this._claimed.has(k)) { seeds.set(region, { q: rq, r: rr }); this._claimed.set(k, region); placed = true; }
            rq += CUBE_DIRS[side].q; rr += CUBE_DIRS[side].r;
          }
        }
      }
    }

    // Flood fill
    const frontiers = new Map<string, Set<string>>();
    const remaining = new Map<string, number>();
    for (const region of regionNames) {
      remaining.set(region, (this._regionIndices.get(region)?.length ?? 1) - 1);
      const seed = seeds.get(region)!;
      const frontier = new Set<string>();
      for (const dir of CUBE_DIRS) {
        const k = tileKey(seed.q + dir.q, seed.r + dir.r);
        if (!this._claimed.has(k)) frontier.add(k);
      }
      frontiers.set(region, frontier);
    }

    for (let iter = 0; iter < 500; iter++) {
      let any = false;
      for (const region of regionNames) {
        const need = remaining.get(region) ?? 0;
        if (need <= 0) continue;
        const frontier = frontiers.get(region)!;
        for (const k of frontier) { if (this._claimed.has(k)) frontier.delete(k); }
        if (frontier.size === 0) continue;
        const regionSeed = seeds.get(region) ?? { q: 0, r: 0 };
        let bestTile: string | null = null, bestScore = -1, bestDist = Infinity;
        for (const k of frontier) {
          const [q, r] = k.split(',').map(Number);
          if (!this._canClaim(q, r, region)) continue;
          let score = 0;
          for (const dir of CUBE_DIRS) {
            if (this._claimed.get(tileKey(q + dir.q, r + dir.r)) === region) score++;
          }
          const dist = cubeDistance({ q, r }, regionSeed);
          if (score > bestScore || (score === bestScore && dist < bestDist)) {
            bestScore = score; bestDist = dist; bestTile = k;
          }
        }
        if (!bestTile) continue;
        this._claimed.set(bestTile, region);
        frontier.delete(bestTile);
        remaining.set(region, need - 1);
        any = true;
        const [q, r] = bestTile.split(',').map(Number);
        for (const dir of CUBE_DIRS) {
          const nk = tileKey(q + dir.q, r + dir.r);
          if (!this._claimed.has(nk)) frontier.add(nk);
        }
      }
      if (!any) break;
    }

    // Assign nodes to tiles
    for (const region of regionNames) {
      const indices = this._regionIndices.get(region) ?? [];
      const tiles: { q: number; r: number }[] = [];
      for (const [k, r] of this._claimed) {
        if (r === region) { const [q, rr] = k.split(',').map(Number); tiles.push({ q, r: rr }); }
      }
      const seed = seeds.get(region) ?? { q: 0, r: 0 };
      tiles.sort((a, b) => cubeDistance(a, seed) - cubeDistance(b, seed));
      const sortedIdx = [...indices].sort((a, b) => nodes[b].degree - nodes[a].degree);
      for (let j = 0; j < sortedIdx.length && j < tiles.length; j++) {
        this.tileCoords.set(sortedIdx[j], tiles[j]);
        this._tileToNode.set(tileKey(tiles[j].q, tiles[j].r), sortedIdx[j]);
      }
    }

    // Overflow
    let overflowRadius = 0;
    for (const [k] of this._claimed) {
      const [q, r] = k.split(',').map(Number);
      overflowRadius = Math.max(overflowRadius, Math.abs(q), Math.abs(r));
    }
    overflowRadius += 3;
    for (let i = 0; i < N; i++) {
      if (this.tileCoords.has(i)) continue;
      for (let rad = overflowRadius; rad < overflowRadius + N; rad++) {
        let placed = false;
        let rq = rad * CUBE_DIRS[4].q, rr = rad * CUBE_DIRS[4].r;
        for (let side = 0; side < 6 && !placed; side++) {
          for (let step = 0; step < rad && !placed; step++) {
            const k = tileKey(rq, rr);
            if (!this._claimed.has(k)) {
              this._claimed.set(k, nodes[i].region);
              this.tileCoords.set(i, { q: rq, r: rr });
              this._tileToNode.set(k, i);
              placed = true;
            }
            rq += CUBE_DIRS[side].q; rr += CUBE_DIRS[side].r;
          }
        }
        if (placed) break;
      }
    }
  }
}
