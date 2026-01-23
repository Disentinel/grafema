/**
 * MountPointResolver - ENRICHMENT plugin for resolving mount points
 *
 * Updates ENDPOINT nodes by adding fullPath based on MOUNT_POINT prefixes.
 *
 * Graph traversal:
 * MOUNT_POINT --MOUNTS--> MODULE --EXPOSES--> ENDPOINT
 *
 * Updates:
 * endpoint.fullPath = mountPoint.prefix + endpoint.localPath
 */

import { Plugin } from '../Plugin.js';
import { createSuccessResult, createErrorResult } from '@grafema/types';
import type { PluginMetadata, PluginContext, PluginResult, GraphBackend } from '@grafema/types';
import type { BaseNodeRecord } from '@grafema/types';
import type { EdgeRecord } from '@grafema/types';

interface EdgeCriteria {
  type?: string;
  src?: string;
  dst?: string;
}

interface MountPointNode extends BaseNodeRecord {
  prefix: string;
}

interface EndpointNode extends BaseNodeRecord {
  localPath?: string;
  path?: string;
  mountPrefixes?: string[];
  fullPaths?: string[];
  mountPrefix?: string;
  fullPath?: string;
}

export class MountPointResolver extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'MountPointResolver',
      phase: 'ENRICHMENT',
      priority: 90,  // High priority - one of first enrichment plugins
      creates: {
        nodes: [],  // Doesn't create new nodes
        edges: []   // Doesn't create new edges
      },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    try {
      const { graph } = context;
      const logger = this.log(context);

      let endpointsUpdated = 0;
      let mountPointsProcessed = 0;

      // Find all MOUNT_POINT nodes
      const allNodes = await graph.getAllNodes();
      const mountPoints = allNodes.filter(node => node.type === 'MOUNT_POINT') as MountPointNode[];

      logger.info('Found mount points', { count: mountPoints.length });

      // For each top-level mount point (from app.use in index.js)
      // apply recursive resolver
      const processedMountPoints = new Set<string>();

      for (const mountPoint of mountPoints) {
        if (!processedMountPoints.has(mountPoint.id)) {
          const updated = await this.resolveMountPoint(graph, mountPoint, '', processedMountPoints);
          endpointsUpdated += updated;
          mountPointsProcessed++;
        }
      }

      // Fallback: process mount points without recursion (old logic for compatibility)
      for (const mountPoint of mountPoints) {
        if (processedMountPoints.has(mountPoint.id)) continue;
        // Find MOUNT_POINT --MOUNTS--> MODULE edge
        const mountsEdges = await this.findEdges(graph, {
          type: 'MOUNTS',
          src: mountPoint.id
        });

        for (const mountsEdge of mountsEdges) {
          const targetModuleId = mountsEdge.dst;

          // Find MODULE --EXPOSES--> ENDPOINT edges
          const exposesEdges = await this.findEdges(graph, {
            type: 'EXPOSES',
            src: targetModuleId
          });

          for (const exposesEdge of exposesEdges) {
            const endpointId = exposesEdge.dst;
            const endpoint = await graph.getNode(endpointId) as EndpointNode | null;

            if (endpoint && endpoint.type === 'ENDPOINT') {
              // Support multiple mount points for one endpoint
              // Store all prefixes and fullPaths in arrays
              const mountPrefixes = endpoint.mountPrefixes || [];
              const fullPaths = endpoint.fullPaths || [];

              const prefix = mountPoint.prefix;
              const fullPath = prefix + (endpoint.localPath || endpoint.path || '');

              // Only add if not already added (avoid duplicates)
              if (!mountPrefixes.includes(prefix)) {
                mountPrefixes.push(prefix);
                fullPaths.push(fullPath);
              }

              // Update endpoint node
              const updatedEndpoint: EndpointNode = {
                ...endpoint,
                mountPrefixes,
                fullPaths,
                mountPrefix: endpoint.mountPrefix || prefix,
                fullPath: endpoint.fullPath || fullPath
              };

              await graph.addNode(updatedEndpoint);
              endpointsUpdated++;
            }
          }
        }

        mountPointsProcessed++;
      }

      logger.info('Updated endpoints', {
        endpoints: endpointsUpdated,
        mountPoints: mountPointsProcessed
      });

      return createSuccessResult(
        { nodes: 0, edges: 0 },
        { endpointsUpdated, mountPointsProcessed }
      );

    } catch (error) {
      const logger = this.log(context);
      logger.error('Error in MountPointResolver', { error });
      return createErrorResult(error as Error);
    }
  }

  /**
   * Recursively resolve mount point and all nested mount points
   */
  private async resolveMountPoint(
    graph: GraphBackend,
    mountPoint: MountPointNode,
    parentPrefix: string,
    processedMountPoints: Set<string>
  ): Promise<number> {
    let endpointsUpdated = 0;

    // Mark as processed
    processedMountPoints.add(mountPoint.id);

    // Calculate full prefix (parent + current)
    const fullPrefix = parentPrefix + mountPoint.prefix;

    // Find MOUNT_POINT --MOUNTS--> MODULE edge
    const mountsEdges = await this.findEdges(graph, {
      type: 'MOUNTS',
      src: mountPoint.id
    });

    for (const mountsEdge of mountsEdges) {
      const targetModuleId = mountsEdge.dst;

      // 1. Process ENDPOINT in this module
      const exposesEdges = await this.findEdges(graph, {
        type: 'EXPOSES',
        src: targetModuleId
      });

      for (const exposesEdge of exposesEdges) {
        const endpointId = exposesEdge.dst;
        const endpoint = await graph.getNode(endpointId) as EndpointNode | null;

        if (endpoint && endpoint.type === 'ENDPOINT') {
          // Support multiple mount points
          const mountPrefixes = endpoint.mountPrefixes || [];
          const fullPaths = endpoint.fullPaths || [];

          const fullPath = fullPrefix + (endpoint.localPath || endpoint.path || '');

          // Only add if not already added
          if (!mountPrefixes.includes(fullPrefix)) {
            mountPrefixes.push(fullPrefix);
            fullPaths.push(fullPath);
          }

          // Update endpoint node with new data
          const updatedEndpoint: EndpointNode = {
            ...endpoint,
            mountPrefixes,
            fullPaths,
            mountPrefix: endpoint.mountPrefix || fullPrefix,
            fullPath: endpoint.fullPath || fullPath
          };

          await graph.addNode(updatedEndpoint);
          endpointsUpdated++;
        }
      }

      // 2. Recursively process nested MOUNT_POINT in this module
      const definesEdges = await this.findEdges(graph, {
        type: 'DEFINES',
        src: targetModuleId
      });

      for (const definesEdge of definesEdges) {
        const nestedMountPointId = definesEdge.dst;
        const nestedMountPoint = await graph.getNode(nestedMountPointId) as MountPointNode | null;

        if (nestedMountPoint && nestedMountPoint.type === 'MOUNT_POINT' &&
            !processedMountPoints.has(nestedMountPointId)) {
          // Recursively process nested mount point
          endpointsUpdated += await this.resolveMountPoint(
            graph,
            nestedMountPoint,
            fullPrefix,  // Pass accumulated prefix
            processedMountPoints
          );
        }
      }
    }

    return endpointsUpdated;
  }

  /**
   * Helper method for finding edges by criteria
   */
  private async findEdges(graph: GraphBackend, criteria: EdgeCriteria): Promise<EdgeRecord[]> {
    const result: EdgeRecord[] = [];

    // Get all edges using RFDBServerBackend API
    if (!graph.getAllEdges) {
      return result;
    }
    const allEdges = await graph.getAllEdges();

    for (const edge of allEdges) {
      let matches = true;

      for (const [key, value] of Object.entries(criteria)) {
        const edgeRecord = edge as unknown as Record<string, unknown>;
        if (edgeRecord[key] !== value) {
          matches = false;
          break;
        }
      }

      if (matches) {
        result.push(edge);
      }
    }

    return result;
  }
}
