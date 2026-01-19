/**
 * SimpleServiceDiscovery - плагин discovery для тестов
 *
 * Находит сервис по package.json в корне проекта и создаёт SERVICE ноду.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export class SimpleServiceDiscovery {
  constructor(config = {}) {
    this.config = config;
  }

  get metadata() {
    return {
      name: 'SimpleServiceDiscovery',
      phase: 'DISCOVERY',
      priority: 100,
      creates: {
        nodes: ['SERVICE'],
        edges: []
      },
      dependencies: []
    };
  }

  async execute(context) {
    const { projectPath, graph } = context;
    const packageJsonPath = join(projectPath, 'package.json');

    if (!existsSync(packageJsonPath)) {
      return {
        success: false,
        error: new Error(`package.json not found: ${packageJsonPath}`)
      };
    }

    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const serviceName = packageJson.name || 'unnamed-service';
      const entrypoint = packageJson.main || 'index.js';

      const serviceId = `SERVICE:${serviceName}`;
      const serviceNode = {
        id: serviceId,
        type: 'SERVICE',
        kind: 'SERVICE',
        name: serviceName,
        file: projectPath,
        filePath: projectPath,
        metadata: {
          discoveryMethod: 'simple',
          entrypoint,
          version: packageJson.version
        }
      };

      await graph.addNode(serviceNode);

      const service = {
        id: serviceId,
        name: serviceName,
        path: join(projectPath, entrypoint),  // path to entrypoint file
        type: 'simple-service',
        metadata: {
          entrypoint: join(projectPath, entrypoint),
          packageJson
        }
      };

      return {
        success: true,
        stats: { nodes: 1, edges: 0 },
        metadata: { services: [service] }
      };
    } catch (error) {
      return {
        success: false,
        error
      };
    }
  }
}
