/**
 * JSASTAnalyzer - плагин для парсинга JavaScript AST
 * Создаёт ноды: FUNCTION, CLASS, METHOD и т.д.
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { basename } from 'path';
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
import { ExpressionEvaluator } from './ast/ExpressionEvaluator.js';
import { GraphBuilder } from './ast/GraphBuilder.js';
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
import { ConditionParser } from './ast/ConditionParser.js';
import { getLine, getColumn } from './ast/utils/location.js';
import { Profiler } from '../../core/Profiler.js';
import { ScopeTracker } from '../../core/ScopeTracker.js';
import { computeSemanticId } from '../../core/SemanticId.js';
import { IdGenerator } from './ast/IdGenerator.js';
import { CollisionResolver } from './ast/CollisionResolver.js';
import { ExpressionNode } from '../../core/nodes/ExpressionNode.js';
import { ConstructorCallNode } from '../../core/nodes/ConstructorCallNode.js';
import { ObjectLiteralNode } from '../../core/nodes/ObjectLiteralNode.js';
import { ArrayLiteralNode } from '../../core/nodes/ArrayLiteralNode.js';
import { NodeFactory } from '../../core/NodeFactory.js';
import { brandNodeInternal } from '../../core/brandNodeInternal.js';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';
import type { PluginContext, PluginResult, PluginMetadata, GraphBackend } from '@grafema/types';
import type {
  ModuleNode,
  FunctionInfo,
  ParameterInfo,
  ScopeInfo,
  BranchInfo,
  CaseInfo,
  LoopInfo,
  TryBlockInfo,
  CatchBlockInfo,
  FinallyBlockInfo,
  VariableDeclarationInfo,
  CallSiteInfo,
  MethodCallInfo,
  EventListenerInfo,
  ClassInstantiationInfo,
  ConstructorCallInfo,
  ClassDeclarationInfo,
  MethodCallbackInfo,
  CallArgumentInfo,
  ImportInfo,
  ExportInfo,
  HttpRequestInfo,
  LiteralInfo,
  VariableAssignmentInfo,
  InterfaceDeclarationInfo,
  TypeAliasInfo,
  EnumDeclarationInfo,
  DecoratorInfo,
  ObjectLiteralInfo,
  ObjectPropertyInfo,
  ArrayLiteralInfo,
  ArrayElementInfo,
  ArrayMutationInfo,
  ArrayMutationArgument,
  ObjectMutationInfo,
  ObjectMutationValue,
  VariableReassignmentInfo,
  ReturnStatementInfo,
  YieldExpressionInfo,
  UpdateExpressionInfo,
  PromiseResolutionInfo,
  PromiseExecutorContext,
  RejectionPatternInfo,
  CatchesFromInfo,
  PropertyAccessInfo,
  TypeParameterInfo,
  CounterRef,
  ProcessedNodes,
  ASTCollections,
  ExtractedVariable,
} from './ast/types.js';
import { extractNamesFromPattern } from './ast/utils/extractNamesFromPattern.js';
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

// Note: Legacy ScopeContext interface removed in REG-141
// Semantic ID generation now uses ScopeTracker exclusively

// Internal Collections with required fields (ASTCollections has optional for GraphBuilder)
interface Collections {
  functions: FunctionInfo[];
  parameters: ParameterInfo[];
  scopes: ScopeInfo[];
  // Branching (switch statements)
  branches: BranchInfo[];
  cases: CaseInfo[];
  // Control flow (loops)
  loops: LoopInfo[];
  // Control flow (try/catch/finally) - Phase 4
  tryBlocks?: TryBlockInfo[];
  catchBlocks?: CatchBlockInfo[];
  finallyBlocks?: FinallyBlockInfo[];
  tryBlockCounterRef?: CounterRef;
  catchBlockCounterRef?: CounterRef;
  finallyBlockCounterRef?: CounterRef;
  variableDeclarations: VariableDeclarationInfo[];
  callSites: CallSiteInfo[];
  methodCalls: MethodCallInfo[];
  eventListeners: EventListenerInfo[];
  classInstantiations: ClassInstantiationInfo[];
  classDeclarations: ClassDeclarationInfo[];
  methodCallbacks: MethodCallbackInfo[];
  callArguments: CallArgumentInfo[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  httpRequests: HttpRequestInfo[];
  literals: LiteralInfo[];
  variableAssignments: VariableAssignmentInfo[];
  // TypeScript-specific collections
  interfaces: InterfaceDeclarationInfo[];
  typeAliases: TypeAliasInfo[];
  enums: EnumDeclarationInfo[];
  decorators: DecoratorInfo[];
  // Type parameter tracking for generics (REG-303)
  typeParameters: TypeParameterInfo[];
  // Object/Array literal tracking
  objectLiterals: ObjectLiteralInfo[];
  objectProperties: ObjectPropertyInfo[];
  arrayLiterals: ArrayLiteralInfo[];
  arrayElements: ArrayElementInfo[];
  // Array mutation tracking for FLOWS_INTO edges
  arrayMutations: ArrayMutationInfo[];
  // Object mutation tracking for FLOWS_INTO edges
  objectMutations: ObjectMutationInfo[];
  // Variable reassignment tracking for FLOWS_INTO edges (REG-290)
  variableReassignments: VariableReassignmentInfo[];
  // Return statement tracking for RETURNS edges
  returnStatements: ReturnStatementInfo[];
  // Update expression tracking for MODIFIES edges (REG-288, REG-312)
  updateExpressions: UpdateExpressionInfo[];
  // Promise resolution tracking for RESOLVES_TO edges (REG-334)
  promiseResolutions: PromiseResolutionInfo[];
  // Promise executor contexts (REG-334) - keyed by executor function's start:end position
  promiseExecutorContexts: Map<string, PromiseExecutorContext>;
  // Yield expression tracking for YIELDS/DELEGATES_TO edges (REG-270)
  yieldExpressions: YieldExpressionInfo[];
  // Property access tracking for PROPERTY_ACCESS nodes (REG-395)
  propertyAccesses: PropertyAccessInfo[];
  propertyAccessCounterRef: CounterRef;
  objectLiteralCounterRef: CounterRef;
  arrayLiteralCounterRef: CounterRef;
  ifScopeCounterRef: CounterRef;
  scopeCounterRef: CounterRef;
  varDeclCounterRef: CounterRef;
  callSiteCounterRef: CounterRef;
  functionCounterRef: CounterRef;
  httpRequestCounterRef: CounterRef;
  literalCounterRef: CounterRef;
  anonymousFunctionCounterRef: CounterRef;
  branchCounterRef: CounterRef;
  caseCounterRef: CounterRef;
  processedNodes: ProcessedNodes;
  code?: string;
  // VisitorCollections compatibility
  classes: ClassDeclarationInfo[];
  methods: FunctionInfo[];
  variables: VariableDeclarationInfo[];
  sideEffects: unknown[];  // TODO: define SideEffectInfo
  variableCounterRef: CounterRef;
  // ScopeTracker for semantic ID generation
  scopeTracker?: ScopeTracker;
  [key: string]: unknown;
}

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
          'PASSES_ARGUMENT', 'MAKES_REQUEST', 'IMPORTS_FROM', 'EXPORTS_TO', 'ASSIGNED_FROM',
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
      await graph.addNode(brandNodeInternal({
        id: module.id,
        type: 'MODULE' as const,
        name: module.name,
        file: module.file,
        contentHash: currentHash
      }));
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
   * Extract variable names from destructuring patterns
   * Uses t.isX() type guards to avoid casts
   *
   * REG-399: Delegated to extractNamesFromPattern utility for code reuse with parameters.
   * This method maintains the same API for backward compatibility.
   */
  extractVariableNamesFromPattern(pattern: t.Node | null | undefined, variables: ExtractedVariable[] = [], propertyPath: string[] = []): ExtractedVariable[] {
    // Delegate to the extracted utility function
    return extractNamesFromPattern(pattern, variables, propertyPath);
  }

  /**
   * Отслеживает присваивание переменной для data flow анализа
   */
  trackVariableAssignment(
    initNode: t.Expression | null | undefined,
    variableId: string,
    variableName: string,
    module: VisitorModule,
    line: number,
    literals: LiteralInfo[],
    variableAssignments: VariableAssignmentInfo[],
    literalCounterRef: CounterRef,
    objectLiterals: ObjectLiteralInfo[],
    objectProperties: ObjectPropertyInfo[],
    objectLiteralCounterRef: CounterRef,
    arrayLiterals: ArrayLiteralInfo[],
    arrayLiteralCounterRef: CounterRef
  ): void {
    if (!initNode) return;
    // initNode is already typed as t.Expression
    const initExpression = initNode;

    // 0. AwaitExpression
    if (initExpression.type === 'AwaitExpression') {
      return this.trackVariableAssignment(initExpression.argument, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef, arrayLiterals, arrayLiteralCounterRef);
    }

    // 0.1. TS type assertion unwrapping (REG-534) — these are type-only wrappers, the value is in .expression
    if (initExpression.type === 'TSAsExpression' || initExpression.type === 'TSSatisfiesExpression' ||
        initExpression.type === 'TSNonNullExpression' || initExpression.type === 'TSTypeAssertion') {
      return this.trackVariableAssignment((initExpression as any).expression, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef, arrayLiterals, arrayLiteralCounterRef);
    }

    // 0.5. ObjectExpression (REG-328) - must be before literal check
    if (initExpression.type === 'ObjectExpression') {
      const column = initExpression.loc?.start.column ?? 0;
      const objectNode = ObjectLiteralNode.create(
        module.file,
        line,
        column,
        { counter: objectLiteralCounterRef.value++ }
      );

      // Add to objectLiterals collection for GraphBuilder to create the node
      objectLiterals.push(objectNode as unknown as ObjectLiteralInfo);

      // Extract properties from the object literal
      this.extractObjectProperties(
        initExpression,
        objectNode.id,
        module,
        objectProperties,
        objectLiterals,
        objectLiteralCounterRef,
        literals,
        literalCounterRef
      );

      // Create ASSIGNED_FROM edge: VARIABLE -> OBJECT_LITERAL
      variableAssignments.push({
        variableId,
        sourceId: objectNode.id,
        sourceType: 'OBJECT_LITERAL'
      });
      return;
    }

    // 0.6. ArrayExpression (REG-534) — must be before literal check (like ObjectExpression at 0.5)
    // Creates proper ARRAY_LITERAL node for queryability: "find all array literals"
    if (initExpression.type === 'ArrayExpression') {
      const column = initExpression.loc?.start.column ?? 0;
      const arrayNode = ArrayLiteralNode.create(
        module.file,
        line,
        column,
        { counter: arrayLiteralCounterRef.value++ }
      );

      // Add to arrayLiterals collection for CoreBuilder to create the node
      arrayLiterals.push(arrayNode as unknown as ArrayLiteralInfo);

      // Create ASSIGNED_FROM edge: VARIABLE -> ARRAY_LITERAL
      variableAssignments.push({
        variableId,
        sourceId: arrayNode.id,
        sourceType: 'ARRAY_LITERAL'
      });
      return;
    }

    // 1. Literal
    const literalValue = ExpressionEvaluator.extractLiteralValue(initExpression);
    if (literalValue !== null) {
      const literalId = `LITERAL#${line}:${initExpression.start}#${module.file}`;
      literals.push({
        id: literalId,
        type: 'LITERAL',
        value: literalValue,
        valueType: typeof literalValue,
        file: module.file,
        line: line
      });

      variableAssignments.push({
        variableId,
        sourceId: literalId,
        sourceType: 'LITERAL'
      });
      return;
    }

    // 2. CallExpression with Identifier
    if (initExpression.type === 'CallExpression' && initExpression.callee.type === 'Identifier') {
      variableAssignments.push({
        variableId,
        sourceId: null,
        sourceType: 'CALL_SITE',
        callName: initExpression.callee.name,
        callLine: getLine(initExpression),
        callColumn: getColumn(initExpression)
      });
      return;
    }

    // 3. MemberExpression call (e.g., arr.map())
    // Uses coordinate-based lookup to reference the standard CALL node created by CallExpressionVisitor
    if (initExpression.type === 'CallExpression' && initExpression.callee.type === 'MemberExpression') {
      variableAssignments.push({
        variableId,
        sourceType: 'METHOD_CALL',
        sourceLine: getLine(initExpression),
        sourceColumn: getColumn(initExpression),
        sourceFile: module.file,
        line: line
      });
      return;
    }

    // 4. Identifier
    if (initExpression.type === 'Identifier') {
      variableAssignments.push({
        variableId,
        sourceType: 'VARIABLE',
        sourceName: initExpression.name,
        line: line
      });
      return;
    }

    // 5. NewExpression -> CONSTRUCTOR_CALL
    if (initExpression.type === 'NewExpression') {
      const callee = initExpression.callee;
      let className: string;

      if (callee.type === 'Identifier') {
        className = callee.name;
      } else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
        // Handle: new module.ClassName()
        className = callee.property.name;
      } else {
        // Unknown callee type, skip
        return;
      }

      const callLine = initExpression.loc?.start.line ?? line;
      const callColumn = initExpression.loc?.start.column ?? 0;

      variableAssignments.push({
        variableId,
        sourceType: 'CONSTRUCTOR_CALL',
        className,
        file: module.file,
        line: callLine,
        column: callColumn
      });
      return;
    }

    // 6. ArrowFunctionExpression or FunctionExpression
    if (initExpression.type === 'ArrowFunctionExpression' || initExpression.type === 'FunctionExpression') {
      variableAssignments.push({
        variableId,
        sourceType: 'FUNCTION',
        functionName: variableName,
        line: line
      });
      return;
    }

    // 7. MemberExpression (без вызова)
    if (initExpression.type === 'MemberExpression') {
      const objectName = initExpression.object.type === 'Identifier'
        ? initExpression.object.name
        : '<complex>';
      const propertyName = initExpression.computed
        ? '<computed>'
        : (initExpression.property.type === 'Identifier' ? initExpression.property.name : '<unknown>');

      const computedPropertyVar = initExpression.computed && initExpression.property.type === 'Identifier'
        ? initExpression.property.name
        : null;

      const column = initExpression.start ?? 0;
      const expressionId = ExpressionNode.generateId('MemberExpression', module.file, line, column);

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'MemberExpression',
        object: objectName,
        property: propertyName,
        computed: initExpression.computed,
        computedPropertyVar,
        objectSourceName: initExpression.object.type === 'Identifier' ? initExpression.object.name : null,
        file: module.file,
        line: line,
        column: column
      });
      return;
    }

    // 8. BinaryExpression
    if (initExpression.type === 'BinaryExpression') {
      const column = initExpression.start ?? 0;
      const expressionId = ExpressionNode.generateId('BinaryExpression', module.file, line, column);

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'BinaryExpression',
        operator: initExpression.operator,
        leftSourceName: initExpression.left.type === 'Identifier' ? initExpression.left.name : null,
        rightSourceName: initExpression.right.type === 'Identifier' ? initExpression.right.name : null,
        file: module.file,
        line: line,
        column: column
      });
      return;
    }

    // 9. ConditionalExpression
    if (initExpression.type === 'ConditionalExpression') {
      const column = initExpression.start ?? 0;
      const expressionId = ExpressionNode.generateId('ConditionalExpression', module.file, line, column);

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'ConditionalExpression',
        consequentSourceName: initExpression.consequent.type === 'Identifier' ? initExpression.consequent.name : null,
        alternateSourceName: initExpression.alternate.type === 'Identifier' ? initExpression.alternate.name : null,
        file: module.file,
        line: line,
        column: column
      });

      this.trackVariableAssignment(initExpression.consequent, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef, arrayLiterals, arrayLiteralCounterRef);
      this.trackVariableAssignment(initExpression.alternate, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef, arrayLiterals, arrayLiteralCounterRef);
      return;
    }

    // 10. LogicalExpression
    if (initExpression.type === 'LogicalExpression') {
      const column = initExpression.start ?? 0;
      const expressionId = ExpressionNode.generateId('LogicalExpression', module.file, line, column);

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'LogicalExpression',
        operator: initExpression.operator,
        leftSourceName: initExpression.left.type === 'Identifier' ? initExpression.left.name : null,
        rightSourceName: initExpression.right.type === 'Identifier' ? initExpression.right.name : null,
        file: module.file,
        line: line,
        column: column
      });

      this.trackVariableAssignment(initExpression.left, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef, arrayLiterals, arrayLiteralCounterRef);
      this.trackVariableAssignment(initExpression.right, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef, arrayLiterals, arrayLiteralCounterRef);
      return;
    }

    // 11. TemplateLiteral
    if (initExpression.type === 'TemplateLiteral' && initExpression.expressions.length > 0) {
      const column = initExpression.start ?? 0;
      const expressionId = ExpressionNode.generateId('TemplateLiteral', module.file, line, column);

      const expressionSourceNames = initExpression.expressions
        .filter((expr): expr is t.Identifier => expr.type === 'Identifier')
        .map(expr => expr.name);

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'TemplateLiteral',
        expressionSourceNames,
        file: module.file,
        line: line,
        column: column
      });

      for (const expr of initExpression.expressions) {
        // Filter out TSType nodes (only in TypeScript code)
        if (t.isExpression(expr)) {
          this.trackVariableAssignment(expr, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef, arrayLiterals, arrayLiteralCounterRef);
        }
      }
      return;
    }

    // 12. UnaryExpression (REG-534): !flag, -x, typeof x, void 0
    if (initExpression.type === 'UnaryExpression') {
      const column = initExpression.start ?? 0;
      const expressionId = ExpressionNode.generateId('UnaryExpression', module.file, line, column);

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'UnaryExpression',
        operator: initExpression.operator,
        unaryArgSourceName: initExpression.argument.type === 'Identifier' ? initExpression.argument.name : null,
        file: module.file,
        line: line,
        column: column
      });
      return;
    }

    // 13. TaggedTemplateExpression (REG-534): html`<div>` — effectively a function call
    // CallExpressionVisitor now handles TaggedTemplateExpression and creates CALL nodes.
    // Use CALL_SITE/METHOD_CALL sourceType so AssignmentBuilder resolves to the CALL node.
    if (initExpression.type === 'TaggedTemplateExpression') {
      if (initExpression.tag.type === 'Identifier') {
        variableAssignments.push({
          variableId,
          sourceId: null,
          sourceType: 'CALL_SITE',
          callName: initExpression.tag.name,
          callLine: getLine(initExpression),
          callColumn: getColumn(initExpression)
        });
      } else if (initExpression.tag.type === 'MemberExpression') {
        variableAssignments.push({
          variableId,
          sourceType: 'METHOD_CALL',
          sourceLine: getLine(initExpression),
          sourceColumn: getColumn(initExpression),
          sourceFile: module.file,
          line: line
        });
      } else {
        // Fallback for complex tag expressions (e.g., tagged template with call expr as tag)
        const column = initExpression.start ?? 0;
        const expressionId = ExpressionNode.generateId('TaggedTemplateExpression', module.file, line, column);
        variableAssignments.push({
          variableId,
          sourceType: 'EXPRESSION',
          sourceId: expressionId,
          expressionType: 'TaggedTemplateExpression',
          file: module.file,
          line: line,
          column: column
        });
      }
      return;
    }

    // 14. ClassExpression (REG-534): const MyClass = class { ... }
    // ClassVisitor handles ClassExpression and creates a CLASS node.
    // Use CLASS sourceType so AssignmentBuilder's createClassAssignmentEdges() resolves it.
    if (initExpression.type === 'ClassExpression') {
      variableAssignments.push({
        variableId,
        sourceType: 'CLASS',
        className: variableName,
        line: line
      });
      return;
    }

    // 15. OptionalCallExpression (REG-534): obj?.method()
    // Note: CallExpressionVisitor doesn't handle OptionalCallExpression, so there may be
    // no CALL node to match. Use EXPRESSION pattern to ensure the assignment edge is created.
    if (initExpression.type === 'OptionalCallExpression') {
      const column = initExpression.start ?? 0;
      const expressionId = ExpressionNode.generateId('OptionalCallExpression', module.file, line, column);

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'OptionalCallExpression',
        file: module.file,
        line: line,
        column: column
      });
      return;
    }

    // 16. OptionalMemberExpression (REG-534): obj?.prop — same logic as MemberExpression (branch 7)
    if (initExpression.type === 'OptionalMemberExpression') {
      const objectName = initExpression.object.type === 'Identifier'
        ? initExpression.object.name
        : '<complex>';
      const propertyName = initExpression.computed
        ? '<computed>'
        : (initExpression.property.type === 'Identifier' ? initExpression.property.name : '<unknown>');

      const computedPropertyVar = initExpression.computed && initExpression.property.type === 'Identifier'
        ? initExpression.property.name
        : null;

      const column = initExpression.start ?? 0;
      const expressionId = ExpressionNode.generateId('MemberExpression', module.file, line, column);

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'MemberExpression',
        object: objectName,
        property: propertyName,
        computed: initExpression.computed,
        computedPropertyVar,
        objectSourceName: initExpression.object.type === 'Identifier' ? initExpression.object.name : null,
        file: module.file,
        line: line,
        column: column
      });
      return;
    }

    // 17. SequenceExpression (REG-534): (a, b, c) — last expression is the value
    if (initExpression.type === 'SequenceExpression' && initExpression.expressions.length > 0) {
      const lastExpr = initExpression.expressions[initExpression.expressions.length - 1];
      if (t.isExpression(lastExpr)) {
        return this.trackVariableAssignment(lastExpr, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef, arrayLiterals, arrayLiteralCounterRef);
      }
      return;
    }

    // 18. YieldExpression (REG-534): yield value — recurse into argument if present
    if (initExpression.type === 'YieldExpression') {
      if (initExpression.argument) {
        return this.trackVariableAssignment(initExpression.argument, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef, arrayLiterals, arrayLiteralCounterRef);
      }
      return;
    }

    // 19. AssignmentExpression (REG-534): (a = b) — right side is the effective value
    if (initExpression.type === 'AssignmentExpression') {
      return this.trackVariableAssignment(initExpression.right, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef, arrayLiterals, arrayLiteralCounterRef);
    }

    // Fallback: unknown expression type — log warning, no edge created (REG-534)
    console.warn(
      `[REG-534] Unhandled expression type "${initExpression.type}" ` +
      `for variable "${variableName}" at ${module.file}:${line}. ` +
      `No assignment edge created.`
    );
  }

  /**
   * Extract object properties and create ObjectPropertyInfo records.
   * Handles nested object/array literals recursively. (REG-328)
   */
  private extractObjectProperties(
    objectExpr: t.ObjectExpression,
    objectId: string,
    module: VisitorModule,
    objectProperties: ObjectPropertyInfo[],
    objectLiterals: ObjectLiteralInfo[],
    objectLiteralCounterRef: CounterRef,
    literals: LiteralInfo[],
    literalCounterRef: CounterRef
  ): void {
    for (const prop of objectExpr.properties) {
      const propLine = prop.loc?.start.line || 0;
      const propColumn = prop.loc?.start.column || 0;

      // Handle spread properties: { ...other }
      if (prop.type === 'SpreadElement') {
        const spreadArg = prop.argument;
        const propertyInfo: ObjectPropertyInfo = {
          objectId,
          propertyName: '<spread>',
          valueType: 'SPREAD',
          file: module.file,
          line: propLine,
          column: propColumn
        };

        if (spreadArg.type === 'Identifier') {
          propertyInfo.valueName = spreadArg.name;
          propertyInfo.valueType = 'VARIABLE';
        }

        objectProperties.push(propertyInfo);
        continue;
      }

      // Handle regular properties
      if (prop.type === 'ObjectProperty') {
        let propertyName: string;

        // Get property name
        if (prop.key.type === 'Identifier') {
          propertyName = prop.key.name;
        } else if (prop.key.type === 'StringLiteral') {
          propertyName = prop.key.value;
        } else if (prop.key.type === 'NumericLiteral') {
          propertyName = String(prop.key.value);
        } else {
          propertyName = '<computed>';
        }

        const propertyInfo: ObjectPropertyInfo = {
          objectId,
          propertyName,
          file: module.file,
          line: propLine,
          column: propColumn,
          valueType: 'EXPRESSION'
        };

        const value = prop.value;

        // Nested object literal - check BEFORE extractLiteralValue
        if (value.type === 'ObjectExpression') {
          const nestedObjectNode = ObjectLiteralNode.create(
            module.file,
            value.loc?.start.line || 0,
            value.loc?.start.column || 0,
            { counter: objectLiteralCounterRef.value++ }
          );
          objectLiterals.push(nestedObjectNode as unknown as ObjectLiteralInfo);
          const nestedObjectId = nestedObjectNode.id;

          // Recursively extract nested properties
          this.extractObjectProperties(
            value,
            nestedObjectId,
            module,
            objectProperties,
            objectLiterals,
            objectLiteralCounterRef,
            literals,
            literalCounterRef
          );

          propertyInfo.valueType = 'OBJECT_LITERAL';
          propertyInfo.nestedObjectId = nestedObjectId;
          propertyInfo.valueNodeId = nestedObjectId;
        }
        // Literal value (primitives only - objects/arrays handled above)
        else {
          const literalValue = ExpressionEvaluator.extractLiteralValue(value);
          // Handle both non-null literals AND explicit null literals (NullLiteral)
          if (literalValue !== null || value.type === 'NullLiteral') {
            const literalId = `LITERAL#${propertyName}#${module.file}#${propLine}:${propColumn}:${literalCounterRef.value++}`;
            literals.push({
              id: literalId,
              type: 'LITERAL',
              value: literalValue,
              valueType: typeof literalValue,
              file: module.file,
              line: propLine,
              column: propColumn,
              parentCallId: objectId,
              argIndex: 0
            });
            propertyInfo.valueType = 'LITERAL';
            propertyInfo.valueNodeId = literalId;
            propertyInfo.literalValue = literalValue;
          }
          // Variable reference
          else if (value.type === 'Identifier') {
            propertyInfo.valueType = 'VARIABLE';
            propertyInfo.valueName = value.name;
          }
          // Call expression
          else if (value.type === 'CallExpression') {
            propertyInfo.valueType = 'CALL';
            propertyInfo.callLine = value.loc?.start.line;
            propertyInfo.callColumn = value.loc?.start.column;
          }
          // Other expressions
          else {
            propertyInfo.valueType = 'EXPRESSION';
          }
        }

        objectProperties.push(propertyInfo);
      }
      // Handle object methods: { foo() {} }
      else if (prop.type === 'ObjectMethod') {
        const propertyName = prop.key.type === 'Identifier' ? prop.key.name : '<computed>';
        objectProperties.push({
          objectId,
          propertyName,
          valueType: 'EXPRESSION',
          file: module.file,
          line: propLine,
          column: propColumn
        });
      }
    }
  }

  /**
   * Recursively unwrap AwaitExpression to get the underlying expression.
   * await await fetch() -> fetch()
   */
  private unwrapAwaitExpression(node: t.Expression): t.Expression {
    if (node.type === 'AwaitExpression' && node.argument) {
      return this.unwrapAwaitExpression(node.argument);
    }
    return node;
  }

  /**
   * Extract call site information from CallExpression.
   * Returns null if not a valid CallExpression.
   */
  private extractCallInfo(node: t.Expression): {
    line: number;
    column: number;
    name: string;
    isMethodCall: boolean;
  } | null {
    if (node.type !== 'CallExpression') {
      return null;
    }

    const callee = node.callee;
    let name: string;
    let isMethodCall = false;

    // Direct call: fetchUser()
    if (t.isIdentifier(callee)) {
      name = callee.name;
    }
    // Method call: obj.fetchUser() or arr.map()
    else if (t.isMemberExpression(callee)) {
      isMethodCall = true;
      const objectName = t.isIdentifier(callee.object)
        ? callee.object.name
        : (t.isThisExpression(callee.object) ? 'this' : 'unknown');
      const methodName = t.isIdentifier(callee.property)
        ? callee.property.name
        : 'unknown';
      name = `${objectName}.${methodName}`;
    }
    else {
      return null;
    }

    return {
      line: node.loc?.start.line ?? 0,
      column: node.loc?.start.column ?? 0,
      name,
      isMethodCall
    };
  }

  /**
   * Check if expression is CallExpression or AwaitExpression wrapping a call.
   */
  private isCallOrAwaitExpression(node: t.Expression): boolean {
    const unwrapped = this.unwrapAwaitExpression(node);
    return unwrapped.type === 'CallExpression';
  }

  /**
   * Tracks destructuring assignments for data flow analysis.
   *
   * For ObjectPattern: creates EXPRESSION nodes representing source.property
   * For ArrayPattern: creates EXPRESSION nodes representing source[index]
   *
   * Supports:
   * - Phase 1 (REG-201): Identifier init expressions (const { x } = obj)
   * - Phase 2 (REG-223): CallExpression/AwaitExpression init (const { x } = getConfig())
   *
   * @param pattern - The destructuring pattern (ObjectPattern or ArrayPattern)
   * @param initNode - The init expression (right-hand side)
   * @param variables - Extracted variables with propertyPath/arrayIndex metadata and IDs
   * @param module - Module context
   * @param variableAssignments - Collection to push assignment info to
   */
  private trackDestructuringAssignment(
    pattern: t.ObjectPattern | t.ArrayPattern,
    initNode: t.Expression | null | undefined,
    variables: Array<ExtractedVariable & { id: string }>,
    module: VisitorModule,
    variableAssignments: VariableAssignmentInfo[]
  ): void {
    if (!initNode) return;

    // Phase 1: Simple Identifier init expressions (REG-201)
    // Examples: const { x } = obj, const [a] = arr
    if (t.isIdentifier(initNode)) {
      const sourceBaseName = initNode.name;

      // Process each extracted variable
      for (const varInfo of variables) {
        const variableId = varInfo.id;

        // Handle rest elements specially - create edge to whole source
        if (varInfo.isRest) {
          variableAssignments.push({
            variableId,
            sourceType: 'VARIABLE',
            sourceName: sourceBaseName,
            line: varInfo.loc.start.line
          });
          continue;
        }

        // ObjectPattern: const { headers } = req → headers ASSIGNED_FROM req.headers
        if (t.isObjectPattern(pattern) && varInfo.propertyPath && varInfo.propertyPath.length > 0) {
          const propertyPath = varInfo.propertyPath;
          const expressionLine = varInfo.loc.start.line;
          const expressionColumn = varInfo.loc.start.column;

          // Build property path string (e.g., "req.headers.contentType" for nested)
          const fullPath = [sourceBaseName, ...propertyPath].join('.');

          const expressionId = ExpressionNode.generateId(
            'MemberExpression',
            module.file,
            expressionLine,
            expressionColumn
          );

          variableAssignments.push({
            variableId,
            sourceType: 'EXPRESSION',
            sourceId: expressionId,
            expressionType: 'MemberExpression',
            object: sourceBaseName,
            property: propertyPath[propertyPath.length - 1], // Last property for simple display
            computed: false,
            path: fullPath,
            objectSourceName: sourceBaseName, // Use objectSourceName for DERIVES_FROM edge creation
            propertyPath: propertyPath,
            file: module.file,
            line: expressionLine,
            column: expressionColumn
          });
        }
        // ArrayPattern: const [first, second] = arr → first ASSIGNED_FROM arr[0]
        else if (t.isArrayPattern(pattern) && varInfo.arrayIndex !== undefined) {
          const arrayIndex = varInfo.arrayIndex;
          const expressionLine = varInfo.loc.start.line;
          const expressionColumn = varInfo.loc.start.column;

          // Check if we also have propertyPath (mixed destructuring: { items: [first] } = data)
          const hasPropertyPath = varInfo.propertyPath && varInfo.propertyPath.length > 0;

          const expressionId = ExpressionNode.generateId(
            'MemberExpression',
            module.file,
            expressionLine,
            expressionColumn
          );

          variableAssignments.push({
            variableId,
            sourceType: 'EXPRESSION',
            sourceId: expressionId,
            expressionType: 'MemberExpression',
            object: sourceBaseName,
            property: String(arrayIndex),
            computed: true,
            objectSourceName: sourceBaseName, // Use objectSourceName for DERIVES_FROM edge creation
            arrayIndex: arrayIndex,
            propertyPath: hasPropertyPath ? varInfo.propertyPath : undefined,
            file: module.file,
            line: expressionLine,
            column: expressionColumn
          });
        }
      }
    }
    // Phase 2: CallExpression or AwaitExpression (REG-223)
    else if (this.isCallOrAwaitExpression(initNode)) {
      const unwrapped = this.unwrapAwaitExpression(initNode);
      const callInfo = this.extractCallInfo(unwrapped);

      if (!callInfo) {
        // Unsupported call pattern (computed callee, etc.)
        return;
      }

      const callRepresentation = `${callInfo.name}()`;

      // Process each extracted variable
      for (const varInfo of variables) {
        const variableId = varInfo.id;

        // Handle rest elements - create direct CALL_SITE assignment
        if (varInfo.isRest) {
          variableAssignments.push({
            variableId,
            sourceType: 'CALL_SITE',
            callName: callInfo.name,
            callLine: callInfo.line,
            callColumn: callInfo.column,
            callSourceLine: callInfo.line,
            callSourceColumn: callInfo.column,
            callSourceFile: module.file,
            callSourceName: callInfo.name,
            line: varInfo.loc.start.line
          });
          continue;
        }

        // ObjectPattern: const { data } = fetchUser() → data ASSIGNED_FROM fetchUser().data
        if (t.isObjectPattern(pattern) && varInfo.propertyPath && varInfo.propertyPath.length > 0) {
          const propertyPath = varInfo.propertyPath;
          const expressionLine = varInfo.loc.start.line;
          const expressionColumn = varInfo.loc.start.column;

          // Build property path string: "fetchUser().data" or "fetchUser().user.name"
          const fullPath = [callRepresentation, ...propertyPath].join('.');

          const expressionId = ExpressionNode.generateId(
            'MemberExpression',
            module.file,
            expressionLine,
            expressionColumn
          );

          variableAssignments.push({
            variableId,
            sourceType: 'EXPRESSION',
            sourceId: expressionId,
            expressionType: 'MemberExpression',
            object: callRepresentation,          // "fetchUser()" - display name
            property: propertyPath[propertyPath.length - 1],
            computed: false,
            path: fullPath,                       // "fetchUser().data"
            propertyPath: propertyPath,           // ["data"]
            // Call source for DERIVES_FROM lookup (REG-223)
            callSourceLine: callInfo.line,
            callSourceColumn: callInfo.column,
            callSourceFile: module.file,
            callSourceName: callInfo.name,
            sourceMetadata: {
              sourceType: callInfo.isMethodCall ? 'method-call' : 'call'
            },
            file: module.file,
            line: expressionLine,
            column: expressionColumn
          });
        }
        // ArrayPattern: const [first] = arr.map(fn) → first ASSIGNED_FROM arr.map(fn)[0]
        else if (t.isArrayPattern(pattern) && varInfo.arrayIndex !== undefined) {
          const arrayIndex = varInfo.arrayIndex;
          const expressionLine = varInfo.loc.start.line;
          const expressionColumn = varInfo.loc.start.column;

          const hasPropertyPath = varInfo.propertyPath && varInfo.propertyPath.length > 0;

          const expressionId = ExpressionNode.generateId(
            'MemberExpression',
            module.file,
            expressionLine,
            expressionColumn
          );

          variableAssignments.push({
            variableId,
            sourceType: 'EXPRESSION',
            sourceId: expressionId,
            expressionType: 'MemberExpression',
            object: callRepresentation,
            property: String(arrayIndex),
            computed: true,
            arrayIndex: arrayIndex,
            propertyPath: hasPropertyPath ? varInfo.propertyPath : undefined,
            // Call source for DERIVES_FROM lookup (REG-223)
            callSourceLine: callInfo.line,
            callSourceColumn: callInfo.column,
            callSourceFile: module.file,
            callSourceName: callInfo.name,
            sourceMetadata: {
              sourceType: callInfo.isMethodCall ? 'method-call' : 'call'
            },
            file: module.file,
            line: expressionLine,
            column: expressionColumn
          });
        }
      }
    }
    // Phase 3: MemberExpression init (REG-534): const { a } = obj.nested
    else if (t.isMemberExpression(initNode)) {
      const objectName = initNode.object.type === 'Identifier' ? initNode.object.name : '<complex>';
      const propertyName = !initNode.computed && initNode.property.type === 'Identifier'
        ? initNode.property.name : '<computed>';
      const sourceRepresentation = `${objectName}.${propertyName}`;

      for (const varInfo of variables) {
        const variableId = varInfo.id;
        if (varInfo.isRest) {
          const column = initNode.start ?? 0;
          const expressionId = ExpressionNode.generateId('MemberExpression', module.file, varInfo.loc.start.line, column);
          variableAssignments.push({
            variableId,
            sourceType: 'EXPRESSION', sourceId: expressionId,
            expressionType: 'MemberExpression',
            object: objectName, property: propertyName,
            computed: initNode.computed,
            objectSourceName: initNode.object.type === 'Identifier' ? initNode.object.name : null,
            file: module.file,
            line: varInfo.loc.start.line,
            column: column
          });
          continue;
        }

        if (t.isObjectPattern(pattern) && varInfo.propertyPath && varInfo.propertyPath.length > 0) {
          const expressionLine = varInfo.loc.start.line;
          const expressionColumn = varInfo.loc.start.column;
          const fullPath = [sourceRepresentation, ...varInfo.propertyPath].join('.');
          const expressionId = ExpressionNode.generateId('MemberExpression', module.file, expressionLine, expressionColumn);

          variableAssignments.push({
            variableId,
            sourceType: 'EXPRESSION', sourceId: expressionId,
            expressionType: 'MemberExpression',
            object: sourceRepresentation,
            property: varInfo.propertyPath[varInfo.propertyPath.length - 1],
            computed: false, path: fullPath,
            objectSourceName: initNode.object.type === 'Identifier' ? initNode.object.name : null,
            propertyPath: varInfo.propertyPath,
            file: module.file,
            line: expressionLine, column: expressionColumn
          });
        } else if (t.isArrayPattern(pattern) && varInfo.arrayIndex !== undefined) {
          const expressionLine = varInfo.loc.start.line;
          const expressionColumn = varInfo.loc.start.column;
          const expressionId = ExpressionNode.generateId('MemberExpression', module.file, expressionLine, expressionColumn);

          variableAssignments.push({
            variableId,
            sourceType: 'EXPRESSION', sourceId: expressionId,
            expressionType: 'MemberExpression',
            object: sourceRepresentation,
            property: String(varInfo.arrayIndex),
            computed: true,
            objectSourceName: initNode.object.type === 'Identifier' ? initNode.object.name : null,
            arrayIndex: varInfo.arrayIndex,
            file: module.file,
            line: expressionLine, column: expressionColumn
          });
        }
      }
    }
    // Phase 4: NewExpression init (REG-534): const { data } = new Response()
    else if (t.isNewExpression(initNode)) {
      const callee = initNode.callee;
      let constructorName: string;
      if (callee.type === 'Identifier') {
        constructorName = callee.name;
      } else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
        constructorName = callee.property.name;
      } else {
        return; // Unknown callee
      }

      const callRepresentation = `new ${constructorName}()`;
      const callLine = initNode.loc?.start.line ?? 0;
      const callColumn = initNode.loc?.start.column ?? 0;

      for (const varInfo of variables) {
        const variableId = varInfo.id;
        if (varInfo.isRest) {
          variableAssignments.push({
            variableId,
            sourceType: 'CONSTRUCTOR_CALL',
            className: constructorName,
            file: module.file,
            line: callLine, column: callColumn
          });
          continue;
        }

        if (t.isObjectPattern(pattern) && varInfo.propertyPath && varInfo.propertyPath.length > 0) {
          const expressionLine = varInfo.loc.start.line;
          const expressionColumn = varInfo.loc.start.column;
          const fullPath = [callRepresentation, ...varInfo.propertyPath].join('.');
          const expressionId = ExpressionNode.generateId('MemberExpression', module.file, expressionLine, expressionColumn);

          variableAssignments.push({
            variableId,
            sourceType: 'EXPRESSION', sourceId: expressionId,
            expressionType: 'MemberExpression',
            object: callRepresentation,
            property: varInfo.propertyPath[varInfo.propertyPath.length - 1],
            computed: false, path: fullPath,
            propertyPath: varInfo.propertyPath,
            file: module.file,
            line: expressionLine, column: expressionColumn
          });
        } else if (t.isArrayPattern(pattern) && varInfo.arrayIndex !== undefined) {
          const expressionLine = varInfo.loc.start.line;
          const expressionColumn = varInfo.loc.start.column;
          const expressionId = ExpressionNode.generateId('MemberExpression', module.file, expressionLine, expressionColumn);

          variableAssignments.push({
            variableId,
            sourceType: 'EXPRESSION', sourceId: expressionId,
            expressionType: 'MemberExpression',
            object: callRepresentation,
            property: String(varInfo.arrayIndex),
            computed: true,
            arrayIndex: varInfo.arrayIndex,
            file: module.file,
            line: expressionLine, column: expressionColumn
          });
        }
      }
    }
    // Phase 5: TS wrapper unwrapping for destructuring (REG-534)
    else if (initNode.type === 'TSAsExpression' || initNode.type === 'TSSatisfiesExpression' ||
             initNode.type === 'TSNonNullExpression' || initNode.type === 'TSTypeAssertion') {
      return this.trackDestructuringAssignment(pattern, (initNode as any).expression, variables, module, variableAssignments);
    }
    // Phase 6: ConditionalExpression init (REG-534): const { a } = cond ? x : y
    // Unlike non-destructuring ConditionalExpression (which creates an intermediate EXPRESSION node
    // AND recurses), destructuring only recurses into branches. This is intentional because
    // destructured variables need per-property tracking from each branch individually — an
    // intermediate EXPRESSION node would not provide useful queryability here.
    else if (t.isConditionalExpression(initNode)) {
      this.trackDestructuringAssignment(pattern, initNode.consequent, variables, module, variableAssignments);
      this.trackDestructuringAssignment(pattern, initNode.alternate, variables, module, variableAssignments);
    }
    // Phase 7: LogicalExpression init (REG-534): const { a } = x || defaults
    // Same rationale as ConditionalExpression above — destructured variables get per-property
    // EXPRESSION nodes from recursing into the right branch. No intermediate node needed.
    else if (t.isLogicalExpression(initNode)) {
      this.trackDestructuringAssignment(pattern, initNode.right, variables, module, variableAssignments);
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
      // Use basename for shorter, more readable semantic IDs
      const scopeTracker = new ScopeTracker(basename(module.file));

      // REG-464: Shared IdGenerator for v2 collision resolution across visitors
      const sharedIdGenerator = new IdGenerator(scopeTracker);

      const functions: FunctionInfo[] = [];
      const parameters: ParameterInfo[] = [];
      const scopes: ScopeInfo[] = [];
      // Branching (switch statements)
      const branches: BranchInfo[] = [];
      const cases: CaseInfo[] = [];
      // Control flow (loops)
      const loops: LoopInfo[] = [];
      const variableDeclarations: VariableDeclarationInfo[] = [];
      const callSites: CallSiteInfo[] = [];
      const methodCalls: MethodCallInfo[] = [];
      const eventListeners: EventListenerInfo[] = [];
      const classInstantiations: ClassInstantiationInfo[] = [];
      const constructorCalls: ConstructorCallInfo[] = [];
      const classDeclarations: ClassDeclarationInfo[] = [];
      const methodCallbacks: MethodCallbackInfo[] = [];
      const callArguments: CallArgumentInfo[] = [];
      const imports: ImportInfo[] = [];
      const exports: ExportInfo[] = [];
      const httpRequests: HttpRequestInfo[] = [];
      const literals: LiteralInfo[] = [];
      const variableAssignments: VariableAssignmentInfo[] = [];
      // TypeScript-specific collections
      const interfaces: InterfaceDeclarationInfo[] = [];
      const typeAliases: TypeAliasInfo[] = [];
      const enums: EnumDeclarationInfo[] = [];
      const decorators: DecoratorInfo[] = [];
      // Type parameter tracking for generics (REG-303)
      const typeParameters: TypeParameterInfo[] = [];
      // Object/Array literal tracking for data flow
      const objectLiterals: ObjectLiteralInfo[] = [];
      const objectProperties: ObjectPropertyInfo[] = [];
      const arrayLiterals: ArrayLiteralInfo[] = [];
      const arrayElements: ArrayElementInfo[] = [];
      // Array mutation tracking for FLOWS_INTO edges
      const arrayMutations: ArrayMutationInfo[] = [];
      // Object mutation tracking for FLOWS_INTO edges
      const objectMutations: ObjectMutationInfo[] = [];
      // Variable reassignment tracking for FLOWS_INTO edges (REG-290)
      const variableReassignments: VariableReassignmentInfo[] = [];
      // Return statement tracking for RETURNS edges
      const returnStatements: ReturnStatementInfo[] = [];
      // Update expression tracking for MODIFIES edges (REG-288, REG-312)
      const updateExpressions: UpdateExpressionInfo[] = [];
      // Promise resolution tracking for RESOLVES_TO edges (REG-334)
      const promiseResolutions: PromiseResolutionInfo[] = [];
      // Promise executor contexts (REG-334) - keyed by executor function's start:end position
      const promiseExecutorContexts = new Map<string, PromiseExecutorContext>();
      // Yield expression tracking for YIELDS/DELEGATES_TO edges (REG-270)
      const yieldExpressions: YieldExpressionInfo[] = [];
      // REG-311: Async error tracking
      const rejectionPatterns: RejectionPatternInfo[] = [];
      const catchesFromInfos: CatchesFromInfo[] = [];
      // Property access tracking for PROPERTY_ACCESS nodes (REG-395)
      const propertyAccesses: PropertyAccessInfo[] = [];

      const ifScopeCounterRef: CounterRef = { value: 0 };
      const scopeCounterRef: CounterRef = { value: 0 };
      const varDeclCounterRef: CounterRef = { value: 0 };
      const callSiteCounterRef: CounterRef = { value: 0 };
      const functionCounterRef: CounterRef = { value: 0 };
      const httpRequestCounterRef: CounterRef = { value: 0 };
      const literalCounterRef: CounterRef = { value: 0 };
      const anonymousFunctionCounterRef: CounterRef = { value: 0 };
      const objectLiteralCounterRef: CounterRef = { value: 0 };
      const arrayLiteralCounterRef: CounterRef = { value: 0 };
      const branchCounterRef: CounterRef = { value: 0 };
      const caseCounterRef: CounterRef = { value: 0 };
      const propertyAccessCounterRef: CounterRef = { value: 0 };

      const processedNodes: ProcessedNodes = {
        functions: new Set(),
        classes: new Set(),
        imports: new Set(),
        exports: new Set(),
        variables: new Set(),
        callSites: new Set(),
        methodCalls: new Set(),
        varDecls: new Set(),
        eventListeners: new Set()
      };

      // Imports/Exports
      this.profiler.start('traverse_imports');
      const importExportVisitor = new ImportExportVisitor(
        module,
        { imports, exports },
        this.extractVariableNamesFromPattern.bind(this)
      );
      traverse(ast, importExportVisitor.getImportHandlers());
      traverse(ast, importExportVisitor.getExportHandlers());
      this.profiler.end('traverse_imports');

      // Variables
      this.profiler.start('traverse_variables');
      const variableVisitor = new VariableVisitor(
        module,
        { variableDeclarations, classInstantiations, literals, variableAssignments, varDeclCounterRef, literalCounterRef, scopes, scopeCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef, arrayLiterals, arrayLiteralCounterRef },
        this.extractVariableNamesFromPattern.bind(this),
        this.trackVariableAssignment.bind(this) as TrackVariableAssignmentCallback,
        scopeTracker  // Pass ScopeTracker for semantic ID generation
      );
      traverse(ast, variableVisitor.getHandlers());
      this.profiler.end('traverse_variables');

      const allCollections: Collections = {
        functions, parameters, scopes,
        // Branching (switch statements)
        branches, cases,
        // Control flow (loops)
        loops,
        variableDeclarations, callSites, methodCalls,
        eventListeners, methodCallbacks, callArguments, classInstantiations, constructorCalls, classDeclarations,
        httpRequests, literals, variableAssignments,
        // TypeScript-specific collections
        interfaces, typeAliases, enums, decorators,
        // Type parameter tracking for generics (REG-303)
        typeParameters,
        // Object/Array literal tracking
        objectLiterals, objectProperties, arrayLiterals, arrayElements,
        // Array mutation tracking
        arrayMutations,
        // Object mutation tracking
        objectMutations,
        // Variable reassignment tracking (REG-290)
        variableReassignments,
        // Return statement tracking
        returnStatements,
        // Update expression tracking (REG-288, REG-312)
        updateExpressions,
        // Promise resolution tracking (REG-334)
        promiseResolutions,
        promiseExecutorContexts,
        // Yield expression tracking (REG-270)
        yieldExpressions,
        // REG-311: Async error tracking
        rejectionPatterns,
        catchesFromInfos,
        // Property access tracking (REG-395)
        propertyAccesses,
        propertyAccessCounterRef,
        objectLiteralCounterRef, arrayLiteralCounterRef,
        ifScopeCounterRef, scopeCounterRef, varDeclCounterRef,
        callSiteCounterRef, functionCounterRef, httpRequestCounterRef,
        literalCounterRef, anonymousFunctionCounterRef,
        branchCounterRef, caseCounterRef,
        processedNodes,
        imports, exports, code,
        // VisitorCollections compatibility
        classes: classDeclarations,
        methods: [],
        variables: variableDeclarations,
        sideEffects: [],
        variableCounterRef: varDeclCounterRef,
        // ScopeTracker for semantic ID generation
        scopeTracker
      };

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
      traverse(ast, {
        AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
          const assignNode = assignPath.node;
          const functionParent = assignPath.getFunctionParent();
          if (functionParent) return;

          if (assignNode.right &&
              (assignNode.right.type === 'FunctionExpression' ||
               assignNode.right.type === 'ArrowFunctionExpression')) {

            let functionName = 'anonymous';
            if (assignNode.left.type === 'MemberExpression') {
              const prop = assignNode.left.property;
              if (t.isIdentifier(prop)) {
                functionName = prop.name;
              }
            } else if (assignNode.left.type === 'Identifier') {
              functionName = assignNode.left.name;
            }

            const funcNode = assignNode.right;
            // Use semantic ID as primary ID (matching FunctionVisitor pattern)
            const functionId = computeSemanticId('FUNCTION', functionName, scopeTracker.getContext());

            functions.push({
              id: functionId,
              type: 'FUNCTION',
              name: functionName,
              file: module.file,
              line: getLine(assignNode),
              column: getColumn(assignNode),
              async: funcNode.async || false,
              generator: funcNode.type === 'FunctionExpression' ? funcNode.generator : false,
              isAssignment: true
            });

            const funcBodyScopeId = `SCOPE#${functionName}:body#${module.file}#${getLine(assignNode)}`;
            scopes.push({
              id: funcBodyScopeId,
              type: 'SCOPE',
              scopeType: 'function_body',
              name: `${functionName}:body`,
              semanticId: `${functionName}:function_body[0]`,
              conditional: false,
              file: module.file,
              line: getLine(assignNode),
              parentFunctionId: functionId
            });

            const funcPath = assignPath.get('right') as NodePath<t.FunctionExpression | t.ArrowFunctionExpression>;
            // Enter function scope for semantic ID generation and analyze
            scopeTracker.enterScope(functionName, 'function');
            this.analyzeFunctionBody(funcPath, funcBodyScopeId, module, allCollections);
            scopeTracker.exitScope();
          }

          // === VARIABLE REASSIGNMENT (REG-290) ===
          // Check if LHS is simple identifier (not obj.prop, not arr[i])
          // Must be checked at module level too
          if (assignNode.left.type === 'Identifier') {
            // Initialize collection if not exists
            if (!allCollections.variableReassignments) {
              allCollections.variableReassignments = [];
            }
            const variableReassignments = allCollections.variableReassignments as VariableReassignmentInfo[];

            this.detectVariableReassignment(assignNode, module, variableReassignments, scopeTracker);
          }
          // === END VARIABLE REASSIGNMENT ===

          // Check for indexed array assignment at module level: arr[i] = value
          this.detectIndexedArrayAssignment(assignNode, module, arrayMutations, scopeTracker, allCollections);

          // Check for object property assignment at module level: obj.prop = value
          this.detectObjectPropertyAssignment(assignNode, module, objectMutations, scopeTracker);
        }
      });
      this.profiler.end('traverse_assignments');

      // Module-level UpdateExpression (obj.count++, arr[i]++, i++) - REG-288/REG-312
      this.profiler.start('traverse_updates');
      traverse(ast, {
        UpdateExpression: (updatePath: NodePath<t.UpdateExpression>) => {
          // Skip if inside a function - analyzeFunctionBody handles those
          const functionParent = updatePath.getFunctionParent();
          if (functionParent) return;

          // Module-level update expression: no parentScopeId
          this.collectUpdateExpression(updatePath.node, module, updateExpressions, undefined, scopeTracker);
        }
      });
      this.profiler.end('traverse_updates');

      // Classes
      this.profiler.start('traverse_classes');
      const classVisitor = new ClassVisitor(
        module,
        allCollections,
        this.analyzeFunctionBody.bind(this),
        scopeTracker  // Pass ScopeTracker for semantic ID generation
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
      traverse(ast, {
        FunctionExpression: (funcPath: NodePath<t.FunctionExpression>) => {
          const funcNode = funcPath.node;
          const functionParent = funcPath.getFunctionParent();
          if (functionParent) return;

          if (funcPath.parent && funcPath.parent.type === 'CallExpression') {
            const funcName = funcNode.id ? funcNode.id.name : this.generateAnonymousName(scopeTracker);
            // Use semantic ID as primary ID (matching FunctionVisitor pattern)
            const functionId = computeSemanticId('FUNCTION', funcName, scopeTracker.getContext());

            functions.push({
              id: functionId,
              type: 'FUNCTION',
              name: funcName,
              file: module.file,
              line: getLine(funcNode),
              column: getColumn(funcNode),
              async: funcNode.async || false,
              generator: funcNode.generator || false,
              isCallback: true,
              parentScopeId: module.id
            });

            const callbackScopeId = `SCOPE#${funcName}:body#${module.file}#${getLine(funcNode)}`;
            scopes.push({
              id: callbackScopeId,
              type: 'SCOPE',
              scopeType: 'callback_body',
              name: `${funcName}:body`,
              semanticId: `${funcName}:callback_body[0]`,
              conditional: false,
              file: module.file,
              line: getLine(funcNode),
              parentFunctionId: functionId
            });

            // Enter callback scope for semantic ID generation and analyze
            scopeTracker.enterScope(funcName, 'callback');
            this.analyzeFunctionBody(funcPath, callbackScopeId, module, allCollections);
            scopeTracker.exitScope();
            funcPath.skip();
          }
        }
      });
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
      const processedConstructorCalls = new Set<string>();
      traverse(ast, {
        NewExpression: (newPath: NodePath<t.NewExpression>) => {
          const newNode = newPath.node;
          const nodeKey = `constructor:new:${newNode.start}:${newNode.end}`;
          if (processedConstructorCalls.has(nodeKey)) {
            return;
          }

          // Skip in-function calls — handled by NewExpressionHandler in analyzeFunctionBody
          const functionParent = newPath.getFunctionParent();
          if (functionParent) return;

          processedConstructorCalls.add(nodeKey);

          // Determine className from callee
          let className: string | null = null;
          if (newNode.callee.type === 'Identifier') {
            className = newNode.callee.name;
          } else if (newNode.callee.type === 'MemberExpression' && newNode.callee.property.type === 'Identifier') {
            className = newNode.callee.property.name;
          }

          if (className) {
            const line = getLine(newNode);
            const column = getColumn(newNode);
            const constructorCallId = ConstructorCallNode.generateId(className, module.file, line, column);
            const isBuiltin = ConstructorCallNode.isBuiltinConstructor(className);

            constructorCalls.push({
              id: constructorCallId,
              type: 'CONSTRUCTOR_CALL',
              className,
              isBuiltin,
              file: module.file,
              line,
              column,
              parentScopeId: module.id
            });

            // REG-334: If this is Promise constructor with executor callback,
            // register the context for resolve/reject detection
            if (className === 'Promise' && newNode.arguments.length > 0) {
              const executorArg = newNode.arguments[0];

              // Only handle inline function expressions (not variable references)
              if (t.isArrowFunctionExpression(executorArg) || t.isFunctionExpression(executorArg)) {
                // Extract resolve/reject parameter names
                let resolveName: string | undefined;
                let rejectName: string | undefined;

                if (executorArg.params.length > 0 && t.isIdentifier(executorArg.params[0])) {
                  resolveName = executorArg.params[0].name;
                }
                if (executorArg.params.length > 1 && t.isIdentifier(executorArg.params[1])) {
                  rejectName = executorArg.params[1].name;
                }

                if (resolveName) {
                  // Key by function node position to allow nested Promise detection
                  const funcKey = `${executorArg.start}:${executorArg.end}`;
                  promiseExecutorContexts.set(funcKey, {
                    constructorCallId,
                    resolveName,
                    rejectName,
                    file: module.file,
                    line,
                    // REG-311: Module-level Promise has no creator function
                    creatorFunctionId: undefined
                  });
                }
              }
            }
          }
        }
      });
      this.profiler.end('traverse_new');

      // Module-level IfStatements
      this.profiler.start('traverse_ifs');
      traverse(ast, {
        IfStatement: (ifPath: NodePath<t.IfStatement>) => {
          const functionParent = ifPath.getFunctionParent();
          if (functionParent) return;

          const ifNode = ifPath.node;
          const condition = code.substring(ifNode.test.start!, ifNode.test.end!) || 'condition';
          const counterId = ifScopeCounterRef.value++;
          const ifScopeId = `SCOPE#if#${module.file}#${getLine(ifNode)}:${getColumn(ifNode)}:${counterId}`;

          const constraints = ConditionParser.parse(ifNode.test);
          const ifSemanticId = this.generateSemanticId('if_statement', scopeTracker);

          scopes.push({
            id: ifScopeId,
            type: 'SCOPE',
            scopeType: 'if_statement',
            name: `if:${getLine(ifNode)}:${getColumn(ifNode)}:${counterId}`,
            semanticId: ifSemanticId,
            conditional: true,
            condition,
            constraints: constraints.length > 0 ? constraints : undefined,
            file: module.file,
            line: getLine(ifNode),
            parentScopeId: module.id
          });

          if (ifNode.alternate && ifNode.alternate.type !== 'IfStatement') {
            const elseCounterId = ifScopeCounterRef.value++;
            const elseScopeId = `SCOPE#else#${module.file}#${getLine(ifNode.alternate)}:${getColumn(ifNode.alternate)}:${elseCounterId}`;

            const negatedConstraints = constraints.length > 0 ? ConditionParser.negate(constraints) : undefined;
            const elseSemanticId = this.generateSemanticId('else_statement', scopeTracker);

            scopes.push({
              id: elseScopeId,
              type: 'SCOPE',
              scopeType: 'else_statement',
              name: `else:${getLine(ifNode.alternate)}:${getColumn(ifNode.alternate)}:${elseCounterId}`,
              semanticId: elseSemanticId,
              conditional: true,
              constraints: negatedConstraints,
              file: module.file,
              line: getLine(ifNode.alternate),
              parentScopeId: module.id
            });
          }
        }
      });
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
      const result = await this.graphBuilder.build(module, graph, projectPath, {
        functions,
        scopes,
        // Branching (switch statements) - use allCollections refs as they're populated by analyzeFunctionBody
        branches: allCollections.branches || branches,
        cases: allCollections.cases || cases,
        // Control flow (loops) - use allCollections refs as they're populated by analyzeFunctionBody
        loops: allCollections.loops || loops,
        // Control flow (try/catch/finally) - Phase 4
        tryBlocks: allCollections.tryBlocks,
        catchBlocks: allCollections.catchBlocks,
        finallyBlocks: allCollections.finallyBlocks,
        variableDeclarations,
        callSites,
        methodCalls,
        eventListeners,
        classInstantiations,
        constructorCalls,
        classDeclarations,
        methodCallbacks,
        // REG-334: Use allCollections.callArguments to include function-level resolve/reject arguments
        callArguments: allCollections.callArguments || callArguments,
        imports,
        exports,
        httpRequests,
        literals,
        variableAssignments,
        parameters,
        // TypeScript-specific collections
        interfaces,
        typeAliases,
        enums,
        decorators,
        // Type parameter tracking for generics (REG-303)
        typeParameters,
        // Array mutation tracking
        arrayMutations,
        // Object mutation tracking
        objectMutations,
        // Variable reassignment tracking (REG-290)
        variableReassignments,
        // Return statement tracking
        returnStatements,
        // Yield expression tracking (REG-270)
        yieldExpressions,
        // Update expression tracking (REG-288, REG-312)
        updateExpressions,
        // Promise resolution tracking (REG-334)
        promiseResolutions: allCollections.promiseResolutions || promiseResolutions,
        // Object/Array literal tracking - use allCollections refs as visitors may have created new arrays
        objectLiterals: allCollections.objectLiterals || objectLiterals,
        objectProperties: allCollections.objectProperties || objectProperties,
        arrayLiterals: allCollections.arrayLiterals || arrayLiterals,
        // REG-311: Async error tracking
        rejectionPatterns: Array.isArray(allCollections.rejectionPatterns)
          ? allCollections.rejectionPatterns as RejectionPatternInfo[]
          : rejectionPatterns,
        catchesFromInfos: Array.isArray(allCollections.catchesFromInfos)
          ? allCollections.catchesFromInfos as CatchesFromInfo[]
          : catchesFromInfos,
        // Property access tracking (REG-395)
        propertyAccesses: allCollections.propertyAccesses || propertyAccesses,
        // REG-297: Top-level await tracking
        hasTopLevelAwait
      });
      this.profiler.end('graph_build');

      nodesCreated = result.nodes;
      edgesCreated = result.edges;

    } catch {
      // Error analyzing module - silently skip, caller handles the result
    }

    return { nodes: nodesCreated, edges: edgesCreated };
  }

  /**
   * Helper to generate semantic ID for a scope using ScopeTracker.
   * Format: "scopePath:scopeType[index]" e.g. "MyClass->myMethod:if_statement[0]"
   */
  private generateSemanticId(
    scopeType: string,
    scopeTracker: ScopeTracker | undefined
  ): string | undefined {
    if (!scopeTracker) return undefined;

    const scopePath = scopeTracker.getScopePath();
    const siblingIndex = scopeTracker.getItemCounter(`semanticId:${scopeType}`);
    return `${scopePath}:${scopeType}[${siblingIndex}]`;
  }

  /**
   * Generate a unique anonymous function name within the current scope.
   * Uses ScopeTracker.getSiblingIndex() for stable naming.
   */
  private generateAnonymousName(scopeTracker: ScopeTracker | undefined): string {
    if (!scopeTracker) return 'anonymous';
    const index = scopeTracker.getSiblingIndex('anonymous');
    return `anonymous[${index}]`;
  }

  /**
   * Factory method to create loop scope handlers.
   * All loop statements (for, for-in, for-of, while, do-while) follow the same pattern:
   * 1. Create scope with SCOPE#<scopeType>#file#line:counter
   * 2. Generate semantic ID
   * 3. Push to scopes array
   * 4. Enter/exit scope tracker
   *
   * @param trackerScopeType - Scope type for ScopeTracker (e.g., 'for', 'for-in', 'while')
   * @param scopeType - Scope type for the graph node (e.g., 'for-loop', 'for-in-loop')
   * @param parentScopeId - Parent scope ID for the scope node
   * @param module - Module context
   * @param scopes - Collection to push scope nodes to
   * @param scopeCounterRef - Counter for unique scope IDs
   * @param scopeTracker - Tracker for semantic ID generation
   */

  /**
   * Handles VariableDeclaration nodes within function bodies.
   *
   * Extracts variable names from patterns (including destructuring), determines
   * if the variable should be CONSTANT or VARIABLE, generates semantic or legacy IDs,
   * and tracks class instantiations and variable assignments.
   *
   * @param varPath - The NodePath for the VariableDeclaration
   * @param parentScopeId - Parent scope ID for the variable
   * @param module - Module context with file info
   * @param variableDeclarations - Collection to push variable declarations to
   * @param classInstantiations - Collection to push class instantiations to
   * @param literals - Collection for literal tracking
   * @param variableAssignments - Collection for variable assignment tracking
   * @param varDeclCounterRef - Counter for unique variable declaration IDs
   * @param literalCounterRef - Counter for unique literal IDs
   * @param scopeTracker - Tracker for semantic ID generation
   * @param parentScopeVariables - Set to track variables for closure analysis
   * @param objectLiterals - Collection for object literal nodes (REG-328)
   * @param objectProperties - Collection for object property edges (REG-328)
   * @param objectLiteralCounterRef - Counter for unique object literal IDs (REG-328)
   */
  private handleVariableDeclaration(
    varPath: NodePath<t.VariableDeclaration>,
    parentScopeId: string,
    module: VisitorModule,
    variableDeclarations: VariableDeclarationInfo[],
    classInstantiations: ClassInstantiationInfo[],
    literals: LiteralInfo[],
    variableAssignments: VariableAssignmentInfo[],
    varDeclCounterRef: CounterRef,
    literalCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    parentScopeVariables: Set<{ name: string; id: string; scopeId: string }>,
    objectLiterals: ObjectLiteralInfo[],
    objectProperties: ObjectPropertyInfo[],
    objectLiteralCounterRef: CounterRef,
    arrayLiterals: ArrayLiteralInfo[],
    arrayLiteralCounterRef: CounterRef
  ): void {
    const varNode = varPath.node;
    const isConst = varNode.kind === 'const';

    // Check if this is a loop variable (for...of or for...in)
    const parent = varPath.parent;
    const isLoopVariable = (t.isForOfStatement(parent) || t.isForInStatement(parent)) && parent.left === varNode;

    varNode.declarations.forEach(declarator => {
      const variables = this.extractVariableNamesFromPattern(declarator.id);
      const variablesWithIds: Array<ExtractedVariable & { id: string }> = [];

      variables.forEach(varInfo => {
        const literalValue = declarator.init ? ExpressionEvaluator.extractLiteralValue(declarator.init) : null;
        const isLiteral = literalValue !== null;
        const isNewExpression = declarator.init && declarator.init.type === 'NewExpression';

        // Loop variables with const should be CONSTANT (they can't be reassigned in loop body)
        // Regular variables with const are CONSTANT only if initialized with literal or new expression
        const shouldBeConstant = isConst && (isLoopVariable || isLiteral || isNewExpression);
        const nodeType = shouldBeConstant ? 'CONSTANT' : 'VARIABLE';

        // Generate semantic ID (primary) or legacy ID (fallback)
        const legacyId = `${nodeType}#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${varDeclCounterRef.value++}`;

        const varId = scopeTracker
          ? computeSemanticId(nodeType, varInfo.name, scopeTracker.getContext())
          : legacyId;

        // Collect variable info with ID for destructuring tracking
        variablesWithIds.push({ ...varInfo, id: varId });

        parentScopeVariables.add({
          name: varInfo.name,
          id: varId,
          scopeId: parentScopeId
        });

        if (shouldBeConstant) {
          const constantData: VariableDeclarationInfo = {
            id: varId,
            type: 'CONSTANT',
            name: varInfo.name,
            file: module.file,
            line: varInfo.loc.start.line,
            parentScopeId
          };

          if (isLiteral) {
            constantData.value = literalValue;
          }

          variableDeclarations.push(constantData);

          const init = declarator.init;
          if (isNewExpression && t.isNewExpression(init) && t.isIdentifier(init.callee)) {
            const className = init.callee.name;
            classInstantiations.push({
              variableId: varId,
              variableName: varInfo.name,
              className: className,
              line: varInfo.loc.start.line,
              parentScopeId
            });
          }
        } else {
          variableDeclarations.push({
            id: varId,
            type: 'VARIABLE',
            name: varInfo.name,
            file: module.file,
            line: varInfo.loc.start.line,
            parentScopeId
          });
        }
      });

      // Track assignments after all variables are created
      if (isLoopVariable) {
        // For loop variables, track assignment from the source collection (right side of for...of/for...in)
        const loopParent = parent as t.ForOfStatement | t.ForInStatement;
        const sourceExpression = loopParent.right;

        if (t.isObjectPattern(declarator.id) || t.isArrayPattern(declarator.id)) {
          // Destructuring in loop: track each variable separately
          this.trackDestructuringAssignment(
            declarator.id,
            sourceExpression,
            variablesWithIds,
            module,
            variableAssignments
          );
        } else {
          // Simple loop variable: create DERIVES_FROM edges (not ASSIGNED_FROM)
          // Loop variables derive their values from the collection (semantic difference)
          variablesWithIds.forEach(varInfo => {
            if (t.isIdentifier(sourceExpression)) {
              variableAssignments.push({
                variableId: varInfo.id,
                sourceType: 'DERIVES_FROM_VARIABLE',
                sourceName: sourceExpression.name,
                file: module.file,
                line: varInfo.loc.start.line
              });
            } else {
              // Fallback to regular tracking for non-identifier expressions
              this.trackVariableAssignment(
                sourceExpression,
                varInfo.id,
                varInfo.name,
                module,
                varInfo.loc.start.line,
                literals,
                variableAssignments,
                literalCounterRef,
                objectLiterals,
                objectProperties,
                objectLiteralCounterRef,
                arrayLiterals,
                arrayLiteralCounterRef
              );
            }
          });
        }
      } else if (declarator.init) {
        // Regular variable declaration with initializer
        if (t.isObjectPattern(declarator.id) || t.isArrayPattern(declarator.id)) {
          // Destructuring: use specialized tracking
          this.trackDestructuringAssignment(
            declarator.id,
            declarator.init,
            variablesWithIds,
            module,
            variableAssignments
          );
        } else {
          // Simple assignment: use existing tracking
          const varInfo = variablesWithIds[0];
          this.trackVariableAssignment(
            declarator.init,
            varInfo.id,
            varInfo.name,
            module,
            varInfo.loc.start.line,
            literals,
            variableAssignments,
            literalCounterRef,
            objectLiterals,
            objectProperties,
            objectLiteralCounterRef,
            arrayLiterals,
            arrayLiteralCounterRef
          );
        }
      }
    });
  }


  /**
   * Handles SwitchStatement nodes.
   * Creates BRANCH node for switch, CASE nodes for each case clause,
   * and EXPRESSION node for discriminant.
   *
   * @param switchPath - The NodePath for the SwitchStatement
   * @param parentScopeId - Parent scope ID
   * @param module - Module context
   * @param collections - AST collections
   * @param scopeTracker - Tracker for semantic ID generation
   */
  private handleSwitchStatement(
    switchPath: NodePath<t.SwitchStatement>,
    parentScopeId: string,
    module: VisitorModule,
    collections: VisitorCollections,
    scopeTracker: ScopeTracker | undefined,
    controlFlowState?: { branchCount: number; caseCount: number }
  ): void {
    const switchNode = switchPath.node;

    // Phase 6 (REG-267): Count branch and non-default cases for cyclomatic complexity
    if (controlFlowState) {
      controlFlowState.branchCount++;  // switch itself is a branch
      // Count non-default cases
      for (const caseNode of switchNode.cases) {
        if (caseNode.test !== null) {  // Not default case
          controlFlowState.caseCount++;
        }
      }
    }

    // Initialize collections if not exist
    if (!collections.branches) {
      collections.branches = [];
    }
    if (!collections.cases) {
      collections.cases = [];
    }
    if (!collections.branchCounterRef) {
      collections.branchCounterRef = { value: 0 };
    }
    if (!collections.caseCounterRef) {
      collections.caseCounterRef = { value: 0 };
    }

    const branches = collections.branches as BranchInfo[];
    const cases = collections.cases as CaseInfo[];
    const branchCounterRef = collections.branchCounterRef as CounterRef;
    const caseCounterRef = collections.caseCounterRef as CounterRef;

    // Create BRANCH node
    const branchCounter = branchCounterRef.value++;
    const legacyBranchId = `${module.file}:BRANCH:switch:${getLine(switchNode)}:${branchCounter}`;
    const branchId = scopeTracker
      ? computeSemanticId('BRANCH', 'switch', scopeTracker.getContext(), { discriminator: branchCounter })
      : legacyBranchId;

    // Handle discriminant expression - store metadata directly (Linus improvement)
    let discriminantExpressionId: string | undefined;
    let discriminantExpressionType: string | undefined;
    let discriminantLine: number | undefined;
    let discriminantColumn: number | undefined;

    if (switchNode.discriminant) {
      const discResult = this.extractDiscriminantExpression(
        switchNode.discriminant,
        module
      );
      discriminantExpressionId = discResult.id;
      discriminantExpressionType = discResult.expressionType;
      discriminantLine = discResult.line;
      discriminantColumn = discResult.column;
    }

    branches.push({
      id: branchId,
      semanticId: branchId,
      type: 'BRANCH',
      branchType: 'switch',
      file: module.file,
      line: getLine(switchNode),
      parentScopeId,
      discriminantExpressionId,
      discriminantExpressionType,
      discriminantLine,
      discriminantColumn
    });

    // Process each case clause
    for (let i = 0; i < switchNode.cases.length; i++) {
      const caseNode = switchNode.cases[i];
      const isDefault = caseNode.test === null;
      const isEmpty = caseNode.consequent.length === 0;

      // Detect fall-through: no break/return/throw at end of consequent
      const fallsThrough = isEmpty || !this.caseTerminates(caseNode);

      // Extract case value
      const value = isDefault ? null : this.extractCaseValue(caseNode.test ?? null);

      const caseCounter = caseCounterRef.value++;
      const valueName = isDefault ? 'default' : String(value);
      const legacyCaseId = `${module.file}:CASE:${valueName}:${getLine(caseNode)}:${caseCounter}`;
      const caseId = scopeTracker
        ? computeSemanticId('CASE', valueName, scopeTracker.getContext(), { discriminator: caseCounter })
        : legacyCaseId;

      cases.push({
        id: caseId,
        semanticId: caseId,
        type: 'CASE',
        value,
        isDefault,
        fallsThrough,
        isEmpty,
        file: module.file,
        line: getLine(caseNode),
        parentBranchId: branchId
      });
    }
  }

  /**
   * Extract EXPRESSION node ID and metadata for switch discriminant
   */
  private extractDiscriminantExpression(
    discriminant: t.Expression,
    module: VisitorModule
  ): { id: string; expressionType: string; line: number; column: number } {
    const line = getLine(discriminant);
    const column = getColumn(discriminant);

    if (t.isIdentifier(discriminant)) {
      // Simple identifier: switch(x) - create EXPRESSION node
      return {
        id: ExpressionNode.generateId('Identifier', module.file, line, column),
        expressionType: 'Identifier',
        line,
        column
      };
    } else if (t.isMemberExpression(discriminant)) {
      // Member expression: switch(action.type)
      return {
        id: ExpressionNode.generateId('MemberExpression', module.file, line, column),
        expressionType: 'MemberExpression',
        line,
        column
      };
    } else if (t.isCallExpression(discriminant)) {
      // Call expression: switch(getType())
      const callee = t.isIdentifier(discriminant.callee) ? discriminant.callee.name : '<complex>';
      // Return CALL node ID instead of EXPRESSION (reuse existing call tracking)
      return {
        id: `${module.file}:CALL:${callee}:${line}:${column}`,
        expressionType: 'CallExpression',
        line,
        column
      };
    }

    // Default: create generic EXPRESSION
    return {
      id: ExpressionNode.generateId(discriminant.type, module.file, line, column),
      expressionType: discriminant.type,
      line,
      column
    };
  }

  /**
   * Extract case test value as a primitive
   */
  private extractCaseValue(test: t.Expression | null): unknown {
    if (!test) return null;

    if (t.isStringLiteral(test)) {
      return test.value;
    } else if (t.isNumericLiteral(test)) {
      return test.value;
    } else if (t.isBooleanLiteral(test)) {
      return test.value;
    } else if (t.isNullLiteral(test)) {
      return null;
    } else if (t.isIdentifier(test)) {
      // Constant reference: case CONSTANTS.ADD
      return test.name;
    } else if (t.isMemberExpression(test)) {
      // Member expression: case Action.ADD
      return this.memberExpressionToString(test);
    }

    return '<complex>';
  }

  /**
   * Check if case clause terminates (has break, return, throw)
   */
  private caseTerminates(caseNode: t.SwitchCase): boolean {
    const statements = caseNode.consequent;
    if (statements.length === 0) return false;

    // Check last statement (or any statement for early returns)
    for (const stmt of statements) {
      if (t.isBreakStatement(stmt)) return true;
      if (t.isReturnStatement(stmt)) return true;
      if (t.isThrowStatement(stmt)) return true;
      if (t.isContinueStatement(stmt)) return true;  // In switch inside loop

      // Check for nested blocks (if last statement is block, check inside)
      if (t.isBlockStatement(stmt)) {
        const lastInBlock = stmt.body[stmt.body.length - 1];
        if (lastInBlock && (
          t.isBreakStatement(lastInBlock) ||
          t.isReturnStatement(lastInBlock) ||
          t.isThrowStatement(lastInBlock)
        )) {
          return true;
        }
      }

      // Check for if-else where both branches terminate
      if (t.isIfStatement(stmt) && stmt.alternate) {
        const ifTerminates = this.blockTerminates(stmt.consequent);
        const elseTerminates = this.blockTerminates(stmt.alternate);
        if (ifTerminates && elseTerminates) return true;
      }
    }

    return false;
  }

  /**
   * Check if a block/statement terminates
   */
  private blockTerminates(node: t.Statement): boolean {
    if (t.isBreakStatement(node)) return true;
    if (t.isReturnStatement(node)) return true;
    if (t.isThrowStatement(node)) return true;
    if (t.isBlockStatement(node)) {
      const last = node.body[node.body.length - 1];
      return last ? this.blockTerminates(last) : false;
    }
    return false;
  }

  /**
   * Count logical operators (&& and ||) in a condition expression.
   * Used for cyclomatic complexity calculation (Phase 6 REG-267).
   *
   * @param node - The condition expression to analyze
   * @returns Number of logical operators found
   */
  private countLogicalOperators(node: t.Expression): number {
    let count = 0;

    const traverse = (expr: t.Expression | t.Node): void => {
      if (t.isLogicalExpression(expr)) {
        // Count && and || operators
        if (expr.operator === '&&' || expr.operator === '||') {
          count++;
        }
        traverse(expr.left);
        traverse(expr.right);
      } else if (t.isConditionalExpression(expr)) {
        // Handle ternary conditions: test ? consequent : alternate
        traverse(expr.test);
        traverse(expr.consequent);
        traverse(expr.alternate);
      } else if (t.isUnaryExpression(expr)) {
        traverse(expr.argument);
      } else if (t.isBinaryExpression(expr)) {
        traverse(expr.left);
        traverse(expr.right);
      } else if (t.isSequenceExpression(expr)) {
        for (const e of expr.expressions) {
          traverse(e);
        }
      } else if (t.isParenthesizedExpression(expr)) {
        traverse(expr.expression);
      }
    };

    traverse(node);
    return count;
  }

  /**
   * Convert MemberExpression to string representation
   */
  private memberExpressionToString(expr: t.MemberExpression): string {
    const parts: string[] = [];

    let current: t.Expression = expr;
    while (t.isMemberExpression(current)) {
      if (t.isIdentifier(current.property)) {
        parts.unshift(current.property.name);
      } else {
        parts.unshift('<computed>');
      }
      current = current.object;
    }

    if (t.isIdentifier(current)) {
      parts.unshift(current.name);
    }

    return parts.join('.');
  }

  /**
   * Extract return expression info from an expression node.
   * Used for both explicit return statements and implicit arrow returns.
   *
   * This method consolidates ~450 lines of duplicated expression handling code
   * from three locations:
   * 1. Top-level implicit arrow returns (arrow function expression body)
   * 2. ReturnStatement handler (explicit returns)
   * 3. Nested arrow function implicit returns
   *
   * @param expr - The expression being returned
   * @param module - Module info for file context
   * @param literals - Collection to add literal nodes to
   * @param literalCounterRef - Counter for generating unique literal IDs
   * @param baseLine - Line number for literal ID generation
   * @param baseColumn - Column number for literal ID generation
   * @param literalIdSuffix - 'return' or 'implicit_return'
   * @returns Partial ReturnStatementInfo with expression-specific fields
   */
  private extractReturnExpressionInfo(
    expr: t.Expression,
    module: { file: string },
    literals: LiteralInfo[],
    literalCounterRef: CounterRef,
    baseLine: number,
    baseColumn: number,
    literalIdSuffix: 'return' | 'implicit_return' | 'yield' = 'return'
  ): Partial<ReturnStatementInfo> {
    const exprLine = getLine(expr);
    const exprColumn = getColumn(expr);

    // Identifier (variable reference)
    if (t.isIdentifier(expr)) {
      return {
        returnValueType: 'VARIABLE',
        returnValueName: expr.name,
      };
    }

    // TemplateLiteral must come BEFORE isLiteral (TemplateLiteral extends Literal)
    if (t.isTemplateLiteral(expr)) {
      const sourceNames: string[] = [];
      for (const embedded of expr.expressions) {
        if (t.isIdentifier(embedded)) {
          sourceNames.push(embedded.name);
        }
      }
      return {
        returnValueType: 'EXPRESSION',
        expressionType: 'TemplateLiteral',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        returnValueId: NodeFactory.generateExpressionId(
          'TemplateLiteral', module.file, exprLine, exprColumn
        ),
        ...(sourceNames.length > 0 ? { expressionSourceNames: sourceNames } : {}),
      };
    }

    // Literal values (after TemplateLiteral check)
    if (t.isLiteral(expr)) {
      const literalId = `LITERAL#${literalIdSuffix}#${module.file}#${baseLine}:${baseColumn}:${literalCounterRef.value++}`;
      literals.push({
        id: literalId,
        type: 'LITERAL',
        value: ExpressionEvaluator.extractLiteralValue(expr),
        valueType: typeof ExpressionEvaluator.extractLiteralValue(expr),
        file: module.file,
        line: exprLine,
        column: exprColumn,
      });
      return {
        returnValueType: 'LITERAL',
        returnValueId: literalId,
      };
    }

    // Direct function call: return foo()
    if (t.isCallExpression(expr) && t.isIdentifier(expr.callee)) {
      return {
        returnValueType: 'CALL_SITE',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        returnValueCallName: expr.callee.name,
      };
    }

    // Method call: return obj.method()
    if (t.isCallExpression(expr) && t.isMemberExpression(expr.callee)) {
      return {
        returnValueType: 'METHOD_CALL',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        returnValueCallName: t.isIdentifier(expr.callee.property)
          ? expr.callee.property.name
          : undefined,
      };
    }

    // BinaryExpression: return a + b
    if (t.isBinaryExpression(expr)) {
      return {
        returnValueType: 'EXPRESSION',
        expressionType: 'BinaryExpression',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        operator: expr.operator,
        returnValueId: NodeFactory.generateExpressionId(
          'BinaryExpression', module.file, exprLine, exprColumn
        ),
        leftSourceName: t.isIdentifier(expr.left) ? expr.left.name : undefined,
        rightSourceName: t.isIdentifier(expr.right) ? expr.right.name : undefined,
      };
    }

    // LogicalExpression: return a && b, return a || b
    if (t.isLogicalExpression(expr)) {
      return {
        returnValueType: 'EXPRESSION',
        expressionType: 'LogicalExpression',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        operator: expr.operator,
        returnValueId: NodeFactory.generateExpressionId(
          'LogicalExpression', module.file, exprLine, exprColumn
        ),
        leftSourceName: t.isIdentifier(expr.left) ? expr.left.name : undefined,
        rightSourceName: t.isIdentifier(expr.right) ? expr.right.name : undefined,
      };
    }

    // ConditionalExpression: return condition ? a : b
    if (t.isConditionalExpression(expr)) {
      return {
        returnValueType: 'EXPRESSION',
        expressionType: 'ConditionalExpression',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        returnValueId: NodeFactory.generateExpressionId(
          'ConditionalExpression', module.file, exprLine, exprColumn
        ),
        consequentSourceName: t.isIdentifier(expr.consequent) ? expr.consequent.name : undefined,
        alternateSourceName: t.isIdentifier(expr.alternate) ? expr.alternate.name : undefined,
      };
    }

    // UnaryExpression: return !x, return -x
    if (t.isUnaryExpression(expr)) {
      return {
        returnValueType: 'EXPRESSION',
        expressionType: 'UnaryExpression',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        operator: expr.operator,
        returnValueId: NodeFactory.generateExpressionId(
          'UnaryExpression', module.file, exprLine, exprColumn
        ),
        unaryArgSourceName: t.isIdentifier(expr.argument) ? expr.argument.name : undefined,
      };
    }

    // MemberExpression (property access): return obj.prop
    if (t.isMemberExpression(expr)) {
      return {
        returnValueType: 'EXPRESSION',
        expressionType: 'MemberExpression',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        returnValueId: NodeFactory.generateExpressionId(
          'MemberExpression', module.file, exprLine, exprColumn
        ),
        object: t.isIdentifier(expr.object) ? expr.object.name : undefined,
        objectSourceName: t.isIdentifier(expr.object) ? expr.object.name : undefined,
        property: t.isIdentifier(expr.property) ? expr.property.name : undefined,
        computed: expr.computed,
      };
    }

    // NewExpression: return new Foo()
    if (t.isNewExpression(expr)) {
      return {
        returnValueType: 'EXPRESSION',
        expressionType: 'NewExpression',
        returnValueLine: exprLine,
        returnValueColumn: exprColumn,
        returnValueId: NodeFactory.generateExpressionId(
          'NewExpression', module.file, exprLine, exprColumn
        ),
      };
    }

    // Fallback for other expression types
    return {
      returnValueType: 'EXPRESSION',
      expressionType: expr.type,
      returnValueLine: exprLine,
      returnValueColumn: exprColumn,
      returnValueId: NodeFactory.generateExpressionId(
        expr.type, module.file, exprLine, exprColumn
      ),
    };
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
    // e.g., `const double = x => x * 2;` — this needs this.extractReturnExpressionInfo,
    // so it stays here rather than in a handler.
    if (t.isArrowFunctionExpression(ctx.funcNode) && !t.isBlockStatement(ctx.funcNode.body) && ctx.currentFunctionId) {
      const bodyExpr = ctx.funcNode.body;
      const exprInfo = this.extractReturnExpressionInfo(
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
      this.collectCatchesFromInfo(
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

  /**
   * Handle CallExpression nodes: direct function calls (greet(), main())
   * and method calls (obj.method(), data.process()).
   *
   * Handles:
   * - Direct function calls (Identifier callee) → callSites collection
   * - Method calls (MemberExpression callee) → methodCalls collection
   * - Array mutation detection (push, unshift, splice)
   * - Object.assign() detection
   * - REG-311: isAwaited and isInsideTry metadata on CALL nodes
   *
   * @param callNode - The call expression AST node
   * @param processedCallSites - Set of already processed call site keys to avoid duplicates
   * @param processedMethodCalls - Set of already processed method call keys to avoid duplicates
   * @param callSites - Collection for direct function calls
   * @param methodCalls - Collection for method calls
   * @param module - Current module being analyzed
   * @param callSiteCounterRef - Counter for legacy ID generation
   * @param scopeTracker - Optional scope tracker for semantic ID generation
   * @param parentScopeId - ID of the parent scope containing this call
   * @param collections - Full collections object for array/object mutations
   * @param isAwaited - REG-311: true if wrapped in await expression
   * @param isInsideTry - REG-311: true if inside try block
   */
  private handleCallExpression(
    callNode: t.CallExpression,
    processedCallSites: Set<string>,
    processedMethodCalls: Set<string>,
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    module: VisitorModule,
    callSiteCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    parentScopeId: string,
    collections: VisitorCollections,
    isAwaited: boolean = false,
    isInsideTry: boolean = false,
    isInsideLoop: boolean = false
  ): void {
    // Handle direct function calls (greet(), main())
    if (callNode.callee.type === 'Identifier') {
      const nodeKey = `${callNode.start}:${callNode.end}`;
      if (processedCallSites.has(nodeKey)) {
        return;
      }
      processedCallSites.add(nodeKey);

      // Generate semantic ID (primary) or legacy ID (fallback)
      const calleeName = callNode.callee.name;
      const legacyId = `CALL#${calleeName}#${module.file}#${getLine(callNode)}:${getColumn(callNode)}:${callSiteCounterRef.value++}`;

      let callId = legacyId;
      if (scopeTracker) {
        const discriminator = scopeTracker.getItemCounter(`CALL:${calleeName}`);
        callId = computeSemanticId('CALL', calleeName, scopeTracker.getContext(), { discriminator });
      }

      callSites.push({
        id: callId,
        type: 'CALL',
        name: calleeName,
        file: module.file,
        line: getLine(callNode),
        column: getColumn(callNode),  // REG-223: Add column for coordinate-based lookup
        parentScopeId,
        targetFunctionName: calleeName,
        // REG-311: Async error tracking metadata
        isAwaited,
        isInsideTry,
        // REG-298: Await-in-loop detection
        ...(isAwaited && isInsideLoop ? { isInsideLoop } : {})
      });
    }
    // Handle method calls (obj.method(), data.process())
    else if (callNode.callee.type === 'MemberExpression') {
      const memberCallee = callNode.callee;
      const object = memberCallee.object;
      const property = memberCallee.property;
      const isComputed = memberCallee.computed;

      if ((object.type === 'Identifier' || object.type === 'ThisExpression') && property.type === 'Identifier') {
        const nodeKey = `${callNode.start}:${callNode.end}`;
        if (processedMethodCalls.has(nodeKey)) {
          return;
        }
        processedMethodCalls.add(nodeKey);

        const objectName = object.type === 'Identifier' ? object.name : 'this';
        const methodName = isComputed ? '<computed>' : property.name;
        const fullName = `${objectName}.${methodName}`;

        // Generate semantic ID (primary) or legacy ID (fallback)
        const legacyId = `CALL#${fullName}#${module.file}#${getLine(callNode)}:${getColumn(callNode)}:${callSiteCounterRef.value++}`;

        let methodCallId = legacyId;
        if (scopeTracker) {
          const discriminator = scopeTracker.getItemCounter(`CALL:${fullName}`);
          methodCallId = computeSemanticId('CALL', fullName, scopeTracker.getContext(), { discriminator });
        }

        methodCalls.push({
          id: methodCallId,
          type: 'CALL',
          name: fullName,
          object: objectName,
          method: methodName,
          computed: isComputed,
          computedPropertyVar: isComputed ? property.name : null,
          file: module.file,
          line: getLine(callNode),
          column: getColumn(callNode),
          parentScopeId,
          // REG-311: Async error tracking metadata
          isAwaited,
          isInsideTry,
          // REG-298: Await-in-loop detection
          ...(isAwaited && isInsideLoop ? { isInsideLoop } : {}),
          isMethodCall: true
        });

        // REG-400: Extract arguments for method calls (enables callback resolution)
        if (callNode.arguments.length > 0) {
          this.extractMethodCallArguments(callNode, methodCallId, module, collections);
        }

        // Check for array mutation methods (push, unshift, splice)
        const ARRAY_MUTATION_METHODS = ['push', 'unshift', 'splice'];
        if (ARRAY_MUTATION_METHODS.includes(methodName)) {
          // Initialize collection if not exists
          if (!collections.arrayMutations) {
            collections.arrayMutations = [];
          }
          const arrayMutations = collections.arrayMutations as ArrayMutationInfo[];
          this.detectArrayMutationInFunction(
            callNode,
            objectName,
            methodName as 'push' | 'unshift' | 'splice',
            module,
            arrayMutations,
            scopeTracker
          );
        }

        // Check for Object.assign() calls
        if (objectName === 'Object' && methodName === 'assign') {
          // Initialize collection if not exists
          if (!collections.objectMutations) {
            collections.objectMutations = [];
          }
          const objectMutations = collections.objectMutations as ObjectMutationInfo[];
          this.detectObjectAssignInFunction(
            callNode,
            module,
            objectMutations,
            scopeTracker
          );
        }
      }
      // REG-117: Nested array mutations like obj.arr.push(item)
      // REG-395: General nested method calls like a.b.c() or obj.nested.method()
      // object is MemberExpression, property is the method name
      else if (object.type === 'MemberExpression' && property.type === 'Identifier') {
        const nestedMember = object;
        const methodName = property.name;
        const ARRAY_MUTATION_METHODS = ['push', 'unshift', 'splice'];

        if (ARRAY_MUTATION_METHODS.includes(methodName)) {
          // Extract base object and property from nested MemberExpression
          const base = nestedMember.object;
          const prop = nestedMember.property;

          // Only handle single-level nesting: obj.arr.push() or this.items.push()
          if ((base.type === 'Identifier' || base.type === 'ThisExpression') &&
              !nestedMember.computed &&
              prop.type === 'Identifier') {
            const baseObjectName = base.type === 'Identifier' ? base.name : 'this';
            const propertyName = prop.name;

            // Initialize collection if not exists
            if (!collections.arrayMutations) {
              collections.arrayMutations = [];
            }
            const arrayMutations = collections.arrayMutations as ArrayMutationInfo[];

            this.detectArrayMutationInFunction(
              callNode,
              `${baseObjectName}.${propertyName}`,  // arrayName for ID purposes
              methodName as 'push' | 'unshift' | 'splice',
              module,
              arrayMutations,
              scopeTracker,
              true,          // isNested
              baseObjectName,
              propertyName
            );
          }
        }

        // REG-395: Create CALL node for nested method calls like a.b.c()
        const objectName = CallExpressionVisitor.extractMemberExpressionName(nestedMember as t.MemberExpression);
        if (objectName) {
          const nodeKey = `${callNode.start}:${callNode.end}`;
          if (!processedMethodCalls.has(nodeKey)) {
            processedMethodCalls.add(nodeKey);

            const fullName = `${objectName}.${methodName}`;
            const legacyId = `CALL#${fullName}#${module.file}#${getLine(callNode)}:${getColumn(callNode)}:${callSiteCounterRef.value++}`;

            let methodCallId = legacyId;
            if (scopeTracker) {
              const discriminator = scopeTracker.getItemCounter(`CALL:${fullName}`);
              methodCallId = computeSemanticId('CALL', fullName, scopeTracker.getContext(), { discriminator });
            }

            methodCalls.push({
              id: methodCallId,
              type: 'CALL',
              name: fullName,
              object: objectName,
              method: methodName,
              file: module.file,
              line: getLine(callNode),
              column: getColumn(callNode),
              parentScopeId,
              isMethodCall: true
            });

            // REG-400: Extract arguments for nested method calls (enables callback resolution)
            if (callNode.arguments.length > 0) {
              this.extractMethodCallArguments(callNode, methodCallId, module, collections);
            }
          }
        }
      }
    }
  }

  /**
   * REG-400: Extract arguments from method call nodes inside function bodies.
   * Populates callArguments collection so GraphBuilder.bufferArgumentEdges can
   * create PASSES_ARGUMENT and callback CALLS edges.
   *
   * This mirrors CallExpressionVisitor.extractArguments but is simplified —
   * handles Identifier, Literal, CallExpression, and Expression types.
   */
  private extractMethodCallArguments(
    callNode: t.CallExpression,
    methodCallId: string,
    module: VisitorModule,
    collections: VisitorCollections
  ): void {
    if (!collections.callArguments) {
      collections.callArguments = [];
    }
    const callArguments = collections.callArguments as CallArgumentInfo[];
    const literals = (collections.literals ?? []) as LiteralInfo[];
    const literalCounterRef = (collections.literalCounterRef ?? { value: 0 }) as CounterRef;

    callNode.arguments.forEach((arg, argIndex) => {
      const argInfo: CallArgumentInfo = {
        callId: methodCallId,
        argIndex,
        file: module.file,
        line: getLine(arg),
        column: getColumn(arg)
      };

      if (t.isSpreadElement(arg)) {
        const spreadArg = arg.argument;
        if (t.isIdentifier(spreadArg)) {
          argInfo.targetType = 'VARIABLE';
          argInfo.targetName = spreadArg.name;
          argInfo.isSpread = true;
        }
      } else if (t.isIdentifier(arg)) {
        argInfo.targetType = 'VARIABLE';
        argInfo.targetName = arg.name;
      } else if (t.isLiteral(arg) && !t.isTemplateLiteral(arg)) {
        const literalValue = ExpressionEvaluator.extractLiteralValue(arg as t.Literal);
        if (literalValue !== null) {
          const argLine = getLine(arg);
          const argColumn = getColumn(arg);
          const literalId = `LITERAL#arg${argIndex}#${module.file}#${argLine}:${argColumn}:${literalCounterRef.value++}`;
          literals.push({
            id: literalId,
            type: 'LITERAL',
            value: literalValue,
            valueType: typeof literalValue,
            file: module.file,
            line: argLine,
            column: argColumn,
            parentCallId: methodCallId,
            argIndex
          });
          argInfo.targetType = 'LITERAL';
          argInfo.targetId = literalId;
          argInfo.literalValue = literalValue;
        }
      } else if (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg)) {
        argInfo.targetType = 'FUNCTION';
        argInfo.functionLine = getLine(arg);
        argInfo.functionColumn = getColumn(arg);
      } else if (t.isCallExpression(arg)) {
        argInfo.targetType = 'CALL';
        argInfo.nestedCallLine = getLine(arg);
        argInfo.nestedCallColumn = getColumn(arg);
      // REG-402: MemberExpression arguments (this.handler, obj.method)
      } else if (t.isMemberExpression(arg)) {
        argInfo.targetType = 'EXPRESSION';
        argInfo.expressionType = 'MemberExpression';
        if (t.isIdentifier(arg.object)) {
          argInfo.objectName = arg.object.name;
        } else if (t.isThisExpression(arg.object)) {
          argInfo.objectName = 'this';
          // Store enclosing class name for direct lookup in GraphBuilder
          const scopeTracker = collections.scopeTracker as ScopeTracker | undefined;
          if (scopeTracker) {
            argInfo.enclosingClassName = scopeTracker.getEnclosingScope('CLASS');
          }
        }
        if (!arg.computed && t.isIdentifier(arg.property)) {
          argInfo.propertyName = arg.property.name;
        }
      } else {
        argInfo.targetType = 'EXPRESSION';
        argInfo.expressionType = arg.type;
      }

      callArguments.push(argInfo);
    });
  }

  /**
   * REG-311: Micro-trace - follow variable assignments within function to find error source.
   * Used to resolve reject(err) or throw err where err is a variable.
   *
   * Uses cycle detection via Set<variableName> to avoid infinite loops on circular assignments.
   *
   * @param variableName - Name of variable to trace
   * @param funcPath - NodePath of containing function for AST traversal
   * @param variableDeclarations - Variable declarations in current scope
   * @returns Error class name if traced to NewExpression, null otherwise, plus trace path
   */
  private microTraceToErrorClass(
    variableName: string,
    funcPath: NodePath<t.Function>,
    _variableDeclarations: VariableDeclarationInfo[]
  ): { errorClassName: string | null; tracePath: string[] } {
    const tracePath: string[] = [variableName];
    const visited = new Set<string>(); // Cycle detection
    let currentName = variableName;

    const funcBody = funcPath.node.body;
    if (!t.isBlockStatement(funcBody)) {
      return { errorClassName: null, tracePath };
    }

    // Iterate until we find a NewExpression or can't trace further
    while (!visited.has(currentName)) {
      visited.add(currentName);
      let found = false;
      let foundNewExpression: string | null = null;
      let nextName: string | null = null;

      // Walk AST to find assignments: currentName = newValue
      funcPath.traverse({
        VariableDeclarator: (declPath: NodePath<t.VariableDeclarator>) => {
          if (found || foundNewExpression) return;
          if (t.isIdentifier(declPath.node.id) && declPath.node.id.name === currentName) {
            const init = declPath.node.init;
            if (init) {
              // Case 1: const err = new Error()
              if (t.isNewExpression(init) && t.isIdentifier(init.callee)) {
                tracePath.push(`new ${init.callee.name}()`);
                foundNewExpression = init.callee.name;
                found = true;
                return;
              }
              // Case 2: const err = otherVar (chain)
              if (t.isIdentifier(init)) {
                tracePath.push(init.name);
                nextName = init.name;
                found = true;
                return;
              }
            }
          }
        },
        AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
          if (found || foundNewExpression) return;
          const left = assignPath.node.left;
          const right = assignPath.node.right;

          if (t.isIdentifier(left) && left.name === currentName) {
            if (t.isNewExpression(right) && t.isIdentifier(right.callee)) {
              tracePath.push(`new ${right.callee.name}()`);
              foundNewExpression = right.callee.name;
              found = true;
              return;
            }
            if (t.isIdentifier(right)) {
              tracePath.push(right.name);
              nextName = right.name;
              found = true;
              return;
            }
          }
        }
      });

      // If we found a NewExpression, return the class name
      if (foundNewExpression) {
        return { errorClassName: foundNewExpression, tracePath };
      }

      // If we found another variable to follow, continue
      if (nextName) {
        currentName = nextName;
        continue;
      }

      // Couldn't trace further
      break;
    }

    return { errorClassName: null, tracePath };
  }

  /**
   * REG-311: Collect CATCHES_FROM info linking catch blocks to exception sources in try blocks.
   *
   * Sources include:
   * - Awaited calls: await foo() in try block
   * - Sync calls: foo() in try block (any call can throw)
   * - Throw statements: throw new Error() in try block
   * - Constructor calls: new SomeClass() in try block
   *
   * @param funcPath - Function path to traverse
   * @param catchBlocks - Collection of CATCH_BLOCK nodes
   * @param callSites - Collection of CALL nodes (direct function calls)
   * @param methodCalls - Collection of CALL nodes (method calls)
   * @param constructorCalls - Collection of CONSTRUCTOR_CALL nodes
   * @param catchesFromInfos - Collection to push CatchesFromInfo to
   * @param module - Module context
   */
  private collectCatchesFromInfo(
    funcPath: NodePath<t.Function>,
    catchBlocks: CatchBlockInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    constructorCalls: ConstructorCallInfo[],
    catchesFromInfos: CatchesFromInfo[],
    module: VisitorModule
  ): void {
    // Traverse to find TryStatements and collect sources
    funcPath.traverse({
      TryStatement: (tryPath: NodePath<t.TryStatement>) => {
        const tryNode = tryPath.node;
        const handler = tryNode.handler;

        // Skip if no catch clause
        if (!handler) return;

        // Find the catch block for this try
        // Match by line number since we don't have the tryBlockId here
        const catchLine = getLine(handler);
        const catchBlock = catchBlocks.find(cb =>
          cb.file === module.file && cb.line === catchLine
        );

        if (!catchBlock || !catchBlock.parameterName) return;

        // Traverse only the try block body (not catch or finally)
        const _tryBody = tryNode.block;
        const sources: Array<{ id: string; type: CatchesFromInfo['sourceType']; line: number }> = [];

        // Collect sources from try block
        tryPath.get('block').traverse({
          // Stop at nested TryStatement - don't collect from inner try blocks
          TryStatement: (innerPath) => {
            innerPath.skip(); // Don't traverse into nested try blocks
          },

          // Stop at function boundaries - don't collect from nested functions
          Function: (innerFuncPath) => {
            innerFuncPath.skip();
          },

          CallExpression: (callPath: NodePath<t.CallExpression>) => {
            const callNode = callPath.node;
            const callLine = getLine(callNode);
            const callColumn = getColumn(callNode);

            // Check if this is an awaited call
            const parent = callPath.parentPath;
            const isAwaited = parent?.isAwaitExpression() ?? false;

            // Find the CALL node that matches this CallExpression
            let sourceId: string | null = null;
            let sourceType: CatchesFromInfo['sourceType'] = 'sync_call';

            // Check method calls first (includes Promise.reject which is a method call)
            const matchingMethodCall = methodCalls.find(mc =>
              mc.file === module.file &&
              mc.line === callLine &&
              mc.column === callColumn
            );

            if (matchingMethodCall) {
              sourceId = matchingMethodCall.id;
              sourceType = isAwaited ? 'awaited_call' : 'sync_call';
            } else {
              // Check direct function calls
              const matchingCallSite = callSites.find(cs =>
                cs.file === module.file &&
                cs.line === callLine &&
                cs.column === callColumn
              );

              if (matchingCallSite) {
                sourceId = matchingCallSite.id;
                sourceType = isAwaited ? 'awaited_call' : 'sync_call';
              }
            }

            if (sourceId) {
              sources.push({ id: sourceId, type: sourceType, line: callLine });
            }
          },

          ThrowStatement: (throwPath: NodePath<t.ThrowStatement>) => {
            const throwNode = throwPath.node;
            const throwLine = getLine(throwNode);
            const throwColumn = getColumn(throwNode);

            // Create a synthetic ID for the throw statement
            // We don't have THROW_STATEMENT nodes, so we use line/column as identifier
            const sourceId = `THROW#${module.file}#${throwLine}:${throwColumn}`;

            sources.push({ id: sourceId, type: 'throw_statement', line: throwLine });
          },

          NewExpression: (newPath: NodePath<t.NewExpression>) => {
            // Skip NewExpression that is direct argument of ThrowStatement
            // In `throw new Error()`, the throw statement is the primary source
            if (newPath.parentPath?.isThrowStatement()) {
              return;
            }

            const newNode = newPath.node;
            const newLine = getLine(newNode);
            const newColumn = getColumn(newNode);

            // Find matching constructor call
            const matchingConstructor = constructorCalls.find(cc =>
              cc.file === module.file &&
              cc.line === newLine &&
              cc.column === newColumn
            );

            if (matchingConstructor) {
              sources.push({ id: matchingConstructor.id, type: 'constructor_call', line: newLine });
            }
          }
        });

        // Create CatchesFromInfo for each source
        for (const source of sources) {
          catchesFromInfos.push({
            catchBlockId: catchBlock.id,
            parameterName: catchBlock.parameterName,
            sourceId: source.id,
            sourceType: source.type,
            file: module.file,
            sourceLine: source.line
          });
        }
      }
    });
  }

  /**
   * Detect array mutation calls (push, unshift, splice) inside functions
   * and collect mutation info for FLOWS_INTO edge creation in GraphBuilder
   *
   * REG-117: Added isNested, baseObjectName, propertyName for nested mutations
   *
   * @param callNode - The call expression node
   * @param arrayName - Name of the array being mutated
   * @param method - The mutation method (push, unshift, splice)
   * @param module - Current module being analyzed
   * @param arrayMutations - Collection to push mutation info into
   * @param scopeTracker - Optional scope tracker for semantic IDs
   * @param isNested - REG-117: true if this is a nested mutation (obj.arr.push)
   * @param baseObjectName - REG-117: base object name for nested mutations
   * @param propertyName - REG-117: property name for nested mutations
   */
  private detectArrayMutationInFunction(
    callNode: t.CallExpression,
    arrayName: string,
    method: 'push' | 'unshift' | 'splice',
    module: VisitorModule,
    arrayMutations: ArrayMutationInfo[],
    scopeTracker?: ScopeTracker,
    isNested?: boolean,
    baseObjectName?: string,
    propertyName?: string
  ): void {
    const mutationArgs: ArrayMutationArgument[] = [];

    // For splice, only arguments from index 2 onwards are insertions
    // splice(start, deleteCount, item1, item2, ...)
    callNode.arguments.forEach((arg, index) => {
      // Skip start and deleteCount for splice
      if (method === 'splice' && index < 2) return;

      const argInfo: ArrayMutationArgument = {
        argIndex: method === 'splice' ? index - 2 : index,
        isSpread: arg.type === 'SpreadElement',
        valueType: 'EXPRESSION'  // Default
      };

      let actualArg: t.Node = arg;
      if (arg.type === 'SpreadElement') {
        actualArg = arg.argument;
      }

      // Determine value type
      const literalValue = ExpressionEvaluator.extractLiteralValue(actualArg);
      if (literalValue !== null) {
        argInfo.valueType = 'LITERAL';
        argInfo.literalValue = literalValue;
      } else if (actualArg.type === 'Identifier') {
        argInfo.valueType = 'VARIABLE';
        argInfo.valueName = actualArg.name;
      } else if (actualArg.type === 'ObjectExpression') {
        argInfo.valueType = 'OBJECT_LITERAL';
      } else if (actualArg.type === 'ArrayExpression') {
        argInfo.valueType = 'ARRAY_LITERAL';
      } else if (actualArg.type === 'CallExpression') {
        argInfo.valueType = 'CALL';
        argInfo.callLine = actualArg.loc?.start.line;
        argInfo.callColumn = actualArg.loc?.start.column;
      }

      mutationArgs.push(argInfo);
    });

    // Only record if there are actual insertions
    if (mutationArgs.length > 0) {
      const line = callNode.loc?.start.line ?? 0;
      const column = callNode.loc?.start.column ?? 0;

      // Generate semantic ID for array mutation if scopeTracker available
      let mutationId: string | undefined;
      if (scopeTracker) {
        const discriminator = scopeTracker.getItemCounter(`ARRAY_MUTATION:${arrayName}.${method}`);
        mutationId = computeSemanticId('ARRAY_MUTATION', `${arrayName}.${method}`, scopeTracker.getContext(), { discriminator });
      }

      arrayMutations.push({
        id: mutationId,
        arrayName,
        mutationMethod: method,
        file: module.file,
        line,
        column,
        insertedValues: mutationArgs,
        // REG-117: Nested mutation fields
        isNested,
        baseObjectName,
        propertyName
      });
    }
  }

  /**
   * Detect indexed array assignment: arr[i] = value
   * Creates ArrayMutationInfo for FLOWS_INTO edge generation in GraphBuilder.
   * For non-variable values (LITERAL, OBJECT_LITERAL, ARRAY_LITERAL), creates
   * value nodes and sets valueNodeId so GraphBuilder can create FLOWS_INTO edges.
   *
   * @param assignNode - The assignment expression node
   * @param module - Current module being analyzed
   * @param arrayMutations - Collection to push mutation info into
   * @param scopeTracker - Scope tracker for semantic ID generation
   * @param collections - Collections for creating value nodes (literals, objectLiterals, etc.)
   */
  private detectIndexedArrayAssignment(
    assignNode: t.AssignmentExpression,
    module: VisitorModule,
    arrayMutations: ArrayMutationInfo[],
    scopeTracker?: ScopeTracker,
    collections?: VisitorCollections
  ): void {
    // Check for indexed array assignment: arr[i] = value
    if (assignNode.left.type === 'MemberExpression' && assignNode.left.computed) {
      const memberExpr = assignNode.left;

      // Only process NumericLiteral keys - those are clearly array indexed assignments
      // e.g., arr[0] = value, arr[1] = value
      // Other computed keys (Identifier, expressions) are ambiguous (could be array or object)
      // and are handled by detectObjectPropertyAssignment as computed mutations
      if (memberExpr.property.type !== 'NumericLiteral') {
        return;
      }

      // Get array name (only simple identifiers for now)
      if (memberExpr.object.type === 'Identifier') {
        const arrayName = memberExpr.object.name;
        const value = assignNode.right;

        // Use defensive loc checks instead of ! assertions
        const line = assignNode.loc?.start.line ?? 0;
        const column = assignNode.loc?.start.column ?? 0;

        const argInfo: ArrayMutationArgument = {
          argIndex: 0,
          isSpread: false,
          valueType: 'EXPRESSION'
        };

        // Determine value type and create value nodes for non-variable types
        // IMPORTANT: Check ObjectExpression/ArrayExpression BEFORE extractLiteralValue
        // to match the order in detectArrayMutation and extractArguments (REG-396).
        // extractLiteralValue returns objects/arrays with all-literal properties as
        // literal values, but we want OBJECT_LITERAL/ARRAY_LITERAL nodes instead.
        if (value.type === 'ObjectExpression') {
          argInfo.valueType = 'OBJECT_LITERAL';
          const valueLine = value.loc?.start.line ?? line;
          const valueColumn = value.loc?.start.column ?? column;
          // Create OBJECT_LITERAL node if collections available
          if (collections?.objectLiteralCounterRef) {
            if (!collections.objectLiterals) collections.objectLiterals = [];
            const objectLiteralCounterRef = collections.objectLiteralCounterRef as CounterRef;
            const objectNode = ObjectLiteralNode.create(
              module.file, valueLine, valueColumn,
              { counter: objectLiteralCounterRef.value++ }
            );
            (collections.objectLiterals as ObjectLiteralInfo[]).push(objectNode as unknown as ObjectLiteralInfo);
            argInfo.valueNodeId = objectNode.id;
          }
        } else if (value.type === 'ArrayExpression') {
          argInfo.valueType = 'ARRAY_LITERAL';
          const valueLine = value.loc?.start.line ?? line;
          const valueColumn = value.loc?.start.column ?? column;
          // Create ARRAY_LITERAL node if collections available
          if (collections?.arrayLiteralCounterRef) {
            if (!collections.arrayLiterals) collections.arrayLiterals = [];
            const arrayLiteralCounterRef = collections.arrayLiteralCounterRef as CounterRef;
            const arrayNode = ArrayLiteralNode.create(
              module.file, valueLine, valueColumn,
              { counter: arrayLiteralCounterRef.value++ }
            );
            (collections.arrayLiterals as ArrayLiteralInfo[]).push(arrayNode as unknown as ArrayLiteralInfo);
            argInfo.valueNodeId = arrayNode.id;
          }
        } else if (value.type === 'Identifier') {
          argInfo.valueType = 'VARIABLE';
          argInfo.valueName = value.name;
        } else if (value.type === 'CallExpression') {
          argInfo.valueType = 'CALL';
          argInfo.callLine = value.loc?.start.line;
          argInfo.callColumn = value.loc?.start.column;
        } else {
          const literalValue = ExpressionEvaluator.extractLiteralValue(value);
          if (literalValue !== null) {
            argInfo.valueType = 'LITERAL';
            argInfo.literalValue = literalValue;
            const valueLine = value.loc?.start.line ?? line;
            const valueColumn = value.loc?.start.column ?? column;
            // Create LITERAL node if collections available
            if (collections?.literals && collections.literalCounterRef) {
              const literalCounterRef = collections.literalCounterRef as CounterRef;
              const literalId = `LITERAL#indexed#${module.file}#${valueLine}:${valueColumn}:${literalCounterRef.value++}`;
              (collections.literals as LiteralInfo[]).push({
                id: literalId,
                type: 'LITERAL',
                value: literalValue,
                valueType: typeof literalValue,
                file: module.file,
                line: valueLine,
                column: valueColumn,
                parentCallId: undefined,
                argIndex: 0
              } as LiteralInfo);
              argInfo.valueNodeId = literalId;
            }
          }
        }

        // Capture scope path for scope-aware lookup (REG-309)
        const scopePath = scopeTracker?.getContext().scopePath ?? [];

        arrayMutations.push({
          arrayName,
          mutationScopePath: scopePath,
          mutationMethod: 'indexed',
          file: module.file,
          line: line,
          column: column,
          insertedValues: [argInfo]
        });
      }
    }
  }

  /**
   * Detect object property assignment: obj.prop = value, obj['prop'] = value
   * Creates ObjectMutationInfo for FLOWS_INTO edge generation in GraphBuilder
   *
   * @param assignNode - The assignment expression node
   * @param module - Current module being analyzed
   * @param objectMutations - Collection to push mutation info into
   * @param scopeTracker - Optional scope tracker for semantic IDs
   */
  private detectObjectPropertyAssignment(
    assignNode: t.AssignmentExpression,
    module: VisitorModule,
    objectMutations: ObjectMutationInfo[],
    scopeTracker?: ScopeTracker
  ): void {
    // Check for property assignment: obj.prop = value or obj['prop'] = value
    if (assignNode.left.type !== 'MemberExpression') return;

    const memberExpr = assignNode.left;

    // Skip NumericLiteral indexed assignment (handled by array mutation handler)
    // Array mutation handler processes: arr[0] (numeric literal index)
    // Object mutation handler processes: obj.prop, obj['prop'], obj[key], obj[expr]
    if (memberExpr.computed && memberExpr.property.type === 'NumericLiteral') {
      return; // Let array mutation handler deal with this
    }

    // Get object name and enclosing class context for 'this'
    let objectName: string;
    let enclosingClassName: string | undefined;

    if (memberExpr.object.type === 'Identifier') {
      objectName = memberExpr.object.name;
    } else if (memberExpr.object.type === 'ThisExpression') {
      objectName = 'this';
      // REG-152: Extract enclosing class name from scope context
      if (scopeTracker) {
        enclosingClassName = scopeTracker.getEnclosingScope('CLASS');
      }
    } else {
      // Complex expressions like obj.nested.prop = value
      // For now, skip these (documented limitation)
      return;
    }

    // Get property name
    let propertyName: string;
    let mutationType: 'property' | 'computed';
    let computedPropertyVar: string | undefined;

    if (!memberExpr.computed) {
      // obj.prop
      if (memberExpr.property.type === 'Identifier') {
        propertyName = memberExpr.property.name;
        mutationType = 'property';
      } else {
        return; // Unexpected property type
      }
    } else {
      // obj['prop'] or obj[key]
      if (memberExpr.property.type === 'StringLiteral') {
        propertyName = memberExpr.property.value;
        mutationType = 'property'; // String literal is effectively a property name
      } else {
        propertyName = '<computed>';
        mutationType = 'computed';
        // Capture variable name for later resolution in enrichment phase
        if (memberExpr.property.type === 'Identifier') {
          computedPropertyVar = memberExpr.property.name;
        }
      }
    }

    // Extract value info
    const value = assignNode.right;
    const valueInfo = this.extractMutationValue(value);

    // Use defensive loc checks
    const line = assignNode.loc?.start.line ?? 0;
    const column = assignNode.loc?.start.column ?? 0;

    // Capture scope path for scope-aware lookup (REG-309)
    const scopePath = scopeTracker?.getContext().scopePath ?? [];

    // Generate semantic ID if scopeTracker available
    let mutationId: string | undefined;
    if (scopeTracker) {
      const discriminator = scopeTracker.getItemCounter(`OBJECT_MUTATION:${objectName}.${propertyName}`);
      mutationId = computeSemanticId('OBJECT_MUTATION', `${objectName}.${propertyName}`, scopeTracker.getContext(), { discriminator });
    }

    objectMutations.push({
      id: mutationId,
      objectName,
      mutationScopePath: scopePath,
      enclosingClassName,  // REG-152: Class name for 'this' mutations
      propertyName,
      mutationType,
      computedPropertyVar,
      file: module.file,
      line,
      column,
      value: valueInfo
    });
  }

  /**
   * Collect update expression info for graph building (i++, obj.prop++, arr[i]++).
   *
   * REG-288: Simple identifiers (i++, --count)
   * REG-312: Member expressions (obj.prop++, arr[i]++, this.count++)
   *
   * Creates UpdateExpressionInfo entries that GraphBuilder uses to create:
   * - UPDATE_EXPRESSION nodes
   * - MODIFIES edges to target variables/objects
   * - READS_FROM self-loops
   * - CONTAINS edges for scope hierarchy
   */
  private collectUpdateExpression(
    updateNode: t.UpdateExpression,
    module: VisitorModule,
    updateExpressions: UpdateExpressionInfo[],
    parentScopeId: string | undefined,
    scopeTracker?: ScopeTracker
  ): void {
    const operator = updateNode.operator as '++' | '--';
    const prefix = updateNode.prefix;
    const line = getLine(updateNode);
    const column = getColumn(updateNode);

    // CASE 1: Simple identifier (i++, --count) - REG-288 behavior
    if (updateNode.argument.type === 'Identifier') {
      const variableName = updateNode.argument.name;

      updateExpressions.push({
        targetType: 'IDENTIFIER',
        variableName,
        variableLine: getLine(updateNode.argument),
        operator,
        prefix,
        file: module.file,
        line,
        column,
        parentScopeId
      });
      return;
    }

    // CASE 2: Member expression (obj.prop++, arr[i]++) - REG-312 new
    if (updateNode.argument.type === 'MemberExpression') {
      const memberExpr = updateNode.argument;

      // Extract object name (reuses detectObjectPropertyAssignment pattern)
      let objectName: string;
      let enclosingClassName: string | undefined;

      if (memberExpr.object.type === 'Identifier') {
        objectName = memberExpr.object.name;
      } else if (memberExpr.object.type === 'ThisExpression') {
        objectName = 'this';
        // REG-152: Extract enclosing class name from scope context
        if (scopeTracker) {
          enclosingClassName = scopeTracker.getEnclosingScope('CLASS');
        }
      } else {
        // Complex expressions: obj.nested.prop++, (obj || fallback).count++
        // Skip for now (documented limitation, same as detectObjectPropertyAssignment)
        return;
      }

      // Extract property name (reuses detectObjectPropertyAssignment pattern)
      let propertyName: string;
      let mutationType: 'property' | 'computed';
      let computedPropertyVar: string | undefined;

      if (!memberExpr.computed) {
        // obj.prop++
        if (memberExpr.property.type === 'Identifier') {
          propertyName = memberExpr.property.name;
          mutationType = 'property';
        } else {
          return; // Unexpected property type
        }
      } else {
        // obj['prop']++ or obj[key]++
        if (memberExpr.property.type === 'StringLiteral') {
          // obj['prop']++ - static string
          propertyName = memberExpr.property.value;
          mutationType = 'property';
        } else {
          // obj[key]++, arr[i]++ - computed property
          propertyName = '<computed>';
          mutationType = 'computed';
          if (memberExpr.property.type === 'Identifier') {
            computedPropertyVar = memberExpr.property.name;
          }
        }
      }

      updateExpressions.push({
        targetType: 'MEMBER_EXPRESSION',
        objectName,
        objectLine: getLine(memberExpr.object),
        enclosingClassName,
        propertyName,
        mutationType,
        computedPropertyVar,
        operator,
        prefix,
        file: module.file,
        line,
        column,
        parentScopeId
      });
    }
  }

  /**
   * Detect variable reassignment for FLOWS_INTO edge creation.
   * Handles all assignment operators: =, +=, -=, *=, /=, etc.
   *
   * Captures COMPLETE metadata for:
   * - LITERAL values (literalValue field)
   * - EXPRESSION nodes (expressionType, expressionMetadata fields)
   * - VARIABLE, CALL_SITE, METHOD_CALL references
   *
   * REG-290: No deferred functionality - all value types captured.
   */
  private detectVariableReassignment(
    assignNode: t.AssignmentExpression,
    module: VisitorModule,
    variableReassignments: VariableReassignmentInfo[],
    scopeTracker?: ScopeTracker
  ): void {
    // LHS must be simple identifier (checked by caller)
    const leftId = assignNode.left as t.Identifier;
    const variableName = leftId.name;
    const operator = assignNode.operator;  // '=', '+=', '-=', etc.

    // Get RHS value info
    const rightExpr = assignNode.right;
    const line = getLine(assignNode);
    const column = getColumn(assignNode);

    // Extract value source (similar to VariableVisitor pattern)
    let valueType: 'VARIABLE' | 'CALL_SITE' | 'METHOD_CALL' | 'LITERAL' | 'EXPRESSION';
    let valueName: string | undefined;
    let valueId: string | null = null;
    let callLine: number | undefined;
    let callColumn: number | undefined;

    // Complete metadata for node creation
    let literalValue: unknown;
    let expressionType: string | undefined;
    let expressionMetadata: VariableReassignmentInfo['expressionMetadata'];

    // 1. Literal value
    const extractedLiteralValue = ExpressionEvaluator.extractLiteralValue(rightExpr);
    if (extractedLiteralValue !== null) {
      valueType = 'LITERAL';
      valueId = `LITERAL#${line}:${rightExpr.start}#${module.file}`;
      literalValue = extractedLiteralValue;  // Store for GraphBuilder
    }
    // 2. Simple identifier (variable reference)
    else if (rightExpr.type === 'Identifier') {
      valueType = 'VARIABLE';
      valueName = rightExpr.name;
    }
    // 3. CallExpression (function call)
    else if (rightExpr.type === 'CallExpression' && rightExpr.callee.type === 'Identifier') {
      valueType = 'CALL_SITE';
      valueName = rightExpr.callee.name;
      callLine = getLine(rightExpr);
      callColumn = getColumn(rightExpr);
    }
    // 4. MemberExpression (method call: obj.method())
    else if (rightExpr.type === 'CallExpression' && rightExpr.callee.type === 'MemberExpression') {
      valueType = 'METHOD_CALL';
      callLine = getLine(rightExpr);
      callColumn = getColumn(rightExpr);
    }
    // 5. Everything else is EXPRESSION
    else {
      valueType = 'EXPRESSION';
      expressionType = rightExpr.type;  // Store AST node type
      // Use correct EXPRESSION ID format: {file}:EXPRESSION:{type}:{line}:{column}
      valueId = `${module.file}:EXPRESSION:${expressionType}:${line}:${column}`;

      // Extract type-specific metadata (matches VariableAssignmentInfo pattern)
      expressionMetadata = {};

      // MemberExpression: obj.prop or obj[key]
      if (rightExpr.type === 'MemberExpression') {
        const objName = rightExpr.object.type === 'Identifier' ? rightExpr.object.name : undefined;
        const propName = rightExpr.property.type === 'Identifier' ? rightExpr.property.name : undefined;
        const computed = rightExpr.computed;

        expressionMetadata.object = objName;
        expressionMetadata.property = propName;
        expressionMetadata.computed = computed;

        // Computed property variable: obj[varName]
        if (computed && rightExpr.property.type === 'Identifier') {
          expressionMetadata.computedPropertyVar = rightExpr.property.name;
        }
      }
      // BinaryExpression: a + b, a - b, etc.
      else if (rightExpr.type === 'BinaryExpression' || rightExpr.type === 'LogicalExpression') {
        expressionMetadata.operator = rightExpr.operator;
        expressionMetadata.leftSourceName = rightExpr.left.type === 'Identifier' ? rightExpr.left.name : undefined;
        expressionMetadata.rightSourceName = rightExpr.right.type === 'Identifier' ? rightExpr.right.name : undefined;
      }
      // ConditionalExpression: condition ? a : b
      else if (rightExpr.type === 'ConditionalExpression') {
        expressionMetadata.consequentSourceName = rightExpr.consequent.type === 'Identifier' ? rightExpr.consequent.name : undefined;
        expressionMetadata.alternateSourceName = rightExpr.alternate.type === 'Identifier' ? rightExpr.alternate.name : undefined;
      }
      // Add more expression types as needed
    }

    // Capture scope path for scope-aware lookup (REG-309)
    const scopePath = scopeTracker?.getContext().scopePath ?? [];

    // Push reassignment info to collection
    variableReassignments.push({
      variableName,
      variableLine: getLine(leftId),
      mutationScopePath: scopePath,
      valueType,
      valueName,
      valueId,
      callLine,
      callColumn,
      operator,
      // Complete metadata
      literalValue,
      expressionType,
      expressionMetadata,
      file: module.file,
      line,
      column
    });
  }

  /**
   * Extract value information from an expression for mutation tracking
   */
  private extractMutationValue(value: t.Expression): ObjectMutationValue {
    const valueInfo: ObjectMutationValue = {
      valueType: 'EXPRESSION'  // Default
    };

    const literalValue = ExpressionEvaluator.extractLiteralValue(value);
    if (literalValue !== null) {
      valueInfo.valueType = 'LITERAL';
      valueInfo.literalValue = literalValue;
    } else if (value.type === 'Identifier') {
      valueInfo.valueType = 'VARIABLE';
      valueInfo.valueName = value.name;
    } else if (value.type === 'ObjectExpression') {
      valueInfo.valueType = 'OBJECT_LITERAL';
    } else if (value.type === 'ArrayExpression') {
      valueInfo.valueType = 'ARRAY_LITERAL';
    } else if (value.type === 'CallExpression') {
      valueInfo.valueType = 'CALL';
      valueInfo.callLine = value.loc?.start.line;
      valueInfo.callColumn = value.loc?.start.column;
    }

    return valueInfo;
  }

  /**
   * Detect Object.assign() calls inside functions
   * Creates ObjectMutationInfo for FLOWS_INTO edge generation in GraphBuilder
   */
  private detectObjectAssignInFunction(
    callNode: t.CallExpression,
    module: VisitorModule,
    objectMutations: ObjectMutationInfo[],
    scopeTracker?: ScopeTracker
  ): void {
    // Need at least 2 arguments: target and at least one source
    if (callNode.arguments.length < 2) return;

    // First argument is target
    const targetArg = callNode.arguments[0];
    let targetName: string;

    if (targetArg.type === 'Identifier') {
      targetName = targetArg.name;
    } else if (targetArg.type === 'ObjectExpression') {
      targetName = '<anonymous>';
    } else {
      return;
    }

    const line = callNode.loc?.start.line ?? 0;
    const column = callNode.loc?.start.column ?? 0;

    for (let i = 1; i < callNode.arguments.length; i++) {
      let arg = callNode.arguments[i];
      let isSpread = false;

      if (arg.type === 'SpreadElement') {
        isSpread = true;
        arg = arg.argument;
      }

      const valueInfo: ObjectMutationValue = {
        valueType: 'EXPRESSION',
        argIndex: i - 1,
        isSpread
      };

      const literalValue = ExpressionEvaluator.extractLiteralValue(arg);
      if (literalValue !== null) {
        valueInfo.valueType = 'LITERAL';
        valueInfo.literalValue = literalValue;
      } else if (arg.type === 'Identifier') {
        valueInfo.valueType = 'VARIABLE';
        valueInfo.valueName = arg.name;
      } else if (arg.type === 'ObjectExpression') {
        valueInfo.valueType = 'OBJECT_LITERAL';
      } else if (arg.type === 'ArrayExpression') {
        valueInfo.valueType = 'ARRAY_LITERAL';
      } else if (arg.type === 'CallExpression') {
        valueInfo.valueType = 'CALL';
        valueInfo.callLine = arg.loc?.start.line;
        valueInfo.callColumn = arg.loc?.start.column;
      }

      let mutationId: string | undefined;
      if (scopeTracker) {
        const discriminator = scopeTracker.getItemCounter(`OBJECT_MUTATION:Object.assign:${targetName}`);
        mutationId = computeSemanticId('OBJECT_MUTATION', `Object.assign:${targetName}`, scopeTracker.getContext(), { discriminator });
      }

      objectMutations.push({
        id: mutationId,
        objectName: targetName,
        propertyName: '<assign>',
        mutationType: 'assign',
        file: module.file,
        line,
        column,
        value: valueInfo
      });
    }
  }
}
