/**
 * SimpleProjectDiscovery - универсальный discovery плагин
 *
 * Находит сервис по package.json в корне проекта.
 * Работает для любого JS/TS проекта.
 * Используется как дефолтный discovery когда нет специфичных плагинов.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { NodeFactory } from '../../core/NodeFactory.js';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import { resolveSourceEntrypoint } from './resolveSourceEntrypoint.js';

/**
 * Service info returned in metadata
 */
interface ServiceInfo {
  id: string;
  name: string;
  path: string;
  type: string;
  metadata: {
    entrypoint: string;
    packageJson: PackageJson;
  };
}

/**
 * Package.json structure (relevant fields)
 */
interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  source?: string;
  description?: string;
  dependencies?: Record<string, string>;
}

export class SimpleProjectDiscovery extends Plugin {

  get metadata(): PluginMetadata {
    return {
      name: 'SimpleProjectDiscovery',
      phase: 'DISCOVERY',
      priority: 50, // Lower priority than specialized discovery plugins
      creates: {
        nodes: ['SERVICE'],
        edges: []
      },
      dependencies: []
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    // projectPath can be at top level (DISCOVERY phase) or in manifest/config
    const projectPath = context.projectPath || (context.manifest as { projectPath?: string })?.projectPath || context.config?.projectPath;

    if (!projectPath) {
      return createErrorResult(new Error('projectPath not found in context'));
    }

    const packageJsonPath = join(projectPath, 'package.json');

    if (!existsSync(packageJsonPath)) {
      return createErrorResult(new Error(`package.json not found: ${packageJsonPath}`));
    }

    try {
      const packageJson: PackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const serviceName = packageJson.name || 'unnamed-service';
      // Prefer TypeScript source over compiled output
      const entrypoint = resolveSourceEntrypoint(projectPath, packageJson)
        ?? packageJson.main
        ?? 'index.js';

      // Используем NodeFactory для создания SERVICE ноды
      const serviceNode = NodeFactory.createService(serviceName, projectPath, {
        discoveryMethod: 'simple',
        entrypoint,
        version: packageJson.version,
        description: packageJson.description,
        dependencies: Object.keys(packageJson.dependencies || {})
      });

      await graph.addNode(serviceNode);

      const service: ServiceInfo = {
        id: serviceNode.id,
        name: serviceName,
        path: join(projectPath, entrypoint),
        type: 'simple-project',
        metadata: {
          entrypoint: join(projectPath, entrypoint),
          packageJson
        }
      };

      return createSuccessResult({ nodes: 1, edges: 0 }, { services: [service] });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return createErrorResult(err);
    }
  }
}
