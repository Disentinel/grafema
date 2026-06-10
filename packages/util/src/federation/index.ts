/**
 * Federation module — cross-shard query routing for RFDB.
 *
 * Enables multiple RFDB shards to discover each other and resolve
 * cross-shard references at query time. Within a shard, the graph
 * is fully materialized (analysis-time). Between shards, references
 * are resolved lazily (execution-time) via the SUBGRAPH primitive.
 *
 * ## Architecture
 *
 * - ShardDiscovery: scans /tmp/rfdb-shards/ for registered shards
 * - FederatedRouter: orchestrates cross-shard traversal and scatter-gather
 * - Each shard is a separate rfdb-server process with its own graph
 * - Discovery is by file path prefix matching (zero-config)
 *
 * ## Usage
 *
 *   const discovery = new ShardDiscovery();
 *   await discovery.scan();
 *
 *   const router = new FederatedRouter(discovery, localClient);
 *   const result = await router.traceDataflow('src/app.ts->userInput', 'forward', 10);
 */

export { ShardDiscovery } from './ShardDiscovery.js';
export type { ShardRegistration } from './ShardDiscovery.js';

export { FederatedRouter, extractSymbolFromId } from './FederatedRouter.js';
export type {
  FederatedTraceResult,
  FederatedTraceHop,
  FrontierEdge,
  SubgraphResponse,
  ManifestResolvedNode,
} from './FederatedRouter.js';
