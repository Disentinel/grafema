/**
 * ServiceDetector - обнаруживает сервисы в монорепозитории
 *
 * Паттерны детекции:
 * 1. Директории с package.json в apps/, packages/, services/
 * 2. Директории с Dockerfile
 * 3. Директории с server.js/index.js entry points
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import type { NodeRecord } from '@grafema/types';

/**
 * Context for ServiceDetector
 */
interface DetectorContext {
  projectPath: string;
  graph: {
    addNode(node: NodeRecord): Promise<void>;
  };
  logger?: {
    info(message: string, data?: Record<string, unknown>): void;
    debug(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
  };
}

/**
 * Package.json structure (relevant fields)
 */
interface PackageJson {
  name?: string;
  main?: string;
  [key: string]: unknown;
}

/**
 * Service info
 */
interface ServiceInfo {
  id: string;
  name: string;
  path: string;
  packageJson: PackageJson | null;
  entryPoint: string | null;
  hasDockerfile: boolean;
}

export class ServiceDetector {
  name: string;
  phase: string;
  priority: number;

  constructor() {
    this.name = 'ServiceDetector';
    this.phase = 'INDEXING';
    this.priority = 90; // Запускается перед JSModuleIndexer
  }

  /**
   * Анализирует проект и создаёт SERVICE ноды
   */
  async analyze(context: DetectorContext): Promise<DetectorContext> {
    const { projectPath, graph, logger } = context;
    const services: ServiceInfo[] = [];

    logger?.info('Detecting services', { projectPath });

    // Паттерн 1: Монорепо структура (apps/, packages/, services/)
    const monorepoPatterns = ['apps', 'packages', 'services'];

    for (const pattern of monorepoPatterns) {
      const monorepoDir = join(projectPath, pattern);

      if (existsSync(monorepoDir)) {
        const detected = this.detectServicesInDir(monorepoDir, projectPath, logger);
        services.push(...detected);
      }
    }

    // Паттерн 2: Корневой проект (если нет монорепо)
    if (services.length === 0) {
      const rootService = this.detectRootService(projectPath, logger);
      if (rootService) {
        services.push(rootService);
      }
    }

    // Создаём SERVICE ноды в графе
    for (const service of services) {
      await graph.addNode({
        id: service.id,
        type: 'SERVICE',
        name: service.name,
        file: service.path,
        metadata: {
          packageJson: service.packageJson,
          entryPoint: service.entryPoint,
          hasDockerfile: service.hasDockerfile
        }
      } as unknown as NodeRecord);
    }

    logger?.info('Services detected', { count: services.length });
    services.forEach(s => logger?.debug('Service found', { name: s.name, path: s.path }));

    return context;
  }

  /**
   * Обнаруживает сервисы в директории монорепо
   */
  private detectServicesInDir(dir: string, projectPath: string, logger?: DetectorContext['logger']): ServiceInfo[] {
    const services: ServiceInfo[] = [];

    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        const fullPath = join(dir, entry);

        // Пропускаем файлы и скрытые директории
        if (!statSync(fullPath).isDirectory() || entry.startsWith('.')) {
          continue;
        }

        // Проверяем признаки сервиса
        const packageJsonPath = join(fullPath, 'package.json');
        const hasPackageJson = existsSync(packageJsonPath);

        if (hasPackageJson) {
          const service = this.createServiceFromDir(fullPath, entry, projectPath, logger);
          if (service) {
            services.push(service);
          }
        }
      }
    } catch (error) {
      logger?.warn('Error scanning directory', { dir, error: (error as Error).message });
    }

    return services;
  }

  /**
   * Обнаруживает корневой сервис (не монорепо)
   */
  private detectRootService(projectPath: string, logger?: DetectorContext['logger']): ServiceInfo | null {
    const packageJsonPath = join(projectPath, 'package.json');

    if (!existsSync(packageJsonPath)) {
      return null;
    }

    const projectName = basename(projectPath);
    return this.createServiceFromDir(projectPath, projectName, projectPath, logger);
  }

  /**
   * Создаёт объект сервиса из директории
   */
  private createServiceFromDir(
    servicePath: string,
    serviceName: string,
    projectPath: string,
    logger?: DetectorContext['logger']
  ): ServiceInfo | null {
    try {
      const packageJsonPath = join(servicePath, 'package.json');
      let packageJson: PackageJson | null = null;

      if (existsSync(packageJsonPath)) {
        const content = readFileSync(packageJsonPath, 'utf-8');
        packageJson = JSON.parse(content) as PackageJson;
      }

      // Определяем entry point
      const entryPoint = this.findEntryPoint(servicePath, packageJson);

      // Проверяем наличие Dockerfile
      const hasDockerfile = existsSync(join(servicePath, 'Dockerfile')) ||
                            existsSync(join(servicePath, 'dockerfile'));

      // Генерируем ID сервиса
      const relativePath = servicePath.replace(projectPath, '').replace(/^\//, '');
      const serviceId = `SERVICE:${relativePath || serviceName}`;

      return {
        id: serviceId,
        name: packageJson?.name || serviceName,
        path: servicePath,
        packageJson,
        entryPoint,
        hasDockerfile
      };
    } catch (error) {
      logger?.warn('Error creating service', { servicePath, error: (error as Error).message });
      return null;
    }
  }

  /**
   * Находит entry point сервиса
   */
  private findEntryPoint(servicePath: string, packageJson: PackageJson | null): string | null {
    // 1. Из package.json main
    if (packageJson?.main) {
      return packageJson.main;
    }

    // 2. Стандартные entry points
    const candidates = [
      'src/index.js',
      'src/index.ts',
      'src/server.js',
      'src/server.ts',
      'src/main.js',
      'src/main.ts',
      'index.js',
      'index.ts',
      'server.js',
      'server.ts',
      'app.js',
      'app.ts'
    ];

    for (const candidate of candidates) {
      if (existsSync(join(servicePath, candidate))) {
        return candidate;
      }
    }

    return null;
  }
}
