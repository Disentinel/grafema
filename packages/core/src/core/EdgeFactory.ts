/**
 * EdgeFactory - centralized edge creation
 *
 * Single interception point for all graph edge construction.
 * Validates inputs and normalizes edge records.
 *
 * Legitimate caller of graph.addEdge() (excluded from guarantee checks).
 */

import type { EdgeRecord, EdgeType } from '@grafema/types';

interface EdgeOptions {
  index?: number;
  metadata?: Record<string, unknown>;
}

export class EdgeFactory {
  /**
   * Create an EdgeRecord from typed parameters.
   *
   * @param type - Edge type (e.g., 'CALLS', 'CONTAINS')
   * @param src - Source node ID
   * @param dst - Destination node ID
   * @param options - Optional index and metadata
   * @returns Normalized EdgeRecord
   */
  static create(
    type: EdgeType,
    src: string,
    dst: string,
    options?: EdgeOptions,
  ): EdgeRecord {
    if (!type) throw new Error('EdgeFactory.create: type is required');
    if (!src) throw new Error('EdgeFactory.create: src is required');
    if (!dst) throw new Error('EdgeFactory.create: dst is required');

    const edge: EdgeRecord = { type, src, dst };

    if (options?.index !== undefined) {
      edge.index = options.index;
    }
    if (options?.metadata !== undefined) {
      edge.metadata = options.metadata;
    }

    return edge;
  }
}
