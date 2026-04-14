/** @typedef {import('./hex.js').HexCoord} HexCoord */

/**
 * A single placeable entity on the map. One hex tile per node.
 * The `coord` field is mutated only through `HexMap.moveNode` / `swap`
 * so the spatial index stays consistent.
 */
export class Node {
  /**
   * @param {string} id
   * @param {HexCoord} coord
   * @param {object} [data]  arbitrary user payload (name, file, type, …)
   */
  constructor(id, coord, data = {}) {
    /** @type {string} */
    this.id = id;
    /** @type {HexCoord} */
    this.coord = { q: coord.q, r: coord.r };
    /** @type {string | null}  region membership, assigned via Region.add */
    this.regionId = null;
    /** @type {object} */
    this.data = data;
  }
}
