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

  // Filter out SERVICE nodes — they are region metadata, not code nodes
  // Keep index mapping so edges still reference correct nodes
  const allNodes: LayoutNode[] = data.nodes.map((n: LayoutNode) => ({
    id: n.id, type: n.type, name: n.name, file: n.file, region: n.region, degree: n.degree,
  }));

  // Build index set of non-SERVICE nodes
  const codeNodeIndices = allNodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.type !== 'SERVICE')
    .map(({ i }) => i);

  // Remap: old index → layout index (only code nodes participate in layout)
  const oldToLayout = new Map<number, number>();
  const layoutToOld = new Map<number, number>();
  const layoutNodes: LayoutNode[] = [];
  for (let li = 0; li < codeNodeIndices.length; li++) {
    const oi = codeNodeIndices[li];
    oldToLayout.set(oi, li);
    layoutToOld.set(li, oi);
    layoutNodes.push(allNodes[oi]);
  }

  // Remap edges (skip edges touching SERVICE nodes)
  const layoutEdges: GraphEdge[] = [];
  for (const e of data.edges as GraphEdge[]) {
    const src = oldToLayout.get(e.source);
    const dst = oldToLayout.get(e.target);
    if (src !== undefined && dst !== undefined) {
      layoutEdges.push({ source: src, target: dst, type: e.type });
    }
  }

  // Run simulated annealing on code nodes only
  const { tileCoords } = annealingLayout(layoutNodes, layoutEdges, regionNames);

  // Build GraphNode[] with world positions (using ORIGINAL indices)
  const nodes: GraphNode[] = [];
  for (const [li, tile] of tileCoords) {
    const oi = layoutToOld.get(li)!;
    const fn = allNodes[oi];
    const { x, z } = cubeToWorld(tile.q, tile.r, TILE_SIZE);
    nodes[oi] = {
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

  // Edges use original indices (Canvas reads from fixture data)
  // But we need to filter edges for Canvas too — only code-node edges
  const edges: GraphEdge[] = (data.edges as GraphEdge[]).filter(
    (e) => oldToLayout.has(e.source) && oldToLayout.has(e.target),
  );

  const typeSet = new Set(data.nodes.map((n: { type: string }) => n.type));
  const edgeTypeSet = new Set(data.edges.map((e: { type: string }) => e.type));
  const regions = buildRegions(data.regions, nodes);

  // Remap tileCoords from layout indices to original indices
  const originalTileCoords = new Map<number, { q: number; r: number }>();
  for (const [li, coord] of tileCoords) {
    const oi = layoutToOld.get(li);
    if (oi !== undefined) originalTileCoords.set(oi, coord);
  }
  (globalThis as Record<string, unknown>).__grafemaTileCoords = originalTileCoords;
  (globalThis as Record<string, unknown>).__grafemaTileSize = TILE_SIZE;

  store.setGraphData({
    nodes,
    edges,
    regions,
    typeTable: [...typeSet] as string[],
    edgeTypeTable: [...edgeTypeSet] as string[],
  });
}
