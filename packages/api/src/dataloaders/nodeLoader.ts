/**
 * Node DataLoader
 *
 * Batches multiple getNode() calls into efficient parallel lookups.
 * Critical for preventing N+1 queries in GraphQL.
 */

import DataLoader from 'dataloader';
import type { BaseNodeRecord } from '@grafema/types';
import type { RFDBServerBackend } from '@grafema/core';

/**
 * Create a DataLoader for batching node lookups.
 *
 * The loader batches all node ID requests made within a single tick
 * and resolves them with parallel backend calls.
 *
 * Complexity: O(n) where n = unique node IDs requested
 */
export function createNodeLoader(
  backend: RFDBServerBackend
): DataLoader<string, BaseNodeRecord | null> {
  return new DataLoader<string, BaseNodeRecord | null>(
    async (ids: readonly string[]) => {
      // Parallelize individual lookups
      // Future optimization: add batch getNodes() to RFDB protocol
      const results = await Promise.all(
        ids.map((id) => backend.getNode(id).catch(() => null))
      );
      return results;
    },
    {
      // Cache results within this request
      cache: true,
      // Use identity function for cache key
      cacheKeyFn: (id) => id,
      // Max batch size to prevent overwhelming backend
      maxBatchSize: 100,
    }
  );
}
