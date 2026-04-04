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

  // --- 4. Assign nodes to tiles, then optimize placement ---
  const regionTiles = new Map<string, { q: number; r: number }[]>();
  for (const [k, region] of claimed) {
    const [q, r] = k.split(',').map(Number);
    if (!regionTiles.has(region)) regionTiles.set(region, []);
    regionTiles.get(region)!.push({ q, r });
  }

  // Initial assignment: nodes with cross-region edges go near the border,
  // others fill from center outward
  const result: GraphNode[] = [];
  const tileCoords = new Map<number, { q: number; r: number }>();

  // Build per-node target: average position of cross-region neighbors
  const nodeTarget = new Map<number, { q: number; r: number }>();
  for (const edge of edges) {
    const r1 = fixtureNodes[edge.source]?.region;
    const r2 = fixtureNodes[edge.target]?.region;
    if (!r1 || !r2 || r1 === r2) continue;
    // For source: target is in r2's seed direction
    const targetSeed = seeds.get(r2);
    if (targetSeed) {
      const prev = nodeTarget.get(edge.source) ?? { q: 0, r: 0 };
      nodeTarget.set(edge.source, { q: prev.q + targetSeed.q, r: prev.r + targetSeed.r });
    }
    const srcSeed = seeds.get(r1);
    if (srcSeed) {
      const prev = nodeTarget.get(edge.target) ?? { q: 0, r: 0 };
      nodeTarget.set(edge.target, { q: prev.q + srcSeed.q, r: prev.r + srcSeed.r });
    }
  }

  for (const region of regionNames) {
    const indices = regionNodeIndices.get(region) ?? [];
    const tiles = regionTiles.get(region) ?? [];
    if (indices.length === 0 || tiles.length === 0) continue;

    const seed = seeds.get(region) ?? { q: 0, r: 0 };

    // Initial: sort nodes by whether they have cross-region edges
    // Those with targets get placed near their target, rest from center
    const withTarget: number[] = [];
    const withoutTarget: number[] = [];
    for (const ni of indices) {
      if (nodeTarget.has(ni)) withTarget.push(ni);
      else withoutTarget.push(ni);
    }

    // Sort tiles by distance from seed
    const sortedTiles = [...tiles];
    sortedTiles.sort((a, b) => cubeDistance(a, seed) - cubeDistance(b, seed));

    // Assign nodes with targets: find tile closest to their target
    const usedTiles = new Set<number>();
    const assignment = new Map<number, number>(); // nodeIdx → tileIdx in sortedTiles

    for (const ni of withTarget) {
      const target = nodeTarget.get(ni)!;
      let bestTileIdx = -1;
      let bestDist = Infinity;
      for (let t = 0; t < sortedTiles.length; t++) {
        if (usedTiles.has(t)) continue;
        const d = cubeDistance(sortedTiles[t], target);
        if (d < bestDist) { bestDist = d; bestTileIdx = t; }
      }
      if (bestTileIdx >= 0) {
        assignment.set(ni, bestTileIdx);
        usedTiles.add(bestTileIdx);
      }
    }

    // Fill remaining from center
    withoutTarget.sort((a, b) => fixtureNodes[b].degree - fixtureNodes[a].degree);
    for (const ni of withoutTarget) {
      for (let t = 0; t < sortedTiles.length; t++) {
        if (!usedTiles.has(t)) {
          assignment.set(ni, t);
          usedTiles.add(t);
          break;
        }
      }
    }

    // --- Swap optimization: minimize total edge length ---
    // For each pair of nodes in this region, try swapping tiles.
    // Accept if total edge length decreases. Repeat until stable.
    const regionIndices = [...assignment.keys()];

    function totalEdgeLength(): number {
      let total = 0;
      for (const edge of edges) {
        const tA = assignment.get(edge.source);
        const tB = assignment.get(edge.target);
        if (tA === undefined || tB === undefined) {
          // Cross-region: use actual tile positions
          const cA = tA !== undefined ? sortedTiles[tA] : tileCoords.get(edge.source);
          const cB = tB !== undefined ? sortedTiles[tB] : tileCoords.get(edge.target);
          if (cA && cB) total += cubeDistance(cA, cB);
          continue;
        }
        total += cubeDistance(sortedTiles[tA], sortedTiles[tB]);
      }
      return total;
    }

    // Simple iterative improvement (fast for small regions)
    for (let pass = 0; pass < 5; pass++) {
      let improved = false;
      for (let i = 0; i < regionIndices.length; i++) {
        for (let j = i + 1; j < regionIndices.length; j++) {
          const ni = regionIndices[i];
          const nj = regionIndices[j];
          const ti = assignment.get(ni)!;
          const tj = assignment.get(nj)!;

          // Try swap
          assignment.set(ni, tj);
          assignment.set(nj, ti);
          const afterLen = totalEdgeLength();

          // Revert
          assignment.set(ni, ti);
          assignment.set(nj, tj);
          const beforeLen = totalEdgeLength();

          if (afterLen < beforeLen) {
            assignment.set(ni, tj);
            assignment.set(nj, ti);
            improved = true;
          }
        }
      }
      if (!improved) break;
    }

    // Write final positions
    for (const [ni, tileIdx] of assignment) {
      const fn = fixtureNodes[ni];
      const tile = sortedTiles[tileIdx];
      const { x, z } = cubeToWorld(tile.q, tile.r, tileSize);

      tileCoords.set(ni, tile);
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
