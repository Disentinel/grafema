/**
 * JSASTAnalyzer - плагин для парсинга JavaScript AST
 * Создаёт ноды: FUNCTION, CLASS, METHOD и т.д.
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { NodePath, TraverseOptions, Visitor } from '@babel/traverse';
import * as t from '@babel/types';

// Type for CJS/ESM interop - @babel/traverse exports a function but @types defines it as namespace
type TraverseFn = (ast: t.Node, opts: TraverseOptions) => void;
const rawModule = traverseModule as unknown as TraverseFn | { default: TraverseFn };
const traverse: TraverseFn = typeof rawModule === 'function' ? rawModule : rawModule.default;

// Type guard for analysis result
interface AnalysisResult {
  nodes: number;
  edges: number;
}

function isAnalysisResult(value: unknown): value is AnalysisResult {
  if (typeof value !== 'object' || value === null) return false;
  if (!('nodes' in value) || !('edges' in value)) return false;
  // After 'in' checks, TS knows properties exist; widening to unknown is safe
  const { nodes, edges } = value as { nodes: unknown; edges: unknown };
  return typeof nodes === 'number' && typeof edges === 'number';
}

import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import { GraphBuilder, GraphDataError } from './ast/GraphBuilder.js';
import {
  ImportExportVisitor,
  VariableVisitor,
  FunctionVisitor,
  ClassVisitor,
  CallExpressionVisitor,
  TypeScriptVisitor,
  PropertyAccessVisitor,
  type VisitorModule,
  type VisitorCollections,
  type TrackVariableAssignmentCallback
} from './ast/visitors/index.js';
import { Task } from '../../core/Task.js';
import { PriorityQueue } from '../../core/PriorityQueue.js';
import { WorkerPool } from '../../core/WorkerPool.js';
import { ASTWorkerPool, type ModuleInfo as ASTModuleInfo, type ParseResult } from '../../core/ASTWorkerPool.js';
import { getLine, getColumn } from './ast/utils/location.js';
import { Profiler } from '../../core/Profiler.js';
import { ScopeTracker } from '../../core/ScopeTracker.js';
import { IdGenerator } from './ast/IdGenerator.js';
import { CollisionResolver } from './ast/CollisionResolver.js';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';
import type { PluginContext, PluginResult, PluginMetadata, GraphBackend, NodeRecord } from '@grafema/types';
import type {
  ModuleNode,
  FunctionInfo,
  ASTCollections,
} from './ast/types.js';
import { extractNamesFromPattern } from './ast/utils/extractNamesFromPattern.js';
import {
  collectUpdateExpression as collectUpdateExpressionFn,
} from './ast/mutation-detection/index.js';
import {
  trackVariableAssignment as trackVariableAssignmentFn,
} from './ast/extractors/index.js';
import { extractReturnExpressionInfo as extractReturnExpressionInfoFn } from './ast/extractors/ReturnExpressionExtractor.js';
import { createModuleLevelAssignmentVisitor } from './ast/extractors/ModuleLevelAssignmentExtractor.js';
import { createModuleLevelNewExpressionVisitor } from './ast/extractors/ModuleLevelNewExpressionExtractor.js';
import { createModuleLevelCallbackVisitor } from './ast/extractors/ModuleLevelCallbackExtractor.js';
import { createModuleLevelIfStatementVisitor } from './ast/extractors/ModuleLevelIfStatementExtractor.js';
import { collectCatchesFromInfo as collectCatchesFromInfoFn } from './ast/utils/CatchesFromCollector.js';
import { createCollections } from './ast/utils/createCollections.js';
import { toASTCollections } from './ast/utils/toASTCollections.js';
import { createFunctionBodyContext } from './ast/FunctionBodyContext.js';
import type { FunctionBodyContext } from './ast/FunctionBodyContext.js';
import {
  VariableHandler,
  ReturnYieldHandler,
  ThrowHandler,
  NestedFunctionHandler,
  PropertyAccessHandler,
  NewExpressionHandler,
  CallExpressionHandler,
  LoopHandler,
  TryCatchHandler,
  BranchHandler,
} from './ast/handlers/index.js';
import type { AnalyzerDelegate } from './ast/handlers/index.js';
import type { FunctionBodyHandler } from './ast/handlers/index.js';

// === LOCAL TYPES ===

interface AnalysisManifest {
  projectPath: string;
  [key: string]: unknown;
}

interface AnalyzeContext extends PluginContext {
  manifest?: AnalysisManifest;
  forceAnalysis?: boolean;
  workerCount?: number;
  /** Enable parallel parsing using ASTWorkerPool (worker_threads) */
  parallelParsing?: boolean;
  // Use base onProgress type for compatibility
  onProgress?: (info: Record<string, unknown>) => void;
}

export class JSASTAnalyzer extends Plugin {
  private graphBuilder: GraphBuilder;
  private analyzedModules: Set<string>;
  private profiler: Profiler;

  constructor() {
    super();
    this.graphBuilder = new GraphBuilder();
    this.analyzedModules = new Set();
    this.profiler = new Profiler('JSASTAnalyzer');
  }

  get metadata(): PluginMetadata {
    return {
      name: 'JSASTAnalyzer',
      phase: 'ANALYSIS',
      creates: {
        nodes: [
          'FUNCTION', 'CLASS', 'METHOD', 'VARIABLE', 'CONSTANT', 'SCOPE',
          'CALL', 'IMPORT', 'EXPORT', 'LITERAL', 'EXTERNAL_MODULE',
          'net:stdio', 'net:request', 'event:listener', 'http:request',
          // TypeScript-specific nodes
          'INTERFACE', 'TYPE', 'ENUM', 'DECORATOR', 'TYPE_PARAMETER'
        ],
        edges: [
          'CONTAINS', 'DECLARES', 'CALLS', 'HAS_SCOPE', 'CAPTURES', 'MODIFIES',
          'WRITES_TO', 'IMPORTS', 'INSTANCE_OF', 'HANDLED_BY', 'HAS_CALLBACK',
          'PASSES_ARGUMENT', 'MAKES_REQUEST', 'IMPORTS_FROM', 'ASSIGNED_FROM',
          // TypeScript-specific edges
          'IMPLEMENTS', 'EXTENDS', 'DECORATED_BY', 'HAS_TYPE_PARAMETER',
          // Promise data flow
          'RESOLVES_TO'
        ]
      },
      dependencies: ['JSModuleIndexer'],
      managesBatch: true,
      fields: [
        { name: 'object', fieldType: 'string', nodeTypes: ['CALL'] },
        { name: 'method', fieldType: 'string', nodeTypes: ['CALL'] },
        { name: 'async', fieldType: 'bool', nodeTypes: ['FUNCTION', 'METHOD'] },
        { name: 'scopeType', fieldType: 'string', nodeTypes: ['SCOPE'] },
        { name: 'importType', fieldType: 'string', nodeTypes: ['IMPORT'] },
        { name: 'exportType', fieldType: 'string', nodeTypes: ['EXPORT'] },
        { name: 'parentScopeId', fieldType: 'id', nodeTypes: ['FUNCTION', 'METHOD', 'SCOPE', 'VARIABLE'] },
      ]
    };
  }

  /**
   * Вычисляет хеш содержимого файла
   */
  calculateFileHash(filePath: string, projectPath: string = ''): string | null {
    try {
      const content = readFileSync(resolveNodeFile(filePath, projectPath), 'utf-8');
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Проверяет нужно ли анализировать модуль (сравнивает хеши)
   */
  async shouldAnalyzeModule(module: ModuleNode, graph: GraphBackend, forceAnalysis: boolean, projectPath: string = ""): Promise<boolean> {
    if (forceAnalysis) {
      return true;
    }

    if (!module.contentHash) {
      return true;
    }

    const currentHash = this.calculateFileHash(module.file, projectPath);
    if (!currentHash) {
      return true;
    }

    if (currentHash !== module.contentHash) {
      await graph.updateNode!({
        id: module.id,
        type: 'MODULE' as const,
        name: module.name,
        file: module.file,
        contentHash: currentHash,
      } as NodeRecord);
      return true;
    }

    // Hash matches - check if module was actually analyzed (has FUNCTION nodes)
    if (graph.queryNodes) {
      for await (const _node of graph.queryNodes({ type: 'FUNCTION', file: module.file })) {
        // Found at least one function - module was analyzed, skip
        return false;
      }
    }
    // No functions found - need to analyze
    return true;
  }

  async execute(context: AnalyzeContext): Promise<PluginResult> {
    const logger = this.log(context);

    try {
      const { manifest, graph, forceAnalysis = false } = context;
      const projectPath = manifest?.projectPath ?? '';

      if (forceAnalysis) {
        this.analyzedModules.clear();
      }

      const allModules = await this.getModuleNodes(graph);

      const modulesToAnalyze: ModuleNode[] = [];
      let skippedCount = 0;

      for (const module of allModules) {
        if (this.analyzedModules.has(module.id)) {
          skippedCount++;
          continue;
        }

        if (await this.shouldAnalyzeModule(module, graph, forceAnalysis, projectPath)) {
          modulesToAnalyze.push(module);
        } else {
          skippedCount++;
        }
      }

      logger.info('Starting module analysis', { toAnalyze: modulesToAnalyze.length, cached: skippedCount });

      if (modulesToAnalyze.length === 0) {
        logger.info('All modules up-to-date, skipping analysis');
        return createSuccessResult({ nodes: 0, edges: 0 });
      }

      // Use ASTWorkerPool for true parallel parsing with worker_threads if enabled
      if (context.parallelParsing) {
        return await this.executeParallel(modulesToAnalyze, graph, projectPath, context);
      }

      const queue = new PriorityQueue();
      const pool = new WorkerPool(context.workerCount || 10);

      const deferIndex = context.deferIndexing ?? false;

      pool.registerHandler('ANALYZE_MODULE', async (task) => {
        // Per-module batch: commit after each module to avoid buffering the entire
        // graph in memory. Prevents connection timeouts on large codebases.
        // REG-487: Pass deferIndex to skip per-commit index rebuild during bulk load.
        if (graph.beginBatch && graph.commitBatch) {
          graph.beginBatch();
          try {
            const result = await this.analyzeModule(task.data.module, graph, projectPath);
            await graph.commitBatch(
              ['JSASTAnalyzer', 'ANALYSIS', task.data.module.file],
              deferIndex,
              ['MODULE'],
            );
            return result;
          } catch (err) {
            if (graph.abortBatch) graph.abortBatch();
            throw err;
          }
        }
        return await this.analyzeModule(task.data.module, graph, projectPath);
      });

      for (const module of modulesToAnalyze) {
        this.analyzedModules.add(module.id);

        const task = new Task({
          id: `analyze:${module.id}`,
          type: 'ANALYZE_MODULE',
          priority: 80,
          data: { module }
        });
        queue.add(task);
      }

      let completed = 0;
      let currentFile = '';

      const progressInterval = setInterval(() => {
        if (context.onProgress && completed > 0) {
          context.onProgress({
            phase: 'analysis',
            currentPlugin: 'JSASTAnalyzer',
            message: `Analyzing ${currentFile} (${completed}/${modulesToAnalyze.length})`,
            totalFiles: modulesToAnalyze.length,
            processedFiles: completed,
            currentService: currentFile
          });
        }
      }, 500);

      pool.on('worker:task:started', (task: Task) => {
        currentFile = task.data.module.file?.replace(projectPath, '') || task.data.module.id;
      });

      pool.on('worker:task:completed', () => {
        completed++;

        if (completed % 10 === 0 || completed === modulesToAnalyze.length) {
          logger.debug('Analysis progress', { completed, total: modulesToAnalyze.length });
        }
      });

      await pool.processQueue(queue);

      clearInterval(progressInterval);

      // REG-487: Rebuild indexes after all deferred commits.
      // This runs inside JSASTAnalyzer.execute() so downstream ANALYSIS plugins
      // (which depend on JSASTAnalyzer) see rebuilt indexes.
      if (deferIndex && graph.rebuildIndexes) {
        logger.info('Rebuilding indexes after deferred bulk load...');
        await graph.rebuildIndexes();
      }

      if (context.onProgress) {
        context.onProgress({
          phase: 'analysis',
          currentPlugin: 'JSASTAnalyzer',
          totalFiles: modulesToAnalyze.length,
          processedFiles: completed
        });
      }

      const stats = queue.getStats();
      let nodesCreated = 0;
      let edgesCreated = 0;

      for (const task of queue.getCompletedTasks()) {
        if (isAnalysisResult(task.result)) {
          nodesCreated += task.result.nodes;
          edgesCreated += task.result.edges;
        }
      }

      logger.info('Analysis complete', { modulesAnalyzed: modulesToAnalyze.length, nodesCreated });
      logger.debug('Worker stats', { ...stats });

      this.profiler.printSummary();

      return createSuccessResult(
        { nodes: nodesCreated, edges: edgesCreated },
        { modulesAnalyzed: modulesToAnalyze.length, workerStats: stats }
      );

    } catch (error) {
      logger.error('Analysis failed', { error: error instanceof Error ? error.message : String(error) });
      const err = error instanceof Error ? error : new Error(String(error));
      return createErrorResult(err);
    }
  }

  /**
   * Execute parallel analysis using ASTWorkerPool (worker_threads).
   *
   * This method uses actual OS threads for true parallel CPU-intensive parsing.
   * Workers generate semantic IDs using ScopeTracker, matching sequential behavior.
   *
   * @param modules - Modules to analyze
   * @param graph - Graph backend for writing results
   * @param projectPath - Project root path
   * @param context - Analysis context with options
   * @returns Plugin result with node/edge counts
   */
  private async executeParallel(
    modules: ModuleNode[],
    graph: GraphBackend,
    projectPath: string,
    context: AnalyzeContext
  ): Promise<PluginResult> {
    const logger = this.log(context);
    const workerCount = context.workerCount || 4;
    const pool = new ASTWorkerPool(workerCount);

    logger.debug('Starting parallel parsing', { workerCount });

    try {
      await pool.init();

      // Convert ModuleNode to ASTModuleInfo format
      const moduleInfos: ASTModuleInfo[] = modules.map(m => ({
        id: m.id,
        file: resolveNodeFile(m.file, projectPath),
        relativeFile: m.file,
        name: m.name
      }));

      // Parse all modules in parallel using worker threads
      const results: ParseResult[] = await pool.parseModules(moduleInfos);

      let nodesCreated = 0;
      let edgesCreated = 0;
      let errors = 0;

      // Process results - collections already have semantic IDs from workers
      for (const result of results) {
        if (result.error) {
          logger.warn('Parse error', { file: result.module.file, error: result.error.message });
          errors++;
          continue;
        }

        if (result.collections) {
          // Find original module for metadata
          const module = modules.find(m => m.id === result.module.id);
          if (!module) continue;

          // Pass collections directly to GraphBuilder - IDs already semantic
          // Cast is safe because ASTWorker.ASTCollections is structurally compatible
          // with ast/types.ASTCollections (METHOD extends FUNCTION semantically)
          const buildResult = await this.graphBuilder.build(
            module,
            graph,
            projectPath,
            result.collections as unknown as ASTCollections
          );

          if (typeof buildResult === 'object' && buildResult !== null) {
            nodesCreated += (buildResult as { nodes: number }).nodes || 0;
            edgesCreated += (buildResult as { edges: number }).edges || 0;
          }
        }

        // Report progress
        if (context.onProgress) {
          context.onProgress({
            phase: 'analysis',
            currentPlugin: 'JSASTAnalyzer',
            message: `Processed ${result.module.name}`,
            totalFiles: modules.length,
            processedFiles: results.indexOf(result) + 1,
            currentService: result.module.file || result.module.name
          });
        }
      }

      logger.info('Parallel parsing complete', { nodesCreated, edgesCreated, errors });

      return createSuccessResult(
        { nodes: nodesCreated, edges: edgesCreated },
        { modulesAnalyzed: modules.length - errors, parallelParsing: true }
      );
    } finally {
      await pool.terminate();
    }
  }

  /**
   * Получить все MODULE ноды из графа
   */
  private async getModuleNodes(graph: GraphBackend): Promise<ModuleNode[]> {
    const modules: ModuleNode[] = [];
    for await (const node of graph.queryNodes({ type: 'MODULE' })) {
      modules.push(node as unknown as ModuleNode);
    }
    return modules;
  }

  /**
   * Анализировать один модуль
   */
  async analyzeModule(module: ModuleNode, graph: GraphBackend, projectPath: string): Promise<{ nodes: number; edges: number }> {
    let nodesCreated = 0;
    let edgesCreated = 0;

    try {
      this.profiler.start('file_read');
      const code = readFileSync(resolveNodeFile(module.file, projectPath), 'utf-8');
      this.profiler.end('file_read');

      this.profiler.start('babel_parse');
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript', 'decorators-legacy']
      });
      this.profiler.end('babel_parse');

      // Create ScopeTracker for semantic ID generation
      // Use module.file (relative path from workspace root) for consistent file references
      const scopeTracker = new ScopeTracker(module.file);

      // REG-464: Shared IdGenerator for v2 collision resolution across visitors
      const sharedIdGenerator = new IdGenerator(scopeTracker);

      // Initialize all collection arrays and counter refs
      const allCollections = createCollections(module, scopeTracker, code);

      // Imports/Exports
      this.profiler.start('traverse_imports');
      const importExportVisitor = new ImportExportVisitor(
        module,
        { imports: allCollections.imports, exports: allCollections.exports },
        extractNamesFromPattern
      );
      traverse(ast, importExportVisitor.getImportHandlers());
      traverse(ast, importExportVisitor.getExportHandlers());
      this.profiler.end('traverse_imports');

      // Variables
      this.profiler.start('traverse_variables');
      const variableVisitor = new VariableVisitor(
        module,
        {
          variableDeclarations: allCollections.variableDeclarations,
          classInstantiations: allCollections.classInstantiations,
          literals: allCollections.literals,
          variableAssignments: allCollections.variableAssignments,
          varDeclCounterRef: allCollections.varDeclCounterRef,
          literalCounterRef: allCollections.literalCounterRef,
          scopes: allCollections.scopes,
          scopeCounterRef: allCollections.scopeCounterRef,
          objectLiterals: allCollections.objectLiterals,
          objectProperties: allCollections.objectProperties,
          objectLiteralCounterRef: allCollections.objectLiteralCounterRef,
          arrayLiterals: allCollections.arrayLiterals,
          arrayLiteralCounterRef: allCollections.arrayLiteralCounterRef,
        },
        extractNamesFromPattern,
        trackVariableAssignmentFn as TrackVariableAssignmentCallback,
        scopeTracker  // Pass ScopeTracker for semantic ID generation
      );
      traverse(ast, variableVisitor.getHandlers());
      this.profiler.end('traverse_variables');

      // Functions
      this.profiler.start('traverse_functions');
      const functionVisitor = new FunctionVisitor(
        module,
        allCollections,
        this.analyzeFunctionBody.bind(this),
        scopeTracker  // Pass ScopeTracker for semantic ID generation
      );
      traverse(ast, functionVisitor.getHandlers());
      this.profiler.end('traverse_functions');

      // AssignmentExpression (module-level function assignments)
      this.profiler.start('traverse_assignments');
      traverse(ast, createModuleLevelAssignmentVisitor({
        module,
        scopeTracker,
        functions: allCollections.functions,
        scopes: allCollections.scopes,
        allCollections,
        arrayMutations: allCollections.arrayMutations,
        objectMutations: allCollections.objectMutations,
        analyzeFunctionBody: this.analyzeFunctionBody.bind(this),
      }));
      this.profiler.end('traverse_assignments');

      // Module-level UpdateExpression (obj.count++, arr[i]++, i++) - REG-288/REG-312
      this.profiler.start('traverse_updates');
      traverse(ast, {
        UpdateExpression: (updatePath: NodePath<t.UpdateExpression>) => {
          // Skip if inside a function - analyzeFunctionBody handles those
          const functionParent = updatePath.getFunctionParent();
          if (functionParent) return;

          // Module-level update expression: no parentScopeId
          collectUpdateExpressionFn(updatePath.node, module, allCollections.updateExpressions, undefined, scopeTracker);
        }
      });
      this.profiler.end('traverse_updates');

      // Classes
      this.profiler.start('traverse_classes');
      const classVisitor = new ClassVisitor(
        module,
        allCollections,
        this.analyzeFunctionBody.bind(this),
        scopeTracker,  // Pass ScopeTracker for semantic ID generation
        trackVariableAssignmentFn as TrackVariableAssignmentCallback  // REG-570
      );
      traverse(ast, classVisitor.getHandlers());
      this.profiler.end('traverse_classes');

      // TypeScript-specific constructs (interfaces, type aliases, enums)
      this.profiler.start('traverse_typescript');
      const typescriptVisitor = new TypeScriptVisitor(module, allCollections, scopeTracker);
      traverse(ast, typescriptVisitor.getHandlers());
      this.profiler.end('traverse_typescript');

      // Module-level callbacks
      this.profiler.start('traverse_callbacks');
      traverse(ast, createModuleLevelCallbackVisitor({
        module,
        scopeTracker,
        functions: allCollections.functions,
        scopes: allCollections.scopes,
        allCollections,
        analyzeFunctionBody: this.analyzeFunctionBody.bind(this),
      }));
      this.profiler.end('traverse_callbacks');

      // Call expressions
      this.profiler.start('traverse_calls');
      const callExpressionVisitor = new CallExpressionVisitor(module, allCollections, scopeTracker, sharedIdGenerator);
      traverse(ast, callExpressionVisitor.getHandlers());
      this.profiler.end('traverse_calls');

      // REG-297: Detect top-level await expressions
      this.profiler.start('traverse_top_level_await');
      let hasTopLevelAwait = false;
      traverse(ast, {
        AwaitExpression(awaitPath: NodePath<t.AwaitExpression>) {
          if (!awaitPath.getFunctionParent()) {
            hasTopLevelAwait = true;
            awaitPath.stop();
          }
        },
        // for-await-of uses ForOfStatement.await, not AwaitExpression
        ForOfStatement(forOfPath: NodePath<t.ForOfStatement>) {
          if (forOfPath.node.await && !forOfPath.getFunctionParent()) {
            hasTopLevelAwait = true;
            forOfPath.stop();
          }
        }
      });
      this.profiler.end('traverse_top_level_await');

      // Property access expressions (REG-395)
      this.profiler.start('traverse_property_access');
      const propertyAccessVisitor = new PropertyAccessVisitor(module, allCollections, scopeTracker);
      traverse(ast, propertyAccessVisitor.getHandlers());
      this.profiler.end('traverse_property_access');

      // Module-level NewExpression (constructor calls)
      // This handles top-level code like `const x = new Date()` that's not inside a function
      this.profiler.start('traverse_new');
      traverse(ast, createModuleLevelNewExpressionVisitor({
        module,
        scopeTracker,
        constructorCalls: allCollections.constructorCalls,
        callArguments: allCollections.callArguments,
        literals: allCollections.literals,
        literalCounterRef: allCollections.literalCounterRef,
        allCollections: allCollections as unknown as Record<string, unknown>,
        promiseExecutorContexts: allCollections.promiseExecutorContexts,
      }));
      this.profiler.end('traverse_new');

      // Module-level IfStatements
      this.profiler.start('traverse_ifs');
      traverse(ast, createModuleLevelIfStatementVisitor({
        module,
        scopeTracker,
        scopes: allCollections.scopes,
        ifScopeCounterRef: allCollections.ifScopeCounterRef,
        code,
      }));
      this.profiler.end('traverse_ifs');

      // REG-464: Resolve v2 ID collisions after all visitors complete
      const pendingNodes = sharedIdGenerator.getPendingNodes();
      if (pendingNodes.length > 0) {
        // Capture pre-resolution IDs to update callArguments afterward
        const preResolutionIds = new Map<{ id: string }, string>();
        for (const pn of pendingNodes) {
          preResolutionIds.set(pn.collectionRef, pn.collectionRef.id);
        }

        const collisionResolver = new CollisionResolver();
        collisionResolver.resolve(pendingNodes);

        // Update callArgument.callId references that became stale after resolution
        const idRemapping = new Map<string, string>();
        for (const pn of pendingNodes) {
          const oldId = preResolutionIds.get(pn.collectionRef)!;
          if (oldId !== pn.collectionRef.id) {
            idRemapping.set(oldId, pn.collectionRef.id);
          }
        }
        if (idRemapping.size > 0) {
          const callArgs = allCollections.callArguments as Array<{ callId: string }> | undefined;
          if (callArgs) {
            for (const arg of callArgs) {
              const resolved = idRemapping.get(arg.callId);
              if (resolved) {
                arg.callId = resolved;
              }
            }
          }
        }
      }

      // Build graph
      this.profiler.start('graph_build');
      const result = await this.graphBuilder.build(
        module, graph, projectPath,
        toASTCollections(allCollections, hasTopLevelAwait)
      );
      this.profiler.end('graph_build');

      nodesCreated = result.nodes;
      edgesCreated = result.edges;

    } catch (err) {
      if (err instanceof GraphDataError) throw err; // propagate data quality errors
      // Error analyzing module - silently skip, caller handles the result
    }

    return { nodes: nodesCreated, edges: edgesCreated };
  }

  /**
   * Анализирует тело функции и извлекает переменные, вызовы, условные блоки.
   * Uses ScopeTracker from collections for semantic ID generation.
   *
   * REG-422: Delegates traversal to extracted handler classes.
   * Local state is encapsulated in FunctionBodyContext; each handler
   * contributes a Visitor fragment that is merged into a single traversal.
   */
  analyzeFunctionBody(
    funcPath: NodePath<t.Function | t.StaticBlock>,
    parentScopeId: string,
    module: VisitorModule,
    collections: VisitorCollections
  ): void {
    // 1. Create context (replaces ~260 lines of local var declarations)
    const ctx = createFunctionBodyContext(
      funcPath, parentScopeId, module, collections,
      (collections.functions ?? []) as FunctionInfo[],
      extractNamesFromPattern
    );

    // 2. Handle implicit return for THIS arrow function if it has an expression body
    // e.g., `const double = x => x * 2;`
    if (t.isArrowFunctionExpression(ctx.funcNode) && !t.isBlockStatement(ctx.funcNode.body) && ctx.currentFunctionId) {
      const bodyExpr = ctx.funcNode.body;
      const exprInfo = extractReturnExpressionInfoFn(
        bodyExpr, module, ctx.literals, ctx.literalCounterRef, ctx.funcLine, ctx.funcColumn, 'implicit_return'
      );
      ctx.returnStatements.push({
        parentFunctionId: ctx.currentFunctionId,
        file: module.file,
        line: getLine(bodyExpr),
        column: getColumn(bodyExpr),
        returnValueType: 'NONE',
        isImplicitReturn: true,
        ...exprInfo,
      });
    }

    // 3. Create handlers and merge their visitors into a single traversal
    // Cast to AnalyzerDelegate — the interface declares the same methods that exist
    // on this class as private. The cast is safe because the shape matches exactly.
    const delegate = this as unknown as AnalyzerDelegate;
    const handlers: FunctionBodyHandler[] = [
      new VariableHandler(ctx, delegate),
      new ReturnYieldHandler(ctx, delegate),
      new ThrowHandler(ctx, delegate),
      new NestedFunctionHandler(ctx, delegate),
      new PropertyAccessHandler(ctx, delegate),
      new NewExpressionHandler(ctx, delegate),
      new CallExpressionHandler(ctx, delegate),
      new LoopHandler(ctx, delegate),
      new TryCatchHandler(ctx, delegate),
      new BranchHandler(ctx, delegate),
    ];

    const mergedVisitor: Visitor = {};
    for (const handler of handlers) {
      Object.assign(mergedVisitor, handler.getHandlers());
    }

    // 4. Single traversal over the function body
    funcPath.traverse(mergedVisitor);

    // 5. Post-traverse: collect CATCHES_FROM info for try/catch blocks
    if (ctx.functionPath) {
      collectCatchesFromInfoFn(
        ctx.functionPath,
        ctx.catchBlocks,
        ctx.callSites,
        ctx.methodCalls,
        ctx.constructorCalls,
        ctx.catchesFromInfos,
        module
      );
    }

    // 6. Post-traverse: Attach control flow metadata to the function node
    this.attachControlFlowMetadata(ctx);
  }

  /**
   * Attach control flow metadata (cyclomatic complexity, error tracking, HOF bindings)
   * to the matching function node after traversal completes.
   */
  private attachControlFlowMetadata(ctx: FunctionBodyContext): void {
    if (!ctx.matchingFunction) return;

    const cyclomaticComplexity = 1 +
      ctx.controlFlowState.branchCount +
      ctx.controlFlowState.loopCount +
      ctx.controlFlowState.caseCount +
      ctx.controlFlowState.logicalOpCount;

    // REG-311: Collect rejection info for this function
    const functionRejectionPatterns = ctx.rejectionPatterns.filter(p => p.functionId === ctx.matchingFunction!.id);
    const asyncPatterns = functionRejectionPatterns.filter(p => p.isAsync);
    const syncPatterns = functionRejectionPatterns.filter(p => !p.isAsync);
    const canReject = asyncPatterns.length > 0;
    const hasAsyncThrow = asyncPatterns.some(p => p.rejectionType === 'async_throw');
    const rejectedBuiltinErrors = [...new Set(
      asyncPatterns
        .filter(p => p.errorClassName !== null)
        .map(p => p.errorClassName!)
    )];
    // REG-286: Sync throw error tracking
    const thrownBuiltinErrors = [...new Set(
      syncPatterns
        .filter(p => p.errorClassName !== null)
        .map(p => p.errorClassName!)
    )];

    ctx.matchingFunction.controlFlow = {
      hasBranches: ctx.controlFlowState.branchCount > 0,
      hasLoops: ctx.controlFlowState.loopCount > 0,
      hasTryCatch: ctx.controlFlowState.hasTryCatch,
      hasEarlyReturn: ctx.controlFlowState.hasEarlyReturn,
      hasThrow: ctx.controlFlowState.hasThrow,
      cyclomaticComplexity,
      // REG-311: Async error tracking
      canReject,
      hasAsyncThrow,
      rejectedBuiltinErrors: rejectedBuiltinErrors.length > 0 ? rejectedBuiltinErrors : undefined,
      // REG-286: Sync throw tracking
      thrownBuiltinErrors: thrownBuiltinErrors.length > 0 ? thrownBuiltinErrors : undefined
    };

    // REG-401: Store invoked parameter indexes for user-defined HOF detection
    if (ctx.invokedParamIndexes.size > 0) {
      ctx.matchingFunction.invokesParamIndexes = [...ctx.invokedParamIndexes];
    }
    // REG-417: Store property paths for destructured param bindings
    if (ctx.invokesParamBindings.length > 0) {
      ctx.matchingFunction.invokesParamBindings = ctx.invokesParamBindings;
    }
  }

}
