/**
 * InstanceOfResolver - резолвит INSTANCE_OF edges к правильным CLASS нодам
 *
 * Проблема: При параллельном анализе модулей, CLASS ноды для импортированных
 * классов создаются как "заглушки" (isInstantiationRef: true) потому что
 * исходный модуль может ещё не быть проанализирован.
 *
 * Решение: После анализа всех модулей этот плагин:
 * 1. Находит все INSTANCE_OF edges
 * 2. Для edges указывающих на "заглушки" (CLASS с isInstantiationRef)
 * 3. Ищет настоящую CLASS декларацию через IMPORT → MODULE → CLASS
 * 4. Перенаправляет INSTANCE_OF edge на настоящий CLASS
 * 5. Удаляет "заглушку" CLASS ноду
 */

import { dirname, resolve } from 'path';
import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';

/**
 * Stub info
 */
interface StubInfo {
  name: string;
  file: string;
}

/**
 * Import info
 */
interface ImportInfo {
  source: string;
  imported: string;
}

/**
 * Edge update info
 */
interface EdgeUpdate {
  src: string;
  oldDst: string;
  newDst: string;
}

export class InstanceOfResolver extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'InstanceOfResolver',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],
        edges: ['INSTANCE_OF']  // Пере-создаёт INSTANCE_OF edges
      },
      dependencies: ['JSASTAnalyzer'],
      consumes: ['INSTANCE_OF'],
      produces: ['INSTANCE_OF']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);
    let resolvedCount = 0;
    let removedStubs = 0;

    // 1. Собираем все CLASS ноды (декларации и заглушки)
    const classDeclarations = new Map<string, string>(); // file:name → classId (только настоящие декларации)
    const classStubs = new Map<string, StubInfo>(); // classId → { name, file }

    for await (const node of graph.queryNodes({ type: 'CLASS' })) {
      if ((node as NodeRecord & { isInstantiationRef?: boolean }).isInstantiationRef) {
        classStubs.set(node.id, { name: node.name as string, file: node.file! });
      } else {
        // Настоящая декларация
        const key = `${node.file}:${node.name}`;
        classDeclarations.set(key, node.id);
      }
    }

    if (classStubs.size === 0) {
      return createSuccessResult({ nodes: 0, edges: 0 }, { resolvedInstanceOf: 0, removedStubs: 0 });
    }

    // 2. Собираем импорты для резолва
    const importMap = new Map<string, ImportInfo>(); // file:localName → { source, imported }
    for await (const node of graph.queryNodes({ type: 'IMPORT' })) {
      const importNode = node as NodeRecord & { local?: string; source?: string; imported?: string };
      const key = `${node.file}:${importNode.local}`;
      importMap.set(key, { source: importNode.source!, imported: importNode.imported! });
    }

    // 3. Для каждой заглушки пытаемся найти настоящую декларацию
    const edgesToUpdate: EdgeUpdate[] = [];
    const stubsToRemove: string[] = [];

    const startTime = Date.now();
    logger.info('Found class stubs to resolve', { count: classStubs.size });
    let processed = 0;
    for (const [stubId, stubInfo] of classStubs) {
      processed++;
      if (onProgress && processed % 50 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'InstanceOfResolver',
          message: `Resolving instance stubs ${processed}/${classStubs.size} (${elapsed}s)`,
          totalFiles: classStubs.size,
          processedFiles: processed
        });
      }
      const { name, file } = stubInfo;

      // Проверяем есть ли импорт для этого класса
      const importKey = `${file}:${name}`;
      const importInfo = importMap.get(importKey);

      if (!importInfo) continue;

      const { source, imported } = importInfo;

      // Только относительные импорты (локальные модули)
      if (!source.startsWith('./') && !source.startsWith('../')) continue;

      // Резолвим путь к исходному модулю
      const moduleDir = dirname(file);
      let resolvedPath = resolve(moduleDir, source);
      if (!resolvedPath.endsWith('.js') && !resolvedPath.endsWith('.ts') && !resolvedPath.endsWith('.mjs')) {
        resolvedPath += '.js';
      }

      // Ищем CLASS декларацию в исходном модуле
      const importedClassName = imported === 'default' ? name : imported;
      const declarationKey = `${resolvedPath}:${importedClassName}`;
      const realClassId = classDeclarations.get(declarationKey);

      if (realClassId) {
        // Нашли настоящий класс!
        // Собираем INSTANCE_OF edges указывающие на заглушку
        const incomingEdges = await graph.getIncomingEdges(stubId, ['INSTANCE_OF']);
        for (const edge of incomingEdges) {
          edgesToUpdate.push({
            src: edge.src,
            oldDst: stubId,
            newDst: realClassId
          });
        }
        stubsToRemove.push(stubId);
      }
    }

    // 4. Обновляем edges (удаляем старые, создаём новые)
    for (const update of edgesToUpdate) {
      // Удаляем старый edge (if supported)
      if (graph.deleteEdge) {
        await graph.deleteEdge(update.src, update.oldDst, 'INSTANCE_OF');
      }

      // Создаём новый edge
      await graph.addEdge({
        type: 'INSTANCE_OF',
        src: update.src,
        dst: update.newDst
      });

      resolvedCount++;
    }

    // 5. Удаляем заглушки (if supported)
    for (const stubId of stubsToRemove) {
      if (graph.deleteNode) {
        await graph.deleteNode(stubId);
        removedStubs++;
      }
    }

    logger.info('Complete', { resolvedInstanceOf: resolvedCount, removedStubs });

    return createSuccessResult(
      { nodes: 0, edges: resolvedCount },
      { resolvedInstanceOf: resolvedCount, removedStubs: removedStubs }
    );
  }
}
