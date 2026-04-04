import { useDataStore, type GraphNode, type GraphEdge, type Region } from './dataStore';
import { annealingLayout, type LayoutNode } from './hexLayout';

export function cubeToWorld(q: number, r: number, size: number) {
  const x = size * (3 / 2) * q;
  const z = size * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
  return { x, z };
}

function buildRegions(fixtureRegions: { path: string; depth: number; tileCount: number }[], nodes: GraphNode[]): Region[] {
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
  const data = await resp.json();

  const TILE_SIZE = 3.0;
  const regionNames = data.regions.map((r: { path: string }) => r.path);

  const layoutNodes: LayoutNode[] = data.nodes.map((n: LayoutNode) => ({
    id: n.id, type: n.type, name: n.name, file: n.file, region: n.region, degree: n.degree,
  }));

  // Run simulated annealing
  const { tileCoords } = annealingLayout(layoutNodes, data.edges, regionNames);

  // Build GraphNode[] with world positions
  const nodes: GraphNode[] = [];
  for (const [ni, tile] of tileCoords) {
    const fn = data.nodes[ni];
    const { x, z } = cubeToWorld(tile.q, tile.r, TILE_SIZE);
    nodes[ni] = {
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

  const edges: GraphEdge[] = data.edges;
  const typeSet = new Set(data.nodes.map((n: { type: string }) => n.type));
  const edgeTypeSet = new Set(data.edges.map((e: { type: string }) => e.type));
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
