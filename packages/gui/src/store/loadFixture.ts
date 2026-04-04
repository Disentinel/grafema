import { useDataStore, type GraphNode, type GraphEdge, type Region } from './dataStore';

interface FixtureNode {
  id: string;
  type: string;
  name: string;
  file: string;
  region: string;
  degree: number;
}

interface FixtureData {
  nodes: FixtureNode[];
  edges: GraphEdge[];
  regions: { path: string; depth: number; tileCount: number }[];
}

const CUBE_DIRS = [
  { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 },
  { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 },
];

export function cubeToWorld(q: number, r: number, size: number) {
  const x = size * (3 / 2) * q;
  const z = size * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
  return { x, z };
}

function tileKey(q: number, r: number): string { return `${q},${r}`; }

function cubeDistance(a: { q: number; r: number }, b: { q: number; r: number }): number {
  return Math.max(
    Math.abs(a.q - b.q),
    Math.abs(a.r - b.r),
    Math.abs((a.q + a.r) - (b.q + b.r)),
  );
}

/**
 * Competitive flood-fill layout.
 *
 * 1. Compute region-to-region edge weights
 * 2. Place seeds: heaviest region at center, neighbors nearby
 * 3. Grow all regions simultaneously — each round, every region
 *    claims one adjacent unclaimed tile, preferring tiles that
 *    border connected regions (shared border attraction)
 * 4. Within each claimed territory, assign nodes by degree (BFS)
 */
function floodFillLayout(
  fixtureNodes: FixtureNode[],
  fixtureRegions: FixtureData['regions'],
  edges: GraphEdge[],
  tileSize: number,
): { nodes: GraphNode[]; tileCoords: Map<number, { q: number; r: number }> } {

  const regionNames = fixtureRegions.map((r) => r.path);

  // --- 1. Region sizes and cross-region edge weights ---
  const regionSize = new Map<string, number>();
  const regionNodeIndices = new Map<string, number[]>();
  for (let i = 0; i < fixtureNodes.length; i++) {
    const r = fixtureNodes[i].region;
    regionSize.set(r, (regionSize.get(r) ?? 0) + 1);
    if (!regionNodeIndices.has(r)) regionNodeIndices.set(r, []);
    regionNodeIndices.get(r)!.push(i);
  }

  // Edge weight between region pairs (count of cross-region edges)
  const pairWeight = new Map<string, number>();
  for (const e of edges) {
    const r1 = fixtureNodes[e.source]?.region;
    const r2 = fixtureNodes[e.target]?.region;
    if (!r1 || !r2 || r1 === r2) continue;
    const key = [r1, r2].sort().join('|');
    pairWeight.set(key, (pairWeight.get(key) ?? 0) + 1);
  }

  // --- 2. Place seeds ---
  // Sort regions by size descending, place biggest at origin
  const sorted = [...regionNames].sort((a, b) =>
    (regionSize.get(b) ?? 0) - (regionSize.get(a) ?? 0),
  );

  const seeds = new Map<string, { q: number; r: number }>();
  const claimed = new Map<string, string>(); // tileKey → regionName

  // Place first seed at origin
  seeds.set(sorted[0], { q: 0, r: 0 });
  claimed.set(tileKey(0, 0), sorted[0]);

  // Place remaining seeds near connected regions, or in a ring
  for (let i = 1; i < sorted.length; i++) {
    const region = sorted[i];

    // Find strongest connected already-placed region
    let bestTarget: { q: number; r: number } | null = null;
    let bestWeight = 0;

    for (const [placed] of seeds) {
      const key = [region, placed].sort().join('|');
      const w = pairWeight.get(key) ?? 0;
      if (w > bestWeight) {
        bestWeight = w;
        bestTarget = seeds.get(placed)!;
      }
    }

    // Search distance: connected = close, unconnected = further
    const searchStart = bestWeight > 0 ? 2 : 5;
    const searchCenter = bestTarget ?? { q: 0, r: 0 };

    // Find unclaimed tile at appropriate distance
    let placed = false;
    for (let rad = searchStart; rad < 20 && !placed; rad++) {
      // Walk hex ring at radius rad from searchCenter
      let rq = searchCenter.q + rad * CUBE_DIRS[4].q;
      let rr = searchCenter.r + rad * CUBE_DIRS[4].r;
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

  // --- 3. Competitive flood fill ---
  // Frontier: for each region, set of unclaimed neighbor tiles
  const frontiers = new Map<string, Set<string>>();
  const remaining = new Map<string, number>(); // tiles still needed

  for (const region of regionNames) {
    remaining.set(region, (regionSize.get(region) ?? 1) - 1); // seed already placed
    const seed = seeds.get(region)!;
    const frontier = new Set<string>();
    for (const dir of CUBE_DIRS) {
      const k = tileKey(seed.q + dir.q, seed.r + dir.r);
      if (!claimed.has(k)) frontier.add(k);
    }
    frontiers.set(region, frontier);
  }

  // Rounds: each region claims one tile per round
  let maxIter = 500;
  while (maxIter-- > 0) {
    let anyChanged = false;

    for (const region of regionNames) {
      const need = remaining.get(region) ?? 0;
      if (need <= 0) continue;

      const frontier = frontiers.get(region)!;

      // Remove already-claimed tiles from frontier
      for (const k of frontier) {
        if (claimed.has(k)) frontier.delete(k);
      }

      if (frontier.size === 0) continue;

      // Score each frontier tile:
      // +2 for each neighbor that belongs to a connected region (attraction)
      // +1 for each neighbor that belongs to this region (compactness)
      let bestTile: string | null = null;
      let bestScore = -Infinity;

      for (const k of frontier) {
        const [q, r] = k.split(',').map(Number);
        let score = 0;

        for (const dir of CUBE_DIRS) {
          const nk = tileKey(q + dir.q, r + dir.r);
          const owner = claimed.get(nk);
          if (owner === region) {
            score += 1; // compactness
          } else if (owner) {
            // Attraction to connected regions
            const key = [region, owner].sort().join('|');
            const w = pairWeight.get(key) ?? 0;
            if (w > 0) score += 2 * Math.min(w, 5); // attraction capped
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestTile = k;
        }
      }

      if (!bestTile) continue;

      // Claim tile
      claimed.set(bestTile, region);
      frontier.delete(bestTile);
      remaining.set(region, need - 1);
      anyChanged = true;

      // Add new neighbors to frontier
      const [q, r] = bestTile.split(',').map(Number);
      for (const dir of CUBE_DIRS) {
        const nk = tileKey(q + dir.q, r + dir.r);
        if (!claimed.has(nk)) frontier.add(nk);
      }
    }

    if (!anyChanged) break;
  }

  // --- 4. Initial placement + global swap optimization ---
  const regionTiles = new Map<string, { q: number; r: number }[]>();
  for (const [k, region] of claimed) {
    const [q, r] = k.split(',').map(Number);
    if (!regionTiles.has(region)) regionTiles.set(region, []);
    regionTiles.get(region)!.push({ q, r });
  }

  // nodeIdx → tile coord (mutable, globally accessible)
  const tileCoords = new Map<number, { q: number; r: number }>();
  // tileKey → nodeIdx (reverse map for swap validation)
  const tileOwner = new Map<string, number>();

  // --- Phase A: initial placement for ALL regions ---
  for (const region of regionNames) {
    const indices = regionNodeIndices.get(region) ?? [];
    const tiles = regionTiles.get(region) ?? [];
    if (indices.length === 0 || tiles.length === 0) continue;

    const seed = seeds.get(region) ?? { q: 0, r: 0 };
    const sortedTiles = [...tiles].sort((a, b) => cubeDistance(a, seed) - cubeDistance(b, seed));

    // Sort nodes by degree desc (high-degree near center)
    const sortedIndices = [...indices].sort((a, b) =>
      fixtureNodes[b].degree - fixtureNodes[a].degree,
    );

    for (let j = 0; j < sortedIndices.length && j < sortedTiles.length; j++) {
      const ni = sortedIndices[j];
      const tile = sortedTiles[j];
      tileCoords.set(ni, tile);
      tileOwner.set(tileKey(tile.q, tile.r), ni);
    }
  }

  // --- Phase B: swap optimization across ALL edges ---
  // For each region, try swapping node pairs to minimize total edge length.
  // Now tileCoords is fully populated so cross-region edges are measurable.

  function edgeCost(nodeA: number, nodeB: number): number {
    const cA = tileCoords.get(nodeA);
    const cB = tileCoords.get(nodeB);
    if (!cA || !cB) return 0;
    return cubeDistance(cA, cB);
  }

  // Precompute per-node edge list for fast cost calculation
  const nodeEdges = new Map<number, number[]>(); // nodeIdx → list of other nodeIdx
  for (const edge of edges) {
    if (!nodeEdges.has(edge.source)) nodeEdges.set(edge.source, []);
    if (!nodeEdges.has(edge.target)) nodeEdges.set(edge.target, []);
    nodeEdges.get(edge.source)!.push(edge.target);
    nodeEdges.get(edge.target)!.push(edge.source);
  }

  // Cost of a single node at its current position
  function nodeCost(ni: number): number {
    let cost = 0;
    for (const other of (nodeEdges.get(ni) ?? [])) {
      cost += edgeCost(ni, other);
    }
    return cost;
  }

  // Swap two nodes (same region only) if it reduces total cost
  for (const region of regionNames) {
    const indices = regionNodeIndices.get(region) ?? [];
    if (indices.length < 2) continue;

    for (let pass = 0; pass < 10; pass++) {
      let improved = false;

      for (let i = 0; i < indices.length; i++) {
        for (let j = i + 1; j < indices.length; j++) {
          const ni = indices[i];
          const nj = indices[j];
          const ci = tileCoords.get(ni)!;
          const cj = tileCoords.get(nj)!;

          // Cost before swap (only edges touching ni or nj)
          const costBefore = nodeCost(ni) + nodeCost(nj);

          // Swap
          tileCoords.set(ni, cj);
          tileCoords.set(nj, ci);

          const costAfter = nodeCost(ni) + nodeCost(nj);

          if (costAfter < costBefore) {
            // Keep swap
            tileOwner.set(tileKey(cj.q, cj.r), ni);
            tileOwner.set(tileKey(ci.q, ci.r), nj);
            improved = true;
          } else {
            // Revert
            tileCoords.set(ni, ci);
            tileCoords.set(nj, cj);
          }
        }
      }

      if (!improved) break;
    }
  }

  // --- Phase C: multi-hop migration ---
  // Border nodes BFS through unclaimed tiles up to depth 4.
  // Pick the position that minimizes edge cost.
  // Constraints:
  //   - Region stays connected after vacating old tile
  //   - New tile must be adjacent to at least one other tile from same region

  function isRegionConnectedWithout(region: string, removedKey: string): boolean {
    const tiles: string[] = [];
    for (const [k, r] of claimed) {
      if (r === region && k !== removedKey) tiles.push(k);
    }
    if (tiles.length === 0) return false; // can't remove last tile

    const visited = new Set<string>();
    const queue = [tiles[0]];
    visited.add(tiles[0]);
    const tileSet = new Set(tiles);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const [cq, cr] = current.split(',').map(Number);
      for (const dir of CUBE_DIRS) {
        const nk = tileKey(cq + dir.q, cr + dir.r);
        if (tileSet.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
    }
    return visited.size === tileSet.size;
  }

  function hasAdjacentRegionTile(q: number, r: number, region: string, excludeKey: string): boolean {
    for (const dir of CUBE_DIRS) {
      const nk = tileKey(q + dir.q, r + dir.r);
      if (nk !== excludeKey && claimed.get(nk) === region) return true;
    }
    return false;
  }

  // BFS through unclaimed tiles from a starting position, up to maxDepth
  function findReachableUnclaimed(startQ: number, startR: number, maxDepth: number): { q: number; r: number; key: string }[] {
    const result: { q: number; r: number; key: string }[] = [];
    const visited = new Set<string>();
    const queue: { q: number; r: number; depth: number }[] = [];

    // Seed from all unclaimed neighbors of start
    for (const dir of CUBE_DIRS) {
      const nq = startQ + dir.q;
      const nr = startR + dir.r;
      const nk = tileKey(nq, nr);
      if (!claimed.has(nk) && !visited.has(nk)) {
        visited.add(nk);
        queue.push({ q: nq, r: nr, depth: 1 });
        result.push({ q: nq, r: nr, key: nk });
      }
    }

    while (queue.length > 0) {
      const { q, r, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;
      for (const dir of CUBE_DIRS) {
        const nq = q + dir.q;
        const nr = r + dir.r;
        const nk = tileKey(nq, nr);
        if (!claimed.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          queue.push({ q: nq, r: nr, depth: depth + 1 });
          result.push({ q: nq, r: nr, key: nk });
        }
      }
    }

    return result;
  }

  const MAX_HOP_DEPTH = 4;

  for (let pass = 0; pass < 15; pass++) {
    let anyMigrated = false;

    for (const region of regionNames) {
      const indices = regionNodeIndices.get(region) ?? [];

      for (const ni of indices) {
        const currentTile = tileCoords.get(ni);
        if (!currentTile) continue;
        const currentKey = tileKey(currentTile.q, currentTile.r);
        const currentCost = nodeCost(ni);

        // Check if we can safely remove this tile
        if (!isRegionConnectedWithout(region, currentKey)) continue;

        // BFS through unclaimed tiles
        const candidates = findReachableUnclaimed(currentTile.q, currentTile.r, MAX_HOP_DEPTH);
        if (candidates.length === 0) continue;

        let bestCandidate: (typeof candidates)[0] | null = null;
        let bestCost = currentCost;

        for (const cand of candidates) {
          // New tile must be adjacent to at least one other tile from this region
          if (!hasAdjacentRegionTile(cand.q, cand.r, region, currentKey)) continue;

          // Evaluate cost at this position
          tileCoords.set(ni, { q: cand.q, r: cand.r });
          const newCost = nodeCost(ni);

          if (newCost < bestCost) {
            bestCost = newCost;
            bestCandidate = cand;
          }

          tileCoords.set(ni, currentTile); // revert
        }

        if (bestCandidate) {
          // Commit migration
          tileCoords.set(ni, { q: bestCandidate.q, r: bestCandidate.r });
          tileOwner.delete(currentKey);
          tileOwner.set(bestCandidate.key, ni);
          claimed.delete(currentKey);
          claimed.set(bestCandidate.key, region);

          // Post-migration connectivity validation
          if (!isRegionConnectedFull(region)) {
            // Revert — migration broke connectivity
            tileCoords.set(ni, currentTile);
            tileOwner.set(currentKey, ni);
            tileOwner.delete(bestCandidate.key);
            claimed.set(currentKey, region);
            claimed.delete(bestCandidate.key);
          } else {
            anyMigrated = true;
          }
        }
      }
    }

    if (!anyMigrated) break;
  }

  // Final connectivity validation — revert any broken regions
  function isRegionConnectedFull(region: string): boolean {
    const tiles: string[] = [];
    for (const [k, r] of claimed) {
      if (r === region) tiles.push(k);
    }
    if (tiles.length <= 1) return true;
    const visited = new Set<string>();
    const queue = [tiles[0]];
    visited.add(tiles[0]);
    const tileSet = new Set(tiles);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const [cq, cr] = current.split(',').map(Number);
      for (const dir of CUBE_DIRS) {
        const nk = tileKey(cq + dir.q, cr + dir.r);
        if (tileSet.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
    }
    return visited.size === tileSet.size;
  }

  // --- Phase D: region teleport ---
  // If a region's total edge cost would be much lower at a different position,
  // vacate all its tiles and re-grow near the ideal centroid.
  //
  // Ideal centroid = weighted average of connected nodes' positions (in other regions).

  function regionTotalCost(region: string): number {
    let cost = 0;
    for (const ni of (regionNodeIndices.get(region) ?? [])) {
      cost += nodeCost(ni);
    }
    return cost;
  }

  function hexSpiral(count: number): { q: number; r: number }[] {
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

  for (const region of regionNames) {
    const indices = regionNodeIndices.get(region) ?? [];
    if (indices.length <= 1) continue;

    // Compute ideal centroid: average position of all nodes in OTHER regions
    // that share edges with this region, weighted by edge count
    let sumQ = 0, sumR = 0, totalW = 0;
    for (const ni of indices) {
      for (const other of (nodeEdges.get(ni) ?? [])) {
        if (fixtureNodes[other]?.region === region) continue;
        const otherTile = tileCoords.get(other);
        if (!otherTile) continue;
        sumQ += otherTile.q;
        sumR += otherTile.r;
        totalW++;
      }
    }

    if (totalW === 0) continue; // no cross-region edges

    const idealQ = Math.round(sumQ / totalW);
    const idealR = Math.round(sumR / totalW);

    // Current centroid
    let curQ = 0, curR = 0;
    for (const ni of indices) {
      const t = tileCoords.get(ni)!;
      curQ += t.q;
      curR += t.r;
    }
    curQ = Math.round(curQ / indices.length);
    curR = Math.round(curR / indices.length);

    // Skip if already very close
    if (cubeDistance({ q: idealQ, r: idealR }, { q: curQ, r: curR }) <= 1) continue;

    const costBefore = regionTotalCost(region);

    // Vacate all tiles of this region
    const oldTiles: { ni: number; tile: { q: number; r: number } }[] = [];
    for (const ni of indices) {
      const t = tileCoords.get(ni)!;
      oldTiles.push({ ni, tile: { ...t } });
      const k = tileKey(t.q, t.r);
      claimed.delete(k);
      tileOwner.delete(k);
    }

    // Try to claim tiles near ideal centroid via spiral
    const spiralTiles = hexSpiral(indices.length * 3); // search wider
    const newTiles: { q: number; r: number }[] = [];

    for (const st of spiralTiles) {
      const q = st.q + idealQ;
      const r = st.r + idealR;
      const k = tileKey(q, r);
      if (!claimed.has(k)) {
        newTiles.push({ q, r });
        if (newTiles.length >= indices.length) break;
      }
    }

    if (newTiles.length < indices.length) {
      // Can't fit — revert
      for (const { ni, tile } of oldTiles) {
        tileCoords.set(ni, tile);
        const k = tileKey(tile.q, tile.r);
        claimed.set(k, region);
        tileOwner.set(k, ni);
      }
      continue;
    }

    // Assign each node to the tile closest to its OWN connected nodes' positions
    // (greedy: process nodes with most external edges first)
    const sortedIndices = [...indices].sort((a, b) => {
      const aExt = (nodeEdges.get(a) ?? []).filter(o => fixtureNodes[o]?.region !== region).length;
      const bExt = (nodeEdges.get(b) ?? []).filter(o => fixtureNodes[o]?.region !== region).length;
      return bExt - aExt; // most externally-connected first
    });
    const usedNewTiles = new Set<number>();

    for (const ni of sortedIndices) {
      // Compute this node's ideal position: average of its cross-region neighbors
      const neighbors = (nodeEdges.get(ni) ?? []).filter(o => fixtureNodes[o]?.region !== region);
      let targetQ = idealQ, targetR = idealR;
      if (neighbors.length > 0) {
        let sq = 0, sr = 0;
        for (const o of neighbors) {
          const ot = tileCoords.get(o);
          if (ot) { sq += ot.q; sr += ot.r; }
        }
        targetQ = Math.round(sq / neighbors.length);
        targetR = Math.round(sr / neighbors.length);
      }

      // Find closest available tile to this node's target
      let bestJ = -1, bestDist = Infinity;
      for (let j = 0; j < newTiles.length; j++) {
        if (usedNewTiles.has(j)) continue;
        const d = cubeDistance(newTiles[j], { q: targetQ, r: targetR });
        if (d < bestDist) { bestDist = d; bestJ = j; }
      }

      if (bestJ >= 0) {
        usedNewTiles.add(bestJ);
        const tile = newTiles[bestJ];
        tileCoords.set(ni, tile);
        const k = tileKey(tile.q, tile.r);
        claimed.set(k, region);
        tileOwner.set(k, ni);
      }
    }

    const costAfter = regionTotalCost(region);
    const teleportConnected = isRegionConnectedFull(region);

    if (costAfter >= costBefore || !teleportConnected) {
      // Revert — teleport didn't help or broke connectivity
      for (const ni of indices) {
        const t = tileCoords.get(ni)!;
        claimed.delete(tileKey(t.q, t.r));
        tileOwner.delete(tileKey(t.q, t.r));
      }
      for (const { ni, tile } of oldTiles) {
        tileCoords.set(ni, tile);
        claimed.set(tileKey(tile.q, tile.r), region);
        tileOwner.set(tileKey(tile.q, tile.r), ni);
      }
    }
  }

  // Re-run swap optimization after teleport (positions changed)
  for (const region of regionNames) {
    const indices = regionNodeIndices.get(region) ?? [];
    if (indices.length < 2) continue;
    for (let pass = 0; pass < 5; pass++) {
      let improved = false;
      for (let i = 0; i < indices.length; i++) {
        for (let j = i + 1; j < indices.length; j++) {
          const ni = indices[i], nj = indices[j];
          const ci = tileCoords.get(ni)!, cj = tileCoords.get(nj)!;
          const costBefore = nodeCost(ni) + nodeCost(nj);
          tileCoords.set(ni, cj);
          tileCoords.set(nj, ci);
          if (nodeCost(ni) + nodeCost(nj) < costBefore) {
            tileOwner.set(tileKey(cj.q, cj.r), ni);
            tileOwner.set(tileKey(ci.q, ci.r), nj);
            improved = true;
          } else {
            tileCoords.set(ni, ci);
            tileCoords.set(nj, cj);
          }
        }
      }
      if (!improved) break;
    }
  }

  // --- Build result ---
  const result: GraphNode[] = [];
  for (const [ni, tile] of tileCoords) {
    const fn = fixtureNodes[ni];
    const { x, z } = cubeToWorld(tile.q, tile.r, tileSize);
    result[ni] = {
      id: fn.id,
      type: fn.type,
      name: fn.name,
      file: fn.file,
      region: fn.region,
      x,
      z,
      degree: fn.degree,
    };
  }

  return { nodes: result, tileCoords };
}

function buildRegions(fixtureRegions: FixtureData['regions'], nodes: GraphNode[]): Region[] {
  return fixtureRegions.map((r) => {
    const regionNodes = nodes.filter((n) => n.region === r.path);
    let cx = 0, cz = 0;
    for (const n of regionNodes) { cx += n.x; cz += n.z; }
    if (regionNodes.length > 0) { cx /= regionNodes.length; cz /= regionNodes.length; }

    return {
      path: r.path,
      depth: r.depth,
      tileCount: r.tileCount,
      border: [],
      centroid: { x: cx, z: cz },
    };
  });
}

export async function loadFixture() {
  const store = useDataStore.getState();
  store.setLoading(true);

  const resp = await fetch('./fixtures/multi-service.json');
  const data: FixtureData = await resp.json();

  const TILE_SIZE = 3.0;
  const { nodes, tileCoords } = floodFillLayout(data.nodes, data.regions, data.edges, TILE_SIZE);
  const edges = data.edges;

  const typeSet = new Set(data.nodes.map((n) => n.type));
  const edgeTypeSet = new Set(data.edges.map((e) => e.type));
  const regions = buildRegions(data.regions, nodes);

  (globalThis as Record<string, unknown>).__grafemaTileCoords = tileCoords;
  (globalThis as Record<string, unknown>).__grafemaTileSize = TILE_SIZE;

  store.setGraphData({
    nodes,
    edges,
    regions,
    typeTable: [...typeSet],
    edgeTypeTable: [...edgeTypeSet],
  });
}
