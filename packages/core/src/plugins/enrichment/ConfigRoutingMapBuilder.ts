/**
 * ConfigRoutingMapBuilder -- reads routing rules from config and writes
 * them to the RoutingMap Resource (REG-256).
 *
 * This is the first RoutingMapBuilder. Future builders will read from
 * nginx.conf, k8s manifests, etc. All write to the same RoutingMap.
 *
 * Phase: ENRICHMENT (early, before ServiceConnectionEnricher)
 * Dependencies: none (reads from config, not from graph)
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { RoutingRule, OrchestratorConfig } from '@grafema/types';
import { ROUTING_MAP_RESOURCE_ID } from '@grafema/types';
import { createRoutingMap } from '../../resources/RoutingMapImpl.js';

export class ConfigRoutingMapBuilder extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ConfigRoutingMapBuilder',
      phase: 'ENRICHMENT',
      creates: { nodes: [], edges: [] },
      dependencies: [],
      consumes: [],
      produces: [],
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { onProgress } = context;
    const logger = this.log(context);

    // Read routing rules from config
    const config = context.config as OrchestratorConfig & { routing?: RoutingRule[] };
    const routing = config?.routing;

    if (!routing || routing.length === 0) {
      logger.debug('No routing rules in config');
      return createSuccessResult({ nodes: 0, edges: 0 }, { rulesLoaded: 0 });
    }

    // Get ResourceRegistry
    const resources = context.resources;
    if (!resources) {
      logger.warn('ResourceRegistry not available -- skipping routing rules');
      return createSuccessResult({ nodes: 0, edges: 0 }, { rulesLoaded: 0 });
    }

    // Get or create RoutingMap Resource
    const routingMap = resources.getOrCreate(ROUTING_MAP_RESOURCE_ID, createRoutingMap);

    // Add rules with source attribution
    const rulesWithSource: RoutingRule[] = routing.map(rule => ({
      ...rule,
      source: rule.source ?? 'config',
    }));

    routingMap.addRules(rulesWithSource);

    if (onProgress) {
      onProgress({
        phase: 'enrichment',
        currentPlugin: 'ConfigRoutingMapBuilder',
        message: `Loaded ${routing.length} routing rules from config`,
        totalFiles: routing.length,
        processedFiles: routing.length,
      });
    }

    logger.info('Loaded routing rules from config', {
      count: routing.length,
      pairs: [...new Set(routing.map(r => `${r.from} -> ${r.to}`))],
    });

    return createSuccessResult({ nodes: 0, edges: 0 }, { rulesLoaded: routing.length });
  }
}
