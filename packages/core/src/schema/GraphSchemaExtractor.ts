/**
 * GraphSchemaExtractor - Extracts graph node/edge type schemas
 *
 * Usage:
 *   const extractor = new GraphSchemaExtractor(backend);
 *   const schema = await extractor.extract();
 *
 * When to use:
 *   - Export graph schema for contract tracking
 *   - Track node/edge type changes via checksum
 *   - Generate graph documentation
 */

import { createHash } from 'crypto';
import { NODE_TYPE, NAMESPACED_TYPE, EDGE_TYPE } from '@grafema/types';
import type { RFDBServerBackend } from '../storage/backends/RFDBServerBackend.js';

// ============================================================================
// Types
// ============================================================================

export interface NodeTypeSchema {
  category: 'base' | 'namespaced';
  namespace?: string;
  count: number;
}

export interface EdgeTypeSchema {
  count: number;
}

export interface GraphSchema {
  $schema: 'grafema-graph-v1';
  extractedAt: string;
  nodeTypes: Record<string, NodeTypeSchema>;
  edgeTypes: Record<string, EdgeTypeSchema>;
  statistics: {
    totalNodes: number;
    totalEdges: number;
    nodeTypeCount: number;
    edgeTypeCount: number;
  };
  checksum: string;
}

// ============================================================================
// Extractor
// ============================================================================

export interface GraphExtractOptions {
  /** Include all defined types, not just used ones (default: false) */
  includeAll?: boolean;
}

export class GraphSchemaExtractor {
  constructor(private backend: RFDBServerBackend) {}

  /**
   * Extract graph schema from current database
   *
   * @param options.includeAll - If true, include all defined types even with count=0
   */
  async extract(options?: GraphExtractOptions): Promise<GraphSchema> {
    const includeAll = options?.includeAll ?? false;
    // Get actual counts from graph
    const nodeCounts = await this.backend.countNodesByType();
    const edgeCounts = await this.backend.countEdgesByType();

    // Build node types from definitions + counts
    const nodeTypes: Record<string, NodeTypeSchema> = {};

    // Base node types
    for (const [_key, value] of Object.entries(NODE_TYPE)) {
      nodeTypes[value] = {
        category: 'base',
        count: nodeCounts[value] || 0,
      };
    }

    // Namespaced node types
    for (const [_key, value] of Object.entries(NAMESPACED_TYPE)) {
      const namespace = value.split(':')[0];
      nodeTypes[value] = {
        category: 'namespaced',
        namespace,
        count: nodeCounts[value] || 0,
      };
    }

    // Add any additional types found in the graph but not in definitions
    for (const [type, count] of Object.entries(nodeCounts)) {
      if (!nodeTypes[type]) {
        const namespace = type.includes(':') ? type.split(':')[0] : undefined;
        nodeTypes[type] = {
          category: namespace ? 'namespaced' : 'base',
          namespace,
          count,
        };
      }
    }

    // Build edge types from definitions + counts
    const edgeTypes: Record<string, EdgeTypeSchema> = {};

    for (const [_key, value] of Object.entries(EDGE_TYPE)) {
      edgeTypes[value] = {
        count: edgeCounts[value] || 0,
      };
    }

    // Add any additional edge types found in the graph
    for (const [type, count] of Object.entries(edgeCounts)) {
      if (!edgeTypes[type]) {
        edgeTypes[type] = { count };
      }
    }

    // Calculate totals
    const totalNodes = Object.values(nodeCounts).reduce((sum, n) => sum + n, 0);
    const totalEdges = Object.values(edgeCounts).reduce((sum, n) => sum + n, 0);

    // Filter out types with count=0 unless includeAll is true
    const filteredNodeTypes: Record<string, NodeTypeSchema> = {};
    for (const [type, info] of Object.entries(nodeTypes)) {
      if (includeAll || info.count > 0) {
        filteredNodeTypes[type] = info;
      }
    }

    const filteredEdgeTypes: Record<string, EdgeTypeSchema> = {};
    for (const [type, info] of Object.entries(edgeTypes)) {
      if (includeAll || info.count > 0) {
        filteredEdgeTypes[type] = info;
      }
    }

    // Sort for deterministic output
    const sortedNodeTypes = this.sortObject(filteredNodeTypes);
    const sortedEdgeTypes = this.sortObject(filteredEdgeTypes);

    // Compute checksum from normalized content (based on filtered types)
    const checksumContent = {
      nodeTypes: Object.keys(sortedNodeTypes).sort(),
      edgeTypes: Object.keys(sortedEdgeTypes).sort(),
    };

    const checksum = createHash('sha256')
      .update(JSON.stringify(checksumContent))
      .digest('hex');

    return {
      $schema: 'grafema-graph-v1',
      extractedAt: new Date().toISOString(),
      nodeTypes: sortedNodeTypes,
      edgeTypes: sortedEdgeTypes,
      statistics: {
        totalNodes,
        totalEdges,
        nodeTypeCount: Object.keys(sortedNodeTypes).length,
        edgeTypeCount: Object.keys(sortedEdgeTypes).length,
      },
      checksum: `sha256:${checksum}`,
    };
  }

  /**
   * Sort object keys alphabetically for deterministic output
   */
  private sortObject<T>(obj: Record<string, T>): Record<string, T> {
    const sorted: Record<string, T> = {};
    const keys = Object.keys(obj).sort();
    for (const key of keys) {
      sorted[key] = obj[key];
    }
    return sorted;
  }
}
