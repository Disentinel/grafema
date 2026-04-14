import { HEX_DIRS, hexKey } from './hex.js';

/**
 * Hex map — single source of truth for nodes/links/routes/regions.
 *
 * Invariants maintained internally:
 *   - `_byCoord` is a spatial index: one entry per occupied hex.
 *   - `_regionAdj` is a lazily-rebuilt adjacency graph between
 *     region ids. `_regionAdjDirty` flags when it needs a rebuild.
 *   - Mutating a node's coord MUST go through `moveNode` or `swap`
 *     so the spatial index stays in sync.
 */
export class HexMap {
  constructor() {
    /** @type {Map<string, import('./node.js').Node>} id → node */
    this.nodes = new Map();
    /** @type {import('./link.js').Link[]} */
    this.links = [];
    /** @type {Map<string, import('./route.js').Route>} */
    this.routes = new Map();
    /** @type {Map<string, import('./region.js').Region>} */
    this.regions = new Map();

    /** @type {Map<string, import('./node.js').Node>} coordKey → node */
    this._byCoord = new Map();

    /** @type {Map<string, Set<string>>} regionId → set of adjacent regionIds */
    this._regionAdj = new Map();
    this._regionAdjDirty = true;

    // ── View state ────────────────────────────────────────────────
    // Current level-of-detail. Integer; 0 = coarsest (outer level),
    // increases toward finer detail. Not used internally — callers
    // (layout algorithms, renderers) read this to decide what to
    // show. Driven by keyboard in demo.js.
    /** @type {number} */
    this.lod = 0;
    /** Soft bounds for LOD — callers may clamp to this range. */
    this.lodMin = 0;
    this.lodMax = 5;
  }

  /** Bump LOD within [lodMin..lodMax]. */
  setLod(level) {
    this.lod = Math.max(this.lodMin, Math.min(this.lodMax, level | 0));
    return this.lod;
  }
  incLod() { return this.setLod(this.lod + 1); }
  decLod() { return this.setLod(this.lod - 1); }

  // ── Snapshot / restore ────────────────────────────────────────
  // Used by the Tectonic debug stepper. Snapshot is just the full
  // set of (node id → coord) pairs — links/regions membership don't
  // change during layout, so nothing else needs to be captured.

  /** Capture current node coords as a plain Map. O(|nodes|). */
  takeSnapshot() {
    const coords = new Map();
    for (const [id, n] of this.nodes) {
      coords.set(id, { q: n.coord.q, r: n.coord.r });
    }
    return coords;
  }

  /**
   * Restore a snapshot taken by takeSnapshot. Bypasses `moveNode`'s
   * occupancy check because the whole set is replaced atomically.
   */
  restoreSnapshot(coords) {
    for (const [id, c] of coords) {
      const n = this.nodes.get(id);
      if (n) { n.coord.q = c.q; n.coord.r = c.r; }
    }
    this._rebuildSpatialIndex();
  }

  /**
   * Internal: rebuild _byCoord from current node coords.
   * Callable after bulk mutations that bypassed moveNode/swap.
   */
  _rebuildSpatialIndex() {
    this._byCoord.clear();
    for (const n of this.nodes.values()) {
      this._byCoord.set(hexKey(n.coord.q, n.coord.r), n);
    }
    this._regionAdjDirty = true;
  }

  // ── Mutation ───────────────────────────────────────────────────

  /** Add a node. Throws if coord occupied. */
  addNode(node) {
    const key = hexKey(node.coord.q, node.coord.r);
    if (this._byCoord.has(key)) {
      throw new Error(`addNode: coord ${key} already occupied by ${this._byCoord.get(key).id}`);
    }
    this.nodes.set(node.id, node);
    this._byCoord.set(key, node);
    this._regionAdjDirty = true;
  }

  removeNode(node) {
    const key = hexKey(node.coord.q, node.coord.r);
    this.nodes.delete(node.id);
    if (this._byCoord.get(key) === node) this._byCoord.delete(key);
    if (node.regionId) {
      const r = this.regions.get(node.regionId);
      if (r) r.remove(node);
    }
    this._regionAdjDirty = true;
  }

  addLink(link) {
    this.links.push(link);
  }

  addRoute(route) {
    this.routes.set(route.id, route);
  }

  addRegion(region) {
    this.regions.set(region.id, region);
    this._regionAdjDirty = true;
  }

  /**
   * Move a node to a new coord. Throws if destination occupied
   * (caller should use `swap` instead in that case). O(1).
   */
  moveNode(node, q, r) {
    const destKey = hexKey(q, r);
    if (this._byCoord.has(destKey) && this._byCoord.get(destKey) !== node) {
      throw new Error(`moveNode: coord ${destKey} occupied — use swap`);
    }
    const oldKey = hexKey(node.coord.q, node.coord.r);
    this._byCoord.delete(oldKey);
    node.coord.q = q;
    node.coord.r = r;
    this._byCoord.set(destKey, node);
    this._regionAdjDirty = true;
  }

  /**
   * Atomically swap the coordinates of two nodes. O(1).
   * Both nodes keep their region membership; only physical positions
   * exchange. Spatial index is updated in place.
   */
  swap(a, b) {
    if (a === b) return;
    const ka = hexKey(a.coord.q, a.coord.r);
    const kb = hexKey(b.coord.q, b.coord.r);
    const tq = a.coord.q, tr = a.coord.r;
    a.coord.q = b.coord.q; a.coord.r = b.coord.r;
    b.coord.q = tq;        b.coord.r = tr;
    this._byCoord.set(ka, b);
    this._byCoord.set(kb, a);
    this._regionAdjDirty = true;
  }

  // ── Queries ────────────────────────────────────────────────────

  /** Node at a given hex coord, or undefined. O(1). */
  nodeAt(q, r) {
    return this._byCoord.get(hexKey(q, r));
  }

  /**
   * Are two nodes adjacent on the hex grid? O(6).
   * Compares the 6 offsets rather than scanning the index.
   */
  nodesAdjacent(a, b) {
    const dq = b.coord.q - a.coord.q;
    const dr = b.coord.r - a.coord.r;
    for (const d of HEX_DIRS) {
      if (d.q === dq && d.r === dr) return true;
    }
    return false;
  }

  /**
   * Sum of link hex-lengths. O(|links|).
   * Useful as a layout cost function.
   */
  totalLinkLength() {
    let total = 0;
    for (const l of this.links) total += l.length();
    return total;
  }

  /** Same, weighted. */
  totalWeightedLinkLength() {
    let total = 0;
    for (const l of this.links) total += l.weightedLength();
    return total;
  }

  /**
   * Region adjacency: "does any tile of `a` have a neighbour owned by `b`".
   * Amortised O(1) after the first call following a mutation — full
   * rebuild is O(|nodes| × 6), lazy-triggered only when the dirty flag
   * is set. Mutations (add/remove/move/swap) flip the flag.
   */
  regionsAdjacent(a, b) {
    if (a === b || a.id === b.id) return false;
    if (this._regionAdjDirty) this._rebuildRegionAdjacency();
    return this._regionAdj.get(a.id)?.has(b.id) ?? false;
  }

  /**
   * All regions adjacent to `r`. Returns a Set of region IDs.
   * Amortised O(1) after cache warm.
   */
  adjacentRegions(r) {
    if (this._regionAdjDirty) this._rebuildRegionAdjacency();
    return this._regionAdj.get(r.id) ?? new Set();
  }

  /** Iterate non-empty regions for rendering/debug. */
  *regionList() {
    for (const r of this.regions.values()) {
      if (r.nodes.size > 0) yield r;
    }
  }

  // ── Internals ──────────────────────────────────────────────────

  _rebuildRegionAdjacency() {
    this._regionAdj.clear();
    for (const [id] of this.regions) this._regionAdj.set(id, new Set());

    // Single spatial pass: for each occupied tile, look at its 6
    // neighbours; any cross-region pair goes into the adjacency.
    for (const node of this.nodes.values()) {
      if (!node.regionId) continue;
      for (const d of HEX_DIRS) {
        const nb = this._byCoord.get(hexKey(node.coord.q + d.q, node.coord.r + d.r));
        if (!nb || !nb.regionId || nb.regionId === node.regionId) continue;
        this._regionAdj.get(node.regionId)?.add(nb.regionId);
        this._regionAdj.get(nb.regionId)?.add(node.regionId);
      }
    }
    this._regionAdjDirty = false;
  }
}
