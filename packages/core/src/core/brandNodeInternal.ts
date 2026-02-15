/**
 * Internal branding helper for legitimate uses outside NodeFactory.
 * DO NOT import this in analyzers or plugins - use NodeFactory instead.
 *
 * Legitimate uses:
 * - NodeFactory (centralized node creation)
 * - GraphBuilder._flushNodes() - batches validated nodes from builders
 * - RFDBServerBackend._parseNode() - re-brands nodes from database
 *
 * @internal
 */
import type { BaseNodeRecord, BrandedNode } from '@grafema/types';

export function brandNodeInternal<T extends BaseNodeRecord>(node: T): BrandedNode<T> {
  return node as BrandedNode<T>;
}
