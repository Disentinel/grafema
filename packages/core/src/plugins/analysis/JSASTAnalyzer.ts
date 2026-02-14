/**
 * JSASTAnalyzer - плагин для парсинга JavaScript AST
 * Создаёт ноды: FUNCTION, CLASS, METHOD и т.д.
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { basename } from 'path';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { NodePath, TraverseOptions } from '@babel/traverse';
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
import { ExpressionNode } from '../../core/nodes/ExpressionNode.js';
import { ConstructorCallNode } from '../../core/nodes/ConstructorCallNode.js';
import { ObjectLiteralNode } from '../../core/nodes/ObjectLiteralNode.js';
import { ArrayLiteralNode } from '../../core/nodes/ArrayLiteralNode.js';
import { NodeFactory } from '../../core/NodeFactory.js';
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
  CounterRef,
  ProcessedNodes,
  ASTCollections,
  ExtractedVariable,
} from './ast/types.js';
import { extractNamesFromPattern } from './ast/utils/extractNamesFromPattern.js';

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

/**
 * Tracks try/catch/finally scope transitions during traversal.
 * Used by createTryStatementHandler and createBlockStatementHandler.
 */
interface TryScopeInfo {
  tryScopeId: string;
  catchScopeId: string | null;
  finallyScopeId: string | null;
  currentBlock: 'try' | 'catch' | 'finally';
  // Phase 4: Control flow node IDs
  tryBlockId: string;
  catchBlockId: string | null;
  finallyBlockId: string | null;
}

/**
 * Tracks if/else scope transitions during traversal.
 * Used by createIfStatementHandler and createBlockStatementHandler.
 * Phase 3: Extended to include branchId for control flow BRANCH nodes.
 */
interface IfElseScopeInfo {
  inElse: boolean;
  hasElse: boolean;
  ifScopeId: string;
  elseScopeId: string | null;
  // Phase 3: Control flow BRANCH node ID
  branchId: string;
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
          'INTERFACE', 'TYPE', 'ENUM', 'DECORATOR'
        ],
        edges: [
          'CONTAINS', 'DECLARES', 'CALLS', 'HAS_SCOPE', 'CAPTURES', 'MODIFIES',
          'WRITES_TO', 'IMPORTS', 'INSTANCE_OF', 'HANDLED_BY', 'HAS_CALLBACK',
          'PASSES_ARGUMENT', 'MAKES_REQUEST', 'IMPORTS_FROM', 'EXPORTS_TO', 'ASSIGNED_FROM',
          // TypeScript-specific edges
          'IMPLEMENTS', 'EXTENDS', 'DECORATED_BY',
          // Promise data flow
          'RESOLVES_TO'
        ]
      },
      dependencies: ['JSModuleIndexer'],
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
      await graph.addNode({
        id: module.id,
        type: 'MODULE',
        name: module.name,
        file: module.file,
        contentHash: currentHash
      });
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

      pool.registerHandler('ANALYZE_MODULE', async (task) => {
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
            processedFiles: completed
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
            processedFiles: results.indexOf(result) + 1
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
    objectLiteralCounterRef: CounterRef
  ): void {
    if (!initNode) return;
    // initNode is already typed as t.Expression
    const initExpression = initNode;

    // 0. AwaitExpression
    if (initExpression.type === 'AwaitExpression') {
      return this.trackVariableAssignment(initExpression.argument, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef);
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

      this.trackVariableAssignment(initExpression.consequent, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef);
      this.trackVariableAssignment(initExpression.alternate, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef);
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

      this.trackVariableAssignment(initExpression.left, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef);
      this.trackVariableAssignment(initExpression.right, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef);
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
          this.trackVariableAssignment(expr, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef);
        }
      }
      return;
    }
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
    // Unsupported init type (MemberExpression without call, etc.)
    // else: do nothing - skip silently
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
        { variableDeclarations, classInstantiations, literals, variableAssignments, varDeclCounterRef, literalCounterRef, scopes, scopeCounterRef, objectLiterals, objectProperties, objectLiteralCounterRef },
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
      const callExpressionVisitor = new CallExpressionVisitor(module, allCollections, scopeTracker);
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
              column
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
    objectLiteralCounterRef: CounterRef
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
                objectLiteralCounterRef
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
            objectLiteralCounterRef
          );
        }
      }
    });
  }

  private createLoopScopeHandler(
    trackerScopeType: string,
    scopeType: string,
    loopType: 'for' | 'for-in' | 'for-of' | 'while' | 'do-while',
    parentScopeId: string,
    module: VisitorModule,
    scopes: ScopeInfo[],
    loops: LoopInfo[],
    scopeCounterRef: CounterRef,
    loopCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    scopeIdStack?: string[],
    controlFlowState?: { loopCount: number; loopDepth: number }
  ): { enter: (path: NodePath<t.Loop>) => void; exit: () => void } {
    return {
      enter: (path: NodePath<t.Loop>) => {
        const node = path.node;

        // Phase 6 (REG-267): Increment loop count for cyclomatic complexity
        if (controlFlowState) {
          controlFlowState.loopCount++;
          // REG-298: Track loop nesting depth for isInsideLoop detection
          controlFlowState.loopDepth++;
        }

        // 1. Create LOOP node
        const loopCounter = loopCounterRef.value++;
        const legacyLoopId = `${module.file}:LOOP:${loopType}:${getLine(node)}:${loopCounter}`;
        const loopId = scopeTracker
          ? computeSemanticId('LOOP', loopType, scopeTracker.getContext(), { discriminator: loopCounter })
          : legacyLoopId;

        // 2. Extract iteration target for for-in/for-of
        let iteratesOverName: string | undefined;
        let iteratesOverLine: number | undefined;
        let iteratesOverColumn: number | undefined;

        if (loopType === 'for-in' || loopType === 'for-of') {
          const loopNode = node as t.ForInStatement | t.ForOfStatement;
          if (t.isIdentifier(loopNode.right)) {
            iteratesOverName = loopNode.right.name;
            iteratesOverLine = getLine(loopNode.right);
            iteratesOverColumn = getColumn(loopNode.right);
          } else if (t.isMemberExpression(loopNode.right)) {
            iteratesOverName = this.memberExpressionToString(loopNode.right);
            iteratesOverLine = getLine(loopNode.right);
            iteratesOverColumn = getColumn(loopNode.right);
          }
        }

        // 2b. Extract init/test/update for classic for loops and test for while/do-while (REG-282)
        let initVariableName: string | undefined;
        let initLine: number | undefined;

        let testExpressionId: string | undefined;
        let testExpressionType: string | undefined;
        let testLine: number | undefined;
        let testColumn: number | undefined;

        let updateExpressionId: string | undefined;
        let updateExpressionType: string | undefined;
        let updateLine: number | undefined;
        let updateColumn: number | undefined;

        if (loopType === 'for') {
          const forNode = node as t.ForStatement;

          // Extract init: let i = 0
          if (forNode.init) {
            initLine = getLine(forNode.init);
            if (t.isVariableDeclaration(forNode.init)) {
              // Get name of first declared variable
              const firstDeclarator = forNode.init.declarations[0];
              if (t.isIdentifier(firstDeclarator.id)) {
                initVariableName = firstDeclarator.id.name;
              }
            }
          }

          // Extract test: i < 10
          if (forNode.test) {
            testLine = getLine(forNode.test);
            testColumn = getColumn(forNode.test);
            testExpressionType = forNode.test.type;
            testExpressionId = ExpressionNode.generateId(forNode.test.type, module.file, testLine, testColumn);
          }

          // Extract update: i++
          if (forNode.update) {
            updateLine = getLine(forNode.update);
            updateColumn = getColumn(forNode.update);
            updateExpressionType = forNode.update.type;
            updateExpressionId = ExpressionNode.generateId(forNode.update.type, module.file, updateLine, updateColumn);
          }
        }

        // Extract test condition for while and do-while loops
        if (loopType === 'while' || loopType === 'do-while') {
          const condLoop = node as t.WhileStatement | t.DoWhileStatement;
          if (condLoop.test) {
            testLine = getLine(condLoop.test);
            testColumn = getColumn(condLoop.test);
            testExpressionType = condLoop.test.type;
            testExpressionId = ExpressionNode.generateId(condLoop.test.type, module.file, testLine, testColumn);
          }
        }

        // Extract async flag for for-await-of (REG-284)
        let isAsync: boolean | undefined;
        if (loopType === 'for-of') {
          const forOfNode = node as t.ForOfStatement;
          isAsync = forOfNode.await === true ? true : undefined;
        }

        // 3. Determine actual parent - use stack for nested loops, otherwise original parentScopeId
        const actualParentScopeId = (scopeIdStack && scopeIdStack.length > 0)
          ? scopeIdStack[scopeIdStack.length - 1]
          : parentScopeId;

        // 3.5. Extract condition expression for while/do-while/for loops (REG-280)
        // Note: for-in and for-of don't have test expressions (they use ITERATES_OVER instead)
        let conditionExpressionId: string | undefined;
        let conditionExpressionType: string | undefined;
        let conditionLine: number | undefined;
        let conditionColumn: number | undefined;

        if (loopType === 'while' || loopType === 'do-while') {
          const testNode = (node as t.WhileStatement | t.DoWhileStatement).test;
          if (testNode) {
            const condResult = this.extractDiscriminantExpression(testNode, module);
            conditionExpressionId = condResult.id;
            conditionExpressionType = condResult.expressionType;
            conditionLine = condResult.line;
            conditionColumn = condResult.column;
          }
        } else if (loopType === 'for') {
          const forNode = node as t.ForStatement;
          // for loop test may be null (infinite loop: for(;;))
          if (forNode.test) {
            const condResult = this.extractDiscriminantExpression(forNode.test, module);
            conditionExpressionId = condResult.id;
            conditionExpressionType = condResult.expressionType;
            conditionLine = condResult.line;
            conditionColumn = condResult.column;
          }
        }

        // 4. Push LOOP info
        loops.push({
          id: loopId,
          semanticId: loopId,
          type: 'LOOP',
          loopType,
          file: module.file,
          line: getLine(node),
          column: getColumn(node),
          parentScopeId: actualParentScopeId,
          iteratesOverName,
          iteratesOverLine,
          iteratesOverColumn,
          conditionExpressionId,
          conditionExpressionType,
          conditionLine,
          conditionColumn,
          // REG-282: init/test/update for classic for loops
          initVariableName,
          initLine,
          testExpressionId,
          testExpressionType,
          testLine,
          testColumn,
          updateExpressionId,
          updateExpressionType,
          updateLine,
          updateColumn,
          // REG-284: async flag for for-await-of
          async: isAsync
        });

        // 5. Create body SCOPE (backward compatibility)
        const scopeId = `SCOPE#${scopeType}#${module.file}#${getLine(node)}:${scopeCounterRef.value++}`;
        const semanticId = this.generateSemanticId(scopeType, scopeTracker);
        scopes.push({
          id: scopeId,
          type: 'SCOPE',
          scopeType,
          semanticId,
          file: module.file,
          line: getLine(node),
          parentScopeId: loopId  // Parent is LOOP, not original parentScopeId
        });

        // 6. Push body SCOPE to scopeIdStack (for CONTAINS edges to nested items)
        // The body scope is the container for nested loops, not the LOOP itself
        if (scopeIdStack) {
          scopeIdStack.push(scopeId);
        }

        // Enter scope for semantic ID generation
        if (scopeTracker) {
          scopeTracker.enterCountedScope(trackerScopeType);
        }
      },
      exit: () => {
        // REG-298: Decrement loop depth counter
        if (controlFlowState) {
          controlFlowState.loopDepth--;
        }

        // Pop loop scope from stack
        if (scopeIdStack) {
          scopeIdStack.pop();
        }

        // Exit scope
        if (scopeTracker) {
          scopeTracker.exitScope();
        }
      }
    };
  }

  /**
   * Factory method to create TryStatement handler.
   * Creates TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK nodes and body SCOPEs.
   * Does NOT use skip() - allows normal traversal for CallExpression/NewExpression visitors.
   *
   * Phase 4 (REG-267): Creates control flow nodes with HAS_CATCH and HAS_FINALLY edges.
   *
   * @param parentScopeId - Parent scope ID for the scope nodes
   * @param module - Module context
   * @param scopes - Collection to push scope nodes to
   * @param tryBlocks - Collection to push TRY_BLOCK nodes to
   * @param catchBlocks - Collection to push CATCH_BLOCK nodes to
   * @param finallyBlocks - Collection to push FINALLY_BLOCK nodes to
   * @param scopeCounterRef - Counter for unique scope IDs
   * @param tryBlockCounterRef - Counter for unique TRY_BLOCK IDs
   * @param catchBlockCounterRef - Counter for unique CATCH_BLOCK IDs
   * @param finallyBlockCounterRef - Counter for unique FINALLY_BLOCK IDs
   * @param scopeTracker - Tracker for semantic ID generation
   * @param tryScopeMap - Map to track try/catch/finally scope transitions
   * @param scopeIdStack - Stack for tracking current scope ID for CONTAINS edges
   */
  private createTryStatementHandler(
    parentScopeId: string,
    module: VisitorModule,
    scopes: ScopeInfo[],
    tryBlocks: TryBlockInfo[],
    catchBlocks: CatchBlockInfo[],
    finallyBlocks: FinallyBlockInfo[],
    scopeCounterRef: CounterRef,
    tryBlockCounterRef: CounterRef,
    catchBlockCounterRef: CounterRef,
    finallyBlockCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    tryScopeMap: Map<t.TryStatement, TryScopeInfo>,
    scopeIdStack?: string[],
    controlFlowState?: { hasTryCatch: boolean; tryBlockDepth: number }
  ): { enter: (tryPath: NodePath<t.TryStatement>) => void; exit: (tryPath: NodePath<t.TryStatement>) => void } {
    return {
      enter: (tryPath: NodePath<t.TryStatement>) => {
        const tryNode = tryPath.node;

        // Phase 6 (REG-267): Mark that this function has try/catch
        if (controlFlowState) {
          controlFlowState.hasTryCatch = true;
          // REG-311: Increment try block depth for O(1) isInsideTry detection
          controlFlowState.tryBlockDepth++;
        }

        // Determine actual parent - use stack for nested structures, otherwise original parentScopeId
        const actualParentScopeId = (scopeIdStack && scopeIdStack.length > 0)
          ? scopeIdStack[scopeIdStack.length - 1]
          : parentScopeId;

        // 1. Create TRY_BLOCK node
        const tryBlockCounter = tryBlockCounterRef.value++;
        const legacyTryBlockId = `${module.file}:TRY_BLOCK:${getLine(tryNode)}:${tryBlockCounter}`;
        const tryBlockId = scopeTracker
          ? computeSemanticId('TRY_BLOCK', 'try', scopeTracker.getContext(), { discriminator: tryBlockCounter })
          : legacyTryBlockId;

        tryBlocks.push({
          id: tryBlockId,
          semanticId: tryBlockId,
          type: 'TRY_BLOCK',
          file: module.file,
          line: getLine(tryNode),
          column: getColumn(tryNode),
          parentScopeId: actualParentScopeId
        });

        // 2. Create try-body SCOPE (backward compatibility)
        // Parent is now TRY_BLOCK, not original parentScopeId
        const tryScopeId = `SCOPE#try-block#${module.file}#${getLine(tryNode)}:${scopeCounterRef.value++}`;
        const trySemanticId = this.generateSemanticId('try-block', scopeTracker);
        scopes.push({
          id: tryScopeId,
          type: 'SCOPE',
          scopeType: 'try-block',
          semanticId: trySemanticId,
          file: module.file,
          line: getLine(tryNode),
          parentScopeId: tryBlockId  // Parent is TRY_BLOCK
        });

        // 3. Create CATCH_BLOCK and catch-body SCOPE if handler exists
        let catchBlockId: string | null = null;
        let catchScopeId: string | null = null;
        if (tryNode.handler) {
          const catchClause = tryNode.handler;
          const catchBlockCounter = catchBlockCounterRef.value++;
          const legacyCatchBlockId = `${module.file}:CATCH_BLOCK:${getLine(catchClause)}:${catchBlockCounter}`;
          catchBlockId = scopeTracker
            ? computeSemanticId('CATCH_BLOCK', 'catch', scopeTracker.getContext(), { discriminator: catchBlockCounter })
            : legacyCatchBlockId;

          // Extract parameter name if present
          let parameterName: string | undefined;
          if (catchClause.param && t.isIdentifier(catchClause.param)) {
            parameterName = catchClause.param.name;
          }

          catchBlocks.push({
            id: catchBlockId,
            semanticId: catchBlockId,
            type: 'CATCH_BLOCK',
            file: module.file,
            line: getLine(catchClause),
            column: getColumn(catchClause),
            parentScopeId,
            parentTryBlockId: tryBlockId,
            parameterName
          });

          // Create catch-body SCOPE (backward compatibility)
          catchScopeId = `SCOPE#catch-block#${module.file}#${getLine(catchClause)}:${scopeCounterRef.value++}`;
          const catchSemanticId = this.generateSemanticId('catch-block', scopeTracker);
          scopes.push({
            id: catchScopeId,
            type: 'SCOPE',
            scopeType: 'catch-block',
            semanticId: catchSemanticId,
            file: module.file,
            line: getLine(catchClause),
            parentScopeId: catchBlockId  // Parent is CATCH_BLOCK
          });
        }

        // 4. Create FINALLY_BLOCK and finally-body SCOPE if finalizer exists
        let finallyBlockId: string | null = null;
        let finallyScopeId: string | null = null;
        if (tryNode.finalizer) {
          const finallyBlockCounter = finallyBlockCounterRef.value++;
          const legacyFinallyBlockId = `${module.file}:FINALLY_BLOCK:${getLine(tryNode.finalizer)}:${finallyBlockCounter}`;
          finallyBlockId = scopeTracker
            ? computeSemanticId('FINALLY_BLOCK', 'finally', scopeTracker.getContext(), { discriminator: finallyBlockCounter })
            : legacyFinallyBlockId;

          finallyBlocks.push({
            id: finallyBlockId,
            semanticId: finallyBlockId,
            type: 'FINALLY_BLOCK',
            file: module.file,
            line: getLine(tryNode.finalizer),
            column: getColumn(tryNode.finalizer),
            parentScopeId,
            parentTryBlockId: tryBlockId
          });

          // Create finally-body SCOPE (backward compatibility)
          finallyScopeId = `SCOPE#finally-block#${module.file}#${getLine(tryNode.finalizer)}:${scopeCounterRef.value++}`;
          const finallySemanticId = this.generateSemanticId('finally-block', scopeTracker);
          scopes.push({
            id: finallyScopeId,
            type: 'SCOPE',
            scopeType: 'finally-block',
            semanticId: finallySemanticId,
            file: module.file,
            line: getLine(tryNode.finalizer),
            parentScopeId: finallyBlockId  // Parent is FINALLY_BLOCK
          });
        }

        // 5. Push try scope onto stack for CONTAINS edges
        if (scopeIdStack) {
          scopeIdStack.push(tryScopeId);
        }

        // Enter try scope for semantic ID generation
        if (scopeTracker) {
          scopeTracker.enterCountedScope('try');
        }

        // 6. Store scope info for catch/finally transitions
        tryScopeMap.set(tryNode, {
          tryScopeId,
          catchScopeId,
          finallyScopeId,
          currentBlock: 'try',
          tryBlockId,
          catchBlockId,
          finallyBlockId
        });
      },
      exit: (tryPath: NodePath<t.TryStatement>) => {
        const tryNode = tryPath.node;
        const _scopeInfo = tryScopeMap.get(tryNode);

        // REG-311: Only decrement try block depth if we're still in 'try' block
        // (not transitioned to catch/finally, where we already decremented)
        if (controlFlowState && _scopeInfo?.currentBlock === 'try') {
          controlFlowState.tryBlockDepth--;
        }

        // Pop the current scope from stack (could be try, catch, or finally)
        if (scopeIdStack) {
          scopeIdStack.pop();
        }

        // Exit the current scope
        if (scopeTracker) {
          scopeTracker.exitScope();
        }

        // Clean up
        tryScopeMap.delete(tryNode);
      }
    };
  }

  /**
   * Factory method to create CatchClause handler.
   * Handles scope transition from try to catch and processes catch parameter.
   *
   * @param module - Module context
   * @param variableDeclarations - Collection to push variable declarations to
   * @param varDeclCounterRef - Counter for unique variable declaration IDs
   * @param scopeTracker - Tracker for semantic ID generation
   * @param tryScopeMap - Map to track try/catch/finally scope transitions
   * @param scopeIdStack - Stack for tracking current scope ID for CONTAINS edges
   */
  private createCatchClauseHandler(
    module: VisitorModule,
    variableDeclarations: VariableDeclarationInfo[],
    varDeclCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    tryScopeMap: Map<t.TryStatement, TryScopeInfo>,
    scopeIdStack?: string[],
    controlFlowState?: { hasTryCatch: boolean; tryBlockDepth: number }
  ): { enter: (catchPath: NodePath<t.CatchClause>) => void } {
    return {
      enter: (catchPath: NodePath<t.CatchClause>) => {
        const catchNode = catchPath.node;
        const parent = catchPath.parent;

        if (!t.isTryStatement(parent)) return;

        const scopeInfo = tryScopeMap.get(parent);
        if (!scopeInfo || !scopeInfo.catchScopeId) return;

        // Transition from try scope to catch scope
        if (scopeInfo.currentBlock === 'try') {
          // Pop try scope, push catch scope
          if (scopeIdStack) {
            scopeIdStack.pop();
            scopeIdStack.push(scopeInfo.catchScopeId);
          }

          // Exit try scope, enter catch scope for semantic ID
          if (scopeTracker) {
            scopeTracker.exitScope();
            scopeTracker.enterCountedScope('catch');
          }

          // REG-311: Decrement tryBlockDepth when leaving try block for catch
          // Calls in catch block should NOT have isInsideTry=true
          if (controlFlowState) {
            controlFlowState.tryBlockDepth--;
          }

          scopeInfo.currentBlock = 'catch';
        }

        // Handle catch parameter (e.g., catch (e) or catch ({ message }))
        if (catchNode.param) {
          const errorVarInfo = this.extractVariableNamesFromPattern(catchNode.param);

          errorVarInfo.forEach(varInfo => {
            const legacyId = `VARIABLE#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${varDeclCounterRef.value++}`;
            const varId = scopeTracker
              ? computeSemanticId('VARIABLE', varInfo.name, scopeTracker.getContext())
              : legacyId;

            variableDeclarations.push({
              id: varId,
              type: 'VARIABLE',
              name: varInfo.name,
              file: module.file,
              line: varInfo.loc.start.line,
              parentScopeId: scopeInfo.catchScopeId!
            });
          });
        }
      }
    };
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
   * Factory method to create IfStatement handler.
   * Creates BRANCH node for if statement and SCOPE nodes for if/else bodies.
   * Tracks if/else scope transitions via ifElseScopeMap.
   *
   * Phase 3 (REG-267): Creates BRANCH node with branchType='if' and
   * HAS_CONSEQUENT/HAS_ALTERNATE edges to body SCOPEs.
   *
   * @param parentScopeId - Parent scope ID for the scope nodes
   * @param module - Module context
   * @param scopes - Collection to push scope nodes to
   * @param branches - Collection to push BRANCH nodes to
   * @param ifScopeCounterRef - Counter for unique if scope IDs
   * @param branchCounterRef - Counter for unique BRANCH IDs
   * @param scopeTracker - Tracker for semantic ID generation
   * @param sourceCode - Source code for extracting condition text
   * @param ifElseScopeMap - Map to track if/else scope transitions
   * @param scopeIdStack - Stack for tracking current scope ID for CONTAINS edges
   */
  private createIfStatementHandler(
    parentScopeId: string,
    module: VisitorModule,
    scopes: ScopeInfo[],
    branches: BranchInfo[],
    ifScopeCounterRef: CounterRef,
    branchCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    sourceCode: string,
    ifElseScopeMap: Map<t.IfStatement, IfElseScopeInfo>,
    scopeIdStack?: string[],
    controlFlowState?: { branchCount: number; logicalOpCount: number },
    countLogicalOperators?: (node: t.Expression) => number
  ): { enter: (ifPath: NodePath<t.IfStatement>) => void; exit: (ifPath: NodePath<t.IfStatement>) => void } {
    return {
      enter: (ifPath: NodePath<t.IfStatement>) => {
        const ifNode = ifPath.node;
        const condition = sourceCode.substring(ifNode.test.start!, ifNode.test.end!) || 'condition';

        // Phase 6 (REG-267): Increment branch count and count logical operators
        if (controlFlowState) {
          controlFlowState.branchCount++;
          if (countLogicalOperators) {
            controlFlowState.logicalOpCount += countLogicalOperators(ifNode.test);
          }
        }

        // Check if this if-statement is an else-if (alternate of parent IfStatement)
        const isElseIf = t.isIfStatement(ifPath.parent) && ifPath.parentKey === 'alternate';

        // Determine actual parent scope
        let actualParentScopeId: string;
        if (isElseIf) {
          // For else-if, parent should be the outer BRANCH (stored in ifElseScopeMap)
          const parentIfInfo = ifElseScopeMap.get(ifPath.parent as t.IfStatement);
          if (parentIfInfo) {
            actualParentScopeId = parentIfInfo.branchId;
          } else {
            // Fallback to stack
            actualParentScopeId = (scopeIdStack && scopeIdStack.length > 0)
              ? scopeIdStack[scopeIdStack.length - 1]
              : parentScopeId;
          }
        } else {
          // For regular if statements, use stack or original parentScopeId
          actualParentScopeId = (scopeIdStack && scopeIdStack.length > 0)
            ? scopeIdStack[scopeIdStack.length - 1]
            : parentScopeId;
        }

        // 1. Create BRANCH node for if statement
        const branchCounter = branchCounterRef.value++;
        const legacyBranchId = `${module.file}:BRANCH:if:${getLine(ifNode)}:${branchCounter}`;
        const branchId = scopeTracker
          ? computeSemanticId('BRANCH', 'if', scopeTracker.getContext(), { discriminator: branchCounter })
          : legacyBranchId;

        // 2. Extract condition expression info for HAS_CONDITION edge
        const conditionResult = this.extractDiscriminantExpression(ifNode.test, module);

        // For else-if, get the parent branch ID
        const isAlternateOfBranchId = isElseIf
          ? ifElseScopeMap.get(ifPath.parent as t.IfStatement)?.branchId
          : undefined;

        branches.push({
          id: branchId,
          semanticId: branchId,
          type: 'BRANCH',
          branchType: 'if',
          file: module.file,
          line: getLine(ifNode),
          parentScopeId: actualParentScopeId,
          discriminantExpressionId: conditionResult.id,
          discriminantExpressionType: conditionResult.expressionType,
          discriminantLine: conditionResult.line,
          discriminantColumn: conditionResult.column,
          isAlternateOfBranchId
        });

        // 3. Create if-body SCOPE (backward compatibility)
        // Parent is now BRANCH, not original parentScopeId
        const counterId = ifScopeCounterRef.value++;
        const ifScopeId = `SCOPE#if#${module.file}#${getLine(ifNode)}:${getColumn(ifNode)}:${counterId}`;

        // Parse condition to extract constraints
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
          parentScopeId: branchId  // Parent is BRANCH, not original parentScopeId
        });

        // 4. Push if scope onto stack for CONTAINS edges
        if (scopeIdStack) {
          scopeIdStack.push(ifScopeId);
        }

        // Enter scope for semantic ID generation
        if (scopeTracker) {
          scopeTracker.enterCountedScope('if');
        }

        // 5. Handle else branch if present
        let elseScopeId: string | null = null;
        if (ifNode.alternate && !t.isIfStatement(ifNode.alternate)) {
          // Only create else scope for actual else block, not else-if
          const elseCounterId = ifScopeCounterRef.value++;
          elseScopeId = `SCOPE#else#${module.file}#${getLine(ifNode.alternate)}:${getColumn(ifNode.alternate)}:${elseCounterId}`;

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
            parentScopeId: branchId  // Parent is BRANCH, not original parentScopeId
          });

          // Store info to switch to else scope when we enter alternate
          ifElseScopeMap.set(ifNode, { inElse: false, hasElse: true, ifScopeId, elseScopeId, branchId });
        } else {
          ifElseScopeMap.set(ifNode, { inElse: false, hasElse: false, ifScopeId, elseScopeId: null, branchId });
        }
      },
      exit: (ifPath: NodePath<t.IfStatement>) => {
        const ifNode = ifPath.node;

        // Pop scope from stack (either if or else, depending on what we're exiting)
        if (scopeIdStack) {
          scopeIdStack.pop();
        }

        // Exit the current scope (either if or else)
        if (scopeTracker) {
          scopeTracker.exitScope();
        }

        // If we were in else, we already exited else scope
        // If we only had if, we exit if scope (done above)
        ifElseScopeMap.delete(ifNode);
      }
    };
  }

  /**
   * Factory method to create ConditionalExpression (ternary) handler.
   * Creates BRANCH nodes with branchType='ternary' and increments branchCount for cyclomatic complexity.
   *
   * Key difference from IfStatement: ternary has EXPRESSIONS as branches, not SCOPE blocks.
   * We store consequentExpressionId and alternateExpressionId in BranchInfo for HAS_CONSEQUENT/HAS_ALTERNATE edges.
   *
   * @param parentScopeId - Parent scope ID for the BRANCH node
   * @param module - Module context
   * @param branches - Collection to push BRANCH nodes to
   * @param branchCounterRef - Counter for unique BRANCH IDs
   * @param scopeTracker - Tracker for semantic ID generation
   * @param scopeIdStack - Stack for tracking current scope ID for CONTAINS edges
   * @param controlFlowState - State for tracking control flow metrics (complexity)
   * @param countLogicalOperators - Function to count logical operators in condition
   */
  private createConditionalExpressionHandler(
    parentScopeId: string,
    module: VisitorModule,
    branches: BranchInfo[],
    branchCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    scopeIdStack?: string[],
    controlFlowState?: { branchCount: number; logicalOpCount: number },
    countLogicalOperators?: (node: t.Expression) => number
  ): (condPath: NodePath<t.ConditionalExpression>) => void {
    return (condPath: NodePath<t.ConditionalExpression>) => {
      const condNode = condPath.node;

      // Increment branch count for cyclomatic complexity
      if (controlFlowState) {
        controlFlowState.branchCount++;
        // Count logical operators in the test condition (e.g., a && b ? x : y)
        if (countLogicalOperators) {
          controlFlowState.logicalOpCount += countLogicalOperators(condNode.test);
        }
      }

      // Determine parent scope from stack or fallback
      const actualParentScopeId = (scopeIdStack && scopeIdStack.length > 0)
        ? scopeIdStack[scopeIdStack.length - 1]
        : parentScopeId;

      // Create BRANCH node with branchType='ternary'
      const branchCounter = branchCounterRef.value++;
      const legacyBranchId = `${module.file}:BRANCH:ternary:${getLine(condNode)}:${branchCounter}`;
      const branchId = scopeTracker
        ? computeSemanticId('BRANCH', 'ternary', scopeTracker.getContext(), { discriminator: branchCounter })
        : legacyBranchId;

      // Extract condition expression info for HAS_CONDITION edge
      const conditionResult = this.extractDiscriminantExpression(condNode.test, module);

      // Generate expression IDs for consequent and alternate
      const consequentLine = getLine(condNode.consequent);
      const consequentColumn = getColumn(condNode.consequent);
      const consequentExpressionId = ExpressionNode.generateId(
        condNode.consequent.type,
        module.file,
        consequentLine,
        consequentColumn
      );

      const alternateLine = getLine(condNode.alternate);
      const alternateColumn = getColumn(condNode.alternate);
      const alternateExpressionId = ExpressionNode.generateId(
        condNode.alternate.type,
        module.file,
        alternateLine,
        alternateColumn
      );

      branches.push({
        id: branchId,
        semanticId: branchId,
        type: 'BRANCH',
        branchType: 'ternary',
        file: module.file,
        line: getLine(condNode),
        parentScopeId: actualParentScopeId,
        discriminantExpressionId: conditionResult.id,
        discriminantExpressionType: conditionResult.expressionType,
        discriminantLine: conditionResult.line,
        discriminantColumn: conditionResult.column,
        consequentExpressionId,
        alternateExpressionId
      });
    };
  }

  /**
   * Factory method to create BlockStatement handler for tracking if/else and try/finally transitions.
   * When entering an else block, switches scope from if to else.
   * When entering a finally block, switches scope from try/catch to finally.
   *
   * @param scopeTracker - Tracker for semantic ID generation
   * @param ifElseScopeMap - Map to track if/else scope transitions
   * @param tryScopeMap - Map to track try/catch/finally scope transitions
   * @param scopeIdStack - Stack for tracking current scope ID for CONTAINS edges
   */
  private createBlockStatementHandler(
    scopeTracker: ScopeTracker | undefined,
    ifElseScopeMap: Map<t.IfStatement, IfElseScopeInfo>,
    tryScopeMap: Map<t.TryStatement, TryScopeInfo>,
    scopeIdStack?: string[]
  ): { enter: (blockPath: NodePath<t.BlockStatement>) => void } {
    return {
      enter: (blockPath: NodePath<t.BlockStatement>) => {
        const parent = blockPath.parent;

        // Check if this block is the alternate of an IfStatement
        if (t.isIfStatement(parent) && parent.alternate === blockPath.node) {
          const scopeInfo = ifElseScopeMap.get(parent);
          if (scopeInfo && scopeInfo.hasElse && !scopeInfo.inElse) {
            // Swap if-scope for else-scope on the stack
            if (scopeIdStack && scopeInfo.elseScopeId) {
              scopeIdStack.pop(); // Remove if-scope
              scopeIdStack.push(scopeInfo.elseScopeId); // Push else-scope
            }

            // Exit if scope, enter else scope for semantic ID tracking
            if (scopeTracker) {
              scopeTracker.exitScope();
              scopeTracker.enterCountedScope('else');
            }
            scopeInfo.inElse = true;
          }
        }

        // Check if this block is the finalizer of a TryStatement
        if (t.isTryStatement(parent) && parent.finalizer === blockPath.node) {
          const scopeInfo = tryScopeMap.get(parent);
          if (scopeInfo && scopeInfo.finallyScopeId && scopeInfo.currentBlock !== 'finally') {
            // Pop current scope (try or catch), push finally scope
            if (scopeIdStack) {
              scopeIdStack.pop();
              scopeIdStack.push(scopeInfo.finallyScopeId);
            }

            // Exit current scope, enter finally scope for semantic ID tracking
            if (scopeTracker) {
              scopeTracker.exitScope();
              scopeTracker.enterCountedScope('finally');
            }
            scopeInfo.currentBlock = 'finally';
          }
        }
      }
    };
  }

  /**
   * Анализирует тело функции и извлекает переменные, вызовы, условные блоки.
   * Uses ScopeTracker from collections for semantic ID generation.
   */
  analyzeFunctionBody(
    funcPath: NodePath<t.Function | t.StaticBlock>,
    parentScopeId: string,
    module: VisitorModule,
    collections: VisitorCollections
  ): void {
    // Extract with defaults for optional properties
    const functions = (collections.functions ?? []) as FunctionInfo[];
    const scopes = (collections.scopes ?? []) as ScopeInfo[];
    const variableDeclarations = (collections.variableDeclarations ?? []) as VariableDeclarationInfo[];
    const callSites = (collections.callSites ?? []) as CallSiteInfo[];
    const methodCalls = (collections.methodCalls ?? []) as MethodCallInfo[];
    const _eventListeners = (collections.eventListeners ?? []) as EventListenerInfo[];
    const _methodCallbacks = (collections.methodCallbacks ?? []) as MethodCallbackInfo[];
    const classInstantiations = (collections.classInstantiations ?? []) as ClassInstantiationInfo[];
    const constructorCalls = (collections.constructorCalls ?? []) as ConstructorCallInfo[];
    const _httpRequests = (collections.httpRequests ?? []) as HttpRequestInfo[];
    const literals = (collections.literals ?? []) as LiteralInfo[];
    const variableAssignments = (collections.variableAssignments ?? []) as VariableAssignmentInfo[];
    const ifScopeCounterRef = (collections.ifScopeCounterRef ?? { value: 0 }) as CounterRef;
    const scopeCounterRef = (collections.scopeCounterRef ?? { value: 0 }) as CounterRef;
    const varDeclCounterRef = (collections.varDeclCounterRef ?? { value: 0 }) as CounterRef;
    const callSiteCounterRef = (collections.callSiteCounterRef ?? { value: 0 }) as CounterRef;
    const functionCounterRef = (collections.functionCounterRef ?? { value: 0 }) as CounterRef;
    const _httpRequestCounterRef = (collections.httpRequestCounterRef ?? { value: 0 }) as CounterRef;
    const literalCounterRef = (collections.literalCounterRef ?? { value: 0 }) as CounterRef;
    const _anonymousFunctionCounterRef = (collections.anonymousFunctionCounterRef ?? { value: 0 }) as CounterRef;
    const scopeTracker = collections.scopeTracker as ScopeTracker | undefined;
    // Object literal tracking (REG-328)
    if (!collections.objectLiterals) {
      collections.objectLiterals = [];
    }
    if (!collections.objectProperties) {
      collections.objectProperties = [];
    }
    if (!collections.objectLiteralCounterRef) {
      collections.objectLiteralCounterRef = { value: 0 };
    }
    const objectLiterals = collections.objectLiterals as ObjectLiteralInfo[];
    const objectProperties = collections.objectProperties as ObjectPropertyInfo[];
    const objectLiteralCounterRef = collections.objectLiteralCounterRef as CounterRef;
    const returnStatements = (collections.returnStatements ?? []) as ReturnStatementInfo[];
    // Initialize yieldExpressions if not exist to ensure nested function calls share same array
    if (!collections.yieldExpressions) {
      collections.yieldExpressions = [];
    }
    const yieldExpressions = collections.yieldExpressions as YieldExpressionInfo[];
    const _parameters = (collections.parameters ?? []) as ParameterInfo[];
    // Control flow collections (Phase 2: LOOP nodes)
    // Initialize if not exist to ensure nested function calls share same arrays
    if (!collections.loops) {
      collections.loops = [];
    }
    if (!collections.loopCounterRef) {
      collections.loopCounterRef = { value: 0 };
    }
    const loops = collections.loops as LoopInfo[];
    const loopCounterRef = collections.loopCounterRef as CounterRef;
    const updateExpressions = (collections.updateExpressions ?? []) as UpdateExpressionInfo[];
    const processedNodes = collections.processedNodes ?? {
      functions: new Set<string>(),
      classes: new Set<string>(),
      imports: new Set<string>(),
      exports: new Set<string>(),
      variables: new Set<string>(),
      callSites: new Set<string>(),
      methodCalls: new Set<string>(),
      varDecls: new Set<string>(),
      eventListeners: new Set<string>()
    };

    const parentScopeVariables = new Set<{ name: string; id: string; scopeId: string }>();

    const processedCallSites = processedNodes.callSites;
    const _processedVarDecls = processedNodes.varDecls;
    const processedMethodCalls = processedNodes.methodCalls;
    const _processedEventListeners = processedNodes.eventListeners;

    // Track if/else scope transitions (Phase 3: extended with branchId)
    const ifElseScopeMap = new Map<t.IfStatement, IfElseScopeInfo>();

    // Ensure branches and branchCounterRef are initialized (used by IfStatement and SwitchStatement)
    if (!collections.branches) {
      collections.branches = [];
    }
    if (!collections.branchCounterRef) {
      collections.branchCounterRef = { value: 0 };
    }
    const branches = collections.branches as BranchInfo[];
    const branchCounterRef = collections.branchCounterRef as CounterRef;

    // Phase 4: Initialize try/catch/finally collections and counters
    if (!collections.tryBlocks) {
      collections.tryBlocks = [];
    }
    if (!collections.catchBlocks) {
      collections.catchBlocks = [];
    }
    if (!collections.finallyBlocks) {
      collections.finallyBlocks = [];
    }
    if (!collections.tryBlockCounterRef) {
      collections.tryBlockCounterRef = { value: 0 };
    }
    if (!collections.catchBlockCounterRef) {
      collections.catchBlockCounterRef = { value: 0 };
    }
    if (!collections.finallyBlockCounterRef) {
      collections.finallyBlockCounterRef = { value: 0 };
    }
    const tryBlocks = collections.tryBlocks as TryBlockInfo[];
    const catchBlocks = collections.catchBlocks as CatchBlockInfo[];
    const finallyBlocks = collections.finallyBlocks as FinallyBlockInfo[];
    const tryBlockCounterRef = collections.tryBlockCounterRef as CounterRef;
    const catchBlockCounterRef = collections.catchBlockCounterRef as CounterRef;
    const finallyBlockCounterRef = collections.finallyBlockCounterRef as CounterRef;

    // Track try/catch/finally scope transitions
    const tryScopeMap = new Map<t.TryStatement, TryScopeInfo>();

    // REG-334: Use shared Promise executor contexts from collections.
    // These are populated by module-level NewExpression handler and function-level NewExpression handler.
    if (!collections.promiseExecutorContexts) {
      collections.promiseExecutorContexts = new Map<string, PromiseExecutorContext>();
    }
    const promiseExecutorContexts = collections.promiseExecutorContexts as Map<string, PromiseExecutorContext>;

    // Initialize promiseResolutions array if not exists
    if (!collections.promiseResolutions) {
      collections.promiseResolutions = [];
    }
    const promiseResolutions = collections.promiseResolutions as PromiseResolutionInfo[];

    // REG-311: Initialize rejectionPatterns and catchesFromInfos collections
    if (!collections.rejectionPatterns) {
      collections.rejectionPatterns = [];
    }
    if (!collections.catchesFromInfos) {
      collections.catchesFromInfos = [];
    }
    const rejectionPatterns = collections.rejectionPatterns as RejectionPatternInfo[];
    const catchesFromInfos = collections.catchesFromInfos as CatchesFromInfo[];

    // Dynamic scope ID stack for CONTAINS edges
    // Starts with the function body scope, gets updated as we enter/exit conditional scopes
    const scopeIdStack: string[] = [parentScopeId];
    const getCurrentScopeId = (): string => scopeIdStack[scopeIdStack.length - 1];

    // Determine the ID of the function we're analyzing for RETURNS edges
    // Find by matching file/line/column in functions collection (it was just added by the visitor)
    // REG-271: Skip for StaticBlock (static blocks don't have RETURNS edges or control flow metadata)
    const funcNode = funcPath.node;
    const functionNode = t.isFunction(funcNode) ? funcNode : null;
    const functionPath = functionNode ? (funcPath as NodePath<t.Function>) : null;
    const funcLine = getLine(funcNode);
    const funcColumn = getColumn(funcNode);
    let currentFunctionId: string | null = null;

    // StaticBlock is not a function - skip function matching for RETURNS edges
    // For StaticBlock, matchingFunction will be undefined
    const matchingFunction = funcNode.type !== 'StaticBlock'
      ? functions.find(f =>
          f.file === module.file &&
          f.line === funcLine &&
          (f.column === undefined || f.column === funcColumn)
        )
      : undefined;

    if (matchingFunction) {
      currentFunctionId = matchingFunction.id;
    }

    // REG-401: Build param name -> index map for parameter invocation detection
    // When a CallExpression callee is an Identifier matching a parameter name,
    // it means this function invokes that parameter (user-defined HOF pattern).
    const paramNameToIndex = new Map<string, number>();
    const invokedParamIndexes = new Set<number>();
    if (functionNode) {
      for (let i = 0; i < functionNode.params.length; i++) {
        const param = functionNode.params[i];
        if (t.isIdentifier(param)) {
          paramNameToIndex.set(param.name, i);
        } else if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
          // Handle default values: function(fn = defaultFn) { fn(); }
          paramNameToIndex.set(param.left.name, i);
        }
      }
    }

    // Phase 6 (REG-267): Control flow tracking state for cyclomatic complexity
    const controlFlowState = {
      branchCount: 0,       // if/switch statements
      loopCount: 0,         // for/while/do-while/for-in/for-of
      caseCount: 0,         // switch cases (excluding default)
      logicalOpCount: 0,    // && and || in conditions
      hasTryCatch: false,
      hasEarlyReturn: false,
      hasThrow: false,
      returnCount: 0,       // Track total return count for early return detection
      totalStatements: 0,   // Track if there are statements after returns
      // REG-311: Try block depth counter for O(1) isInsideTry detection
      tryBlockDepth: 0,
      // REG-298: Loop depth counter for O(1) isInsideLoop detection
      loopDepth: 0
    };

    // Handle implicit return for THIS arrow function if it has an expression body
    // e.g., `const double = x => x * 2;` - the function we're analyzing IS an arrow with expression body
    if (t.isArrowFunctionExpression(funcNode) && !t.isBlockStatement(funcNode.body) && currentFunctionId) {
      const bodyExpr = funcNode.body;
      const bodyLine = getLine(bodyExpr);
      const bodyColumn = getColumn(bodyExpr);

      // Extract expression-specific info using shared method
      const exprInfo = this.extractReturnExpressionInfo(
        bodyExpr, module, literals, literalCounterRef, funcLine, funcColumn, 'implicit_return'
      );

      const returnInfo: ReturnStatementInfo = {
        parentFunctionId: currentFunctionId,
        file: module.file,
        line: bodyLine,
        column: bodyColumn,
        returnValueType: 'NONE',
        isImplicitReturn: true,
        ...exprInfo,
      };

      returnStatements.push(returnInfo);
    }

    funcPath.traverse({
      VariableDeclaration: (varPath: NodePath<t.VariableDeclaration>) => {
        this.handleVariableDeclaration(
          varPath,
          getCurrentScopeId(),
          module,
          variableDeclarations,
          classInstantiations,
          literals,
          variableAssignments,
          varDeclCounterRef,
          literalCounterRef,
          scopeTracker,
          parentScopeVariables,
          objectLiterals,
          objectProperties,
          objectLiteralCounterRef
        );
      },

      // Detect indexed array assignments: arr[i] = value
      AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
        const assignNode = assignPath.node;

        // === VARIABLE REASSIGNMENT (REG-290) ===
        // Check if LHS is simple identifier (not obj.prop, not arr[i])
        // Must be checked FIRST before array/object mutation handlers
        if (assignNode.left.type === 'Identifier') {
          // Initialize collection if not exists
          if (!collections.variableReassignments) {
            collections.variableReassignments = [];
          }
          const variableReassignments = collections.variableReassignments as VariableReassignmentInfo[];

          this.detectVariableReassignment(assignNode, module, variableReassignments, scopeTracker);
        }
        // === END VARIABLE REASSIGNMENT ===

        // Initialize collection if not exists
        if (!collections.arrayMutations) {
          collections.arrayMutations = [];
        }
        const arrayMutations = collections.arrayMutations as ArrayMutationInfo[];

        // Check for indexed array assignment: arr[i] = value
        this.detectIndexedArrayAssignment(assignNode, module, arrayMutations, scopeTracker, collections);

        // Initialize object mutations collection if not exists
        if (!collections.objectMutations) {
          collections.objectMutations = [];
        }
        const objectMutations = collections.objectMutations as ObjectMutationInfo[];

        // Check for object property assignment: obj.prop = value
        this.detectObjectPropertyAssignment(assignNode, module, objectMutations, scopeTracker);
      },

      // Handle return statements for RETURNS edges
      ReturnStatement: (returnPath: NodePath<t.ReturnStatement>) => {
        // Skip if we couldn't determine the function ID
        if (!currentFunctionId) {
          return;
        }

        // Skip if this return is inside a nested function (not the function we're analyzing)
        // Check if there's a function ancestor BETWEEN us and funcNode
        // Stop checking once we reach funcNode - parents above funcNode are outside scope
        let parent: NodePath | null = returnPath.parentPath;
        let isInsideConditional = false;
        while (parent) {
          // If we've reached funcNode, we're done checking - this return belongs to funcNode
          if (parent.node === funcNode) {
            break;
          }
          if (t.isFunction(parent.node)) {
            // Found a function between returnPath and funcNode - this return is inside a nested function
            return;
          }
          // Track if return is inside a conditional block (if/else, switch case, loop, try/catch)
          if (t.isIfStatement(parent.node) ||
              t.isSwitchCase(parent.node) ||
              t.isLoop(parent.node) ||
              t.isTryStatement(parent.node) ||
              t.isCatchClause(parent.node)) {
            isInsideConditional = true;
          }
          parent = parent.parentPath;
        }

        // Phase 6 (REG-267): Track return count and early return detection
        controlFlowState.returnCount++;

        // A return is "early" if it's inside a conditional structure
        // (More returns after this one indicate the function doesn't always end here)
        if (isInsideConditional) {
          controlFlowState.hasEarlyReturn = true;
        }

        const returnNode = returnPath.node;
        const returnLine = getLine(returnNode);
        const returnColumn = getColumn(returnNode);

        // Handle bare return; (no value)
        if (!returnNode.argument) {
          // Skip - no data flow value
          return;
        }

        const arg = returnNode.argument;

        // Extract expression-specific info using shared method
        const exprInfo = this.extractReturnExpressionInfo(
          arg, module, literals, literalCounterRef, returnLine, returnColumn, 'return'
        );

        const returnInfo: ReturnStatementInfo = {
          parentFunctionId: currentFunctionId,
          file: module.file,
          line: returnLine,
          column: returnColumn,
          returnValueType: 'NONE',
          ...exprInfo,
        };

        returnStatements.push(returnInfo);
      },

      // Phase 6 (REG-267): Track throw statements for control flow metadata
      // REG-311: Detect async_throw rejection patterns
      // REG-286: Detect sync_throw patterns for ALL functions (THROWS edges)
      ThrowStatement: (throwPath: NodePath<t.ThrowStatement>) => {
        // Skip if this throw is inside a nested function (not the function we're analyzing)
        let parent: NodePath | null = throwPath.parentPath;
        while (parent) {
          if (t.isFunction(parent.node) && parent.node !== funcNode) {
            // This throw is inside a nested function - skip it
            return;
          }
          parent = parent.parentPath;
        }

        controlFlowState.hasThrow = true;

        // REG-286: Track throw patterns for ALL functions (sync and async)
        // Async throws → REJECTS edges, sync throws → THROWS edges
        const isAsyncFunction = functionNode?.async === true;
        if (currentFunctionId && functionNode && functionPath) {
          const throwNode = throwPath.node;
          const arg = throwNode.argument;
          const throwLine = getLine(throwNode);
          const throwColumn = getColumn(throwNode);

          // Case 1: throw new Error() or throw new CustomError()
          if (arg && t.isNewExpression(arg) && t.isIdentifier(arg.callee)) {
            rejectionPatterns.push({
              functionId: currentFunctionId,
              errorClassName: arg.callee.name,
              rejectionType: isAsyncFunction ? 'async_throw' : 'sync_throw',
              isAsync: isAsyncFunction,
              file: module.file,
              line: throwLine,
              column: throwColumn
            });
          }
          // Case 2: throw identifier - needs micro-trace
          else if (arg && t.isIdentifier(arg)) {
            const varName = arg.name;

            // Check if it's a parameter
            const isParameter = functionNode.params.some(param =>
              t.isIdentifier(param) && param.name === varName
            );

            if (isParameter) {
              // Parameter forwarding - can't resolve statically
              rejectionPatterns.push({
                functionId: currentFunctionId,
                errorClassName: null,
                rejectionType: 'variable_parameter',
                isAsync: isAsyncFunction,
                file: module.file,
                line: throwLine,
                column: throwColumn,
                sourceVariableName: varName
              });
            } else {
              // Try micro-trace
              const { errorClassName, tracePath } = this.microTraceToErrorClass(
                varName,
                functionPath,
                variableDeclarations
              );

              rejectionPatterns.push({
                functionId: currentFunctionId,
                errorClassName,
                rejectionType: errorClassName ? 'variable_traced' : 'variable_unknown',
                isAsync: isAsyncFunction,
                file: module.file,
                line: throwLine,
                column: throwColumn,
                sourceVariableName: varName,
                tracePath
              });
            }
          }
        }
      },

      // Handle yield expressions for YIELDS/DELEGATES_TO edges (REG-270)
      YieldExpression: (yieldPath: NodePath<t.YieldExpression>) => {
        // Skip if we couldn't determine the function ID
        if (!currentFunctionId) {
          return;
        }

        // Skip if this yield is inside a nested function (not the function we're analyzing)
        // Check if there's a function ancestor BETWEEN us and funcNode
        let parent: NodePath | null = yieldPath.parentPath;
        while (parent) {
          // If we've reached funcNode, we're done checking - this yield belongs to funcNode
          if (parent.node === funcNode) {
            break;
          }
          if (t.isFunction(parent.node)) {
            // Found a function between yieldPath and funcNode - this yield is inside a nested function
            return;
          }
          parent = parent.parentPath;
        }

        const yieldNode = yieldPath.node;
        const yieldLine = getLine(yieldNode);
        const yieldColumn = getColumn(yieldNode);
        const isDelegate = yieldNode.delegate ?? false;

        // Handle bare yield; (no value) - only valid for non-delegate yield
        if (!yieldNode.argument && !isDelegate) {
          // Skip - no data flow value
          return;
        }

        // For yield* without argument (syntax error in practice, but handle gracefully)
        if (!yieldNode.argument) {
          return;
        }

        const arg = yieldNode.argument;

        // Extract expression-specific info using shared method
        // Note: We reuse extractReturnExpressionInfo since yield values have identical semantics
        const exprInfo = this.extractReturnExpressionInfo(
          arg, module, literals, literalCounterRef, yieldLine, yieldColumn, 'yield'
        );

        // Map ReturnStatementInfo fields to YieldExpressionInfo fields
        const yieldInfo: YieldExpressionInfo = {
          parentFunctionId: currentFunctionId,
          file: module.file,
          line: yieldLine,
          column: yieldColumn,
          isDelegate,
          yieldValueType: exprInfo.returnValueType ?? 'NONE',
          yieldValueName: exprInfo.returnValueName,
          yieldValueId: exprInfo.returnValueId,
          yieldValueLine: exprInfo.returnValueLine,
          yieldValueColumn: exprInfo.returnValueColumn,
          yieldValueCallName: exprInfo.returnValueCallName,
          expressionType: exprInfo.expressionType,
          operator: exprInfo.operator,
          leftSourceName: exprInfo.leftSourceName,
          rightSourceName: exprInfo.rightSourceName,
          consequentSourceName: exprInfo.consequentSourceName,
          alternateSourceName: exprInfo.alternateSourceName,
          object: exprInfo.object,
          property: exprInfo.property,
          computed: exprInfo.computed,
          objectSourceName: exprInfo.objectSourceName,
          expressionSourceNames: exprInfo.expressionSourceNames,
          unaryArgSourceName: exprInfo.unaryArgSourceName,
        };

        yieldExpressions.push(yieldInfo);
      },

      ForStatement: this.createLoopScopeHandler('for', 'for-loop', 'for', parentScopeId, module, scopes, loops, scopeCounterRef, loopCounterRef, scopeTracker, scopeIdStack, controlFlowState),
      ForInStatement: this.createLoopScopeHandler('for-in', 'for-in-loop', 'for-in', parentScopeId, module, scopes, loops, scopeCounterRef, loopCounterRef, scopeTracker, scopeIdStack, controlFlowState),
      ForOfStatement: this.createLoopScopeHandler('for-of', 'for-of-loop', 'for-of', parentScopeId, module, scopes, loops, scopeCounterRef, loopCounterRef, scopeTracker, scopeIdStack, controlFlowState),
      WhileStatement: this.createLoopScopeHandler('while', 'while-loop', 'while', parentScopeId, module, scopes, loops, scopeCounterRef, loopCounterRef, scopeTracker, scopeIdStack, controlFlowState),
      DoWhileStatement: this.createLoopScopeHandler('do-while', 'do-while-loop', 'do-while', parentScopeId, module, scopes, loops, scopeCounterRef, loopCounterRef, scopeTracker, scopeIdStack, controlFlowState),

      // Phase 4 (REG-267): Now creates TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK nodes
      TryStatement: this.createTryStatementHandler(
        parentScopeId,
        module,
        scopes,
        tryBlocks,
        catchBlocks,
        finallyBlocks,
        scopeCounterRef,
        tryBlockCounterRef,
        catchBlockCounterRef,
        finallyBlockCounterRef,
        scopeTracker,
        tryScopeMap,
        scopeIdStack,
        controlFlowState
      ),

      CatchClause: this.createCatchClauseHandler(
        module,
        variableDeclarations,
        varDeclCounterRef,
        scopeTracker,
        tryScopeMap,
        scopeIdStack,
        controlFlowState
      ),

      SwitchStatement: (switchPath: NodePath<t.SwitchStatement>) => {
        this.handleSwitchStatement(
          switchPath,
          parentScopeId,
          module,
          collections,
          scopeTracker,
          controlFlowState
        );
      },

      FunctionDeclaration: (funcDeclPath: NodePath<t.FunctionDeclaration>) => {
        const node = funcDeclPath.node;
        const funcName = node.id ? node.id.name : this.generateAnonymousName(scopeTracker);
        // Use semantic ID as primary ID when scopeTracker available
        const legacyId = `FUNCTION#${funcName}#${module.file}#${getLine(node)}:${getColumn(node)}:${functionCounterRef.value++}`;
        const functionId = scopeTracker
          ? computeSemanticId('FUNCTION', funcName, scopeTracker.getContext())
          : legacyId;

        functions.push({
          id: functionId,
          type: 'FUNCTION',
          name: funcName,
          file: module.file,
          line: getLine(node),
          column: getColumn(node),
          async: node.async || false,
          generator: node.generator || false,
          parentScopeId
        });

        const nestedScopeId = `SCOPE#${funcName}:body#${module.file}#${getLine(node)}`;
        const closureSemanticId = this.generateSemanticId('closure', scopeTracker);
        scopes.push({
          id: nestedScopeId,
          type: 'SCOPE',
          scopeType: 'closure',
          name: `${funcName}:body`,
          semanticId: closureSemanticId,
          conditional: false,
          file: module.file,
          line: getLine(node),
          parentFunctionId: functionId,
          capturesFrom: parentScopeId
        });

        // Enter nested function scope for semantic ID generation
        if (scopeTracker) {
          scopeTracker.enterScope(funcName, 'function');
        }
        this.analyzeFunctionBody(funcDeclPath, nestedScopeId, module, collections);
        if (scopeTracker) {
          scopeTracker.exitScope();
        }
        funcDeclPath.skip();
      },

      FunctionExpression: (funcPath: NodePath<t.FunctionExpression>) => {
        const node = funcPath.node;
        const funcName = node.id ? node.id.name : this.generateAnonymousName(scopeTracker);
        // Use semantic ID as primary ID when scopeTracker available
        const legacyId = `FUNCTION#${funcName}#${module.file}#${getLine(node)}:${getColumn(node)}:${functionCounterRef.value++}`;
        const functionId = scopeTracker
          ? computeSemanticId('FUNCTION', funcName, scopeTracker.getContext())
          : legacyId;

        functions.push({
          id: functionId,
          type: 'FUNCTION',
          name: funcName,
          file: module.file,
          line: getLine(node),
          column: getColumn(node),
          async: node.async || false,
          generator: node.generator || false,
          parentScopeId
        });

        const nestedScopeId = `SCOPE#${funcName}:body#${module.file}#${getLine(node)}`;
        const closureSemanticId = this.generateSemanticId('closure', scopeTracker);
        scopes.push({
          id: nestedScopeId,
          type: 'SCOPE',
          scopeType: 'closure',
          name: `${funcName}:body`,
          semanticId: closureSemanticId,
          conditional: false,
          file: module.file,
          line: getLine(node),
          parentFunctionId: functionId,
          capturesFrom: parentScopeId
        });

        // Enter nested function scope for semantic ID generation
        if (scopeTracker) {
          scopeTracker.enterScope(funcName, 'function');
        }
        this.analyzeFunctionBody(funcPath, nestedScopeId, module, collections);
        if (scopeTracker) {
          scopeTracker.exitScope();
        }
        funcPath.skip();
      },

      ArrowFunctionExpression: (arrowPath: NodePath<t.ArrowFunctionExpression>) => {
        const node = arrowPath.node;
        const line = getLine(node);
        const column = getColumn(node);

        // Определяем имя (anonymous если не присвоено переменной)
        const parent = arrowPath.parent;
        let funcName: string;
        if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
          funcName = parent.id.name;
        } else {
          // Используем scope-level счётчик для стабильного semanticId
          funcName = this.generateAnonymousName(scopeTracker);
        }

        // Use semantic ID as primary ID when scopeTracker available
        const legacyId = `FUNCTION#${funcName}:${line}:${column}:${functionCounterRef.value++}`;
        const functionId = scopeTracker
          ? computeSemanticId('FUNCTION', funcName, scopeTracker.getContext())
          : legacyId;

        functions.push({
          id: functionId,
          type: 'FUNCTION',
          name: funcName,
          file: module.file,
          line,
          column,
          async: node.async || false,
          arrowFunction: true,
          parentScopeId
        });

        if (node.body.type === 'BlockStatement') {
          const nestedScopeId = `SCOPE#${funcName}:body#${module.file}#${line}`;
          const arrowSemanticId = this.generateSemanticId('arrow_body', scopeTracker);
          scopes.push({
            id: nestedScopeId,
            type: 'SCOPE',
            scopeType: 'arrow_body',
            name: `${funcName}:body`,
            semanticId: arrowSemanticId,
            conditional: false,
            file: module.file,
            line,
            parentFunctionId: functionId,
            capturesFrom: parentScopeId
          });

          // Enter arrow function scope for semantic ID generation
          if (scopeTracker) {
            scopeTracker.enterScope(funcName, 'arrow');
          }
          this.analyzeFunctionBody(arrowPath, nestedScopeId, module, collections);
          if (scopeTracker) {
            scopeTracker.exitScope();
          }
        } else {
          // Arrow function with expression body (implicit return)
          // e.g., x => x * 2, () => 42
          const bodyExpr = node.body;
          const bodyLine = getLine(bodyExpr);
          const bodyColumn = getColumn(bodyExpr);

          // Extract expression-specific info using shared method
          const exprInfo = this.extractReturnExpressionInfo(
            bodyExpr, module, literals, literalCounterRef, line, column, 'implicit_return'
          );

          const returnInfo: ReturnStatementInfo = {
            parentFunctionId: functionId,
            file: module.file,
            line: bodyLine,
            column: bodyColumn,
            returnValueType: 'NONE',
            isImplicitReturn: true,
            ...exprInfo,
          };

          returnStatements.push(returnInfo);
        }

        arrowPath.skip();
      },

      UpdateExpression: (updatePath: NodePath<t.UpdateExpression>) => {
        const updateNode = updatePath.node;

        // REG-288/REG-312: Collect update expression info for graph building
        this.collectUpdateExpression(updateNode, module, updateExpressions, getCurrentScopeId(), scopeTracker);

        // Legacy behavior: update scope.modifies for IDENTIFIER targets
        if (updateNode.argument.type === 'Identifier') {
          const varName = updateNode.argument.name;

          // Find variable by name - could be from parent scope or declarations
          const fromParentScope = Array.from(parentScopeVariables).find(v => v.name === varName);
          const fromDeclarations = variableDeclarations.find(v => v.name === varName);
          const variable = fromParentScope ?? fromDeclarations;

          if (variable) {
            const scope = scopes.find(s => s.id === parentScopeId);
            if (scope) {
              if (!scope.modifies) scope.modifies = [];
              scope.modifies.push({
                variableId: variable.id,
                variableName: varName,
                line: getLine(updateNode)
              });
            }
          }
        }
      },

      // IF statements - создаём условные scope и обходим содержимое для CALL узлов
      // Phase 3 (REG-267): Now creates BRANCH nodes with branchType='if'
      IfStatement: this.createIfStatementHandler(
        parentScopeId,
        module,
        scopes,
        branches,
        ifScopeCounterRef,
        branchCounterRef,
        scopeTracker,
        collections.code ?? '',
        ifElseScopeMap,
        scopeIdStack,
        controlFlowState,
        this.countLogicalOperators.bind(this)
      ),

      // Ternary expressions (REG-287): Creates BRANCH nodes with branchType='ternary'
      ConditionalExpression: this.createConditionalExpressionHandler(
        parentScopeId,
        module,
        branches,
        branchCounterRef,
        scopeTracker,
        scopeIdStack,
        controlFlowState,
        this.countLogicalOperators.bind(this)
      ),

      // Track when we enter the alternate (else) block of an IfStatement
      BlockStatement: this.createBlockStatementHandler(scopeTracker, ifElseScopeMap, tryScopeMap, scopeIdStack),

      // Function call expressions
      CallExpression: (callPath: NodePath<t.CallExpression>) => {
        // REG-311: Detect isAwaited (parent is AwaitExpression)
        const parent = callPath.parentPath;
        const isAwaited = parent?.isAwaitExpression() ?? false;

        // REG-311: Detect isInsideTry (O(1) via depth counter)
        const isInsideTry = controlFlowState.tryBlockDepth > 0;

        // REG-298: Detect isInsideLoop (O(1) via depth counter)
        const isInsideLoop = controlFlowState.loopDepth > 0;

        this.handleCallExpression(
          callPath.node,
          processedCallSites,
          processedMethodCalls,
          callSites,
          methodCalls,
          module,
          callSiteCounterRef,
          scopeTracker,
          getCurrentScopeId(),
          collections,
          isAwaited,
          isInsideTry,
          isInsideLoop
        );

        // REG-401: Detect parameter invocation for user-defined HOF tracking
        // If callee is an Identifier matching a parameter name, record the param index.
        // Nested functions are already skipped by FunctionDeclaration/FunctionExpression/ArrowFunction
        // handlers calling path.skip(), so shadowed names won't be falsely matched.
        const callNodeForParam = callPath.node;
        if (t.isIdentifier(callNodeForParam.callee) && paramNameToIndex.size > 0) {
          const paramIndex = paramNameToIndex.get(callNodeForParam.callee.name);
          if (paramIndex !== undefined) {
            invokedParamIndexes.add(paramIndex);
          }
        }

        // REG-334: Check for resolve/reject calls inside Promise executors
        const callNode = callPath.node;
        if (t.isIdentifier(callNode.callee)) {
          const calleeName = callNode.callee.name;

          // Walk up function parents to find Promise executor context
          // This handles nested callbacks like: new Promise((resolve) => { db.query((err, data) => { resolve(data); }); });
          let funcParent = callPath.getFunctionParent();
          while (funcParent) {
            const funcNode = funcParent.node;
            const funcKey = `${funcNode.start}:${funcNode.end}`;
            const context = promiseExecutorContexts.get(funcKey);

            if (context) {
              const isResolve = calleeName === context.resolveName;
              const isReject = calleeName === context.rejectName;

              if (isResolve || isReject) {
                // Find the CALL node ID for this resolve/reject call
                // It was just added by handleCallExpression
                const callLine = getLine(callNode);
                const callColumn = getColumn(callNode);

                // Find matching call site that was just added
                const resolveCall = callSites.find(cs =>
                  cs.name === calleeName &&
                  cs.file === module.file &&
                  cs.line === callLine &&
                  cs.column === callColumn
                );

                if (resolveCall) {
                  promiseResolutions.push({
                    callId: resolveCall.id,
                    constructorCallId: context.constructorCallId,
                    isReject,
                    file: module.file,
                    line: callLine
                  });

                  // REG-334: Collect arguments for resolve/reject calls
                  // This enables traceValues to follow PASSES_ARGUMENT edges
                  if (!collections.callArguments) {
                    collections.callArguments = [];
                  }
                  const callArgumentsArr = collections.callArguments as CallArgumentInfo[];

                  // Process arguments (typically just one: resolve(value))
                  callNode.arguments.forEach((arg, argIndex) => {
                    const argInfo: CallArgumentInfo = {
                      callId: resolveCall.id,
                      argIndex,
                      file: module.file,
                      line: getLine(arg),
                      column: getColumn(arg)
                    };

                    // Handle different argument types
                    if (t.isIdentifier(arg)) {
                      argInfo.targetType = 'VARIABLE';
                      argInfo.targetName = arg.name;
                    } else if (t.isLiteral(arg) && !t.isTemplateLiteral(arg)) {
                      // Create LITERAL node for the argument value
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
                          parentCallId: resolveCall.id,
                          argIndex
                        });
                        argInfo.targetType = 'LITERAL';
                        argInfo.targetId = literalId;
                        argInfo.literalValue = literalValue;
                      }
                    } else if (t.isCallExpression(arg)) {
                      argInfo.targetType = 'CALL';
                      argInfo.nestedCallLine = getLine(arg);
                      argInfo.nestedCallColumn = getColumn(arg);
                    } else {
                      argInfo.targetType = 'EXPRESSION';
                      argInfo.expressionType = arg.type;
                    }

                    callArgumentsArr.push(argInfo);
                  });
                }

                break; // Found context, stop searching
              }
            }

            funcParent = funcParent.getFunctionParent();
          }

          // REG-311: Detect executor_reject pattern - reject(new Error()) inside Promise executor
          // Walk up to find Promise executor context and check if this is reject call with NewExpression arg
          funcParent = callPath.getFunctionParent();
          while (funcParent && currentFunctionId) {
            const funcNode = funcParent.node;
            const funcKey = `${funcNode.start}:${funcNode.end}`;
            const context = promiseExecutorContexts.get(funcKey);

            if (context && calleeName === context.rejectName && callNode.arguments.length > 0) {
              // REG-311: Use the creator function's ID (the function that created the Promise),
              // not the executor's ID
              const targetFunctionId = context.creatorFunctionId || currentFunctionId;
              const arg = callNode.arguments[0];
              const callLine = getLine(callNode);
              const callColumn = getColumn(callNode);

              // Case 1: reject(new Error())
              if (t.isNewExpression(arg) && t.isIdentifier(arg.callee)) {
                rejectionPatterns.push({
                  functionId: targetFunctionId,
                  errorClassName: arg.callee.name,
                  rejectionType: 'executor_reject',
                  isAsync: true,
                  file: module.file,
                  line: callLine,
                  column: callColumn
                });
              }
              // Case 2: reject(err) where err is variable
              else if (t.isIdentifier(arg)) {
                const varName = arg.name;
                // Check if it's a parameter of ANY containing function (executor, outer, etc.)
                // Walk up the function chain to find if varName is a parameter
                let isParameter = false;
                let checkParent: NodePath<t.Node> | null = funcParent;
                while (checkParent) {
                  if (t.isFunction(checkParent.node)) {
                    if (checkParent.node.params.some(p =>
                      t.isIdentifier(p) && p.name === varName
                    )) {
                      isParameter = true;
                      break;
                    }
                  }
                  checkParent = checkParent.getFunctionParent();
                }

                if (isParameter) {
                  rejectionPatterns.push({
                    functionId: targetFunctionId,
                    errorClassName: null,
                    rejectionType: 'variable_parameter',
                    isAsync: true,
                    file: module.file,
                    line: callLine,
                    column: callColumn,
                    sourceVariableName: varName
                  });
                } else {
                  // Try micro-trace
                  const { errorClassName, tracePath } = this.microTraceToErrorClass(
                    varName,
                    funcParent as NodePath<t.Function>,
                    variableDeclarations
                  );

                  rejectionPatterns.push({
                    functionId: targetFunctionId,
                    errorClassName,
                    rejectionType: errorClassName ? 'variable_traced' : 'variable_unknown',
                    isAsync: true,
                    file: module.file,
                    line: callLine,
                    column: callColumn,
                    sourceVariableName: varName,
                    tracePath
                  });
                }
              }
              break;
            }
            funcParent = funcParent.getFunctionParent();
          }
        }

        // REG-311: Detect Promise.reject(new Error()) pattern
        if (t.isMemberExpression(callNode.callee) && currentFunctionId) {
          const memberCallee = callNode.callee;
          if (t.isIdentifier(memberCallee.object) &&
              memberCallee.object.name === 'Promise' &&
              t.isIdentifier(memberCallee.property) &&
              memberCallee.property.name === 'reject' &&
              callNode.arguments.length > 0) {
            const arg = callNode.arguments[0];
            const callLine = getLine(callNode);
            const callColumn = getColumn(callNode);

            // Case 1: Promise.reject(new Error())
            if (t.isNewExpression(arg) && t.isIdentifier(arg.callee)) {
              rejectionPatterns.push({
                functionId: currentFunctionId,
                errorClassName: arg.callee.name,
                rejectionType: 'promise_reject',
                isAsync: true,
                file: module.file,
                line: callLine,
                column: callColumn
              });
            }
            // Case 2: Promise.reject(err) where err is variable
            else if (t.isIdentifier(arg)) {
              const varName = arg.name;
              // Check if it's a parameter of containing function
              const isParameter = functionNode
                ? functionNode.params.some(param => t.isIdentifier(param) && param.name === varName)
                : false;

              if (isParameter) {
                rejectionPatterns.push({
                  functionId: currentFunctionId,
                  errorClassName: null,
                  rejectionType: 'variable_parameter',
                  isAsync: true,
                  file: module.file,
                  line: callLine,
                  column: callColumn,
                  sourceVariableName: varName
                });
              } else {
                // Try micro-trace
                if (!functionPath) {
                  rejectionPatterns.push({
                    functionId: currentFunctionId,
                    errorClassName: null,
                    rejectionType: 'variable_unknown',
                    isAsync: true,
                    file: module.file,
                    line: callLine,
                    column: callColumn,
                    sourceVariableName: varName,
                    tracePath: [varName]
                  });
                  return;
                }

                const { errorClassName, tracePath } = this.microTraceToErrorClass(
                  varName,
                  functionPath,
                  variableDeclarations
                );

                rejectionPatterns.push({
                  functionId: currentFunctionId,
                  errorClassName,
                  rejectionType: errorClassName ? 'variable_traced' : 'variable_unknown',
                  isAsync: true,
                  file: module.file,
                  line: callLine,
                  column: callColumn,
                  sourceVariableName: varName,
                  tracePath
                });
              }
            }
          }
        }
      },

      // NewExpression (constructor calls)
      NewExpression: (newPath: NodePath<t.NewExpression>) => {
        const newNode = newPath.node;
        const nodeKey = `new:${newNode.start}:${newNode.end}`;

        // Determine className from callee
        let className: string | null = null;
        if (newNode.callee.type === 'Identifier') {
          className = newNode.callee.name;
        } else if (newNode.callee.type === 'MemberExpression' && newNode.callee.property.type === 'Identifier') {
          className = newNode.callee.property.name;
        }

        // Create CONSTRUCTOR_CALL node (always, for all NewExpressions)
        if (className) {
          const constructorKey = `constructor:${nodeKey}`;
          if (!processedCallSites.has(constructorKey)) {
            processedCallSites.add(constructorKey);

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
              column
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
                    // REG-311: Store the ID of the function that creates the Promise
                    creatorFunctionId: currentFunctionId || undefined
                  });
                }
              }
            }
          }
        }

        // Handle simple constructor: new Foo()
        if (newNode.callee.type === 'Identifier') {
          if (processedCallSites.has(nodeKey)) {
            return;
          }
          processedCallSites.add(nodeKey);

          // Generate semantic ID (primary) or legacy ID (fallback)
          const constructorName = newNode.callee.name;
          const legacyId = `CALL#new:${constructorName}#${module.file}#${getLine(newNode)}:${getColumn(newNode)}:${callSiteCounterRef.value++}`;

          let newCallId = legacyId;
          if (scopeTracker) {
            const discriminator = scopeTracker.getItemCounter(`CALL:new:${constructorName}`);
            newCallId = computeSemanticId('CALL', `new:${constructorName}`, scopeTracker.getContext(), { discriminator });
          }

          callSites.push({
            id: newCallId,
            type: 'CALL',
            name: constructorName,
            file: module.file,
            line: getLine(newNode),
            parentScopeId: getCurrentScopeId(),
            targetFunctionName: constructorName,
            isNew: true
          });
        }
        // Handle namespaced constructor: new ns.Constructor()
        else if (newNode.callee.type === 'MemberExpression') {
          const memberCallee = newNode.callee;
          const object = memberCallee.object;
          const property = memberCallee.property;

          if (object.type === 'Identifier' && property.type === 'Identifier') {
            if (processedMethodCalls.has(nodeKey)) {
              return;
            }
            processedMethodCalls.add(nodeKey);

            const objectName = object.name;
            const constructorName = property.name;
            const fullName = `${objectName}.${constructorName}`;

            // Generate semantic ID for method-style constructor call
            const legacyId = `CALL#new:${fullName}#${module.file}#${getLine(newNode)}:${getColumn(newNode)}:${callSiteCounterRef.value++}`;

            let newMethodCallId = legacyId;
            if (scopeTracker) {
              const discriminator = scopeTracker.getItemCounter(`CALL:new:${fullName}`);
              newMethodCallId = computeSemanticId('CALL', `new:${fullName}`, scopeTracker.getContext(), { discriminator });
            }

            methodCalls.push({
              id: newMethodCallId,
              type: 'CALL',
              name: fullName,
              object: objectName,
              method: constructorName,
              file: module.file,
              line: getLine(newNode),
              column: getColumn(newNode),
              parentScopeId: getCurrentScopeId(),
              isNew: true
            });
          }
        }
      },

      // Property access expressions (REG-395)
      // Shared handler for both MemberExpression and OptionalMemberExpression
      MemberExpression: (memberPath: NodePath<t.MemberExpression>) => {
        // Initialize collections if needed
        if (!collections.propertyAccesses) {
          collections.propertyAccesses = [];
        }
        if (!collections.propertyAccessCounterRef) {
          collections.propertyAccessCounterRef = { value: 0 };
        }

        PropertyAccessVisitor.extractPropertyAccesses(
          memberPath,
          memberPath.node,
          module,
          collections.propertyAccesses as PropertyAccessInfo[],
          collections.propertyAccessCounterRef as CounterRef,
          scopeTracker,
          currentFunctionId || getCurrentScopeId()
        );
      },
      // OptionalMemberExpression: obj?.prop (same logic as MemberExpression)
      OptionalMemberExpression: (memberPath: NodePath) => {
        // Initialize collections if needed
        if (!collections.propertyAccesses) {
          collections.propertyAccesses = [];
        }
        if (!collections.propertyAccessCounterRef) {
          collections.propertyAccessCounterRef = { value: 0 };
        }

        PropertyAccessVisitor.extractPropertyAccesses(
          memberPath,
          memberPath.node as t.MemberExpression,
          module,
          collections.propertyAccesses as PropertyAccessInfo[],
          collections.propertyAccessCounterRef as CounterRef,
          scopeTracker,
          currentFunctionId || getCurrentScopeId()
        );
      },
      // MetaProperty: new.target (REG-301)
      MetaProperty: (metaPath: NodePath<t.MetaProperty>) => {
        // Initialize collections if needed
        if (!collections.propertyAccesses) {
          collections.propertyAccesses = [];
        }
        if (!collections.propertyAccessCounterRef) {
          collections.propertyAccessCounterRef = { value: 0 };
        }

        PropertyAccessVisitor.extractMetaProperty(
          metaPath.node,
          module,
          collections.propertyAccesses as PropertyAccessInfo[],
          collections.propertyAccessCounterRef as CounterRef,
          scopeTracker,
          currentFunctionId || getCurrentScopeId()
        );
      }
    });

    // REG-311: Second pass - collect CATCHES_FROM info for try/catch blocks
    // This links catch blocks to exception sources in their corresponding try blocks
    if (functionPath) {
      this.collectCatchesFromInfo(
        functionPath,
        catchBlocks,
        callSites,
        methodCalls,
        constructorCalls,
        catchesFromInfos,
        module
      );
    }

    // Phase 6 (REG-267): Attach control flow metadata to the function node
    if (matchingFunction) {
      const cyclomaticComplexity = 1 +
        controlFlowState.branchCount +
        controlFlowState.loopCount +
        controlFlowState.caseCount +
        controlFlowState.logicalOpCount;

      // REG-311: Collect rejection info for this function
      const functionRejectionPatterns = rejectionPatterns.filter(p => p.functionId === matchingFunction.id);
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

      matchingFunction.controlFlow = {
        hasBranches: controlFlowState.branchCount > 0,
        hasLoops: controlFlowState.loopCount > 0,
        hasTryCatch: controlFlowState.hasTryCatch,
        hasEarlyReturn: controlFlowState.hasEarlyReturn,
        hasThrow: controlFlowState.hasThrow,
        cyclomaticComplexity,
        // REG-311: Async error tracking
        canReject,
        hasAsyncThrow,
        rejectedBuiltinErrors: rejectedBuiltinErrors.length > 0 ? rejectedBuiltinErrors : undefined,
        // REG-286: Sync throw tracking
        thrownBuiltinErrors: thrownBuiltinErrors.length > 0 ? thrownBuiltinErrors : undefined
      };

      // REG-401: Store invoked parameter indexes for user-defined HOF detection
      if (invokedParamIndexes.size > 0) {
        matchingFunction.invokesParamIndexes = [...invokedParamIndexes];
      }
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
