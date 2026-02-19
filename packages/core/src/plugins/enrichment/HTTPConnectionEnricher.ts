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
import { pathsMatch, hasParams, deduplicateById } from './httpPathUtils.js';

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
      creates: {
        nodes: [],
        edges: ['INTERACTS_WITH', 'HTTP_RECEIVES']
      },
      dependencies: ['ExpressRouteAnalyzer', 'FetchAnalyzer', 'ExpressResponseAnalyzer'],
      consumes: ['RESPONDS_WITH'],
      produces: ['INTERACTS_WITH', 'HTTP_RECEIVES']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    try {
      // Собираем все http:route (backend endpoints)
      const routes: HTTPRouteNode[] = [];
      let routeCounter = 0;
      for await (const node of graph.queryNodes({ type: 'http:route' })) {
        routes.push(node as HTTPRouteNode);
        routeCounter++;
        if (onProgress && routeCounter % 100 === 0) {
          onProgress({
            phase: 'enrichment',
            currentPlugin: 'HTTPConnectionEnricher',
            message: `Collecting routes ${routeCounter}`,
            totalFiles: 0,
            processedFiles: routeCounter,
          });
        }
      }

      // Собираем все http:request (frontend requests)
      const requests: HTTPRequestNode[] = [];
      let requestCounter = 0;
      for await (const node of graph.queryNodes({ type: 'http:request' })) {
        requests.push(node as HTTPRequestNode);
        requestCounter++;
        if (onProgress && requestCounter % 100 === 0) {
          onProgress({
            phase: 'enrichment',
            currentPlugin: 'HTTPConnectionEnricher',
            message: `Collecting requests ${requestCounter}`,
            totalFiles: 0,
            processedFiles: requestCounter,
          });
        }
      }

      logger.debug('Found routes and requests', {
        routes: routes.length,
        requests: requests.length
      });

      // Дедуплицируем по ID (из-за multi-service анализа)
      const uniqueRoutes = deduplicateById(routes);
      const uniqueRequests = deduplicateById(requests);

      logger.info('Unique routes and requests', {
        routes: uniqueRoutes.length,
        requests: uniqueRequests.length
      });

      let edgesCreated = 0;
      const errors: Error[] = [];
      const connections: ConnectionInfo[] = [];

      // Для каждого request ищем matching route
      for (let ri = 0; ri < uniqueRequests.length; ri++) {
        const request = uniqueRequests[ri];

        if (onProgress && ri % 50 === 0) {
          onProgress({
            phase: 'enrichment',
            currentPlugin: 'HTTPConnectionEnricher',
            message: `Matching requests ${ri}/${uniqueRequests.length}`,
            totalFiles: uniqueRequests.length,
            processedFiles: ri,
          });
        }

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

          if (routePath && pathsMatch(url, routePath)) {
            // 1. Create INTERACTS_WITH edge (existing)
            await graph.addEdge({
              type: 'INTERACTS_WITH',
              src: request.id,
              dst: route.id,
              matchType: hasParams(routePath) ? 'parametric' : 'exact'
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

}
