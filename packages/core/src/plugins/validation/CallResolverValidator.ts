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

/**
 * Call resolver issue
 */
interface CallResolverIssue {
  type: string;
  severity: string;
  message: string;
  callName: string;
  nodeId: string;
  file?: string;
  line?: number;
}

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

    console.log('[CallResolverValidator] Starting call resolution validation using Datalog...');

    // Check if graph supports checkGuarantee
    if (!graph.checkGuarantee) {
      console.log('[CallResolverValidator] Graph does not support checkGuarantee, skipping validation');
      return createSuccessResult({ nodes: 0, edges: 0 }, { skipped: true });
    }

    // Datalog гарантия:
    // CALL без "object" (т.е. CALL_SITE) должен иметь CALLS ребро
    const violations = await graph.checkGuarantee(`
      violation(X) :- node(X, "CALL"), \\+ attr(X, "object", _), \\+ edge(X, _, "CALLS").
    `) as DatalogViolation[];

    const issues: CallResolverIssue[] = [];

    if (violations.length > 0) {
      console.log(`[CallResolverValidator] Found ${violations.length} unresolved function calls`);

      for (const v of violations) {
        const nodeId = v.bindings.find(b => b.name === 'X')?.value;
        if (nodeId) {
          const node = await graph.getNode(nodeId);
          if (node) {
            issues.push({
              type: 'UNRESOLVED_FUNCTION_CALL',
              severity: 'WARNING',
              message: `Call to "${node.name}" at ${node.file}:${node.line || '?'} does not resolve to a function definition`,
              callName: node.name as string,
              nodeId: nodeId,
              file: node.file,
              line: node.line as number | undefined
            });
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
      unresolvedInternalCalls: issues.length,
      externalMethodCalls: methodCallStats.external,
      issues: issues.length
    };

    console.log('[CallResolverValidator] Summary:', summary);

    if (issues.length > 0) {
      console.log(`[CallResolverValidator] Unresolved calls:`);
      for (const issue of issues.slice(0, 10)) { // Show first 10
        console.log(`  ⚠️ ${issue.message}`);
      }
      if (issues.length > 10) {
        console.log(`  ... and ${issues.length - 10} more`);
      }
    }

    return createSuccessResult(
      { nodes: 0, edges: 0 },
      { summary, issues }
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
