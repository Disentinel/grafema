/**
 * WorkspaceDiscovery - Discovery plugin for npm/pnpm/yarn/lerna workspaces
 *
 * Detects workspace configuration and creates SERVICE nodes for each package.
 * Priority: 110 (higher than MonorepoServiceDiscovery at 100)
 *
 * Supports:
 * - pnpm-workspace.yaml
 * - package.json workspaces (npm/yarn)
 * - lerna.json
 */

import { DiscoveryPlugin } from './DiscoveryPlugin.js';
import { createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import { detectWorkspaceType } from './workspaces/detector.js';
import { parsePnpmWorkspace, parseNpmWorkspace, parseLernaConfig } from './workspaces/parsers.js';
import { resolveWorkspacePackages, type WorkspacePackage } from './workspaces/globResolver.js';
import { NodeFactory } from '../../core/NodeFactory.js';
import { resolveSourceEntrypoint } from './resolveSourceEntrypoint.js';

/**
 * Service info returned in result metadata
 */
interface ServiceInfo {
  id: string;
  name: string;
  path: string;
  type: string;
  metadata: {
    workspaceType: string;
    relativePath: string;
    entrypoint: string | null;
    packageJson: Record<string, unknown>;
  };
}

export class WorkspaceDiscovery extends DiscoveryPlugin {
  get metadata(): PluginMetadata {
    return {
      name: 'WorkspaceDiscovery',
      phase: 'DISCOVERY',
      priority: 110, // Higher than MonorepoServiceDiscovery (100)
      creates: {
        nodes: ['SERVICE'],
        edges: []
      },
      dependencies: []
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);
    const { projectPath, graph } = context;

    // Validate projectPath
    if (!projectPath) {
      return createErrorResult(new Error('projectPath is required'));
    }

    logger.debug('Detecting workspace type', { projectPath });

    // Step 1: Detect workspace type
    const detection = detectWorkspaceType(projectPath);

    if (!detection.type) {
      logger.debug('Not a workspace project, skipping');
      return createSuccessResult({ nodes: 0, edges: 0 }, {
        services: [],
        skipped: true,
        reason: 'No workspace configuration found'
      });
    }

    logger.info('Workspace detected', {
      type: detection.type,
      configPath: detection.configPath
    });

    // Step 2: Parse workspace configuration
    let config;
    try {
      switch (detection.type) {
        case 'pnpm':
          config = parsePnpmWorkspace(detection.configPath!);
          break;
        case 'npm':
        case 'yarn':
          config = parseNpmWorkspace(detection.configPath!);
          break;
        case 'lerna':
          config = parseLernaConfig(detection.configPath!);
          break;
        default:
          throw new Error(`Unknown workspace type: ${detection.type}`);
      }
    } catch (error) {
      return createErrorResult(error as Error);
    }

    logger.debug('Workspace config parsed', {
      patterns: config.patterns,
      negativePatterns: config.negativePatterns
    });

    // Step 3: Resolve patterns to packages
    const packages = resolveWorkspacePackages(projectPath, config);

    logger.info('Workspace packages resolved', { count: packages.length });

    // Step 4: Create SERVICE nodes
    const services: ServiceInfo[] = [];

    for (const pkg of packages) {
      const serviceNode = this.createServiceNode(pkg, detection.type!, projectPath);

      await graph.addNode(serviceNode);

      services.push({
        id: serviceNode.id,
        name: pkg.name,
        path: pkg.path,
        type: 'workspace-package',
        metadata: {
          workspaceType: detection.type!,
          relativePath: pkg.relativePath,
          entrypoint: serviceNode.entrypoint,
          packageJson: pkg.packageJson as Record<string, unknown>
        }
      });
    }

    logger.info('Services created from workspace', {
      count: services.length,
      workspaceType: detection.type
    });

    return createSuccessResult(
      { nodes: services.length, edges: 0 },
      { services, workspaceType: detection.type }
    );
  }

  /**
   * Create SERVICE node from workspace package.
   */
  private createServiceNode(pkg: WorkspacePackage, workspaceType: string, _projectPath: string) {
    // Resolve entrypoint (prefer TypeScript source)
    const entrypoint = resolveSourceEntrypoint(pkg.path, pkg.packageJson)
      ?? (pkg.packageJson.main as string | undefined)
      ?? null;

    const serviceNode = NodeFactory.createService(pkg.name, pkg.path, {
      discoveryMethod: 'workspace',
      entrypoint: entrypoint ?? undefined,
      version: pkg.packageJson.version as string | undefined,
      description: pkg.packageJson.description as string | undefined,
      dependencies: Object.keys(pkg.packageJson.dependencies || {})
    });

    // Add metadata for workspace-specific information
    // BaseNodeRecord supports optional metadata field
    const nodeWithMetadata = serviceNode as typeof serviceNode & { metadata: Record<string, unknown> };
    nodeWithMetadata.metadata = {
      workspaceType,
      discoveryMethod: 'workspace',
      relativePath: pkg.relativePath,
      version: pkg.packageJson.version as string | undefined,
      description: pkg.packageJson.description as string | undefined,
      private: pkg.packageJson.private as boolean | undefined,
      dependencies: Object.keys(pkg.packageJson.dependencies || {}),
      entrypoint: entrypoint
    };

    return nodeWithMetadata;
  }
}
