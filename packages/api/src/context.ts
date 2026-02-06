/**
 * GraphQL Context
 *
 * Request-scoped context containing backend connection and DataLoaders.
 */

import type { IncomingMessage } from 'node:http';
import type { RFDBServerBackend } from '@grafema/core';
import { createDataLoaders, type DataLoaders } from './dataloaders/index.js';

export interface GraphQLContext {
  /** Graph backend connection */
  backend: RFDBServerBackend;
  /** DataLoaders for batching (per-request) */
  loaders: DataLoaders;
  /** Request start time for timeout tracking */
  startTime: number;
}

/**
 * Create context for a GraphQL request.
 * Creates fresh DataLoaders to ensure no cross-request caching.
 */
export function createContext(
  backend: RFDBServerBackend,
  _req: IncomingMessage
): GraphQLContext {
  return {
    backend,
    loaders: createDataLoaders(backend),
    startTime: Date.now(),
  };
}
