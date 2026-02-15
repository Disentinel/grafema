/**
 * GraphInitializer — sets up the graph structure before analysis.
 * Extracted from Orchestrator.ts (REG-462).
 *
 * Responsibilities:
 * - Create GRAPH_META node with project metadata
 * - Register plugin nodes (grafema:plugin) with dependency edges
 * - Declare metadata fields for RFDB server-side indexing
 */

import type { Plugin } from './plugins/Plugin.js';
import type { GraphBackend, Logger, FieldDeclaration, NodeRecord } from '@grafema/types';
import { NodeFactory } from './core/NodeFactory.js';
import { brandNodeInternal } from './core/brandNodeInternal.js';

export class GraphInitializer {
  constructor(
    private graph: GraphBackend,
    private plugins: Plugin[],
    private logger: Logger,
  ) {}

  /**
   * Initialize graph: register plugins, declare fields, create meta node.
   * Called once at the start of analysis (before any phase).
   */
  async init(projectPath: string): Promise<void> {
    await this.registerPluginNodes();
    await this.declarePluginFields();
    await this.createGraphMetaNode(projectPath);
  }

  /**
   * Create GRAPH_META node with project metadata.
   * Called once at the start of analysis (single-root or multi-root).
   */
  private async createGraphMetaNode(projectPath: string): Promise<void> {
    await this.graph.addNode(brandNodeInternal({
      id: '__graph_meta__',
      type: 'GRAPH_META' as NodeRecord['type'],
      name: 'graph_metadata',
      file: '',
      projectPath: projectPath,
      analyzedAt: new Date().toISOString()
    }));
  }

  /**
   * Register all loaded plugins as grafema:plugin nodes in the graph.
   *
   * Creates a node for each plugin with its metadata (phase, priority,
   * creates, dependencies). Also creates DEPENDS_ON edges between
   * plugins that declare dependencies.
   *
   * Complexity: O(p) where p = number of plugins (typically 20-35).
   */
  private async registerPluginNodes(): Promise<void> {
    const pluginNodes: Array<{ id: string; name: string; dependencies: string[] }> = [];

    for (const plugin of this.plugins) {
      const meta = plugin.metadata;
      if (!meta?.name) continue;

      const sourceFile = (plugin.config?.sourceFile as string) || '';
      const isBuiltin = !sourceFile;

      const node = NodeFactory.createPlugin(meta.name, meta.phase, {
        file: sourceFile,
        builtin: isBuiltin,
        createsNodes: (meta.creates?.nodes as string[]) ?? [],
        createsEdges: (meta.creates?.edges as string[]) ?? [],
        dependencies: meta.dependencies ?? [],
      });

      await this.graph.addNode(node);
      pluginNodes.push({
        id: node.id,
        name: meta.name,
        dependencies: meta.dependencies ?? [],
      });
    }

    // Create DEPENDS_ON edges between plugins
    const nameToId = new Map<string, string>();
    for (const pn of pluginNodes) {
      nameToId.set(pn.name, pn.id);
    }

    for (const pn of pluginNodes) {
      for (const dep of pn.dependencies) {
        const depId = nameToId.get(dep);
        if (depId) {
          await this.graph.addEdge({
            src: pn.id,
            dst: depId,
            type: 'DEPENDS_ON',
          });
        }
      }
    }

    this.logger.debug('Registered plugin nodes', {
      count: pluginNodes.length,
      edges: pluginNodes.reduce((sum, pn) => sum + pn.dependencies.filter(d => nameToId.has(d)).length, 0),
    });
  }

  /**
   * Collect field declarations from all plugins and send to RFDB for indexing.
   * Deduplicates by field name (last declaration wins if nodeTypes differ).
   * Called once before analysis to enable server-side metadata indexing.
   */
  private async declarePluginFields(): Promise<void> {
    if (!this.graph.declareFields) return;

    const fieldMap = new Map<string, FieldDeclaration>();
    for (const plugin of this.plugins) {
      const fields = plugin.metadata?.fields;
      if (!fields) continue;
      for (const field of fields) {
        fieldMap.set(field.name, field);
      }
    }

    if (fieldMap.size === 0) return;

    const fields = [...fieldMap.values()];
    const count = await this.graph.declareFields(fields);
    this.logger.debug('Declared metadata fields for indexing', { fields: count });
  }
}
