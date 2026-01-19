/**
 * DataFlowValidator - проверяет что все переменные прослеживаются до листовых узлов
 *
 * ПРАВИЛО: Каждая переменная должна иметь путь до листового узла через ASSIGNED_FROM рёбра
 *
 * ЛИСТОВЫЕ УЗЛЫ:
 * - LITERAL: примитивные значения
 * - EXTERNAL_STDIO: console.log/error
 * - EXTERNAL_DATABASE: database queries
 * - EXTERNAL_NETWORK: HTTP requests
 * - EXTERNAL_FILESYSTEM: fs.readFile
 * - EVENT_LISTENER: события
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';

/**
 * Edge structure
 */
interface EdgeRecord {
  type: string;
  src: string;
  dst: string;
  [key: string]: unknown;
}

/**
 * Data flow issue
 */
interface DataFlowIssue {
  type: string;
  severity: string;
  message: string;
  variable: string;
  file?: string;
  line?: number;
  chain?: string[];
}

/**
 * Path finding result
 */
interface PathResult {
  found: boolean;
  chain: string[];
}

/**
 * Validation summary
 */
interface ValidationSummary {
  total: number;
  validated: number;
  issues: number;
  byType: Record<string, number>;
}

export class DataFlowValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'DataFlowValidator',
      phase: 'VALIDATION',
      priority: 100,
      creates: {
        nodes: [],
        edges: []
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;

    console.log('[DataFlowValidator] Starting data flow validation...');

    // Check if graph supports getAllEdges
    if (!graph.getAllEdges) {
      console.log('[DataFlowValidator] Graph does not support getAllEdges, skipping validation');
      return createSuccessResult({ nodes: 0, edges: 0 }, { skipped: true });
    }

    // Получаем все переменные
    const allNodes = await graph.getAllNodes();
    const allEdges = await graph.getAllEdges() as EdgeRecord[];

    const variables = allNodes.filter(n =>
      n.type === 'VARIABLE_DECLARATION' || n.type === 'CONSTANT'
    );

    console.log(`[DataFlowValidator] Found ${variables.length} variables to validate`);

    const issues: DataFlowIssue[] = [];
    const leafTypes = new Set([
      'LITERAL',
      'EXTERNAL_STDIO',
      'EXTERNAL_DATABASE',
      'EXTERNAL_NETWORK',
      'EXTERNAL_FILESYSTEM',
      'EVENT_LISTENER',
      'CLASS',          // NewExpression - конструкторы классов
      'FUNCTION',       // Arrow functions и function expressions
      'METHOD_CALL',    // Вызовы методов (промежуточные узлы)
      'CALL_SITE'       // Вызовы функций (промежуточные узлы)
    ]);

    for (const variable of variables) {
      // Проверяем наличие ASSIGNED_FROM ребра
      const assignment = allEdges.find(e =>
        e.type === 'ASSIGNED_FROM' && e.src === variable.id
      );

      if (!assignment) {
        issues.push({
          type: 'MISSING_ASSIGNMENT',
          severity: 'WARNING',
          message: `Variable "${variable.name}" (${variable.file}:${variable.line}) has no ASSIGNED_FROM edge`,
          variable: variable.name as string,
          file: variable.file,
          line: variable.line as number | undefined
        });
        continue;
      }

      // Проверяем что источник существует
      const source = allNodes.find(n => n.id === assignment.dst);
      if (!source) {
        issues.push({
          type: 'BROKEN_REFERENCE',
          severity: 'ERROR',
          message: `Variable "${variable.name}" references non-existent node ${assignment.dst}`,
          variable: variable.name as string,
          file: variable.file,
          line: variable.line as number | undefined
        });
        continue;
      }

      // Проверяем путь до листового узла
      const path = this.findPathToLeaf(variable, allNodes, allEdges, leafTypes);
      if (!path.found) {
        issues.push({
          type: 'NO_LEAF_NODE',
          severity: 'WARNING',
          message: `Variable "${variable.name}" (${variable.file}:${variable.line}) does not trace to a leaf node. Chain: ${path.chain.join(' -> ')}`,
          variable: variable.name as string,
          file: variable.file,
          line: variable.line as number | undefined,
          chain: path.chain
        });
      }
    }

    // Группируем issues по типу
    const summary: ValidationSummary = {
      total: variables.length,
      validated: variables.length - issues.length,
      issues: issues.length,
      byType: {}
    };

    for (const issue of issues) {
      if (!summary.byType[issue.type]) {
        summary.byType[issue.type] = 0;
      }
      summary.byType[issue.type]++;
    }

    console.log('[DataFlowValidator] Summary:', summary);

    // Выводим issues
    if (issues.length > 0) {
      console.log(`[DataFlowValidator] Found ${issues.length} issues:`);
      for (const issue of issues) {
        const level = issue.severity === 'ERROR' ? '❌' : '⚠️';
        console.log(`  ${level} [${issue.type}] ${issue.message}`);
      }
    }

    return createSuccessResult(
      { nodes: 0, edges: 0 },
      { summary, issues }
    );
  }

  /**
   * Находит путь от переменной до листового узла
   */
  private findPathToLeaf(
    startNode: NodeRecord,
    allNodes: NodeRecord[],
    allEdges: EdgeRecord[],
    leafTypes: Set<string>,
    visited: Set<string> = new Set(),
    chain: string[] = []
  ): PathResult {
    // Защита от циклов
    if (visited.has(startNode.id)) {
      return { found: false, chain: [...chain, `${startNode.type}:${startNode.name} (CYCLE)`] };
    }

    visited.add(startNode.id);
    chain.push(`${startNode.type}:${startNode.name}`);

    // Проверяем что это листовой узел
    if (leafTypes.has(startNode.type)) {
      return { found: true, chain };
    }

    // Ищем ASSIGNED_FROM ребро
    const assignment = allEdges.find(e =>
      e.type === 'ASSIGNED_FROM' && e.src === startNode.id
    );

    if (!assignment) {
      // Для METHOD_CALL и CALL_SITE - это промежуточные узлы, но можем считать их leaf для первой версии
      if (startNode.type === 'METHOD_CALL' || startNode.type === 'CALL_SITE') {
        return { found: true, chain: [...chain, '(intermediate node)'] };
      }

      return { found: false, chain: [...chain, '(no assignment)'] };
    }

    // Продолжаем по цепочке
    const nextNode = allNodes.find(n => n.id === assignment.dst);
    if (!nextNode) {
      return { found: false, chain: [...chain, '(broken reference)'] };
    }

    return this.findPathToLeaf(nextNode, allNodes, allEdges, leafTypes, visited, chain);
  }
}
