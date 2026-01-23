/**
 * HTTPConnectionEnricher - связывает http:request (frontend) с http:route (backend)
 *
 * Создаёт INTERACTS_WITH edges между:
 * - Frontend fetch('/api/users') → Backend GET /api/users
 * - Frontend fetch('/api/users', {method: 'POST'}) → Backend POST /api/users
 *
 * Поддержка параметризованных путей:
 * - /api/graph/:serviceId матчится с /api/graph/my-service
 */

import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';

/**
 * HTTP route node
 */
interface HTTPRouteNode extends BaseNodeRecord {
  method?: string;
  path?: string;
  url?: string;
}

/**
 * HTTP request node
 */
interface HTTPRequestNode extends BaseNodeRecord {
  method?: string;
  url?: string;
}

/**
 * Connection info for logging
 */
interface ConnectionInfo {
  request: string;
  route: string;
  requestFile?: string;
  routeFile?: string;
}

export class HTTPConnectionEnricher extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'HTTPConnectionEnricher',
      phase: 'ENRICHMENT',
      priority: 50,  // После основных enrichers
      creates: {
        nodes: [],
        edges: ['INTERACTS_WITH']
      },
      dependencies: ['ExpressRouteAnalyzer', 'FetchAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);

    try {
      // Собираем все http:route (backend endpoints)
      const routes: HTTPRouteNode[] = [];
      for await (const node of graph.queryNodes({ type: 'http:route' })) {
        routes.push(node as HTTPRouteNode);
      }

      // Собираем все http:request (frontend requests)
      const requests: HTTPRequestNode[] = [];
      for await (const node of graph.queryNodes({ type: 'http:request' })) {
        requests.push(node as HTTPRequestNode);
      }

      logger.debug('Found routes and requests', {
        routes: routes.length,
        requests: requests.length
      });

      // Дедуплицируем по ID (из-за multi-service анализа)
      const uniqueRoutes = this.deduplicateById(routes);
      const uniqueRequests = this.deduplicateById(requests);

      logger.info('Unique routes and requests', {
        routes: uniqueRoutes.length,
        requests: uniqueRequests.length
      });

      let edgesCreated = 0;
      const connections: ConnectionInfo[] = [];

      // Для каждого request ищем matching route
      for (const request of uniqueRequests) {
        // Пропускаем dynamic URLs
        if (request.url === 'dynamic' || !request.url) {
          continue;
        }

        const method = (request.method || 'GET').toUpperCase();
        const url = request.url;

        // Ищем matching route
        for (const route of uniqueRoutes) {
          const routeMethod = (route.method || 'GET').toUpperCase();
          const routePath = route.path;

          if (routePath && method === routeMethod && this.pathsMatch(url, routePath)) {
            // Создаём edge
            await graph.addEdge({
              type: 'INTERACTS_WITH',
              src: request.id,
              dst: route.id,
              matchType: this.hasParams(routePath) ? 'parametric' : 'exact'
            });

            connections.push({
              request: `${method} ${url}`,
              route: `${routeMethod} ${routePath}`,
              requestFile: request.file,
              routeFile: route.file
            });

            edgesCreated++;
            break; // Один request → один route
          }
        }
      }

      // Логируем найденные связи
      if (connections.length > 0) {
        logger.info('Connections found', {
          count: connections.length,
          examples: connections.slice(0, 5).map(c => `${c.request} → ${c.route}`)
        });
      }

      return createSuccessResult(
        { nodes: 0, edges: edgesCreated },
        {
          connections: connections.length,
          routesAnalyzed: uniqueRoutes.length,
          requestsAnalyzed: uniqueRequests.length
        }
      );

    } catch (error) {
      logger.error('Error in HTTPConnectionEnricher', { error });
      return createErrorResult(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Проверяет совпадают ли пути
   * Поддерживает параметризованные пути: /api/users/:id матчится с /api/users/123
   */
  private pathsMatch(requestUrl: string, routePath: string): boolean {
    // Точное совпадение
    if (requestUrl === routePath) {
      return true;
    }

    // Если route не имеет параметров, требуем точное совпадение
    if (!this.hasParams(routePath)) {
      return false;
    }

    // Преобразуем route path в regex
    // /api/users/:id → /api/users/[^/]+
    const regexPattern = routePath
      .replace(/:[^/]+/g, '[^/]+')  // :param → [^/]+
      .replace(/\//g, '\\/');        // / → \/

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(requestUrl);
  }

  /**
   * Проверяет есть ли параметры в пути
   */
  private hasParams(path: string): boolean {
    return Boolean(path && path.includes(':'));
  }

  /**
   * Убирает дубликаты по ID
   */
  private deduplicateById<T extends BaseNodeRecord>(nodes: T[]): T[] {
    const seen = new Set<string>();
    const unique: T[] = [];

    for (const node of nodes) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        unique.push(node);
      }
    }

    return unique;
  }
}
