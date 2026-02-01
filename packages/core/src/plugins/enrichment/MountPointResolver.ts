/**
 * MountPointResolver - ENRICHMENT plugin for resolving mount points
 *
 * REG-248 Fix: Now works with ExpressRouteAnalyzer's node types:
 * - express:middleware (with mountPath) instead of MOUNT_POINT
 * - http:route instead of ENDPOINT
 *
 * Algorithm:
 * 1. Find express:middleware nodes with mountPath
 * 2. Get the MODULE node for the file containing the mount
 * 3. Follow IMPORTS edges to find imported modules
 * 4. Find http:route nodes in those modules
 * 5. Update routes with fullPath = mountPath + route.path
 *
 * Note: This applies mount prefixes to ALL routes in imported modules.
 * This matches how Express router mounting typically works.
 */

import { Plugin } from '../Plugin.js';
import { createSuccessResult, createErrorResult } from '@grafema/types';
import type { PluginMetadata, PluginContext, PluginResult } from '@grafema/types';
import type { BaseNodeRecord } from '@grafema/types';

interface MountNode {
  id: string;
  type: string;
  mountPath?: string;
  prefix?: string;  // Alternative field used by express:mount
  name?: string;    // The imported router variable name
  file?: string;
  [key: string]: unknown;
}

interface RouteNode {
  id: string;
  type: string;
  path?: string;
  fullPath?: string;
  localPath?: string;
  mountPrefix?: string;
  mountPrefixes?: string[];
  fullPaths?: string[];
  file?: string;
  routerName?: string;
  [key: string]: unknown;
}

export class MountPointResolver extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'MountPointResolver',
      phase: 'ENRICHMENT',
      priority: 90,  // High priority - one of first enrichment plugins
      creates: {
        nodes: [],  // Updates existing nodes
        edges: []   // Doesn't create edges
      },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer', 'ExpressRouteAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    try {
      const { graph } = context;
      const logger = this.log(context);

      let routesUpdated = 0;
      let mountPointsProcessed = 0;

      // Step 1: Find all mount points (express:middleware with mountPath)
      const mountNodes: MountNode[] = [];
      for await (const node of graph.queryNodes({ type: 'express:middleware' })) {
        const mount = node as MountNode;
        // Only include mounts with a meaningful path (not global middleware)
        if (mount.mountPath && mount.mountPath !== '/' && mount.name) {
          mountNodes.push(mount);
        }
      }

      // Also check for express:mount (from ExpressAnalyzer, if enabled)
      for await (const node of graph.queryNodes({ type: 'express:mount' })) {
        const mount = node as MountNode;
        if (mount.mountPath || (mount as { prefix?: string }).prefix) {
          // express:mount uses 'prefix' field
          const prefix = mount.mountPath || (mount as { prefix?: string }).prefix;
          if (prefix && prefix !== '/') {
            mountNodes.push({
              ...mount,
              mountPath: prefix
            });
          }
        }
      }

      logger.info('Found mount points', { count: mountNodes.length });

      // Debug: log mount point details
      for (const mount of mountNodes) {
        logger.debug('Mount point details', {
          id: mount.id,
          mountPath: mount.mountPath,
          name: mount.name,
          file: mount.file
        });
      }

      if (mountNodes.length === 0) {
        return createSuccessResult(
          { nodes: 0, edges: 0 },
          { routesUpdated: 0, mountPointsProcessed: 0 }
        );
      }

      // Step 2: Build module import relationships using DEPENDS_ON edges
      // JSModuleIndexer creates DEPENDS_ON edges between MODULE nodes
      // Map<sourceModuleFile, Set<importedModuleFile>>
      const moduleImports = new Map<string, Set<string>>();

      // First, build MODULE file lookup
      const moduleFiles = new Map<string, string>(); // moduleId -> file
      for await (const node of graph.queryNodes({ type: 'MODULE' })) {
        const mod = node as { id: string; file?: string };
        if (mod.file) {
          moduleFiles.set(mod.id, mod.file);
        }
      }

      logger.debug('MODULE nodes indexed', { count: moduleFiles.size });

      // Then, get all DEPENDS_ON edges to build the relationship
      if (graph.getAllEdges) {
        const edges = await graph.getAllEdges();
        for (const edge of edges) {
          if (edge.type === 'DEPENDS_ON') {
            const srcFile = moduleFiles.get(edge.src);
            const dstFile = moduleFiles.get(edge.dst);
            if (srcFile && dstFile) {
              if (!moduleImports.has(srcFile)) {
                moduleImports.set(srcFile, new Set());
              }
              moduleImports.get(srcFile)!.add(dstFile);
              logger.debug('Found module dependency', { from: srcFile, to: dstFile });
            }
          }
        }
      }
      logger.debug('Module imports built', { files: moduleImports.size });

      // Step 3: Collect all routes by file
      const routesByFile = new Map<string, RouteNode[]>();
      for await (const node of graph.queryNodes({ type: 'http:route' })) {
        const route = node as RouteNode;
        if (route.file) {
          if (!routesByFile.has(route.file)) {
            routesByFile.set(route.file, []);
          }
          routesByFile.get(route.file)!.push(route);
        }
      }

      // Step 4: For each mount point, find and update routes
      for (const mount of mountNodes) {
        if (!mount.file || !mount.mountPath) continue;

        // Get all modules imported by this file
        const importedFiles = moduleImports.get(mount.file);
        if (!importedFiles || importedFiles.size === 0) {
          logger.debug('No imports found for mount', { file: mount.file, name: mount.name });
          continue;
        }

        // For each imported module, check if it has routes
        for (const importedFile of importedFiles) {
          const routes = routesByFile.get(importedFile);
          if (!routes || routes.length === 0) continue;

          logger.debug('Found routes in imported module', {
            mountFile: mount.file,
            importedFile,
            routeCount: routes.length
          });

          // Update routes with fullPath
          for (const route of routes) {
            const localPath = route.localPath || route.path || '';
            const fullPath = mount.mountPath + localPath;

            // Support multiple mount points
            const mountPrefixes = route.mountPrefixes || [];
            const fullPaths = route.fullPaths || [];

            if (!mountPrefixes.includes(mount.mountPath)) {
              mountPrefixes.push(mount.mountPath);
              fullPaths.push(fullPath);
            }

            // Update route node
            const updatedRoute: RouteNode = {
              ...route,
              mountPrefixes,
              fullPaths,
              mountPrefix: route.mountPrefix || mount.mountPath,
              fullPath: route.fullPath || fullPath
            };

            await graph.addNode(updatedRoute as BaseNodeRecord);
            routesUpdated++;
          }

          mountPointsProcessed++;
        }
      }

      logger.info('Updated routes with mount prefixes', {
        routes: routesUpdated,
        mountPoints: mountPointsProcessed
      });

      return createSuccessResult(
        { nodes: 0, edges: 0 },
        { routesUpdated, mountPointsProcessed }
      );

    } catch (error) {
      const logger = this.log(context);
      logger.error('Error in MountPointResolver', { error });
      return createErrorResult(error as Error);
    }
  }
}
