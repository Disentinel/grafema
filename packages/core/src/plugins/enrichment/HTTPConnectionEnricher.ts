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
import { StrictModeError, ValidationError } from '../../errors/GrafemaError.js';

/**
 * HTTP route node
 */
interface HTTPRouteNode extends BaseNodeRecord {
  method?: string;
  path?: string;
  fullPath?: string;  // Set by MountPointResolver for mounted routes
  url?: string;
}

/**
 * HTTP request node
 */
interface HTTPRequestNode extends BaseNodeRecord {
  method?: string;
  methodSource?: MethodSource;
  url?: string;
  responseDataNode?: string;  // ID of response.json() CALL node (set by FetchAnalyzer)
}

type MethodSource = 'explicit' | 'default' | 'unknown';

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
        edges: ['INTERACTS_WITH', 'HTTP_RECEIVES']
      },
      dependencies: ['ExpressRouteAnalyzer', 'FetchAnalyzer', 'ExpressResponseAnalyzer']
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
      const errors: Error[] = [];
      const connections: ConnectionInfo[] = [];

      // Для каждого request ищем matching route
      for (const request of uniqueRequests) {
        const methodSource = request.methodSource ?? 'explicit';
        const method = request.method ? request.method.toUpperCase() : null;
        const url = request.url;

        if (methodSource === 'unknown') {
          const urlLabel = url ?? 'unknown';
          const message = `Unknown HTTP method for request ${urlLabel}`;
          if (context.strictMode) {
            errors.push(new StrictModeError(
              message,
              'STRICT_UNKNOWN_HTTP_METHOD',
              {
                filePath: request.file,
                lineNumber: request.line as number | undefined,
                phase: 'ENRICHMENT',
                plugin: 'HTTPConnectionEnricher',
                requestId: request.id,
              },
              'Provide method as a string literal or resolvable const (e.g., method: \"POST\")'
            ));
          } else {
            errors.push(new ValidationError(
              message,
              'WARN_HTTP_METHOD_UNKNOWN',
              {
                filePath: request.file,
                lineNumber: request.line as number | undefined,
                phase: 'ENRICHMENT',
                plugin: 'HTTPConnectionEnricher',
                requestId: request.id,
              },
              'Provide method as a string literal or resolvable const (e.g., method: \"POST\")',
              'warning'
            ));
          }
          continue;
        }

        // Пропускаем dynamic URLs
        if (url === 'dynamic' || !url) {
          continue;
        }

        // Ищем matching route
        for (const route of uniqueRoutes) {
          const routeMethod = route.method ? route.method.toUpperCase() : null;
          // Use fullPath (from MountPointResolver) if available, fallback to local path
          const routePath = route.fullPath || route.path;

          if (!routeMethod) continue;
          if (methodSource === 'default' && routeMethod !== 'GET') continue;
          if (methodSource === 'explicit' && (!method || method !== routeMethod)) continue;

          if (routePath && this.pathsMatch(url, routePath)) {
            // 1. Create INTERACTS_WITH edge (existing)
            await graph.addEdge({
              type: 'INTERACTS_WITH',
              src: request.id,
              dst: route.id,
              matchType: this.hasParams(routePath) ? 'parametric' : 'exact'
            });

            edgesCreated++;

            // 2. Create HTTP_RECEIVES edges if both sides have data nodes
            const responseDataNode = request.responseDataNode;
            if (responseDataNode) {
              const respondsWithEdges = await graph.getOutgoingEdges(route.id, ['RESPONDS_WITH']);
              for (const respEdge of respondsWithEdges) {
                await graph.addEdge({
                  type: 'HTTP_RECEIVES',
                  src: responseDataNode,
                  dst: respEdge.dst,
                  metadata: {
                    method: request.method,
                    path: request.url,
                    viaRequest: request.id,
                    viaRoute: route.id
                  }
                });
                edgesCreated++;
              }
            }

            const requestLabel = `${method ?? 'UNKNOWN'} ${url}`;
            connections.push({
              request: requestLabel,
              route: `${routeMethod} ${routePath}`,
              requestFile: request.file,
              routeFile: route.file
            });

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
        },
        errors
      );

    } catch (error) {
      logger.error('Error in HTTPConnectionEnricher', { error });
      return createErrorResult(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Normalize URL to canonical form for comparison.
   * Converts both Express params (:id) and template literals (${...}) to {param}.
   */
  private normalizeUrl(url: string): string {
    return url
      .replace(/:[A-Za-z0-9_]+/g, '{param}')      // :id -> {param}
      .replace(/\$\{[^}]*\}/g, '{param}'); // ${...} -> {param}, ${userId} -> {param}
  }

  /**
   * Check if URL has any parameter placeholders (after normalization)
   */
  private hasParamsNormalized(normalizedUrl: string): boolean {
    return normalizedUrl.includes('{param}');
  }

  /**
   * Check if request URL matches route path.
   * Supports:
   * - Exact match
   * - Express params (:id)
   * - Template literals (${...})
   * - Concrete values matching params (/users/123 matches /users/:id)
   */
  private pathsMatch(requestUrl: string, routePath: string): boolean {
    // Normalize both to canonical form
    const normRequest = this.normalizeUrl(requestUrl);
    const normRoute = this.normalizeUrl(routePath);

    // If both normalize to same string, they match
    if (normRequest === normRoute) {
      return true;
    }

    // If route has no params after normalization, require exact match
    if (!this.hasParamsNormalized(normRoute)) {
      return false;
    }

    // Handle case where request has concrete value (e.g., '/users/123')
    // and route has param (e.g., '/users/{param}')
    return this.buildParamRegex(normRoute).test(normRequest);
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private buildParamRegex(normalizedRoute: string): RegExp {
    const parts = normalizedRoute.split('{param}');
    const pattern = parts.map(part => this.escapeRegExp(part)).join('[^/]+');
    return new RegExp(`^${pattern}$`);
  }

  /**
   * Check if path has parameters (for edge matchType metadata)
   */
  private hasParams(path: string): boolean {
    if (!path) return false;
    // Check for Express params or template literals
    return path.includes(':') || path.includes('${');
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
