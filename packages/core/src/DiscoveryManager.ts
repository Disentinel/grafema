/**
 * DiscoveryManager — handles service and entrypoint discovery.
 * Extracted from Orchestrator.ts (REG-462).
 *
 * Responsibilities:
 * - Run discovery plugins to find services/entrypoints
 * - Handle config-provided services (REG-174)
 * - Handle entrypoint override (bypass discovery)
 * - Build unified list of indexing units
 * - Topological sort of discovery plugins (REG-367)
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { resolveSourceEntrypoint } from './plugins/discovery/resolveSourceEntrypoint.js';
import type { Plugin, PluginContext } from './plugins/Plugin.js';
import type { GraphBackend, Logger, ServiceDefinition } from '@grafema/types';
import { NodeFactory } from './core/NodeFactory.js';
import { toposort } from './core/toposort.js';
import type { ProgressCallback } from './PhaseRunner.js';
import type {
  OrchestratorOptions,
  ServiceInfo,
  EntrypointInfo,
  DiscoveryManifest,
  IndexingUnit,
} from './OrchestratorTypes.js';

export class DiscoveryManager {
  constructor(
    private plugins: Plugin[],
    private graph: GraphBackend,
    private config: OrchestratorOptions,
    private logger: Logger,
    private onProgress: ProgressCallback,
    private configServices: ServiceDefinition[] | undefined,
  ) {}

  /**
   * Run discovery: entrypoint override → config services → plugin discovery.
   * Returns a DiscoveryManifest with discovered services and entrypoints.
   */
  async discover(projectPath: string, entrypoint?: string): Promise<DiscoveryManifest> {
    if (entrypoint) {
      return this.discoverFromEntrypoint(projectPath, entrypoint);
    }
    return this.discoverFromPluginsOrConfig(projectPath);
  }

  /**
   * Discover services in a specific root directory.
   * Used by multi-root workspace analysis (REG-76).
   */
  async discoverInRoot(rootPath: string): Promise<DiscoveryManifest> {
    return this.discoverFromPluginsOrConfig(rootPath);
  }

  /**
   * Build unified list of indexing units from services and entrypoints.
   * Deduplicates by path (services take priority over entrypoints).
   */
  buildIndexingUnits(manifest: DiscoveryManifest): IndexingUnit[] {
    const units: IndexingUnit[] = [];
    const seenPaths = new Set<string>();

    // 1. Add services first (they have priority)
    for (const service of manifest.services || []) {
      const path = service.path || service.metadata?.entrypoint;
      if (path && !seenPaths.has(path)) {
        seenPaths.add(path);
        units.push({
          ...service,  // Spread first to allow overrides
          id: service.id,
          name: service.name,
          path: path,
          type: 'service' as const,
        });
      }
    }

    // 2. Add entrypoints that aren't already covered by services
    for (const ep of manifest.entrypoints || []) {
      const path = ep.file;
      if (path && !seenPaths.has(path)) {
        seenPaths.add(path);
        units.push({
          ...ep,  // Spread first to allow overrides
          id: ep.id,
          name: ep.name || ep.file.split('/').pop()!,
          path: path,
          type: 'entrypoint' as const,
          entrypointType: ep.type,
          trigger: ep.trigger,
        });
      }
    }

    this.logger.debug('Built indexing units', {
      total: units.length,
      services: units.filter(u => u.type === 'service').length,
      entrypoints: units.filter(u => u.type === 'entrypoint').length
    });
    return units;
  }

  /**
   * Create synthetic manifest from entrypoint override (bypasses discovery).
   */
  private discoverFromEntrypoint(projectPath: string, entrypoint: string): DiscoveryManifest {
    const entrypointPath = entrypoint.startsWith('/')
      ? entrypoint
      : join(projectPath, entrypoint);
    const serviceName = entrypoint.split('/').pop()?.replace(/\.[^.]+$/, '') || 'main';
    const manifest: DiscoveryManifest = {
      services: [{
        id: `service:${serviceName}`,
        name: serviceName,
        path: entrypointPath,
        metadata: { entrypoint: entrypointPath }
      }],
      entrypoints: [],
      projectPath: projectPath
    };
    this.logger.info('Using entrypoint override', { entrypoint, resolved: entrypointPath });
    return manifest;
  }

  /**
   * Discovery via config services or plugins.
   * Config services (REG-174) take precedence if provided.
   */
  private async discoverFromPluginsOrConfig(projectPath: string): Promise<DiscoveryManifest> {
    if (this.configServices && this.configServices.length > 0) {
      return this.discoverFromConfig(projectPath);
    }
    return this.discoverFromPlugins(projectPath);
  }

  /**
   * Use config-provided services directly (REG-174).
   * Creates SERVICE nodes in graph and returns manifest.
   */
  private async discoverFromConfig(projectPath: string): Promise<DiscoveryManifest> {
    this.logger.info('Using config-provided services (skipping discovery plugins)', {
      serviceCount: this.configServices!.length
    });

    const services: ServiceInfo[] = [];
    for (const configSvc of this.configServices!) {
      const servicePath = join(projectPath, configSvc.path);

      // Resolve entrypoint
      let entrypoint: string;
      if (configSvc.entryPoint) {
        entrypoint = configSvc.entryPoint;
      } else {
        const packageJsonPath = join(servicePath, 'package.json');
        if (existsSync(packageJsonPath)) {
          try {
            const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
            entrypoint = resolveSourceEntrypoint(servicePath, pkg) ?? pkg.main ?? 'index.js';
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.logger.warn('Failed to read package.json for auto-detection', {
              service: configSvc.name,
              path: packageJsonPath,
              error: message
            });
            entrypoint = 'index.js';
          }
        } else {
          entrypoint = 'index.js';
        }
      }

      const serviceNode = NodeFactory.createService(configSvc.name, servicePath, {
        discoveryMethod: 'config',
        entrypoint: entrypoint,
      });
      await this.graph.addNode(serviceNode);

      services.push({
        id: serviceNode.id,
        name: configSvc.name,
        path: servicePath,
        metadata: {
          entrypoint: join(servicePath, entrypoint),
        },
      });

      this.logger.info('Registered config service', {
        name: configSvc.name,
        path: servicePath,
        entrypoint: entrypoint
      });
    }

    return {
      services,
      entrypoints: [],
      projectPath: projectPath
    };
  }

  /**
   * Run discovery plugins (original code path).
   * Plugins are topologically sorted by dependencies (REG-367).
   */
  private async discoverFromPlugins(projectPath: string): Promise<DiscoveryManifest> {
    const context = {
      projectPath,
      graph: this.graph,
      config: this.config,
      phase: 'DISCOVERY',
      logger: this.logger,
    };

    // Filter plugins for DISCOVERY phase
    const discoveryPlugins = this.plugins.filter(p => p.metadata.phase === 'DISCOVERY');

    // Topological sort by dependencies (REG-367)
    const discoveryPluginMap = new Map(discoveryPlugins.map(p => [p.metadata.name, p]));
    const sortedDiscoveryIds = toposort(
      discoveryPlugins.map(p => ({
        id: p.metadata.name,
        dependencies: p.metadata.dependencies ?? [],
      }))
    );
    discoveryPlugins.length = 0;
    for (const id of sortedDiscoveryIds) {
      const plugin = discoveryPluginMap.get(id);
      if (plugin) discoveryPlugins.push(plugin);
    }

    const allServices: ServiceInfo[] = [];
    const allEntrypoints: EntrypointInfo[] = [];

    for (let i = 0; i < discoveryPlugins.length; i++) {
      const plugin = discoveryPlugins[i];

      this.onProgress({
        phase: 'discovery',
        currentPlugin: plugin.metadata.name,
        message: `Running ${plugin.metadata.name}... (${i + 1}/${discoveryPlugins.length})`
      });

      const result = await plugin.execute(context as PluginContext);

      if (result.success && result.metadata?.services) {
        allServices.push(...(result.metadata.services as ServiceInfo[]));
      }

      if (result.success && result.metadata?.entrypoints) {
        allEntrypoints.push(...(result.metadata.entrypoints as EntrypointInfo[]));
      }

      if (result.success && result.created.nodes > 0 &&
          !result.metadata?.services && !result.metadata?.entrypoints) {
        this.logger.warn('Discovery plugin created nodes but returned no services/entrypoints in metadata', {
          plugin: plugin.metadata.name,
          nodesCreated: result.created.nodes,
          hint: 'Services must be returned via result.metadata.services for Orchestrator to index them'
        });
      }

      this.onProgress({
        phase: 'discovery',
        currentPlugin: plugin.metadata.name,
        message: `✓ ${plugin.metadata.name} complete`
      });
    }

    return {
      services: allServices,
      entrypoints: allEntrypoints,
      projectPath: projectPath
    };
  }
}
