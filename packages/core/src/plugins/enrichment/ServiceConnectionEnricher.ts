/**
 * ServiceConnectionEnricher -- connects http:request to http:route nodes
 * with cross-service routing support (REG-256).
 *
 * Replaces HTTPConnectionEnricher with:
 * 1. Service-aware matching (uses SERVICE nodes to determine ownership)
 * 2. RoutingMap URL transformation (stripPrefix/addPrefix before matching)
 * 3. customerFacing metadata (marks routes in customer-facing services)
 *
 * Falls back to direct path matching when no RoutingMap exists (backward compat).
 *
 * Phase: ENRICHMENT
 * Dependencies: ExpressRouteAnalyzer, FetchAnalyzer, ExpressResponseAnalyzer,
 *               MountPointResolver, ConfigRoutingMapBuilder
 */

import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord, ServiceDefinition, RoutingMap, OrchestratorConfig } from '@grafema/types';
import { ROUTING_MAP_RESOURCE_ID } from '@grafema/types';
import { brandNodeInternal } from '../../core/brandNodeInternal.js';
import { StrictModeError, ValidationError } from '../../errors/GrafemaError.js';
import { pathsMatch, hasParams, deduplicateById } from './httpPathUtils.js';

/**
 * HTTP route node
 */
interface HTTPRouteNode extends BaseNodeRecord {
  method?: string;
  path?: string;
  fullPath?: string;
  url?: string;
  customerFacing?: boolean;
}

/**
 * HTTP request node
 */
interface HTTPRequestNode extends BaseNodeRecord {
  method?: string;
  methodSource?: MethodSource;
  url?: string;
  responseDataNode?: string;
}

type MethodSource = 'explicit' | 'default' | 'unknown';

/**
 * Service entry from graph SERVICE nodes
 */
interface ServiceEntry {
  name: string;
  path: string;
}

/**
 * Connection info for logging
 */
interface ConnectionInfo {
  request: string;
  route: string;
  requestFile?: string;
  routeFile?: string;
  transformed?: string;
}

export class ServiceConnectionEnricher extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ServiceConnectionEnricher',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],
        edges: ['INTERACTS_WITH', 'HTTP_RECEIVES'],
      },
      dependencies: [
        'ExpressRouteAnalyzer',
        'FetchAnalyzer',
        'ExpressResponseAnalyzer',
        'MountPointResolver',
        'ConfigRoutingMapBuilder',
      ],
      consumes: ['RESPONDS_WITH'],
      produces: ['INTERACTS_WITH', 'HTTP_RECEIVES'],
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    try {
      // 1. Build service ownership map from SERVICE nodes
      const serviceMap = await this.buildServiceMap(graph);
      logger.debug('Service map built', { services: serviceMap.length });

      // 2. Get RoutingMap from ResourceRegistry (may not exist)
      const routingMap = context.resources?.get<RoutingMap>(ROUTING_MAP_RESOURCE_ID) ?? null;
      if (routingMap) {
        logger.info('RoutingMap available', { rules: routingMap.ruleCount });
      }

      // 3. Mark customerFacing on route nodes
      const config = context.config as OrchestratorConfig;
      const services = (config?.services ?? []) as ServiceDefinition[];

      // 4. Collect all http:route (backend endpoints)
      const routes: HTTPRouteNode[] = [];
      let routeCounter = 0;
      for await (const node of graph.queryNodes({ type: 'http:route' })) {
        routes.push(node as HTTPRouteNode);
        routeCounter++;
        if (onProgress && routeCounter % 100 === 0) {
          onProgress({
            phase: 'enrichment',
            currentPlugin: 'ServiceConnectionEnricher',
            message: `Collecting routes ${routeCounter}`,
            totalFiles: 0,
            processedFiles: routeCounter,
          });
        }
      }

      // 5. Collect all http:request (frontend requests)
      const requests: HTTPRequestNode[] = [];
      let requestCounter = 0;
      for await (const node of graph.queryNodes({ type: 'http:request' })) {
        requests.push(node as HTTPRequestNode);
        requestCounter++;
        if (onProgress && requestCounter % 100 === 0) {
          onProgress({
            phase: 'enrichment',
            currentPlugin: 'ServiceConnectionEnricher',
            message: `Collecting requests ${requestCounter}`,
            totalFiles: 0,
            processedFiles: requestCounter,
          });
        }
      }

      logger.debug('Found routes and requests', {
        routes: routes.length,
        requests: requests.length,
      });

      // 6. Deduplicate by ID (multi-service analysis can produce duplicates)
      const uniqueRoutes = deduplicateById(routes);
      const uniqueRequests = deduplicateById(requests);

      logger.info('Unique routes and requests', {
        routes: uniqueRoutes.length,
        requests: uniqueRequests.length,
      });

      // 7. Mark customerFacing routes
      await this.markCustomerFacingRoutes(graph, uniqueRoutes, serviceMap, services, logger);

      // 8. Match requests to routes
      let edgesCreated = 0;
      const errors: Error[] = [];
      const connections: ConnectionInfo[] = [];

      for (let ri = 0; ri < uniqueRequests.length; ri++) {
        const request = uniqueRequests[ri];

        if (onProgress && ri % 50 === 0) {
          onProgress({
            phase: 'enrichment',
            currentPlugin: 'ServiceConnectionEnricher',
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
                plugin: 'ServiceConnectionEnricher',
                requestId: request.id,
              },
              'Provide method as a string literal or resolvable const (e.g., method: "POST")'
            ));
          } else {
            errors.push(new ValidationError(
              message,
              'WARN_HTTP_METHOD_UNKNOWN',
              {
                filePath: request.file,
                lineNumber: request.line as number | undefined,
                phase: 'ENRICHMENT',
                plugin: 'ServiceConnectionEnricher',
                requestId: request.id,
              },
              'Provide method as a string literal or resolvable const (e.g., method: "POST")',
              'warning'
            ));
          }
          continue;
        }

        // Skip dynamic URLs
        if (url === 'dynamic' || !url) {
          continue;
        }

        // Determine request's owning service
        const requestService = request.file
          ? this.getServiceForFile(request.file, serviceMap)
          : undefined;

        // Find matching route
        for (const route of uniqueRoutes) {
          const routeMethod = route.method ? route.method.toUpperCase() : null;
          // Use fullPath (from MountPointResolver) if available, fallback to local path
          const routePath = route.fullPath || route.path;

          if (!routeMethod) continue;
          if (methodSource === 'default' && routeMethod !== 'GET') continue;
          if (methodSource === 'explicit' && (!method || method !== routeMethod)) continue;

          // Determine route's owning service
          const routeService = route.file
            ? this.getServiceForFile(route.file, serviceMap)
            : undefined;

          // Apply URL transformation if routing rules exist
          const urlToMatch = this.transformUrl(url, requestService, routeService, routingMap);

          if (routePath && pathsMatch(urlToMatch, routePath)) {
            // 1. Create INTERACTS_WITH edge
            await graph.addEdge({
              type: 'INTERACTS_WITH',
              src: request.id,
              dst: route.id,
              matchType: hasParams(routePath) ? 'parametric' : 'exact',
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
                    viaRoute: route.id,
                  },
                });
                edgesCreated++;
              }
            }

            connections.push({
              request: `${method ?? 'UNKNOWN'} ${url}`,
              route: `${routeMethod} ${routePath}`,
              requestFile: request.file,
              routeFile: route.file,
              transformed: urlToMatch !== url ? urlToMatch : undefined,
            });

            break; // One request -> one route
          }
        }
      }

      // Log found connections
      if (connections.length > 0) {
        logger.info('Connections found', {
          count: connections.length,
          examples: connections.slice(0, 5).map(c =>
            c.transformed
              ? `${c.request} -> ${c.route} (via ${c.transformed})`
              : `${c.request} -> ${c.route}`
          ),
        });
      }

      return createSuccessResult(
        { nodes: 0, edges: edgesCreated },
        {
          connections: connections.length,
          routesAnalyzed: uniqueRoutes.length,
          requestsAnalyzed: uniqueRequests.length,
        },
        errors
      );
    } catch (error) {
      logger.error('Error in ServiceConnectionEnricher', { error });
      return createErrorResult(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // ===========================================================================
  // Service ownership
  // ===========================================================================

  /**
   * Build service ownership map from SERVICE nodes in the graph.
   * Returns entries sorted by path length descending (most specific first).
   *
   * Complexity: O(s) where s = SERVICE nodes (typically 2-5)
   */
  private async buildServiceMap(graph: PluginContext['graph']): Promise<ServiceEntry[]> {
    const entries: ServiceEntry[] = [];
    for await (const node of graph.queryNodes({ type: 'SERVICE' })) {
      if (node.file && node.name) {
        entries.push({ name: node.name as string, path: node.file as string });
      }
    }
    // Sort by path length descending so longest prefix matches first
    entries.sort((a, b) => b.path.length - a.path.length);
    return entries;
  }

  /**
   * Find which service owns a file path.
   * Uses longest-prefix match against service paths.
   *
   * Complexity: O(s) where s = service count (typically 2-5)
   */
  private getServiceForFile(filePath: string, serviceMap: ServiceEntry[]): string | undefined {
    for (const entry of serviceMap) {
      if (filePath.startsWith(entry.path)) {
        return entry.name;
      }
    }
    return undefined;
  }

  // ===========================================================================
  // customerFacing marking
  // ===========================================================================

  /**
   * Mark route nodes as customerFacing based on service configuration.
   * Only marks routes whose owning service has customerFacing: true.
   *
   * Complexity: O(routes * services) -- typically O(routes * 2..5)
   */
  private async markCustomerFacingRoutes(
    graph: PluginContext['graph'],
    routes: HTTPRouteNode[],
    serviceMap: ServiceEntry[],
    services: ServiceDefinition[],
    logger: ReturnType<typeof this.log>
  ): Promise<number> {
    const cfServices = new Set(
      services.filter(s => s.customerFacing).map(s => s.name)
    );

    if (cfServices.size === 0) return 0;

    let count = 0;
    for (const route of routes) {
      if (!route.file) continue;
      const serviceName = this.getServiceForFile(route.file, serviceMap);
      if (serviceName && cfServices.has(serviceName)) {
        // LEGITIMATE USE: brandNodeInternal() is correct here because:
        // 1. This node was already created and validated by ExpressRouteAnalyzer
        // 2. We're enriching it with customerFacing metadata, not creating a new node
        // 3. The original node structure and type remain unchanged
        await graph.addNode(brandNodeInternal({
          ...route,
          customerFacing: true,
        }));
        // Update the in-memory object for later validation
        route.customerFacing = true;
        count++;
      }
    }

    if (count > 0) {
      logger.info('Marked customer-facing routes', { count });
    }
    return count;
  }

  // ===========================================================================
  // Routing transformation
  // ===========================================================================

  /**
   * Try to transform a URL using routing rules for a service pair.
   * Returns the transformed URL, or the original URL if no rule applies.
   */
  private transformUrl(
    url: string,
    requestService: string | undefined,
    routeService: string | undefined,
    routingMap: RoutingMap | null
  ): string {
    if (!requestService || !routeService || !routingMap) return url;

    const match = routingMap.findMatch({
      fromService: requestService,
      requestUrl: url,
    });

    if (match && match.targetService === routeService) {
      return match.transformedUrl;
    }

    return url;
  }

}
