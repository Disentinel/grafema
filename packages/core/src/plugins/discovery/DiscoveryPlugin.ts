/**
 * Базовый класс для плагинов DISCOVERY фазы
 *
 * DISCOVERY фаза отвечает за:
 * 1. Поиск сервисов/компонентов в проекте
 * 2. Создание SERVICE нод
 * 3. Возврат манифеста для последующих фаз
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
   * result.metadata.services - массив найденных сервисов
   * [
   *   {
   *     id: string,
   *     name: string,
   *     path: string,
   *     type: string,
   *     metadata: Object
   *   }
   * ]
   */
  abstract execute(context: PluginContext): Promise<PluginResult>;
}
