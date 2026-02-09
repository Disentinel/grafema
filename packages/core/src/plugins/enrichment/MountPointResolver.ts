/**
 * MountPointResolver - ENRICHMENT plugin for resolving mount points
 *
 * REG-248 Fix: Now works with ExpressRouteAnalyzer's node types:
 * - express:middleware (with mountPath) instead of MOUNT_POINT
 * - http:route instead of ENDPOINT
 *
 * REG-318 Fix: Uses IMPORT nodes to determine which file a router variable
 * comes from, then applies mount prefix ONLY to routes in that specific file.
 *
 * Algorithm:
 * 1. Find express:middleware nodes with mountPath
 * 2. Build import map: for each mount file, map local variable names to resolved file paths
 * 3. For each mount, find the specific imported file matching mount.name
 * 4. Apply mount prefix only to routes in that specific file
 */

import { Plugin } from '../Plugin.js';
import { createSuccessResult, createErrorResult } from '@grafema/types';
import type { PluginMetadata, PluginContext, PluginResult } from '@grafema/types';
import type { BaseNodeRecord } from '@grafema/types';
import { isRelativeImport, resolveRelativeSpecifier } from '../../utils/moduleResolution.js';

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
      creates: {
        nodes: [],  // Updates existing nodes
        edges: []   // Doesn't create edges
      },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer', 'ExpressRouteAnalyzer']
    };
  }

  /**
   * Resolve relative import source to absolute file path.
   * Uses shared utility from moduleResolution.ts (REG-320).
   */
  private resolveImportSource(importSource: string, containingFile: string): string | null {
    // Only handle relative imports
    if (!isRelativeImport(importSource)) {
      return null;  // External package
    }

    return resolveRelativeSpecifier(importSource, containingFile, { useFilesystem: true });
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

      // Step 2: Build import map for files that contain mount points
      // Map<file, Map<localName, resolvedFile>>
      const importMaps = new Map<string, Map<string, string>>();
      const mountFiles = new Set(mountNodes.map(m => m.file).filter((f): f is string => Boolean(f)));

      for (const mountFile of mountFiles) {
        const importMap = new Map<string, string>();

        // Query IMPORT nodes in this file
        for await (const node of graph.queryNodes({ type: 'IMPORT' })) {
          const importNode = node as { file?: string; local?: string; source?: string };

          if (importNode.file !== mountFile) continue;
          if (!importNode.local || !importNode.source) continue;

          // Resolve source to absolute path
          const resolvedPath = this.resolveImportSource(importNode.source, mountFile);
          if (resolvedPath) {
            importMap.set(importNode.local, resolvedPath);
            logger.debug('Import mapped', {
              local: importNode.local,
              source: importNode.source,
              resolved: resolvedPath
            });
          }
        }

        importMaps.set(mountFile, importMap);
      }

      logger.debug('Import maps built', {
        files: importMaps.size,
        totalMappings: [...importMaps.values()].reduce((sum, m) => sum + m.size, 0)
      });

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
        if (!mount.file || !mount.mountPath || !mount.name) continue;

        // Get import map for this file
        const importMap = importMaps.get(mount.file);
        if (!importMap) {
          logger.debug('No import map for mount file', { file: mount.file });
          continue;
        }

        // Find the specific imported file for this mount variable
        const importedFile = importMap.get(mount.name);
        if (!importedFile) {
          logger.debug('No import found for mount name', {
            file: mount.file,
            mountName: mount.name,
            availableImports: [...importMap.keys()]
          });
          continue;
        }

        // Get routes in that specific file
        const routes = routesByFile.get(importedFile);
        if (!routes || routes.length === 0) {
          logger.debug('No routes in imported file', {
            importedFile,
            mountName: mount.name
          });
          continue;
        }

        logger.debug('Applying mount prefix', {
          mountPath: mount.mountPath,
          mountName: mount.name,
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
      const err = error instanceof Error ? error : new Error(String(error));
      return createErrorResult(err);
    }
  }
}
