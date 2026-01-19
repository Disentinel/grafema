/**
 * Base Plugin class
 *
 * PLUGIN CONTRACT:
 *
 * 1. Metadata - plugin description
 * 2. Execute - plugin logic execution
 * 3. Return value - PluginResult
 */

import type {
  PluginMetadata,
  PluginContext,
  PluginResult,
  IPlugin,
  NodeFilter,
} from '@grafema/types';
import type { NodeRecord } from '@grafema/types';

// Re-export types for convenience
export type { PluginMetadata, PluginContext, PluginResult, IPlugin };

// Re-export helper functions from types/plugins.js
export { createSuccessResult, createErrorResult } from '@grafema/types';

/**
 * Base Plugin class - extend this for all plugins
 */
export abstract class Plugin implements IPlugin {
  config: Record<string, unknown>;

  constructor(config: Record<string, unknown> = {}) {
    this.config = config;
  }

  /**
   * Plugin metadata
   */
  abstract get metadata(): PluginMetadata;

  /**
   * Initialize plugin (optional)
   * Called once before first execute
   */
  async initialize(_context: PluginContext): Promise<void> {
    // Optionally override
  }

  /**
   * Execute plugin
   */
  abstract execute(context: PluginContext): Promise<PluginResult>;

  /**
   * Cleanup resources (optional)
   * Called after phase completion
   */
  async cleanup(): Promise<void> {
    // Optionally override
  }

  /**
   * Helper: Get all MODULE nodes from graph
   * Works with RFDBServerBackend
   */
  async getModules(graph: PluginContext['graph']): Promise<NodeRecord[]> {
    const modules: NodeRecord[] = [];
    const filter: NodeFilter = { type: 'MODULE' };
    for await (const node of graph.queryNodes(filter)) {
      modules.push(node);
    }
    return modules;
  }
}
