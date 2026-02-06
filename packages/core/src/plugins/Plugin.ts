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
  Logger,
} from '@grafema/types';
import type { NodeRecord, AnyBrandedNode } from '@grafema/types';

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
   *
   * Returns branded nodes since they come from the database.
   */
  async getModules(graph: PluginContext['graph']): Promise<AnyBrandedNode[]> {
    const modules: AnyBrandedNode[] = [];
    const filter: NodeFilter = { type: 'MODULE' };
    for await (const node of graph.queryNodes(filter)) {
      modules.push(node);
    }
    return modules;
  }

  /**
   * Get a logger from context with console fallback for backward compatibility.
   */
  protected log(context: PluginContext): Logger {
    if (context.logger) {
      return context.logger;
    }

    // Fallback to console for backward compatibility
    const safeStringify = (obj: Record<string, unknown>): string => {
      try {
        const seen = new WeakSet();
        return JSON.stringify(obj, (_key, value) => {
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[Circular]';
            seen.add(value);
          }
          return value;
        });
      } catch {
        return '[serialization failed]';
      }
    };

    const format = (msg: string, ctx?: Record<string, unknown>) =>
      ctx ? `${msg} ${safeStringify(ctx)}` : msg;

    return {
      error: (msg: string, ctx?: Record<string, unknown>) =>
        console.error(`[ERROR] ${format(msg, ctx)}`),
      warn: (msg: string, ctx?: Record<string, unknown>) =>
        console.warn(`[WARN] ${format(msg, ctx)}`),
      info: (msg: string, ctx?: Record<string, unknown>) =>
        console.log(`[INFO] ${format(msg, ctx)}`),
      debug: (msg: string, ctx?: Record<string, unknown>) =>
        console.debug(`[DEBUG] ${format(msg, ctx)}`),
      trace: (msg: string, ctx?: Record<string, unknown>) =>
        console.debug(`[TRACE] ${format(msg, ctx)}`),
    };
  }
}
