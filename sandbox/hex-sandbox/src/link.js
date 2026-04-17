import { hexDistance } from './hex.js';

/**
 * A directed edge between two nodes with an optional weight.
 * `length()` returns the current hex-distance (recomputed on demand).
 */
export class Link {
  /**
   * @param {import('./node.js').Node} source
   * @param {import('./node.js').Node} target
   * @param {number} [weight]
   * @param {string} [type]
   */
  constructor(source, target, weight = 1, type = 'default') {
    this.source = source;
    this.target = target;
    this.weight = weight;
    this.type = type;
  }

  /** Current hex-distance between endpoints. */
  length() {
    return hexDistance(this.source.coord, this.target.coord);
  }

  /** Weighted length (convenience for cost functions). */
  weightedLength() {
    return this.length() * this.weight;
  }
}
