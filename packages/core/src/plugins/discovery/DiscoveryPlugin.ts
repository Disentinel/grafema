/**
 * Базовый класс для плагинов DISCOVERY фазы
 *
 * DISCOVERY фаза отвечает за:
 * 1. Поиск сервисов/компонентов в проекте
 * 2. Создание SERVICE нод
 * 3. Возврат манифеста для последующих фаз
 *
 * IMPORTANT CONTRACT:
 * Discovery plugins MUST return found services via `result.metadata.services`
 * (not `result.data.services` which doesn't exist in PluginResult interface).
 *
 * Example:
 * ```typescript
 * return createSuccessResult(
 *   { nodes: services.length, edges: 0 },
 *   { services: foundServices }  // <-- This becomes result.metadata.services
 * );
 * ```
 *
 * The Orchestrator reads services from result.metadata.services to build
 * the indexing queue. If services are not returned here, they won't be indexed
 * even if SERVICE nodes were created in the graph.
 */

import { Plugin } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';

export abstract class DiscoveryPlugin extends Plugin {
  constructor(config: Record<string, unknown> = {}) {
    super(config);
  }

  get metadata(): PluginMetadata {
    return {
      name: this.constructor.name,
      phase: 'DISCOVERY',
      priority: 100,
      creates: {
        nodes: ['SERVICE'],
        edges: []
      },
      dependencies: []
    };
  }

  /**
   * Выполнить discovery
   *
   * @param context - PluginContext
   * context.projectPath - корневая директория проекта
   *
   * @returns Promise<PluginResult>
   *
   * CRITICAL: Services MUST be returned via result.metadata.services:
   *
   * ```typescript
   * return createSuccessResult(
   *   { nodes: services.length, edges: 0 },
   *   { services: foundServices }  // <-- metadata.services
   * );
   * ```
   *
   * ServiceInfo interface:
   * ```typescript
   * interface ServiceInfo {
   *   id: string;        // Unique service identifier
   *   name: string;      // Human-readable name
   *   path: string;      // Directory path
   *   type: string;      // Service type (e.g., 'express', 'fastify')
   *   metadata: {
   *     entrypoint?: string;  // Main file path (e.g., 'src/index.ts')
   *     // ... other service-specific metadata
   *   };
   * }
   * ```
   *
   * If services are created in graph but NOT returned via metadata.services,
   * Orchestrator will show "0 services" and won't index anything.
   */
  abstract execute(context: PluginContext): Promise<PluginResult>;
}
