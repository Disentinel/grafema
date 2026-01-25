/**
 * CallResolverValidator - проверяет что все вызовы функций ссылаются на определения
 *
 * Использует Datalog для декларативной проверки гарантии:
 * "Все внутренние вызовы функций (CALL_SITE) должны иметь CALLS ребро к FUNCTION"
 *
 * ПРАВИЛО (Datalog):
 * violation(X) :- node(X, "CALL"), \+ attr(X, "object", _), \+ edge(X, _, "CALLS").
 *
 * Это находит CALL узлы без "object" метаданных (т.е. CALL_SITE, не METHOD_CALL),
 * которые не имеют CALLS ребра к определению функции.
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import { ValidationError } from '../../errors/GrafemaError.js';

/**
 * Method call statistics
 */
interface MethodCallStats {
  total: number;
  resolved: number;
  external: number;
}

/**
 * Validation summary
 */
interface ValidationSummary {
  totalCalls: number;
  resolvedInternalCalls: number;
  unresolvedInternalCalls: number;
  externalMethodCalls: number;
  issues: number;
}

/**
 * Datalog violation result
 */
interface DatalogViolation {
  bindings: Array<{ name: string; value: string }>;
}

export class CallResolverValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'CallResolverValidator',
      phase: 'VALIDATION',
      priority: 90,
      creates: {
        nodes: [],
        edges: []
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);

    logger.info('Starting call resolution validation using Datalog');

    // Check if graph supports checkGuarantee
    if (!graph.checkGuarantee) {
      logger.debug('Graph does not support checkGuarantee, skipping validation');
      return createSuccessResult({ nodes: 0, edges: 0 }, { skipped: true });
    }

    // Datalog гарантия:
    // CALL без "object" (т.е. CALL_SITE) должен иметь CALLS ребро
    const violations = await graph.checkGuarantee(`
      violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
    `) as DatalogViolation[];

    const errors: ValidationError[] = [];

    if (violations.length > 0) {
      logger.debug('Unresolved function calls found', { count: violations.length });

      for (const v of violations) {
        const nodeId = v.bindings.find(b => b.name === 'X')?.value;
        if (nodeId) {
          const node = await graph.getNode(nodeId);
          if (node) {
            errors.push(new ValidationError(
              `Call to "${node.name}" at ${node.file}:${node.line || '?'} does not resolve to a function definition`,
              'ERR_UNRESOLVED_CALL',
              {
                filePath: node.file,
                lineNumber: node.line as number | undefined,
                phase: 'VALIDATION',
                plugin: 'CallResolverValidator',
                nodeId,
                callName: node.name as string,
              },
              'Ensure the function is defined and exported'
            ));
          }
        }
      }
    }

    // Также проверим METHOD_CALL на известные внешние методы
    // (это информационно, не ошибка)
    const methodCallStats = await this.countMethodCalls(graph);

    const summary: ValidationSummary = {
      totalCalls: methodCallStats.total,
      resolvedInternalCalls: methodCallStats.resolved,
      unresolvedInternalCalls: errors.length,
      externalMethodCalls: methodCallStats.external,
      issues: errors.length
    };

    logger.info('Validation complete', { ...summary });

    if (errors.length > 0) {
      logger.warn('Unresolved calls detected', { count: errors.length });
      for (const error of errors.slice(0, 10)) { // Show first 10
        logger.warn(error.message);
      }
      if (errors.length > 10) {
        logger.debug(`... and ${errors.length - 10} more`);
      }
    }

    return createSuccessResult(
      { nodes: 0, edges: 0 },
      { summary },
      errors
    );
  }

  /**
   * Подсчитывает статистику по вызовам
   */
  private async countMethodCalls(graph: PluginContext['graph']): Promise<MethodCallStats> {
    const stats: MethodCallStats = {
      total: 0,
      resolved: 0,
      external: 0
    };

    // Подсчитываем все CALL узлы
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      stats.total++;

      // Проверяем наличие "object" в метаданных (METHOD_CALL)
      if ((node as NodeRecord & { object?: string }).object) {
        stats.external++;
      } else {
        // CALL_SITE - проверяем есть ли CALLS ребро
        const edges = await graph.getOutgoingEdges(node.id, ['CALLS']);
        if (edges.length > 0) {
          stats.resolved++;
        }
      }
    }

    return stats;
  }
}
