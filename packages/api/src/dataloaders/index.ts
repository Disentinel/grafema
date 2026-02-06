/**
 * DataLoader Factory
 *
 * Creates all DataLoaders for a request context.
 * DataLoaders batch and cache database requests within a single GraphQL request.
 */

import type { RFDBServerBackend } from '@grafema/core';
import { createNodeLoader } from './nodeLoader.js';

export interface DataLoaders {
  /** Batch node lookups by ID */
  node: ReturnType<typeof createNodeLoader>;
}

/**
 * Create all DataLoaders for a request.
 * DataLoaders are per-request to prevent cross-request caching issues.
 */
export function createDataLoaders(backend: RFDBServerBackend): DataLoaders {
  return {
    node: createNodeLoader(backend),
  };
}
