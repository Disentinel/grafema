/**
 * IncrementalAnalysisPlugin - плагин для инкрементального анализа
 *
 * НАЗНАЧЕНИЕ:
 * Обнаруживает изменённые файлы через VCS (Git) и создаёт __local версии
 * только для изменённых нод, используя fine-grained merge
 *
 * АЛГОРИТМ:
 * 1. Получить список изменённых файлов из VCS
 * 2. Для каждого файла:
 *    - Парсить новый код
 *    - Получить main версию нод
 *    - Классифицировать: added/modified/deleted/unchanged
 *    - Создать __local версии только для added/modified
 * 3. Переанализировать изменённые ноды для создания связей
 *
 * ВЕРСИИ:
 * - "main" - committed код (git HEAD)
 * - "__local" - uncommitted изменения
 */

import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { GraphBackend } from '@grafema/types';
import type { NodeRecord } from '@grafema/types';
import { versionManager, VersionedNode } from '../../core/VersionManager.js';
import { VCSPluginFactory } from '../vcs/index.js';
import type { VCSPlugin } from '../vcs/VCSPlugin.js';
import { parse, ParserPlugin } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import { readFile } from 'fs/promises';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse = (traverseModule as any).default || traverseModule;

/**
 * Manifest with project path
 */
interface AnalysisManifest {
  projectPath: string;
  [key: string]: unknown;
}

/**
 * Changed file info from VCS
 */
interface ChangedFileInfo {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

/**
 * Call site info
 */
interface CallSite {
  callee: string;
  object?: string;
  method?: string;
  type: 'FUNCTION_CALL' | 'METHOD_CALL';
}

/**
 * Extended graph interface with version methods
 */
interface VersionAwareGraph extends GraphBackend {
  getNodesByVersion(
    version: string,
    filter: { file: string }
  ): Promise<VersionedNode[]>;
  getNodesByStableId(stableId: string): Promise<VersionedNode[]>;
}

export class IncrementalAnalysisPlugin extends Plugin {
  private vcsPlugin: VCSPlugin | null = null;

  get metadata(): PluginMetadata {
    return {
      name: 'IncrementalAnalysisPlugin',
      phase: 'ANALYSIS',
      priority: 85, // Запускается после JSModuleIndexer (90) но перед JSASTAnalyzer (80)
      creates: {
        nodes: ['FUNCTION', 'CLASS', 'VARIABLE_DECLARATION'], // Создаёт __local версии
        edges: ['REPLACES', 'CALLS', 'USES']
      },
      dependencies: ['JSModuleIndexer']
    };
  }

  async initialize(context: PluginContext): Promise<void> {
    // Инициализируем VCS плагин
    const manifest = context.manifest as AnalysisManifest | undefined;
    this.vcsPlugin = await VCSPluginFactory.detect({
      rootPath: manifest?.projectPath
    });

    if (!this.vcsPlugin) {
      console.log('[IncrementalAnalysis] No VCS detected, skipping incremental analysis');
    } else {
      console.log(`[IncrementalAnalysis] Using VCS: ${this.vcsPlugin.metadata.name}`);
    }
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    try {
      const { graph } = context;
      const manifest = context.manifest as AnalysisManifest | undefined;
      const projectPath = manifest?.projectPath ?? '';

      // Если нет VCS - пропускаем инкрементальный анализ
      if (!this.vcsPlugin) {
        return createSuccessResult(
          { nodes: 0, edges: 0 },
          {
            skipped: true,
            reason: 'No VCS detected'
          }
        );
      }

      // Проверяем наличие uncommitted изменений
      const hasChanges = await this.vcsPlugin.hasUncommittedChanges();
      if (!hasChanges) {
        console.log('[IncrementalAnalysis] No uncommitted changes detected');
        return createSuccessResult(
          { nodes: 0, edges: 0 },
          {
            skipped: true,
            reason: 'No uncommitted changes'
          }
        );
      }

      // Получаем список изменённых файлов
      const changedFiles = (await this.vcsPlugin.getChangedFiles()) as ChangedFileInfo[];
      console.log(
        `[IncrementalAnalysis] All changed files:`,
        changedFiles.map(f => f.path)
      );

      const jsFiles = changedFiles.filter(
        file =>
          file.path.endsWith('.js') || file.path.endsWith('.mjs') || file.path.endsWith('.cjs')
      );

      if (jsFiles.length === 0) {
        console.log('[IncrementalAnalysis] No JavaScript files changed');
        return createSuccessResult(
          { nodes: 0, edges: 0 },
          {
            skipped: true,
            reason: 'No JS files changed'
          }
        );
      }

      console.log(
        `[IncrementalAnalysis] Found ${jsFiles.length} changed JS files:`,
        jsFiles.map(f => f.path)
      );

      let totalNodesCreated = 0;
      let totalEdgesCreated = 0;

      // Обрабатываем каждый изменённый файл
      for (const fileInfo of jsFiles) {
        const result = await this.processChangedFile(
          fileInfo,
          projectPath,
          graph as unknown as VersionAwareGraph
        );
        totalNodesCreated += result.nodesCreated;
        totalEdgesCreated += result.edgesCreated;
      }

      console.log(
        `[IncrementalAnalysis] Created ${totalNodesCreated} __local nodes, ${totalEdgesCreated} edges`
      );

      return createSuccessResult(
        { nodes: totalNodesCreated, edges: totalEdgesCreated },
        {
          filesProcessed: jsFiles.length,
          changedFiles: jsFiles.map(f => ({ path: f.path, status: f.status }))
        }
      );
    } catch (error) {
      console.error('[IncrementalAnalysis] Error:', error);
      return createErrorResult(error as Error);
    }
  }

  /**
   * Обработать один изменённый файл
   */
  private async processChangedFile(
    fileInfo: ChangedFileInfo,
    projectPath: string,
    graph: VersionAwareGraph
  ): Promise<{ nodesCreated: number; edgesCreated: number }> {
    const { path: relativePath, status } = fileInfo;
    // relativePath может начинаться с / или быть относительным
    const fullPath = relativePath.startsWith('/') ? relativePath : `${projectPath}/${relativePath}`;

    console.log(`[IncrementalAnalysis] Processing ${relativePath} (${status})`);

    // Если файл удалён - ничего не делаем (main версия остаётся, __local не создаём)
    if (status === 'deleted') {
      console.log(`  → File deleted, keeping main version only`);
      return { nodesCreated: 0, edgesCreated: 0 };
    }

    // Выполняем fine-grained merge
    const result = await this.finegrainedMerge(fullPath, graph);

    console.log(
      `  → Added: ${result.added}, Modified: ${result.modified}, Unchanged: ${result.unchanged}, Deleted: ${result.deleted}`
    );

    return {
      nodesCreated: result.added + result.modified,
      edgesCreated: result.edgesCreated || 0
    };
  }

  /**
   * Fine-grained merge - ключевая функция инкрементального анализа
   */
  private async finegrainedMerge(
    filePath: string,
    graph: VersionAwareGraph
  ): Promise<{
    added: number;
    modified: number;
    unchanged: number;
    deleted: number;
    edgesCreated: number;
  }> {
    // 1. Парсим новое содержимое файла
    const newContent = await readFile(filePath, 'utf-8');
    const newNodes = await this.extractTopLevelNodes(newContent, filePath);

    console.log(`  → Parsed ${newNodes.length} nodes from new content`);

    // 2. Получаем существующие main ноды для этого файла
    const mainNodes = await graph.getNodesByVersion('main', {
      file: filePath
    });

    const mainTopLevel = mainNodes.filter(node =>
      ['FUNCTION', 'CLASS', 'VARIABLE_DECLARATION', 'MODULE'].includes(node.type!)
    );

    console.log(`  → Found ${mainTopLevel.length} existing main nodes`);

    // 3. Классифицируем изменения
    const changes = versionManager.classifyChanges(mainTopLevel, newNodes);

    console.log(
      `  → Classification: +${changes.added.length} ~${changes.modified.length} =${changes.unchanged.length} -${changes.deleted.length}`
    );

    // 4. Создаём __local версии для added/modified нод
    let edgesCreated = 0;

    // 4a. ADDED nodes - просто создаём с версией __local
    for (const node of changes.added) {
      const enrichedNode = versionManager.enrichNodeWithVersion(node, '__local');
      await graph.addNode(enrichedNode as unknown as NodeRecord);
    }

    // 4b. MODIFIED nodes - создаём __local версию + REPLACES ребро
    for (const { old: oldNode, new: newNode } of changes.modified) {
      const mainNodeId = versionManager.generateVersionedId(oldNode, 'main');
      const enrichedNode = versionManager.enrichNodeWithVersion(newNode, '__local', {
        replacesId: mainNodeId
      });

      await graph.addNode(enrichedNode as unknown as NodeRecord);

      // Создаём REPLACES ребро
      const replacesEdge = versionManager.createReplacesEdge(enrichedNode.id!, mainNodeId);
      console.log(`    [REPLACES] ${newNode.name}: ${enrichedNode.id} → ${mainNodeId}`);
      await graph.addEdge({
        type: replacesEdge.type,
        src: replacesEdge.fromId,
        dst: replacesEdge.toId
      });
      edgesCreated++;
    }

    // 4c. UNCHANGED nodes - не создаём __local версию (используется main)
    // 4d. DELETED nodes - не создаём __local версию (main остаётся, показывая что было удалено)

    // 5. Переанализируем изменённые ноды для создания связей (CALLS, USES)
    const nodesToReanalyze = [...changes.added, ...changes.modified.map(m => m.new)];

    if (nodesToReanalyze.length > 0) {
      const reanalyzeResult = await this.reanalyzeNodes(nodesToReanalyze, filePath, '__local', graph);
      edgesCreated += reanalyzeResult.edgesCreated;
    }

    return {
      added: changes.added.length,
      modified: changes.modified.length,
      unchanged: changes.unchanged.length,
      deleted: changes.deleted.length,
      edgesCreated
    };
  }

  /**
   * Извлечь top-level ноды из файла
   */
  private async extractTopLevelNodes(content: string, filePath: string): Promise<VersionedNode[]> {
    const nodes: VersionedNode[] = [];

    try {
      // Парсим с помощью Babel
      const ast = parse(content, {
        sourceType: 'module',
        plugins: [
          'jsx',
          'typescript',
          'decorators-legacy',
          'classProperties',
          'objectRestSpread',
          'optionalChaining',
          'nullishCoalescingOperator'
        ] as ParserPlugin[]
      });

      // Обходим AST и извлекаем top-level декларации
      traverse(ast, {
        // Function Declarations (включая export function)
        FunctionDeclaration: (path: NodePath) => {
          // Только top-level функции (родитель - Program или ExportNamedDeclaration)
          const parentType = path.parent.type;
          if (
            parentType !== 'Program' &&
            parentType !== 'ExportNamedDeclaration' &&
            parentType !== 'ExportDefaultDeclaration'
          ) {
            return;
          }

          const node = path.node as {
            id?: { name: string };
            params: Array<{ name?: string; type: string }>;
            async?: boolean;
            generator?: boolean;
            body: { start: number; end: number };
            loc?: { start: { line: number; column: number } };
          };

          nodes.push({
            type: 'FUNCTION',
            name: node.id?.name || 'anonymous',
            file: filePath,
            line: node.loc?.start.line || 0,
            column: node.loc?.start.column || 0,
            params: node.params.map(p => p.name || p.type),
            async: node.async || false,
            exported:
              this.isExported(path) ||
              parentType === 'ExportNamedDeclaration' ||
              parentType === 'ExportDefaultDeclaration',
            bodyHash: versionManager.calculateBodyHash(content.substring(node.body.start, node.body.end)) ?? undefined
          });
        },

        // Class Declarations
        ClassDeclaration: (path: NodePath) => {
          const parentType = path.parent.type;
          if (
            parentType !== 'Program' &&
            parentType !== 'ExportNamedDeclaration' &&
            parentType !== 'ExportDefaultDeclaration'
          ) {
            return;
          }

          const node = path.node as {
            id?: { name: string };
            superClass?: { name: string };
            body: { body: Array<{ type: string; key: { name: string } }> };
            loc?: { start: { line: number; column: number } };
          };

          const methods = node.body.body
            .filter(member => member.type === 'ClassMethod')
            .map(method => method.key.name);

          nodes.push({
            type: 'CLASS',
            name: node.id?.name || 'anonymous',
            file: filePath,
            line: node.loc?.start.line || 0,
            column: node.loc?.start.column || 0,
            methods: methods,
            exported:
              this.isExported(path) ||
              parentType === 'ExportNamedDeclaration' ||
              parentType === 'ExportDefaultDeclaration',
            extends: node.superClass?.name || undefined
          });
        },

        // Variable Declarations (const, let, var)
        VariableDeclaration: (path: NodePath) => {
          const parentType = path.parent.type;
          if (parentType !== 'Program' && parentType !== 'ExportNamedDeclaration') {
            return;
          }

          const node = path.node as {
            kind: string;
            declarations: Array<{ id: { type: string; name: string }; init: unknown | null }>;
            loc?: { start: { line: number; column: number } };
          };

          // Каждый declarator - отдельная нода
          for (const declarator of node.declarations) {
            if (declarator.id.type === 'Identifier') {
              nodes.push({
                type: 'VARIABLE_DECLARATION',
                name: declarator.id.name,
                file: filePath,
                line: node.loc?.start.line || 0,
                column: node.loc?.start.column || 0,
                kind: node.kind // const, let, var
              });
            }
          }
        }
      });
    } catch (error) {
      console.error(`  ✗ Failed to parse ${filePath}:`, (error as Error).message);
    }

    return nodes;
  }

  /**
   * Проверить, экспортируется ли нода
   */
  private isExported(path: NodePath): boolean {
    // Проверяем родительский узел
    const parent = path.parent;

    if (parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportDefaultDeclaration') {
      return true;
    }

    // Проверяем наличие export в том же scope
    // export { foo, bar }
    const programPath = path.findParent(p => p.isProgram());
    if (programPath) {
      const nodeName = (path.node as { id?: { name: string } }).id?.name;
      if (!nodeName) return false;

      let isExported = false;
      programPath.traverse({
        ExportNamedDeclaration: (exportPath: NodePath) => {
          const specifiers = (exportPath.node as { specifiers?: Array<{ exported?: { name: string }; local?: { name: string } }> }).specifiers;
          if (specifiers) {
            for (const spec of specifiers) {
              if (spec.exported?.name === nodeName || spec.local?.name === nodeName) {
                isExported = true;
              }
            }
          }
        }
      });

      return isExported;
    }

    return false;
  }

  /**
   * Переанализировать ноды для создания CALLS/USES edges
   */
  private async reanalyzeNodes(
    nodes: VersionedNode[],
    filePath: string,
    version: string,
    graph: VersionAwareGraph
  ): Promise<{ edgesCreated: number }> {
    let edgesCreated = 0;

    try {
      // Читаем файл заново
      const content = await readFile(filePath, 'utf-8');

      // Парсим AST
      const ast = parse(content, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript', 'decorators-legacy'] as ParserPlugin[]
      });

      // Для каждой ноды ищем её в AST и анализируем
      for (const node of nodes) {
        if (node.type === 'FUNCTION') {
          const functionEdges = await this.analyzeFunctionCalls(node, ast, version, graph);
          edgesCreated += functionEdges;
        } else if (node.type === 'CLASS') {
          const classEdges = await this.analyzeClassMethods(node, ast, version, graph);
          edgesCreated += classEdges;
        }
      }

      console.log(`  → Reanalyzed ${nodes.length} nodes, created ${edgesCreated} edges`);

      return { edgesCreated };
    } catch (error) {
      console.error(`[IncrementalAnalysis] Error reanalyzing nodes:`, error);
      return { edgesCreated: 0 };
    }
  }

  /**
   * Анализировать вызовы функций внутри функции
   */
  private async analyzeFunctionCalls(
    functionNode: VersionedNode,
    ast: unknown,
    version: string,
    graph: VersionAwareGraph
  ): Promise<number> {
    let edgesCreated = 0;
    let functionPath: NodePath | null = null;

    // Ищем функцию в AST по имени
    traverse(ast, {
      FunctionDeclaration: (path: NodePath) => {
        const node = path.node as { id?: { name: string } };
        if (node.id?.name === functionNode.name) {
          functionPath = path;
          path.stop();
        }
      },

      // Arrow functions и function expressions в VariableDeclaration
      VariableDeclarator: (path: NodePath) => {
        const node = path.node as { id?: { name: string }; init?: { type: string } };
        if (node.id?.name === functionNode.name) {
          if (
            node.init?.type === 'ArrowFunctionExpression' ||
            node.init?.type === 'FunctionExpression'
          ) {
            functionPath = path.get('init') as NodePath;
            path.stop();
          }
        }
      }
    });

    // Если нашли функцию, анализируем её тело
    if (functionPath) {
      edgesCreated = await this.traverseFunctionBody(functionPath, functionNode, version, graph);
    }

    return edgesCreated;
  }

  /**
   * Traverse function body для поиска CALLS
   */
  private async traverseFunctionBody(
    path: NodePath,
    functionNode: VersionedNode,
    version: string,
    graph: VersionAwareGraph
  ): Promise<number> {
    const callSites: CallSite[] = [];

    // Собираем все CallExpression внутри функции
    path.traverse({
      CallExpression: (callPath: NodePath) => {
        const node = callPath.node as { callee: { type: string; name?: string; object?: { name: string }; property?: { name: string } } };
        const callee = node.callee;

        // Простые вызовы: foo()
        if (callee.type === 'Identifier') {
          callSites.push({
            callee: callee.name!,
            type: 'FUNCTION_CALL'
          });
        }

        // Method calls: obj.method()
        else if (callee.type === 'MemberExpression') {
          const objectName = callee.object?.name;
          const methodName = callee.property?.name;

          if (objectName && methodName) {
            callSites.push({
              callee: `${objectName}.${methodName}`,
              object: objectName,
              method: methodName,
              type: 'METHOD_CALL'
            });
          }
        }
      }
    });

    // Создаём CALLS edges для каждого call site (последовательно)
    let edgesCreated = 0;
    for (const callSite of callSites) {
      // Генерируем ID для caller (__local версия)
      const callerId = versionManager.generateVersionedId(functionNode, version);

      // Пытаемся найти callee в графе (сначала __local, потом main)
      const calleeName = callSite.callee.split('.')[0]; // Для method calls берём объект
      const calleeStableId = `FUNCTION:${calleeName}:${functionNode.file}`;

      // Ищем callee в базе
      try {
        const created = await this.findCalleeAndCreateEdge(callerId, calleeStableId, version, graph);
        if (created) edgesCreated++;
      } catch (err) {
        console.error(`[IncrementalAnalysis] Error creating CALLS edge:`, err);
      }
    }

    return edgesCreated;
  }

  /**
   * Найти callee и создать CALLS edge
   */
  private async findCalleeAndCreateEdge(
    callerId: string,
    calleeStableId: string,
    version: string,
    graph: VersionAwareGraph
  ): Promise<boolean> {
    try {
      // Ищем callee сначала в __local, потом в main
      const calleeVersions = await graph.getNodesByStableId(calleeStableId);

      if (calleeVersions.length === 0) {
        // Callee не найден - возможно это external функция
        return false;
      }

      // Предпочитаем __local версию, если есть
      const calleeNode =
        calleeVersions.find(n => n.version === '__local') ||
        calleeVersions.find(n => n.version === 'main');

      if (!calleeNode) {
        return false;
      }

      // Создаём CALLS edge
      await graph.addEdge({
        type: 'CALLS',
        src: callerId,
        dst: calleeNode.id!
      });

      return true;
    } catch (error) {
      console.error(`[IncrementalAnalysis] Error finding callee:`, error);
      return false;
    }
  }

  /**
   * Анализировать методы класса
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async analyzeClassMethods(
    _classNode: VersionedNode,
    _ast: unknown,
    _version: string,
    _graph: VersionAwareGraph
  ): Promise<number> {
    // TODO: реализовать анализ методов класса
    return 0;
  }
}
