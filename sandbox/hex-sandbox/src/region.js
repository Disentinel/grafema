/**
 * A set of nodes forming one logical grouping.
 * Region adjacency to other regions is computed on the map level
 * (see `HexMap.regionsAdjacent`), not per-region, so that a single
 * spatial pass can populate all pairs at once.
 */
export class Region {
  /**
   * @param {string} id
   * @param {object} [data]
   */
  constructor(id, data = {}) {
    this.id = id;
    /** @type {Set<import('./node.js').Node>} */
    this.nodes = new Set();
    this.data = data;
  }

  /** Add a node to the region and tag its back-reference. */
  add(node) {
    this.nodes.add(node);
    node.regionId = this.id;
  }

  /** Remove and clear the back-reference iff this region owned it. */
  remove(node) {
    if (this.nodes.delete(node) && node.regionId === this.id) {
      node.regionId = null;
    }
  }

  size() {
    return this.nodes.size;
  }
}
