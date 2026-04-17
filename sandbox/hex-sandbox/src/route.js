/**
 * A named path through a set of nodes. Rendered as a polyline.
 * `segments` is a list of ordered node lists; one route can have
 * multiple disjoint segments (e.g. branching trace, multi-span path).
 */
export class Route {
  /**
   * @param {string} id
   * @param {import('./node.js').Node[][]} [segments]
   * @param {string} [color]
   */
  constructor(id, segments = [], color = '#ffcc00') {
    this.id = id;
    /** @type {import('./node.js').Node[][]} */
    this.segments = segments;
    this.color = color;
  }

  /** Total edge length across all segments. */
  totalLength() {
    let total = 0;
    for (const seg of this.segments) {
      for (let i = 1; i < seg.length; i++) {
        total += hexDistance(seg[i - 1].coord, seg[i].coord);
      }
    }
    return total;
  }
}

// Avoid a circular-import penalty by re-importing here.
import { hexDistance } from './hex.js';
