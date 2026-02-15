/**
 * UnconnectedRouteValidator -- creates ISSUE nodes for customer-facing routes
 * that have no frontend consumers (REG-256).
 *
 * Only checks routes marked with customerFacing: true (set by ServiceConnectionEnricher).
 * Routes without the flag are considered internal and don't raise issues.
 *
 * Creates issue:connectivity ISSUE nodes with AFFECTS edges to flagged routes.
 *
 * Phase: VALIDATION
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';

interface RouteNode {
  id: string;
  type: string;
  file?: string;
  line?: number;
  column?: number;
  method?: string;
  path?: string;
  fullPath?: string;
  customerFacing?: boolean;
}

export class UnconnectedRouteValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'UnconnectedRouteValidator',
      phase: 'VALIDATION',
      dependencies: [],
      creates: {
        nodes: ['ISSUE'],
        edges: ['AFFECTS'],
      },
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);

    logger.info('Starting unconnected route check');

    let issueCount = 0;

    for await (const node of graph.queryNodes({ type: 'http:route' })) {
      const route = node as unknown as RouteNode;

      // Only check customer-facing routes
      if (!route.customerFacing) continue;

      // Check for incoming INTERACTS_WITH edges (frontend consumers)
      const incoming = await graph.getIncomingEdges(route.id, ['INTERACTS_WITH']);

      if (incoming.length === 0) {
        const routePath = route.fullPath || route.path || '';
        const method = route.method || 'UNKNOWN';

        if (context.reportIssue) {
          await context.reportIssue({
            category: 'connectivity',
            severity: 'warning',
            message: `Customer-facing route ${method} ${routePath} has no frontend consumers`,
            file: route.file || '',
            line: route.line || 0,
            column: route.column || 0,
            targetNodeId: route.id,
            context: {
              type: 'UNCONNECTED_CUSTOMER_ROUTE',
              method,
              path: routePath,
            },
          });
          issueCount++;
        }
      }
    }

    if (issueCount > 0) {
      logger.info('Unconnected customer-facing routes found', { count: issueCount });
    } else {
      logger.info('No unconnected customer-facing routes');
    }

    return createSuccessResult(
      { nodes: issueCount, edges: issueCount },
      { issueCount }
    );
  }
}
