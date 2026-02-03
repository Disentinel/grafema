/**
 * MethodCallResolver - обогащает METHOD_CALL ноды связями CALLS к определениям методов
 *
 * Находит вызовы методов (CALL с "object" атрибутом) и пытается связать их с:
 * 1. Методами классов в том же файле
 * 2. Методами классов в импортированных модулях
 * 3. Методами объектов переменных
 *
 * СОЗДАЁТ РЁБРА:
 * - METHOD_CALL -> CALLS -> METHOD (для методов классов)
 * - METHOD_CALL -> CALLS -> FUNCTION (для методов объектов)
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';
import { StrictModeError } from '../../errors/GrafemaError.js';

/**
 * Extended call node with method properties
 */
interface MethodCallNode extends BaseNodeRecord {
  object?: string;
  method?: string;
}

/**
 * Class entry in method index
 */
interface ClassEntry {
  classNode: BaseNodeRecord;
  methods: Map<string, BaseNodeRecord>;
}

export class MethodCallResolver extends Plugin {
  private _containingClassCache?: Map<string, BaseNodeRecord | null>;

  get metadata(): PluginMetadata {
    return {
      name: 'MethodCallResolver',
      phase: 'ENRICHMENT',
      priority: 50,
      creates: {
        nodes: [],
        edges: ['CALLS']
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    logger.info('Starting method call resolution');

    let methodCallsProcessed = 0;
    let edgesCreated = 0;
    let unresolved = 0;
    const errors: Error[] = [];

    // Собираем все METHOD_CALL ноды (CALL с object атрибутом)
    const methodCalls: MethodCallNode[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      const callNode = node as MethodCallNode;
      if (callNode.object) {
        methodCalls.push(callNode);
      }
    }

    logger.info('Found method calls to resolve', { count: methodCalls.length });

    // Собираем все классы и их методы для быстрого поиска
    const classMethodIndex = await this.buildClassMethodIndex(graph, logger);
    logger.info('Indexed classes', { count: classMethodIndex.size });

    // Собираем переменные и их типы (если известны)
    const variableTypes = await this.buildVariableTypeIndex(graph, logger);

    const startTime = Date.now();

    for (const methodCall of methodCalls) {
      methodCallsProcessed++;

      // Report progress every 50 calls
      if (onProgress && methodCallsProcessed % 50 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'MethodCallResolver',
          message: `Resolving method calls ${methodCallsProcessed}/${methodCalls.length} (${elapsed}s)`,
          totalFiles: methodCalls.length,
          processedFiles: methodCallsProcessed
        });
      }

      // Log every 10 calls with timing
      if (methodCallsProcessed % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const avgTime = ((Date.now() - startTime) / methodCallsProcessed).toFixed(0);
        logger.debug('Progress', {
          processed: methodCallsProcessed,
          total: methodCalls.length,
          elapsed: `${elapsed}s`,
          avgTime: `${avgTime}ms/call`
        });
      }

      // Пропускаем внешние методы (console, Array.prototype, etc.)
      if (this.isExternalMethod(methodCall.object!, methodCall.method!)) {
        continue;
      }

      // Проверяем есть ли уже CALLS ребро
      const existingEdges = await graph.getOutgoingEdges(methodCall.id, ['CALLS']);
      if (existingEdges.length > 0) {
        continue; // Уже есть связь
      }

      // Пытаемся найти определение метода
      const targetMethod = await this.resolveMethodCall(
        methodCall,
        classMethodIndex,
        variableTypes,
        graph
      );

      if (targetMethod) {
        await graph.addEdge({
          src: methodCall.id,
          dst: targetMethod.id,
          type: 'CALLS'
        });
        edgesCreated++;
      } else {
        unresolved++;

        // In strict mode, collect error for later reporting
        if (context.strictMode) {
          const error = new StrictModeError(
            `Cannot resolve method call: ${methodCall.object}.${methodCall.method}`,
            'STRICT_UNRESOLVED_METHOD',
            {
              filePath: methodCall.file,
              lineNumber: methodCall.line as number | undefined,
              phase: 'ENRICHMENT',
              plugin: 'MethodCallResolver',
              object: methodCall.object,
              method: methodCall.method,
            },
            `Check if class "${methodCall.object}" is imported and has method "${methodCall.method}"`
          );
          errors.push(error);
        }
      }
    }

    const summary = {
      methodCallsProcessed,
      edgesCreated,
      unresolved,
      classesIndexed: classMethodIndex.size
    };

    logger.info('Summary', summary);

    return createSuccessResult({ nodes: 0, edges: edgesCreated }, summary, errors);
  }

  /**
   * Строит индекс классов и их методов
   */
  private async buildClassMethodIndex(graph: PluginContext['graph'], logger: ReturnType<typeof this.log>): Promise<Map<string, ClassEntry>> {
    const index = new Map<string, ClassEntry>();
    const startTime = Date.now();
    let classCount = 0;

    for await (const classNode of graph.queryNodes({ nodeType: 'CLASS' })) {
      classCount++;
      if (classCount % 50 === 0) {
        logger.debug('Indexing classes', { count: classCount });
      }

      const className = classNode.name as string;
      if (!className) continue;

      const classEntry: ClassEntry = {
        classNode,
        methods: new Map()
      };

      const containsEdges = await graph.getOutgoingEdges(classNode.id, ['CONTAINS']);
      for (const edge of containsEdges) {
        const childNode = await graph.getNode(edge.dst);
        if (childNode && (childNode.type === 'METHOD' || childNode.type === 'FUNCTION')) {
          if (childNode.name) {
            classEntry.methods.set(childNode.name as string, childNode);
          }
        }
      }

      index.set(className, classEntry);

      // Также индексируем по файлу для локального резолвинга
      const fileKey = `${classNode.file}:${className}`;
      index.set(fileKey, classEntry);
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.debug('Indexed class entries', { count: index.size, time: `${totalTime}s` });

    return index;
  }

  /**
   * Строит индекс переменных и их типов (из INSTANCE_OF рёбер)
   */
  private async buildVariableTypeIndex(graph: PluginContext['graph'], logger: ReturnType<typeof this.log>): Promise<Map<string, string>> {
    const startTime = Date.now();
    const index = new Map<string, string>();

    for await (const classNode of graph.queryNodes({ nodeType: 'CLASS' })) {
      if (!classNode.name) continue;

      const incomingEdges = await graph.getIncomingEdges(classNode.id, ['INSTANCE_OF']);
      for (const edge of incomingEdges) {
        index.set(edge.src.toString(), classNode.name as string);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.debug('Built variable type index', { entries: index.size, time: `${elapsed}s` });
    return index;
  }

  /**
   * Пытается найти определение метода
   */
  private async resolveMethodCall(
    methodCall: MethodCallNode,
    classMethodIndex: Map<string, ClassEntry>,
    variableTypes: Map<string, string>,
    graph: PluginContext['graph']
  ): Promise<BaseNodeRecord | null> {
    const { object, method, file } = methodCall;

    if (!object || !method) return null;

    // 1. Проверяем если object - это имя класса напрямую (статический вызов)
    if (classMethodIndex.has(object)) {
      const classEntry = classMethodIndex.get(object)!;
      if (classEntry.methods.has(method)) {
        return classEntry.methods.get(method)!;
      }
    }

    // 2. Проверяем локальный класс в том же файле
    const localKey = `${file}:${object}`;
    if (classMethodIndex.has(localKey)) {
      const classEntry = classMethodIndex.get(localKey)!;
      if (classEntry.methods.has(method)) {
        return classEntry.methods.get(method)!;
      }
    }

    // 3. Проверяем если object - это "this" (ссылка на текущий класс)
    if (object === 'this') {
      if (!this._containingClassCache) this._containingClassCache = new Map();

      let containingClass = this._containingClassCache.get(methodCall.id);
      if (containingClass === undefined) {
        containingClass = await this.findContainingClass(methodCall, graph);
        this._containingClassCache.set(methodCall.id, containingClass);
      }

      if (containingClass && classMethodIndex.has(containingClass.name as string)) {
        const classEntry = classMethodIndex.get(containingClass.name as string)!;
        if (classEntry.methods.has(method)) {
          return classEntry.methods.get(method)!;
        }
      }
    }

    // 4. Используем variableTypes индекс
    for (const [, className] of variableTypes.entries()) {
      if (className && classMethodIndex.has(className)) {
        const classEntry = classMethodIndex.get(className)!;
        if (classEntry.methods.has(method)) {
          return classEntry.methods.get(method)!;
        }
      }
    }

    return null;
  }

  /**
   * Находит класс, содержащий данный method call
   */
  private async findContainingClass(
    methodCall: MethodCallNode,
    graph: PluginContext['graph']
  ): Promise<BaseNodeRecord | null> {
    const incomingEdges = await graph.getIncomingEdges(methodCall.id, ['CONTAINS']);

    for (const edge of incomingEdges) {
      const parentNode = await graph.getNode(edge.src);
      if (!parentNode) continue;

      if (parentNode.type === 'CLASS') {
        return parentNode;
      }

      const found = await this.findContainingClassRecursive(parentNode, graph, new Set());
      if (found) return found;
    }

    return null;
  }

  private async findContainingClassRecursive(
    node: BaseNodeRecord,
    graph: PluginContext['graph'],
    visited: Set<string>
  ): Promise<BaseNodeRecord | null> {
    if (visited.has(node.id.toString())) return null;
    visited.add(node.id.toString());

    const incomingEdges = await graph.getIncomingEdges(node.id, ['CONTAINS']);

    for (const edge of incomingEdges) {
      const parentNode = await graph.getNode(edge.src);
      if (!parentNode) continue;

      if (parentNode.type === 'CLASS') {
        return parentNode;
      }

      const found = await this.findContainingClassRecursive(parentNode, graph, visited);
      if (found) return found;
    }

    return null;
  }

  /**
   * Проверяет является ли метод внешним (console, Array, Promise, etc.)
   */
  private isExternalMethod(object: string, method: string): boolean {
    const externalObjects = new Set([
      'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
      'Boolean', 'Date', 'RegExp', 'Error', 'Promise', 'Set', 'Map',
      'WeakSet', 'WeakMap', 'Symbol', 'Proxy', 'Reflect', 'Intl',
      'process', 'global', 'window', 'document', 'Buffer',
      'fs', 'path', 'http', 'https', 'crypto', 'os', 'url', 'util'
    ]);

    return externalObjects.has(object);
  }
}
