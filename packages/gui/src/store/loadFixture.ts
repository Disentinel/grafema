import { useDataStore, type GraphNode, type GraphEdge, type Region } from './dataStore';
import { useRouteStore, type Route } from './routeStore';
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

  // Exclude container types — they are region metadata, not code entities
  const EXCLUDED_TYPES = new Set(['SERVICE', 'MODULE']);
  const codeNodeIndices = allNodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => !EXCLUDED_TYPES.has(n.type))
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

  // Build dense GraphNode[] using layout indices (0..N-1, no gaps)
  const nodes: GraphNode[] = [];
  for (let li = 0; li < layoutNodes.length; li++) {
    const tile = tileCoords.get(li);
    if (!tile) continue;
    const fn = layoutNodes[li];
    const { x, z } = cubeToWorld(tile.q, tile.r, TILE_SIZE);
    // Get metrics from original fixture data
    const origIdx = layoutToOld.get(li);
    const origNode = origIdx !== undefined ? data.nodes[origIdx] : null;

    nodes[li] = {
      id: fn.id,
      type: fn.type,
      name: fn.name,
      file: fn.file,
      region: fn.region,
      x,
      z,
      metrics: origNode?.metrics,
      degree: fn.degree,
    };
  }

  // Edges already use layout indices (remapped above)
  const edges = layoutEdges;

  const typeSet = new Set(layoutNodes.map((n) => n.type));
  const edgeTypeSet = new Set(edges.map((e) => e.type));
  const regions = buildRegions(data.regions, nodes);

  (globalThis as Record<string, unknown>).__grafemaTileCoords = tileCoords;
  (globalThis as Record<string, unknown>).__grafemaTileSize = TILE_SIZE;

  store.setGraphData({
    nodes,
    edges,
    regions,
    typeTable: [...typeSet] as string[],
    edgeTypeTable: [...edgeTypeSet] as string[],
  });

  // Load routes — resolve node IDs to layout indices
  if (data.routes) {
    const idToLayoutIdx = new Map<string, number>();
    for (let li = 0; li < layoutNodes.length; li++) {
      idToLayoutIdx.set(layoutNodes[li].id, li);
    }

    const routes: Route[] = data.routes
      .map((r: { id: string; label: string; color: string; nodeIds: string[] }) => ({
        id: r.id,
        label: r.label,
        color: r.color,
        nodeIndices: r.nodeIds
          .map((nid: string) => idToLayoutIdx.get(nid))
          .filter((idx: number | undefined): idx is number => idx !== undefined),
        visible: true,
      }))
      .filter((r: Route) => r.nodeIndices.length >= 2);

    useRouteStore.getState().setRoutes(routes);
  }
}
