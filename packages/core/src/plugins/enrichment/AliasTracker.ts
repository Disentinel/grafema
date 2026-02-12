/**
 * AliasTracker - резолвит вызовы через алиасы
 *
 * Проблема: `const m = obj.method; m()` не резолвится как method call
 * Решение: трассируем ASSIGNED_FROM цепочки чтобы найти оригинальный источник
 *
 * ИСПОЛЬЗУЕТ:
 * - VARIABLE -> ASSIGNED_FROM -> EXPRESSION (из JSASTAnalyzer)
 * - EXPRESSION с expressionType='MemberExpression'
 *
 * СОЗДАЁТ:
 * - CALL -> CALLS -> METHOD/FUNCTION (когда алиас резолвится)
 * - CALL -> ALIAS_OF -> EXPRESSION (для трассировки)
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord, NodeRecord } from '@grafema/types';
import { StrictModeError } from '../../errors/GrafemaError.js';

/**
 * Alias info from index
 */
interface AliasInfo {
  variableId: string;
  variableName: string;
  expressionId: string;
  expressionType: string;
  object?: string;
  property?: string;
  computed?: boolean;
  computedPropertyVar?: string;
  file: string;
}

/**
 * Expression source info
 */
interface ExpressionSource {
  expressionId: string;
  expressionType: string;
  object?: string;
  property?: string;
  computed?: boolean;
  computedPropertyVar?: string;
}

/**
 * Depth exceeded info
 */
interface DepthExceededInfo {
  file?: string;
  name: string;
  chain: string[];
  depth: number;
}

/**
 * Extended call node
 */
interface CallNode extends BaseNodeRecord {
  object?: string;
  method?: string;
}

export class AliasTracker extends Plugin {
  static MAX_DEPTH = 10;
  private depthExceeded: DepthExceededInfo[] = [];

  get metadata(): PluginMetadata {
    return {
      name: 'AliasTracker',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],
        edges: ['CALLS', 'ALIAS_OF']
      },
      dependencies: ['MethodCallResolver'],
      consumes: ['ASSIGNED_FROM', 'CONTAINS', 'INSTANCE_OF'],
      produces: ['CALLS', 'ALIAS_OF']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    logger.info('Starting alias resolution');

    let callsProcessed = 0;
    let aliasesFound = 0;
    let edgesCreated = 0;
    let resolvedToMethod = 0;
    const errors: Error[] = [];

    // Трекинг превышений глубины
    this.depthExceeded = [];

    // 1. Найти все CALL без object (call sites) которые ещё не резолвлены
    const unresolvedCalls: CallNode[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      const callNode = node as CallNode;
      // Пропускаем method calls (у них есть object)
      if (callNode.object) continue;

      // Пропускаем уже резолвленные
      const existingEdges = await graph.getOutgoingEdges(node.id, ['CALLS']);
      if (existingEdges.length > 0) continue;

      unresolvedCalls.push(callNode);
    }

    logger.info('Found unresolved call sites', { count: unresolvedCalls.length });

    // 2. Строим индекс алиасов: variableName -> EXPRESSION info
    const aliasIndex = await this.buildAliasIndex(graph);
    logger.debug('Found potential aliases', { count: aliasIndex.size });

    // 3. Строим индекс методов для резолвинга
    const methodIndex = await this.buildMethodIndex(graph);

    // 4. Обрабатываем каждый нерезолвленный вызов
    for (const call of unresolvedCalls) {
      callsProcessed++;

      // Report progress every 50 calls
      if (onProgress && callsProcessed % 50 === 0) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'AliasTracker',
          message: `Tracking aliases ${callsProcessed}/${unresolvedCalls.length}`,
          totalFiles: unresolvedCalls.length,
          processedFiles: callsProcessed
        });
      }

      const callName = call.name as string;
      const callFile = call.file;

      // Ищем алиас с таким же именем в том же файле
      const aliasKey = `${callFile}:${callName}`;
      const alias = aliasIndex.get(aliasKey);

      if (!alias) continue;

      aliasesFound++;

      // Создаём ALIAS_OF ребро для трассировки
      await graph.addEdge({
        src: call.id,
        dst: alias.expressionId,
        type: 'ALIAS_OF'
      });
      edgesCreated++;

      // Если это MemberExpression - пробуем резолвить как method call
      if (alias.expressionType === 'MemberExpression') {
        const targetMethod = await this.resolveAliasedMethodCall(
          alias.object,
          alias.property,
          callFile!,
          methodIndex,
          graph,
          alias.computedPropertyVar // Pass variable name for computed access
        );

        if (targetMethod) {
          await graph.addEdge({
            src: call.id,
            dst: targetMethod.id,
            type: 'CALLS'
          });
          edgesCreated++;
          resolvedToMethod++;
        }
      }
    }

    const summary = {
      callsProcessed,
      aliasesFound,
      edgesCreated,
      resolvedToMethod,
      aliasesIndexed: aliasIndex.size,
      depthExceeded: this.depthExceeded.length
    };

    // Алярм если были превышения глубины
    if (this.depthExceeded.length > 0) {
      logger.warn('Alias chains exceeded max depth', {
        count: this.depthExceeded.length,
        maxDepth: AliasTracker.MAX_DEPTH,
        examples: this.depthExceeded.slice(0, 5).map(info => ({
          file: info.file,
          name: info.name,
          chain: info.chain.join(' → ')
        }))
      });

      // In strict mode, report as errors
      if (context.strictMode) {
        for (const info of this.depthExceeded) {
          const error = new StrictModeError(
            `Alias chain exceeded max depth (${info.depth}): ${info.name}`,
            'STRICT_ALIAS_DEPTH_EXCEEDED',
            {
              filePath: info.file,
              phase: 'ENRICHMENT',
              plugin: 'AliasTracker',
              aliasName: info.name,
              chainLength: info.depth,
            },
            `Possible circular alias reference. Chain: ${info.chain.slice(0, 3).join(' -> ')}...`
          );
          errors.push(error);
        }
      }
    }

    logger.info('Summary', summary);

    return createSuccessResult({ nodes: 0, edges: edgesCreated }, summary, errors);
  }

  /**
   * Строит индекс алиасов: file:variableName -> EXPRESSION info
   * Поддерживает транзитивные цепочки: a = b; b = c; c = obj.method
   */
  private async buildAliasIndex(graph: PluginContext['graph']): Promise<Map<string, AliasInfo>> {
    const index = new Map<string, AliasInfo>();

    // Находим все VARIABLE ноды
    for await (const varNode of graph.queryNodes({ nodeType: 'VARIABLE' })) {
      const expressionSource = await this.findExpressionSource(varNode, graph, new Set());
      if (expressionSource) {
        const key = `${varNode.file}:${varNode.name}`;
        index.set(key, {
          variableId: varNode.id,
          variableName: varNode.name as string,
          ...expressionSource,
          file: varNode.file!
        });
      }
    }

    // Также проверяем CONSTANT ноды (const m = obj.method)
    for await (const constNode of graph.queryNodes({ nodeType: 'CONSTANT' })) {
      const expressionSource = await this.findExpressionSource(constNode, graph, new Set());
      if (expressionSource) {
        const key = `${constNode.file}:${constNode.name}`;
        index.set(key, {
          variableId: constNode.id,
          variableName: constNode.name as string,
          ...expressionSource,
          file: constNode.file!
        });
      }
    }

    return index;
  }

  /**
   * Рекурсивно ищет EXPRESSION источник через цепочки ASSIGNED_FROM
   */
  private async findExpressionSource(
    node: NodeRecord,
    graph: PluginContext['graph'],
    visited: Set<string>,
    depth: number = 0,
    chain: string[] = []
  ): Promise<ExpressionSource | null> {
    // Добавляем текущую ноду в цепочку
    chain.push((node.name as string) || node.id);

    // Защита от бесконечных циклов
    if (visited.has(node.id.toString())) return null;
    visited.add(node.id.toString());

    // Защита от слишком глубоких цепочек
    if (depth > AliasTracker.MAX_DEPTH) {
      this.depthExceeded.push({
        file: node.file,
        name: chain[0],
        chain: chain.slice(0, 5),
        depth: depth
      });
      return null;
    }

    // Получаем ASSIGNED_FROM рёбра
    const assignedFromEdges = await graph.getOutgoingEdges(node.id, ['ASSIGNED_FROM']);

    for (const edge of assignedFromEdges) {
      const targetNode = await graph.getNode(edge.dst);
      if (!targetNode) continue;

      // Если это EXPRESSION - нашли источник!
      if (targetNode.type === 'EXPRESSION') {
        return {
          expressionId: targetNode.id,
          expressionType: targetNode.expressionType as string,
          object: targetNode.object as string | undefined,
          property: targetNode.property as string | undefined,
          computed: targetNode.computed as boolean | undefined,
          computedPropertyVar: targetNode.computedPropertyVar as string | undefined
        };
      }

      // Если это VARIABLE или CONSTANT - идём глубже (транзитивно)
      if (targetNode.type === 'VARIABLE' || targetNode.type === 'CONSTANT') {
        const result = await this.findExpressionSource(targetNode, graph, visited, depth + 1, chain);
        if (result) return result;
      }
    }

    return null;
  }

  /**
   * Строит индекс методов для резолвинга: className:methodName -> METHOD node
   */
  private async buildMethodIndex(graph: PluginContext['graph']): Promise<Map<string, NodeRecord>> {
    const index = new Map<string, NodeRecord>();

    // Индексируем методы классов
    for await (const classNode of graph.queryNodes({ nodeType: 'CLASS' })) {
      const className = classNode.name as string;
      if (!className) continue;

      const containsEdges = await graph.getOutgoingEdges(classNode.id, ['CONTAINS']);
      for (const edge of containsEdges) {
        const childNode = await graph.getNode(edge.dst);
        if (childNode && (childNode.type === 'METHOD' || childNode.type === 'FUNCTION')) {
          if (childNode.name) {
            // По имени класса
            index.set(`${className}:${childNode.name}`, childNode);
            // По файлу и имени класса
            index.set(`${classNode.file}:${className}:${childNode.name}`, childNode);
          }
        }
      }
    }

    return index;
  }

  /**
   * Пытается резолвить алиасированный method call
   */
  private async resolveAliasedMethodCall(
    objectName: string | undefined,
    propertyName: string | undefined,
    file: string,
    methodIndex: Map<string, NodeRecord>,
    graph: PluginContext['graph'],
    computedPropertyVar: string | null = null
  ): Promise<NodeRecord | null> {
    if (!objectName || !propertyName) return null;

    // Если property вычисляемый - пробуем трассировать через computedPropertyVar
    if (propertyName === '<computed>') {
      if (!computedPropertyVar) {
        return null;
      }

      if (!graph.findByAttr) {
        return null;
      }
      const varNodes = await graph.findByAttr({
        name: computedPropertyVar,
        file: file
      });

      for (const varId of varNodes) {
        const assignedFromEdges = await graph.getOutgoingEdges(varId, ['ASSIGNED_FROM']);
        for (const edge of assignedFromEdges) {
          const targetNode = await graph.getNode(edge.dst);
          if (targetNode && targetNode.type === 'LITERAL' && typeof targetNode.value === 'string') {
            propertyName = targetNode.value as string;
            break;
          }
        }
        if (propertyName !== '<computed>') break;
      }

      if (propertyName === '<computed>') {
        return null;
      }
    }

    // 1. Проверяем прямое имя класса
    const directKey = `${objectName}:${propertyName}`;
    if (methodIndex.has(directKey)) {
      return methodIndex.get(directKey)!;
    }

    // 2. Проверяем локальный класс в том же файле
    const localKey = `${file}:${objectName}:${propertyName}`;
    if (methodIndex.has(localKey)) {
      return methodIndex.get(localKey)!;
    }

    // 3. Ищем переменную с типом (INSTANCE_OF)
    if (!graph.findByAttr) {
      return null;
    }
    const varNodes = await graph.findByAttr({
      name: objectName,
      file: file
    });

    for (const varId of varNodes) {
      const instanceOfEdges = await graph.getOutgoingEdges(varId, ['INSTANCE_OF']);
      for (const edge of instanceOfEdges) {
        const classNode = await graph.getNode(edge.dst);
        if (classNode && classNode.name) {
          const classKey = `${classNode.name}:${propertyName}`;
          if (methodIndex.has(classKey)) {
            return methodIndex.get(classKey)!;
          }
        }
      }
    }

    return null;
  }
}
