/**
 * ExpressHandlerLinker - creates HANDLED_BY edges connecting
 * http:route nodes to their handler FUNCTION nodes.
 *
 * This enricher runs AFTER ExpressRouteAnalyzer (analysis phase) and
 * creates cross-references between routes and functions.
 *
 * Strategy:
 * 1. For inline handlers (arrow/function expressions): match by byte offset (start)
 * 2. For named handlers (Identifier references): match by function name
 *
 * This approach avoids duplicating semantic ID computation logic
 * (which is solely owned by JSASTAnalyzer/ScopeTracker).
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';

/**
 * Extended http:route node with handler identification fields.
 * Note: These fields are stored at the top level after metadata parsing,
 * not nested under a metadata object.
 */
interface HttpRouteNode extends BaseNodeRecord {
  type: 'http:route';
  handlerStart?: number;  // Byte offset for inline handlers
  handlerName?: string;   // Function name for named handlers
}

/**
 * Extended FUNCTION node with start field
 */
interface FunctionNode extends BaseNodeRecord {
  type: 'FUNCTION';
  start?: number;
}

export class ExpressHandlerLinker extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ExpressHandlerLinker',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],
        edges: ['HANDLED_BY']
      },
      dependencies: ['JSASTAnalyzer', 'ExpressRouteAnalyzer'],
      consumes: [],
      produces: ['HANDLED_BY']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    logger.info('Starting Express handler linking');

    const startTime = Date.now();

    let routesProcessed = 0;
    let edgesCreated = 0;
    let noHandlerInfo = 0;
    let handlerNotFound = 0;

    // Collect all http:route nodes
    const routeNodes: HttpRouteNode[] = [];
    for await (const node of graph.queryNodes({ type: 'http:route' })) {
      routeNodes.push(node as HttpRouteNode);
    }

    logger.info('Found routes to process', { count: routeNodes.length });

    if (routeNodes.length === 0) {
      return createSuccessResult({ nodes: 0, edges: 0 });
    }

    // Group routes by file for efficient batch lookup
    const routesByFile = new Map<string, HttpRouteNode[]>();
    for (const route of routeNodes) {
      const file = route.file;
      if (!file) continue;
      const routes = routesByFile.get(file) || [];
      routes.push(route);
      routesByFile.set(file, routes);
    }

    // Process routes file by file
    for (const [file, fileRoutes] of routesByFile) {
      // Build function lookup maps for this file
      const functionsByStart = new Map<number, string>(); // start -> nodeId
      const functionsByName = new Map<string, string>();  // name -> nodeId (first match)

      for await (const fn of graph.queryNodes({ type: 'FUNCTION', file })) {
        const funcNode = fn as FunctionNode;
        if (funcNode.start !== undefined) {
          functionsByStart.set(funcNode.start, funcNode.id);
        }
        if (funcNode.name && !functionsByName.has(funcNode.name)) {
          functionsByName.set(funcNode.name, funcNode.id);
        }
      }

      // Link routes to handlers
      for (const route of fileRoutes) {
        routesProcessed++;

        // Report progress
        if (onProgress && routesProcessed % 20 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          onProgress({
            phase: 'enrichment',
            currentPlugin: 'ExpressHandlerLinker',
            message: `Linking handlers ${routesProcessed}/${routeNodes.length} (${elapsed}s)`,
            totalFiles: routeNodes.length,
            processedFiles: routesProcessed
          });
        }

        // Handler identification is stored at top level after metadata parsing
        const handlerStart = route.handlerStart;
        const handlerName = route.handlerName;

        // Try to find handler function
        let handlerId: string | undefined;

        if (handlerStart !== undefined) {
          // Inline handler: lookup by byte offset
          handlerId = functionsByStart.get(handlerStart);
        } else if (handlerName !== undefined) {
          // Named handler: lookup by name
          handlerId = functionsByName.get(handlerName);
        } else {
          noHandlerInfo++;
          continue;
        }

        if (!handlerId) {
          handlerNotFound++;
          logger.debug('Handler not found', {
            route: route.id,
            handlerStart,
            handlerName,
            file
          });
          continue;
        }

        // Create HANDLED_BY edge: route -> handler function
        await graph.addEdge({
          type: 'HANDLED_BY',
          src: route.id,
          dst: handlerId
        });
        edgesCreated++;
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info('Complete', {
      routesProcessed,
      edgesCreated,
      noHandlerInfo,
      handlerNotFound,
      time: `${totalTime}s`
    });

    return createSuccessResult(
      { nodes: 0, edges: edgesCreated },
      {
        routesProcessed,
        edgesCreated,
        noHandlerInfo,
        handlerNotFound,
        timeMs: Date.now() - startTime
      }
    );
  }
}
