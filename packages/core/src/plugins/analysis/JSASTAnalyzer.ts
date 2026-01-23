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
  type VisitorModule,
  type VisitorCollections,
  type TrackVariableAssignmentCallback
} from './ast/visitors/index.js';
import { Task } from '../../core/Task.js';
import { PriorityQueue } from '../../core/PriorityQueue.js';
import { WorkerPool } from '../../core/WorkerPool.js';
import { ASTWorkerPool, type ModuleInfo as ASTModuleInfo, type ParseResult } from '../../core/ASTWorkerPool.js';
import { ConditionParser } from './ast/ConditionParser.js';
import { Profiler } from '../../core/Profiler.js';
import { ScopeTracker } from '../../core/ScopeTracker.js';
import { computeSemanticId } from '../../core/SemanticId.js';
import { ExpressionNode } from '../../core/nodes/ExpressionNode.js';
import type { PluginContext, PluginResult, PluginMetadata, GraphBackend } from '@grafema/types';
import type {
  ModuleNode,
  FunctionInfo,
  ParameterInfo,
  ScopeInfo,
  VariableDeclarationInfo,
  CallSiteInfo,
  MethodCallInfo,
  EventListenerInfo,
  ClassInstantiationInfo,
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
  CounterRef,
  ProcessedNodes,
  ASTCollections,
  ExtractedVariable,
} from './ast/types.js';

// === LOCAL TYPES ===

// Note: Legacy ScopeContext interface removed in REG-141
// Semantic ID generation now uses ScopeTracker exclusively

// Internal Collections with required fields (ASTCollections has optional for GraphBuilder)
interface Collections {
  functions: FunctionInfo[];
  parameters: ParameterInfo[];
  scopes: ScopeInfo[];
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
      priority: 80,
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
          'IMPLEMENTS', 'EXTENDS', 'DECORATED_BY'
        ]
      },
      dependencies: ['JSModuleIndexer']
    };
  }

  /**
   * Вычисляет хеш содержимого файла
   */
  calculateFileHash(filePath: string): string | null {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Проверяет нужно ли анализировать модуль (сравнивает хеши)
   */
  async shouldAnalyzeModule(module: ModuleNode, graph: GraphBackend, forceAnalysis: boolean): Promise<boolean> {
    if (forceAnalysis) {
      return true;
    }

    if (!module.contentHash) {
      return true;
    }

    const currentHash = this.calculateFileHash(module.file);
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

        if (await this.shouldAnalyzeModule(module, graph, forceAnalysis)) {
          modulesToAnalyze.push(module);
        } else {
          skippedCount++;
        }
      }

      console.log(`[JSASTAnalyzer] Starting analysis of ${modulesToAnalyze.length} modules (${skippedCount} cached)...`);

      if (modulesToAnalyze.length === 0) {
        console.log(`[JSASTAnalyzer] All modules are up-to-date, skipping analysis`);
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
          console.log(`[JSASTAnalyzer] Progress: ${completed}/${modulesToAnalyze.length}`);
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

      console.log(`[JSASTAnalyzer] Analyzed ${modulesToAnalyze.length} modules, created ${nodesCreated} nodes`);
      console.log(`[JSASTAnalyzer] Stats:`, stats);

      this.profiler.printSummary();

      return createSuccessResult(
        { nodes: nodesCreated, edges: edgesCreated },
        { modulesAnalyzed: modulesToAnalyze.length, workerStats: stats }
      );

    } catch (error) {
      console.error(`[JSASTAnalyzer] Error:`, error);
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
    const workerCount = context.workerCount || 4;
    const pool = new ASTWorkerPool(workerCount);

    console.log(`[JSASTAnalyzer] Starting parallel parsing with ${workerCount} workers...`);

    try {
      await pool.init();

      // Convert ModuleNode to ASTModuleInfo format
      const moduleInfos: ASTModuleInfo[] = modules.map(m => ({
        id: m.id,
        file: m.file,
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
          console.error(`[JSASTAnalyzer] Error parsing ${result.module.file}:`, result.error.message);
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
            message: `Processed ${result.module.file.replace(projectPath, '')}`,
            totalFiles: modules.length,
            processedFiles: results.indexOf(result) + 1
          });
        }
      }

      console.log(`[JSASTAnalyzer] Parallel parsing complete: ${nodesCreated} nodes, ${edgesCreated} edges, ${errors} errors`);

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
   */
  extractVariableNamesFromPattern(pattern: t.Node | null | undefined, variables: ExtractedVariable[] = [], propertyPath: string[] = []): ExtractedVariable[] {
    if (!pattern) return variables;

    if (t.isIdentifier(pattern)) {
      variables.push({
        name: pattern.name,
        loc: pattern.loc?.start ? { start: pattern.loc.start } : { start: { line: 0, column: 0 } },
        propertyPath: propertyPath.length > 0 ? [...propertyPath] : undefined
      });
    } else if (t.isObjectPattern(pattern)) {
      pattern.properties.forEach((prop) => {
        if (t.isRestElement(prop)) {
          const restVars = this.extractVariableNamesFromPattern(prop.argument, [], []);
          restVars.forEach(v => {
            v.isRest = true;
            v.propertyPath = propertyPath.length > 0 ? [...propertyPath] : undefined;
            variables.push(v);
          });
        } else if (t.isObjectProperty(prop) && prop.value) {
          const key = t.isIdentifier(prop.key) ? prop.key.name :
                     (t.isStringLiteral(prop.key) || t.isNumericLiteral(prop.key) ? String(prop.key.value) : null);

          if (key !== null) {
            const newPath = [...propertyPath, key];
            this.extractVariableNamesFromPattern(prop.value, variables, newPath);
          } else {
            this.extractVariableNamesFromPattern(prop.value, variables, propertyPath);
          }
        }
      });
    } else if (t.isArrayPattern(pattern)) {
      pattern.elements.forEach((element, index) => {
        if (element) {
          if (t.isRestElement(element)) {
            const restVars = this.extractVariableNamesFromPattern(element.argument, [], []);
            restVars.forEach(v => {
              v.isRest = true;
              v.arrayIndex = index;
              v.propertyPath = propertyPath.length > 0 ? [...propertyPath] : undefined;
              variables.push(v);
            });
          } else {
            const extracted = this.extractVariableNamesFromPattern(element, [], propertyPath);
            extracted.forEach(v => {
              v.arrayIndex = index;
              variables.push(v);
            });
          }
        }
      });
    } else if (t.isRestElement(pattern)) {
      const restVars = this.extractVariableNamesFromPattern(pattern.argument, [], propertyPath);
      restVars.forEach(v => {
        v.isRest = true;
        variables.push(v);
      });
    } else if (t.isAssignmentPattern(pattern)) {
      this.extractVariableNamesFromPattern(pattern.left, variables, propertyPath);
    }

    return variables;
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
    literalCounterRef: CounterRef
  ): void {
    if (!initNode) return;
    // initNode is already typed as t.Expression
    const initExpression = initNode;

    // 0. AwaitExpression
    if (initExpression.type === 'AwaitExpression') {
      return this.trackVariableAssignment(initExpression.argument, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef);
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
        callLine: initExpression.loc!.start.line,
        callColumn: initExpression.loc!.start.column
      });
      return;
    }

    // 3. MemberExpression call (e.g., arr.map())
    if (initExpression.type === 'CallExpression' && initExpression.callee.type === 'MemberExpression') {
      const callee = initExpression.callee;
      const objectName = callee.object.type === 'Identifier' ? callee.object.name : (callee.object.type === 'ThisExpression' ? 'this' : 'unknown');
      const methodName = callee.property.type === 'Identifier' ? callee.property.name : 'unknown';

      const fullName = `${objectName}.${methodName}`;
      const methodCallId = `CALL#${fullName}#${module.file}#${initExpression.loc!.start.line}:${initExpression.loc!.start.column}:inline`;

      const existing = variableAssignments.find(a => a.sourceId === methodCallId);
      if (!existing) {
        const extractedArgs: unknown[] = [];
        initExpression.arguments.forEach((arg, index) => {
          if (arg.type !== 'SpreadElement') {
            const argLiteralValue = ExpressionEvaluator.extractLiteralValue(arg);
            if (argLiteralValue !== null) {
              const literalId = `LITERAL#arg${index}#${module.file}#${initExpression.loc!.start.line}:${initExpression.loc!.start.column}:${literalCounterRef.value++}`;
              literals.push({
                id: literalId,
                type: 'LITERAL',
                value: argLiteralValue,
                valueType: typeof argLiteralValue,
                file: module.file,
                line: arg.loc?.start.line || initExpression.loc!.start.line,
                column: arg.loc?.start.column || initExpression.loc!.start.column,
                parentCallId: methodCallId,
                argIndex: index
              });
              extractedArgs.push(argLiteralValue);
            } else {
              extractedArgs.push(undefined);
            }
          }
        });

        literals.push({
          id: methodCallId,
          type: 'CALL',
          name: fullName,
          object: objectName,
          method: methodName,
          file: module.file,
          arguments: extractedArgs,
          line: initExpression.loc!.start.line,
          column: initExpression.loc!.start.column
        });
      }

      variableAssignments.push({
        variableId,
        sourceId: methodCallId,
        sourceType: 'CALL'
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

    // 5. NewExpression
    if (initExpression.type === 'NewExpression') {
      const callee = initExpression.callee;
      if (callee.type === 'Identifier') {
        variableAssignments.push({
          variableId,
          sourceType: 'CLASS',
          className: callee.name,
          line: line
        });
      }
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

      this.trackVariableAssignment(initExpression.consequent, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef);
      this.trackVariableAssignment(initExpression.alternate, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef);
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

      this.trackVariableAssignment(initExpression.left, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef);
      this.trackVariableAssignment(initExpression.right, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef);
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
          this.trackVariableAssignment(expr, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef);
        }
      }
      return;
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
      const code = readFileSync(module.file, 'utf-8');
      this.profiler.end('file_read');

      this.profiler.start('babel_parse');
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript']
      });
      this.profiler.end('babel_parse');

      // Create ScopeTracker for semantic ID generation
      // Use basename for shorter, more readable semantic IDs
      const scopeTracker = new ScopeTracker(basename(module.file));

      const functions: FunctionInfo[] = [];
      const parameters: ParameterInfo[] = [];
      const scopes: ScopeInfo[] = [];
      const variableDeclarations: VariableDeclarationInfo[] = [];
      const callSites: CallSiteInfo[] = [];
      const methodCalls: MethodCallInfo[] = [];
      const eventListeners: EventListenerInfo[] = [];
      const classInstantiations: ClassInstantiationInfo[] = [];
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
        { variableDeclarations, classInstantiations, literals, variableAssignments, varDeclCounterRef, literalCounterRef },
        this.extractVariableNamesFromPattern.bind(this),
        this.trackVariableAssignment.bind(this) as TrackVariableAssignmentCallback,
        scopeTracker  // Pass ScopeTracker for semantic ID generation
      );
      traverse(ast, variableVisitor.getHandlers());
      this.profiler.end('traverse_variables');

      const allCollections: Collections = {
        functions, parameters, scopes, variableDeclarations, callSites, methodCalls,
        eventListeners, methodCallbacks, callArguments, classInstantiations, classDeclarations,
        httpRequests, literals, variableAssignments,
        // TypeScript-specific collections
        interfaces, typeAliases, enums, decorators,
        // Object/Array literal tracking
        objectLiterals, objectProperties, arrayLiterals, arrayElements,
        // Array mutation tracking
        arrayMutations,
        // Object mutation tracking
        objectMutations,
        objectLiteralCounterRef, arrayLiteralCounterRef,
        ifScopeCounterRef, scopeCounterRef, varDeclCounterRef,
        callSiteCounterRef, functionCounterRef, httpRequestCounterRef,
        literalCounterRef, anonymousFunctionCounterRef, processedNodes,
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
              stableId: functionId,
              type: 'FUNCTION',
              name: functionName,
              file: module.file,
              line: assignNode.loc!.start.line,
              column: assignNode.loc!.start.column,
              async: funcNode.async || false,
              generator: funcNode.type === 'FunctionExpression' ? funcNode.generator : false,
              isAssignment: true
            });

            const funcBodyScopeId = `SCOPE#${functionName}:body#${module.file}#${assignNode.loc!.start.line}`;
            scopes.push({
              id: funcBodyScopeId,
              type: 'SCOPE',
              scopeType: 'function_body',
              name: `${functionName}:body`,
              semanticId: `${functionName}:function_body[0]`,
              conditional: false,
              file: module.file,
              line: assignNode.loc!.start.line,
              parentFunctionId: functionId
            });

            const funcPath = assignPath.get('right') as NodePath<t.FunctionExpression | t.ArrowFunctionExpression>;
            // Enter function scope for semantic ID generation and analyze
            scopeTracker.enterScope(functionName, 'function');
            this.analyzeFunctionBody(funcPath, funcBodyScopeId, module, allCollections);
            scopeTracker.exitScope();
          }

          // Check for indexed array assignment at module level: arr[i] = value
          this.detectIndexedArrayAssignment(assignNode, module, arrayMutations);

          // Check for object property assignment at module level: obj.prop = value
          this.detectObjectPropertyAssignment(assignNode, module, objectMutations, scopeTracker);
        }
      });
      this.profiler.end('traverse_assignments');

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
              stableId: functionId,
              type: 'FUNCTION',
              name: funcName,
              file: module.file,
              line: funcNode.loc!.start.line,
              column: funcNode.loc!.start.column,
              async: funcNode.async || false,
              generator: funcNode.generator || false,
              isCallback: true,
              parentScopeId: module.id
            });

            const callbackScopeId = `SCOPE#${funcName}:body#${module.file}#${funcNode.loc!.start.line}`;
            scopes.push({
              id: callbackScopeId,
              type: 'SCOPE',
              scopeType: 'callback_body',
              name: `${funcName}:body`,
              semanticId: `${funcName}:callback_body[0]`,
              conditional: false,
              file: module.file,
              line: funcNode.loc!.start.line,
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

      // Module-level IfStatements
      this.profiler.start('traverse_ifs');
      traverse(ast, {
        IfStatement: (ifPath: NodePath<t.IfStatement>) => {
          const functionParent = ifPath.getFunctionParent();
          if (functionParent) return;

          const ifNode = ifPath.node;
          const condition = code.substring(ifNode.test.start!, ifNode.test.end!) || 'condition';
          const counterId = ifScopeCounterRef.value++;
          const ifScopeId = `SCOPE#if#${module.file}#${ifNode.loc!.start.line}:${ifNode.loc!.start.column}:${counterId}`;

          const constraints = ConditionParser.parse(ifNode.test);
          const ifSemanticId = this.generateSemanticId('if_statement', scopeTracker);

          scopes.push({
            id: ifScopeId,
            type: 'SCOPE',
            scopeType: 'if_statement',
            name: `if:${ifNode.loc!.start.line}:${ifNode.loc!.start.column}:${counterId}`,
            semanticId: ifSemanticId,
            conditional: true,
            condition,
            constraints: constraints.length > 0 ? constraints : undefined,
            file: module.file,
            line: ifNode.loc!.start.line,
            parentScopeId: module.id
          });

          if (ifNode.alternate && ifNode.alternate.type !== 'IfStatement') {
            const elseCounterId = ifScopeCounterRef.value++;
            const elseScopeId = `SCOPE#else#${module.file}#${ifNode.alternate.loc!.start.line}:${ifNode.alternate.loc!.start.column}:${elseCounterId}`;

            const negatedConstraints = constraints.length > 0 ? ConditionParser.negate(constraints) : undefined;
            const elseSemanticId = this.generateSemanticId('else_statement', scopeTracker);

            scopes.push({
              id: elseScopeId,
              type: 'SCOPE',
              scopeType: 'else_statement',
              name: `else:${ifNode.alternate.loc!.start.line}:${ifNode.alternate.loc!.start.column}:${elseCounterId}`,
              semanticId: elseSemanticId,
              conditional: true,
              constraints: negatedConstraints,
              file: module.file,
              line: ifNode.alternate.loc!.start.line,
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
        variableDeclarations,
        callSites,
        methodCalls,
        eventListeners,
        classInstantiations,
        classDeclarations,
        methodCallbacks,
        callArguments,
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
        // Object/Array literal tracking - use allCollections refs as visitors may have created new arrays
        objectLiterals: allCollections.objectLiterals || objectLiterals,
        arrayLiterals: allCollections.arrayLiterals || arrayLiterals
      });
      this.profiler.end('graph_build');

      nodesCreated = result.nodes;
      edgesCreated = result.edges;

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[JSASTAnalyzer] Error analyzing ${module.file}:`, err.message);
      console.error(err.stack);
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
    parentScopeVariables: Set<{ name: string; id: string; scopeId: string }>
  ): void {
    const varNode = varPath.node;
    const isConst = varNode.kind === 'const';

    varNode.declarations.forEach(declarator => {
      const variables = this.extractVariableNamesFromPattern(declarator.id);

      variables.forEach(varInfo => {
        const literalValue = declarator.init ? ExpressionEvaluator.extractLiteralValue(declarator.init) : null;
        const isLiteral = literalValue !== null;
        const isNewExpression = declarator.init && declarator.init.type === 'NewExpression';

        const shouldBeConstant = isConst && (isLiteral || isNewExpression);
        const nodeType = shouldBeConstant ? 'CONSTANT' : 'VARIABLE';

        // Generate semantic ID (primary) or legacy ID (fallback)
        const legacyId = `${nodeType}#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${varDeclCounterRef.value++}`;

        const varId = scopeTracker
          ? computeSemanticId(nodeType, varInfo.name, scopeTracker.getContext())
          : legacyId;

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

        if (declarator.init) {
          this.trackVariableAssignment(declarator.init, varId, varInfo.name, module, varInfo.loc.start.line, literals, variableAssignments, literalCounterRef);
        }
      });
    });
  }

  private createLoopScopeHandler(
    trackerScopeType: string,
    scopeType: string,
    parentScopeId: string,
    module: VisitorModule,
    scopes: ScopeInfo[],
    scopeCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined
  ): { enter: (path: NodePath<t.Loop>) => void; exit: () => void } {
    return {
      enter: (path: NodePath<t.Loop>) => {
        const node = path.node;
        const scopeId = `SCOPE#${scopeType}#${module.file}#${node.loc!.start.line}:${scopeCounterRef.value++}`;
        const semanticId = this.generateSemanticId(scopeType, scopeTracker);
        scopes.push({
          id: scopeId,
          type: 'SCOPE',
          scopeType,
          semanticId,
          file: module.file,
          line: node.loc!.start.line,
          parentScopeId
        });

        // Enter scope for semantic ID generation
        if (scopeTracker) {
          scopeTracker.enterCountedScope(trackerScopeType);
        }
      },
      exit: () => {
        // Exit scope
        if (scopeTracker) {
          scopeTracker.exitScope();
        }
      }
    };
  }

  /**
   * Process VariableDeclarations within a try/catch/finally block.
   * This is a simplified version that doesn't track parentScopeVariables or class instantiations.
   *
   * @param blockPath - The NodePath for the block to process
   * @param blockScopeId - The scope ID for variables in this block
   * @param module - Module context
   * @param variableDeclarations - Collection to push variable declarations to
   * @param literals - Collection for literal tracking
   * @param variableAssignments - Collection for variable assignment tracking
   * @param varDeclCounterRef - Counter for unique variable declaration IDs
   * @param literalCounterRef - Counter for unique literal IDs
   * @param scopeTracker - Tracker for semantic ID generation
   */
  private processBlockVariables(
    blockPath: NodePath,
    blockScopeId: string,
    module: VisitorModule,
    variableDeclarations: VariableDeclarationInfo[],
    literals: LiteralInfo[],
    variableAssignments: VariableAssignmentInfo[],
    varDeclCounterRef: CounterRef,
    literalCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined
  ): void {
    blockPath.traverse({
      VariableDeclaration: (varPath: NodePath<t.VariableDeclaration>) => {
        const varNode = varPath.node;
        const isConst = varNode.kind === 'const';

        varNode.declarations.forEach(declarator => {
          const variables = this.extractVariableNamesFromPattern(declarator.id);

          variables.forEach(varInfo => {
            const literalValue = declarator.init ? ExpressionEvaluator.extractLiteralValue(declarator.init) : null;
            const isLiteral = literalValue !== null;
            const isNewExpression = declarator.init && declarator.init.type === 'NewExpression';
            const shouldBeConstant = isConst && (isLiteral || isNewExpression);
            const nodeType = shouldBeConstant ? 'CONSTANT' : 'VARIABLE';

            const legacyId = `${nodeType}#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${varDeclCounterRef.value++}`;
            const varId = scopeTracker
              ? computeSemanticId(nodeType, varInfo.name, scopeTracker.getContext())
              : legacyId;

            variableDeclarations.push({
              id: varId,
              type: nodeType,
              name: varInfo.name,
              file: module.file,
              line: varInfo.loc.start.line,
              parentScopeId: blockScopeId
            });

            if (declarator.init) {
              this.trackVariableAssignment(declarator.init, varId, varInfo.name, module, varInfo.loc.start.line, literals, variableAssignments, literalCounterRef);
            }
          });
        });
      }
    });
  }

  /**
   * Handles TryStatement nodes within function bodies.
   * Creates try, catch (with optional error parameter), and finally scopes,
   * and processes variable declarations within each block.
   *
   * @param tryPath - The NodePath for the TryStatement
   * @param parentScopeId - Parent scope ID for the scope nodes
   * @param module - Module context
   * @param scopes - Collection to push scope nodes to
   * @param variableDeclarations - Collection to push variable declarations to
   * @param literals - Collection for literal tracking
   * @param variableAssignments - Collection for variable assignment tracking
   * @param scopeCounterRef - Counter for unique scope IDs
   * @param varDeclCounterRef - Counter for unique variable declaration IDs
   * @param literalCounterRef - Counter for unique literal IDs
   * @param scopeTracker - Tracker for semantic ID generation
   */
  private handleTryStatement(
    tryPath: NodePath<t.TryStatement>,
    parentScopeId: string,
    module: VisitorModule,
    scopes: ScopeInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    literals: LiteralInfo[],
    variableAssignments: VariableAssignmentInfo[],
    scopeCounterRef: CounterRef,
    varDeclCounterRef: CounterRef,
    literalCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined
  ): void {
    const tryNode = tryPath.node;

    // Create and process try block
    const tryScopeId = `SCOPE#try-block#${module.file}#${tryNode.loc!.start.line}:${scopeCounterRef.value++}`;
    const trySemanticId = this.generateSemanticId('try-block', scopeTracker);
    scopes.push({
      id: tryScopeId,
      type: 'SCOPE',
      scopeType: 'try-block',
      semanticId: trySemanticId,
      file: module.file,
      line: tryNode.loc!.start.line,
      parentScopeId
    });

    if (scopeTracker) {
      scopeTracker.enterCountedScope('try');
    }
    this.processBlockVariables(
      tryPath.get('block'),
      tryScopeId,
      module,
      variableDeclarations,
      literals,
      variableAssignments,
      varDeclCounterRef,
      literalCounterRef,
      scopeTracker
    );
    if (scopeTracker) {
      scopeTracker.exitScope();
    }

    // Create and process catch block if present
    if (tryNode.handler) {
      const catchBlock = tryNode.handler;
      const catchScopeId = `SCOPE#catch-block#${module.file}#${catchBlock.loc!.start.line}:${scopeCounterRef.value++}`;
      const catchSemanticId = this.generateSemanticId('catch-block', scopeTracker);

      scopes.push({
        id: catchScopeId,
        type: 'SCOPE',
        scopeType: 'catch-block',
        semanticId: catchSemanticId,
        file: module.file,
        line: catchBlock.loc!.start.line,
        parentScopeId
      });

      if (scopeTracker) {
        scopeTracker.enterCountedScope('catch');
      }

      // Handle catch parameter (e.g., catch (e))
      if (catchBlock.param) {
        const errorVarInfo = this.extractVariableNamesFromPattern(catchBlock.param);

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
            parentScopeId: catchScopeId
          });
        });
      }

      this.processBlockVariables(
        tryPath.get('handler.body'),
        catchScopeId,
        module,
        variableDeclarations,
        literals,
        variableAssignments,
        varDeclCounterRef,
        literalCounterRef,
        scopeTracker
      );

      if (scopeTracker) {
        scopeTracker.exitScope();
      }
    }

    // Create and process finally block if present
    if (tryNode.finalizer) {
      const finallyScopeId = `SCOPE#finally-block#${module.file}#${tryNode.finalizer.loc!.start.line}:${scopeCounterRef.value++}`;
      const finallySemanticId = this.generateSemanticId('finally-block', scopeTracker);

      scopes.push({
        id: finallyScopeId,
        type: 'SCOPE',
        scopeType: 'finally-block',
        semanticId: finallySemanticId,
        file: module.file,
        line: tryNode.finalizer.loc!.start.line,
        parentScopeId
      });

      if (scopeTracker) {
        scopeTracker.enterCountedScope('finally');
      }

      const finalizerPath = tryPath.get('finalizer');
      if (finalizerPath.node) {
        this.processBlockVariables(
          finalizerPath as NodePath,
          finallyScopeId,
          module,
          variableDeclarations,
          literals,
          variableAssignments,
          varDeclCounterRef,
          literalCounterRef,
          scopeTracker
        );
      }

      if (scopeTracker) {
        scopeTracker.exitScope();
      }
    }

    tryPath.skip();
  }

  /**
   * Factory method to create IfStatement handler.
   * Creates if scope with condition parsing and optional else scope.
   * Tracks if/else scope transitions via ifElseScopeMap.
   *
   * @param parentScopeId - Parent scope ID for the scope nodes
   * @param module - Module context
   * @param scopes - Collection to push scope nodes to
   * @param ifScopeCounterRef - Counter for unique if scope IDs
   * @param scopeTracker - Tracker for semantic ID generation
   * @param sourceCode - Source code for extracting condition text
   * @param ifElseScopeMap - Map to track if/else scope transitions
   */
  private createIfStatementHandler(
    parentScopeId: string,
    module: VisitorModule,
    scopes: ScopeInfo[],
    ifScopeCounterRef: CounterRef,
    scopeTracker: ScopeTracker | undefined,
    sourceCode: string,
    ifElseScopeMap: Map<t.IfStatement, { inElse: boolean; hasElse: boolean }>
  ): { enter: (ifPath: NodePath<t.IfStatement>) => void; exit: (ifPath: NodePath<t.IfStatement>) => void } {
    return {
      enter: (ifPath: NodePath<t.IfStatement>) => {
        const ifNode = ifPath.node;
        const condition = sourceCode.substring(ifNode.test.start!, ifNode.test.end!) || 'condition';
        const counterId = ifScopeCounterRef.value++;
        const ifScopeId = `SCOPE#if#${module.file}#${ifNode.loc!.start.line}:${ifNode.loc!.start.column}:${counterId}`;

        // Parse condition to extract constraints
        const constraints = ConditionParser.parse(ifNode.test);
        const ifSemanticId = this.generateSemanticId('if_statement', scopeTracker);

        scopes.push({
          id: ifScopeId,
          type: 'SCOPE',
          scopeType: 'if_statement',
          name: `if:${ifNode.loc!.start.line}:${ifNode.loc!.start.column}:${counterId}`,
          semanticId: ifSemanticId,
          conditional: true,
          condition,
          constraints: constraints.length > 0 ? constraints : undefined,
          file: module.file,
          line: ifNode.loc!.start.line,
          parentScopeId
        });

        // Enter scope for semantic ID generation
        if (scopeTracker) {
          scopeTracker.enterCountedScope('if');
        }

        // Handle else branch if present
        if (ifNode.alternate && !t.isIfStatement(ifNode.alternate)) {
          // Only create else scope for actual else block, not else-if
          const elseCounterId = ifScopeCounterRef.value++;
          const elseScopeId = `SCOPE#else#${module.file}#${ifNode.alternate.loc!.start.line}:${ifNode.alternate.loc!.start.column}:${elseCounterId}`;

          const negatedConstraints = constraints.length > 0 ? ConditionParser.negate(constraints) : undefined;
          const elseSemanticId = this.generateSemanticId('else_statement', scopeTracker);

          scopes.push({
            id: elseScopeId,
            type: 'SCOPE',
            scopeType: 'else_statement',
            name: `else:${ifNode.alternate.loc!.start.line}:${ifNode.alternate.loc!.start.column}:${elseCounterId}`,
            semanticId: elseSemanticId,
            conditional: true,
            constraints: negatedConstraints,
            file: module.file,
            line: ifNode.alternate.loc!.start.line,
            parentScopeId
          });

          // Store info to switch to else scope when we enter alternate
          ifElseScopeMap.set(ifNode, { inElse: false, hasElse: true });
        } else {
          ifElseScopeMap.set(ifNode, { inElse: false, hasElse: false });
        }
      },
      exit: (ifPath: NodePath<t.IfStatement>) => {
        const ifNode = ifPath.node;

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
   * Factory method to create BlockStatement handler for tracking if/else transitions.
   * When entering an else block, switches scope from if to else.
   *
   * @param scopeTracker - Tracker for semantic ID generation
   * @param ifElseScopeMap - Map to track if/else scope transitions
   */
  private createIfElseBlockStatementHandler(
    scopeTracker: ScopeTracker | undefined,
    ifElseScopeMap: Map<t.IfStatement, { inElse: boolean; hasElse: boolean }>
  ): { enter: (blockPath: NodePath<t.BlockStatement>) => void } {
    return {
      enter: (blockPath: NodePath<t.BlockStatement>) => {
        // Check if this block is the alternate of an IfStatement
        const parent = blockPath.parent;
        if (t.isIfStatement(parent) && parent.alternate === blockPath.node) {
          const scopeInfo = ifElseScopeMap.get(parent);
          if (scopeInfo && scopeInfo.hasElse && !scopeInfo.inElse && scopeTracker) {
            // Exit if scope, enter else scope
            scopeTracker.exitScope();
            scopeTracker.enterCountedScope('else');
            scopeInfo.inElse = true;
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
    funcPath: NodePath<t.Function>,
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
    const eventListeners = (collections.eventListeners ?? []) as EventListenerInfo[];
    const methodCallbacks = (collections.methodCallbacks ?? []) as MethodCallbackInfo[];
    const classInstantiations = (collections.classInstantiations ?? []) as ClassInstantiationInfo[];
    const httpRequests = (collections.httpRequests ?? []) as HttpRequestInfo[];
    const literals = (collections.literals ?? []) as LiteralInfo[];
    const variableAssignments = (collections.variableAssignments ?? []) as VariableAssignmentInfo[];
    const ifScopeCounterRef = (collections.ifScopeCounterRef ?? { value: 0 }) as CounterRef;
    const scopeCounterRef = (collections.scopeCounterRef ?? { value: 0 }) as CounterRef;
    const varDeclCounterRef = (collections.varDeclCounterRef ?? { value: 0 }) as CounterRef;
    const callSiteCounterRef = (collections.callSiteCounterRef ?? { value: 0 }) as CounterRef;
    const functionCounterRef = (collections.functionCounterRef ?? { value: 0 }) as CounterRef;
    const httpRequestCounterRef = (collections.httpRequestCounterRef ?? { value: 0 }) as CounterRef;
    const literalCounterRef = (collections.literalCounterRef ?? { value: 0 }) as CounterRef;
    const anonymousFunctionCounterRef = (collections.anonymousFunctionCounterRef ?? { value: 0 }) as CounterRef;
    const scopeTracker = collections.scopeTracker as ScopeTracker | undefined;
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
    const processedVarDecls = processedNodes.varDecls;
    const processedMethodCalls = processedNodes.methodCalls;
    const processedEventListeners = processedNodes.eventListeners;

    // Track if/else scope transitions
    const ifElseScopeMap = new Map<t.IfStatement, { inElse: boolean; hasElse: boolean }>();

    funcPath.traverse({
      VariableDeclaration: (varPath: NodePath<t.VariableDeclaration>) => {
        this.handleVariableDeclaration(
          varPath,
          parentScopeId,
          module,
          variableDeclarations,
          classInstantiations,
          literals,
          variableAssignments,
          varDeclCounterRef,
          literalCounterRef,
          scopeTracker,
          parentScopeVariables
        );
      },

      // Detect indexed array assignments: arr[i] = value
      AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
        const assignNode = assignPath.node;

        // Initialize collection if not exists
        if (!collections.arrayMutations) {
          collections.arrayMutations = [];
        }
        const arrayMutations = collections.arrayMutations as ArrayMutationInfo[];

        // Check for indexed array assignment: arr[i] = value
        this.detectIndexedArrayAssignment(assignNode, module, arrayMutations);

        // Initialize object mutations collection if not exists
        if (!collections.objectMutations) {
          collections.objectMutations = [];
        }
        const objectMutations = collections.objectMutations as ObjectMutationInfo[];

        // Check for object property assignment: obj.prop = value
        this.detectObjectPropertyAssignment(assignNode, module, objectMutations, scopeTracker);
      },

      ForStatement: this.createLoopScopeHandler('for', 'for-loop', parentScopeId, module, scopes, scopeCounterRef, scopeTracker),
      ForInStatement: this.createLoopScopeHandler('for-in', 'for-in-loop', parentScopeId, module, scopes, scopeCounterRef, scopeTracker),
      ForOfStatement: this.createLoopScopeHandler('for-of', 'for-of-loop', parentScopeId, module, scopes, scopeCounterRef, scopeTracker),
      WhileStatement: this.createLoopScopeHandler('while', 'while-loop', parentScopeId, module, scopes, scopeCounterRef, scopeTracker),
      DoWhileStatement: this.createLoopScopeHandler('do-while', 'do-while-loop', parentScopeId, module, scopes, scopeCounterRef, scopeTracker),

      TryStatement: (tryPath: NodePath<t.TryStatement>) => {
        this.handleTryStatement(
          tryPath,
          parentScopeId,
          module,
          scopes,
          variableDeclarations,
          literals,
          variableAssignments,
          scopeCounterRef,
          varDeclCounterRef,
          literalCounterRef,
          scopeTracker
        );
      },

      SwitchStatement: (switchPath: NodePath<t.SwitchStatement>) => {
        const switchNode = switchPath.node;
        const scopeId = `SCOPE#switch-case#${module.file}#${switchNode.loc!.start.line}:${scopeCounterRef.value++}`;
        const semanticId = this.generateSemanticId('switch-case', scopeTracker);

        scopes.push({
          id: scopeId,
          type: 'SCOPE',
          scopeType: 'switch-case',
          semanticId,
          file: module.file,
          line: switchNode.loc!.start.line,
          parentScopeId
        });
      },

      FunctionExpression: (funcPath: NodePath<t.FunctionExpression>) => {
        const node = funcPath.node;
        const funcName = node.id ? node.id.name : this.generateAnonymousName(scopeTracker);
        // Use semantic ID as primary ID when scopeTracker available
        const legacyId = `FUNCTION#${funcName}#${module.file}#${node.loc!.start.line}:${node.loc!.start.column}:${functionCounterRef.value++}`;
        const functionId = scopeTracker
          ? computeSemanticId('FUNCTION', funcName, scopeTracker.getContext())
          : legacyId;

        functions.push({
          id: functionId,
          stableId: functionId,
          type: 'FUNCTION',
          name: funcName,
          file: module.file,
          line: node.loc!.start.line,
          column: node.loc!.start.column,
          async: node.async || false,
          generator: node.generator || false,
          parentScopeId
        });

        const nestedScopeId = `SCOPE#${funcName}:body#${module.file}#${node.loc!.start.line}`;
        const closureSemanticId = this.generateSemanticId('closure', scopeTracker);
        scopes.push({
          id: nestedScopeId,
          type: 'SCOPE',
          scopeType: 'closure',
          name: `${funcName}:body`,
          semanticId: closureSemanticId,
          conditional: false,
          file: module.file,
          line: node.loc!.start.line,
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
        const line = node.loc!.start.line;
        const column = node.loc!.start.column;

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
          stableId: functionId,
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
        }

        arrowPath.skip();
      },

      UpdateExpression: (updatePath: NodePath<t.UpdateExpression>) => {
        const updateNode = updatePath.node;
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
                line: updateNode.loc!.start.line
              });
            }
          }
        }
      },

      // IF statements - создаём условные scope и обходим содержимое для CALL узлов
      IfStatement: this.createIfStatementHandler(
        parentScopeId,
        module,
        scopes,
        ifScopeCounterRef,
        scopeTracker,
        collections.code ?? '',
        ifElseScopeMap
      ),

      // Track when we enter the alternate (else) block of an IfStatement
      BlockStatement: this.createIfElseBlockStatementHandler(scopeTracker, ifElseScopeMap),

      // Function call expressions
      CallExpression: (callPath: NodePath<t.CallExpression>) => {
        this.handleCallExpression(
          callPath.node,
          processedCallSites,
          processedMethodCalls,
          callSites,
          methodCalls,
          module,
          callSiteCounterRef,
          scopeTracker,
          parentScopeId,
          collections
        );
      },

      // NewExpression (constructor calls)
      NewExpression: (newPath: NodePath<t.NewExpression>) => {
        const newNode = newPath.node;

        // Handle simple constructor: new Foo()
        if (newNode.callee.type === 'Identifier') {
          const nodeKey = `new:${newNode.start}:${newNode.end}`;
          if (processedCallSites.has(nodeKey)) {
            return;
          }
          processedCallSites.add(nodeKey);

          // Generate semantic ID (primary) or legacy ID (fallback)
          const constructorName = newNode.callee.name;
          const legacyId = `CALL#new:${constructorName}#${module.file}#${newNode.loc!.start.line}:${newNode.loc!.start.column}:${callSiteCounterRef.value++}`;

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
            line: newNode.loc!.start.line,
            parentScopeId,
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
            const nodeKey = `new:${newNode.start}:${newNode.end}`;
            if (processedMethodCalls.has(nodeKey)) {
              return;
            }
            processedMethodCalls.add(nodeKey);

            const objectName = object.name;
            const constructorName = property.name;
            const fullName = `${objectName}.${constructorName}`;

            // Generate semantic ID for method-style constructor call
            const legacyId = `CALL#new:${fullName}#${module.file}#${newNode.loc!.start.line}:${newNode.loc!.start.column}:${callSiteCounterRef.value++}`;

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
              line: newNode.loc!.start.line,
              column: newNode.loc!.start.column,
              parentScopeId,
              isNew: true
            });
          }
        }
      }
    });
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
    collections: VisitorCollections
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
      const legacyId = `CALL#${calleeName}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`;

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
        line: callNode.loc!.start.line,
        parentScopeId,
        targetFunctionName: calleeName
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
        const legacyId = `CALL#${fullName}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`;

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
          line: callNode.loc!.start.line,
          column: callNode.loc!.start.column,
          parentScopeId
        });

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
    }
  }

  /**
   * Detect array mutation calls (push, unshift, splice) inside functions
   * and collect mutation info for FLOWS_INTO edge creation in GraphBuilder
   *
   * @param callNode - The call expression node
   * @param arrayName - Name of the array being mutated
   * @param method - The mutation method (push, unshift, splice)
   * @param module - Current module being analyzed
   * @param arrayMutations - Collection to push mutation info into
   * @param scopeTracker - Optional scope tracker for semantic IDs
   */
  private detectArrayMutationInFunction(
    callNode: t.CallExpression,
    arrayName: string,
    method: 'push' | 'unshift' | 'splice',
    module: VisitorModule,
    arrayMutations: ArrayMutationInfo[],
    scopeTracker?: ScopeTracker
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
        insertedValues: mutationArgs
      });
    }
  }

  /**
   * Detect indexed array assignment: arr[i] = value
   * Creates ArrayMutationInfo for FLOWS_INTO edge generation in GraphBuilder
   *
   * @param assignNode - The assignment expression node
   * @param module - Current module being analyzed
   * @param arrayMutations - Collection to push mutation info into
   */
  private detectIndexedArrayAssignment(
    assignNode: t.AssignmentExpression,
    module: VisitorModule,
    arrayMutations: ArrayMutationInfo[]
  ): void {
    // Check for indexed array assignment: arr[i] = value
    if (assignNode.left.type === 'MemberExpression' && assignNode.left.computed) {
      const memberExpr = assignNode.left;

      // Only process NumericLiteral keys - those are clearly array indexed assignments
      // e.g., arr[0] = value, arr[1] = value
      // All other computed keys (StringLiteral, Identifier, expressions) are handled as object mutations
      // This avoids duplicate edge creation for ambiguous cases like obj[key] = value
      if (memberExpr.property.type !== 'NumericLiteral') {
        return;
      }

      // Get array name (only simple identifiers for now)
      if (memberExpr.object.type === 'Identifier') {
        const arrayName = memberExpr.object.name;
        const value = assignNode.right;

        const argInfo: ArrayMutationArgument = {
          argIndex: 0,
          isSpread: false,
          valueType: 'EXPRESSION'
        };

        // Determine value type
        const literalValue = ExpressionEvaluator.extractLiteralValue(value);
        if (literalValue !== null) {
          argInfo.valueType = 'LITERAL';
          argInfo.literalValue = literalValue;
        } else if (value.type === 'Identifier') {
          argInfo.valueType = 'VARIABLE';
          argInfo.valueName = value.name;
        } else if (value.type === 'ObjectExpression') {
          argInfo.valueType = 'OBJECT_LITERAL';
        } else if (value.type === 'ArrayExpression') {
          argInfo.valueType = 'ARRAY_LITERAL';
        } else if (value.type === 'CallExpression') {
          argInfo.valueType = 'CALL';
          argInfo.callLine = value.loc?.start.line;
          argInfo.callColumn = value.loc?.start.column;
        }

        // Use defensive loc checks instead of ! assertions
        const line = assignNode.loc?.start.line ?? 0;
        const column = assignNode.loc?.start.column ?? 0;

        arrayMutations.push({
          arrayName,
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

    // Get object name
    let objectName: string;
    if (memberExpr.object.type === 'Identifier') {
      objectName = memberExpr.object.name;
    } else if (memberExpr.object.type === 'ThisExpression') {
      objectName = 'this';
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

    // Generate semantic ID if scopeTracker available
    let mutationId: string | undefined;
    if (scopeTracker) {
      const discriminator = scopeTracker.getItemCounter(`OBJECT_MUTATION:${objectName}.${propertyName}`);
      mutationId = computeSemanticId('OBJECT_MUTATION', `${objectName}.${propertyName}`, scopeTracker.getContext(), { discriminator });
    }

    objectMutations.push({
      id: mutationId,
      objectName,
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
