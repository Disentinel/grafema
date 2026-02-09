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
import { ValidationError } from '../../errors/GrafemaError.js';

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
      dependencies: [],
      creates: {
        nodes: [],
        edges: []
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);

    logger.info('Starting data flow validation');

    // Check if graph supports getAllEdges
    if (!graph.getAllEdges) {
      logger.debug('Graph does not support getAllEdges, skipping validation');
      return createSuccessResult({ nodes: 0, edges: 0 }, { skipped: true });
    }

    // Получаем все переменные
    const allNodes = await graph.getAllNodes();
    const allEdges = await graph.getAllEdges() as EdgeRecord[];

    const variables = allNodes.filter(n =>
      n.type === 'VARIABLE_DECLARATION' || n.type === 'CONSTANT'
    );

    logger.debug('Variables collected', { count: variables.length });

    const errors: ValidationError[] = [];
    const leafTypes = new Set([
      'LITERAL',
      'net:stdio',
      'db:query',
      'net:request',
      'fs:operation',
      'event:listener',
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
        errors.push(new ValidationError(
          `Variable "${variable.name}" (${variable.file}:${variable.line}) has no ASSIGNED_FROM edge`,
          'ERR_MISSING_ASSIGNMENT',
          {
            filePath: variable.file,
            lineNumber: variable.line as number | undefined,
            phase: 'VALIDATION',
            plugin: 'DataFlowValidator',
            variable: variable.name as string,
          },
          undefined,
          'warning'
        ));
        continue;
      }

      // Проверяем что источник существует
      const source = allNodes.find(n => n.id === assignment.dst);
      if (!source) {
        errors.push(new ValidationError(
          `Variable "${variable.name}" references non-existent node ${assignment.dst}`,
          'ERR_BROKEN_REFERENCE',
          {
            filePath: variable.file,
            lineNumber: variable.line as number | undefined,
            phase: 'VALIDATION',
            plugin: 'DataFlowValidator',
            variable: variable.name as string,
            targetNodeId: assignment.dst,
          },
          undefined,
          'error'
        ));
        continue;
      }

      // Проверяем путь до листового узла
      const path = this.findPathToLeaf(variable, allNodes, allEdges, leafTypes);
      if (!path.found) {
        errors.push(new ValidationError(
          `Variable "${variable.name}" (${variable.file}:${variable.line}) does not trace to a leaf node. Chain: ${path.chain.join(' -> ')}`,
          'ERR_NO_LEAF_NODE',
          {
            filePath: variable.file,
            lineNumber: variable.line as number | undefined,
            phase: 'VALIDATION',
            plugin: 'DataFlowValidator',
            variable: variable.name as string,
            chain: path.chain,
          },
          undefined,
          'warning'
        ));
      }
    }

    // Группируем errors по коду
    const byCode: Record<string, number> = {};
    for (const error of errors) {
      if (!byCode[error.code]) {
        byCode[error.code] = 0;
      }
      byCode[error.code]++;
    }

    const summary: ValidationSummary = {
      total: variables.length,
      validated: variables.length - errors.length,
      issues: errors.length,
      byType: byCode
    };

    logger.info('Validation complete', { ...summary });

    // Выводим errors
    if (errors.length > 0) {
      logger.warn('Data flow issues found', { count: errors.length });
      for (const error of errors) {
        if (error.severity === 'error') {
          logger.error(`[${error.code}] ${error.message}`);
        } else {
          logger.warn(`[${error.code}] ${error.message}`);
        }
      }
    }

    return createSuccessResult(
      { nodes: 0, edges: 0 },
      { summary },
      errors
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

    // REG-262: Check if variable is used by a method call (incoming USES edge)
    // If something USES this variable, the variable is not dead
    const usedByCall = allEdges.find(e =>
      e.type === 'USES' && e.dst === startNode.id
    );
    if (usedByCall) {
      const callNode = allNodes.find(n => n.id === usedByCall.src);
      const callName = callNode?.name ?? usedByCall.src;
      return { found: true, chain: [...chain, `(used by ${callName})`] };
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
