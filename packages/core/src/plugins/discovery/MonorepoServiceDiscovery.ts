/**
 * MonorepoServiceDiscovery - плагин для поиска сервисов в монорепозитории
 *
 * Стратегия discovery:
 * 1. Ищет директорию pkg/ в корне проекта
 * 2. Каждая поддиректория в pkg/ считается сервисом
 * 3. Создаёт SERVICE ноды для каждого найденного сервиса
 */

import { DiscoveryPlugin } from './DiscoveryPlugin.js';
import { createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import { NodeFactory } from '../../core/NodeFactory.js';
import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Service info returned in metadata
 */
interface ServiceInfo {
  id: string;
  name: string;
  path: string;
  type: string;
}

/**
 * Configuration options
 */
interface MonorepoConfig extends Record<string, unknown> {
  servicesDir?: string;
  excludeDirs?: string[];
}

export class MonorepoServiceDiscovery extends DiscoveryPlugin {
  private servicesDir: string;
  private excludeDirs: string[];

  constructor(config: MonorepoConfig = {}) {
    super(config);
    // Настройки по умолчанию
    this.servicesDir = config.servicesDir || 'pkg';
    this.excludeDirs = config.excludeDirs || ['.git', 'node_modules', 'build', 'dist'];
  }

  get metadata(): PluginMetadata {
    return {
      name: 'MonorepoServiceDiscovery',
      phase: 'DISCOVERY',
      creates: {
        nodes: ['SERVICE'],
        edges: []
      },
      dependencies: []
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);
    const { projectPath } = context;
    const factory = this.getFactory(context);
    const servicesPath = join(projectPath!, this.servicesDir);

    logger.debug('Looking for services', { servicesPath });

    if (!existsSync(servicesPath)) {
      return createErrorResult(
        new Error(`Services directory not found: ${servicesPath}`)
      );
    }

    try {
      const services: ServiceInfo[] = [];
      const entries = readdirSync(servicesPath);
      logger.debug('Found entries', { count: entries.length });

      for (const entry of entries) {
        const fullPath = join(servicesPath, entry);
        const stat = statSync(fullPath);

        // Пропускаем файлы и исключённые директории
        if (!stat.isDirectory() || this.excludeDirs.includes(entry)) {
          continue;
        }

        // Создаём SERVICE ноду via NodeFactory for proper branding
        const serviceNode = NodeFactory.createService(entry, fullPath, {
          discoveryMethod: 'monorepo',
        });
        const serviceId = serviceNode.id;

        await factory!.store(serviceNode);

        services.push({
          id: serviceId,
          name: entry,
          path: fullPath,
          type: 'monorepo-service'
        });
      }

      return createSuccessResult(
        { nodes: services.length, edges: 0 },
        { services }
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return createErrorResult(err);
    }
  }
}
