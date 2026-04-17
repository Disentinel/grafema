import { useDataStore, type GraphNode, type GraphEdge, type Region } from './dataStore';
import { useRouteStore, type Route } from './routeStore';

export function cubeToWorld(q: number, r: number, size: number) {
  const x = size * (3 / 2) * q;
  const z = size * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
  return { x, z };
}

interface FixtureNode {
  id: string;
  type: string;
  name: string;
  file: string;
  region: string;
  degree: number;
  metrics?: Record<string, number>;
}

interface FixtureRegion {
  path: string;
  depth: number;
  tileCount: number;
}

/**
 * Deterministic grid placement: groups nodes by region and lays out each
 * region as a rectangular hex block. Used as a zero-dependency replacement
 * for the old client-side SA — the fixture is a small demo dataset and
 * precise packing isn't needed.
 */
function gridLayout(nodes: FixtureNode[]): Map<number, { q: number; r: number }> {
  const byRegion = new Map<string, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const r = nodes[i].region;
    let bucket = byRegion.get(r);
    if (!bucket) { bucket = []; byRegion.set(r, bucket); }
    bucket.push(i);
  }

  const coords = new Map<number, { q: number; r: number }>();
  const regionNames = [...byRegion.keys()].sort();
  // Lay out regions in a coarse grid, each region is a small square block.
  const REGION_GAP = 3; // empty tiles between region blocks
  let cursorQ = 0;
  let cursorR = 0;
  let rowMaxR = 0;
  const COLS = Math.max(1, Math.ceil(Math.sqrt(regionNames.length)));
  let regionCol = 0;

  for (const rpath of regionNames) {
    const indices = byRegion.get(rpath)!;
    const side = Math.max(1, Math.ceil(Math.sqrt(indices.length)));
    for (let k = 0; k < indices.length; k++) {
      const lq = k % side;
      const lr = Math.floor(k / side);
      coords.set(indices[k], { q: cursorQ + lq, r: cursorR + lr });
    }
    const blockHeight = Math.ceil(indices.length / side);
    if (blockHeight > rowMaxR) rowMaxR = blockHeight;
    cursorQ += side + REGION_GAP;
    regionCol++;
    if (regionCol >= COLS) {
      regionCol = 0;
      cursorQ = 0;
      cursorR += rowMaxR + REGION_GAP;
      rowMaxR = 0;
    }
  }

  return coords;
}

function buildRegions(fixtureRegions: FixtureRegion[], nodes: GraphNode[]): Region[] {
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
  const data = await resp.json() as {
    nodes: FixtureNode[];
    edges: GraphEdge[];
    regions: FixtureRegion[];
    routes?: { id: string; label: string; color: string; nodeIds: string[] }[];
  };

  const TILE_SIZE = 3.0;

  // Exclude container types — they are region metadata, not code entities.
  const EXCLUDED_TYPES = new Set(['SERVICE', 'MODULE']);
  const oldToLayout = new Map<number, number>();
  const layoutNodes: FixtureNode[] = [];
  for (let i = 0; i < data.nodes.length; i++) {
    const n = data.nodes[i];
    if (EXCLUDED_TYPES.has(n.type)) continue;
    oldToLayout.set(i, layoutNodes.length);
    layoutNodes.push(n);
  }

  // Remap edges
  const edges: GraphEdge[] = [];
  for (const e of data.edges) {
    const src = oldToLayout.get(e.source);
    const dst = oldToLayout.get(e.target);
    if (src !== undefined && dst !== undefined) {
      edges.push({ source: src, target: dst, type: e.type });
    }
  }

  // Deterministic grid placement (no SA)
  const tileCoords = gridLayout(layoutNodes);

  const nodes: GraphNode[] = [];
  for (let li = 0; li < layoutNodes.length; li++) {
    const tile = tileCoords.get(li);
    if (!tile) continue;
    const fn = layoutNodes[li];
    const { x, z } = cubeToWorld(tile.q, tile.r, TILE_SIZE);
    nodes[li] = {
      id: fn.id,
      type: fn.type,
      name: fn.name,
      file: fn.file,
      region: fn.region,
      x,
      z,
      metrics: fn.metrics,
      degree: fn.degree,
    };
  }

  const typeSet = new Set(layoutNodes.map((n) => n.type));
  const edgeTypeSet = new Set(edges.map((e) => e.type));
  const regions = buildRegions(data.regions, nodes);

  (globalThis as Record<string, unknown>).__grafemaTileSize = TILE_SIZE;

  store.setGraphData({
    nodes,
    edges,
    regions,
    typeTable: [...typeSet],
    edgeTypeTable: [...edgeTypeSet],
  });

  // Load routes — resolve node IDs to layout indices
  if (data.routes) {
    const idToLayoutIdx = new Map<string, number>();
    for (let li = 0; li < layoutNodes.length; li++) {
      idToLayoutIdx.set(layoutNodes[li].id, li);
    }

    const routes: Route[] = data.routes
      .map((r) => ({
        id: r.id,
        label: r.label,
        color: r.color,
        nodeIndices: r.nodeIds
          .map((nid) => idToLayoutIdx.get(nid))
          .filter((idx): idx is number => idx !== undefined),
        visible: false,
      }))
      .filter((r) => r.nodeIndices.length >= 2);

    useRouteStore.getState().setRoutes(routes);
  }
}
