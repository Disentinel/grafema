/**
 * JSASTAnalyzer - плагин для парсинга JavaScript AST
 * Создаёт ноды: FUNCTION, CLASS, METHOD и т.д.
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
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
import { ConditionParser } from './ast/ConditionParser.js';
import { Profiler } from '../../core/Profiler.js';
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
  CounterRef,
  ProcessedNodes,
  ASTCollections,
  ExtractedVariable,
} from './ast/types.js';

// === LOCAL TYPES ===

/**
 * Context for tracking semantic IDs within a scope hierarchy.
 * Used to generate stable, line-number-independent IDs for SCOPE nodes.
 */
interface ScopeContext {
  semanticPath: string;                    // "ClassName.method" or "funcName"
  siblingCounters: Map<string, number>;    // scopeType → count for this level
}

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
  ifScopeCounterRef: CounterRef;
  scopeCounterRef: CounterRef;
  varDeclCounterRef: CounterRef;
  callSiteCounterRef: CounterRef;
  functionCounterRef: CounterRef;
  httpRequestCounterRef: CounterRef;
  literalCounterRef: CounterRef;
  anonymousFunctionCounterRef: CounterRef;
  processedNodes: ProcessedNodes;
  moduleScopeCtx?: ScopeContext;
  code?: string;
  // VisitorCollections compatibility
  classes: ClassDeclarationInfo[];
  methods: FunctionInfo[];
  variables: VariableDeclarationInfo[];
  sideEffects: unknown[];  // TODO: define SideEffectInfo
  variableCounterRef: CounterRef;
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
  // Use base onProgress type for compatibility
  onProgress?: (info: Record<string, unknown>) => void;
}

export class JSASTAnalyzer extends Plugin {
  private graphBuilder: GraphBuilder;
  private analyzedModules: Set<string>;
  private profiler: Profiler;
  private _cacheCleared: boolean;

  constructor() {
    super();
    this.graphBuilder = new GraphBuilder();
    this.analyzedModules = new Set();
    this.profiler = new Profiler('JSASTAnalyzer');
    this._cacheCleared = false;
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

      if (forceAnalysis && !this._cacheCleared) {
        this.analyzedModules.clear();
        this._cacheCleared = true;
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

      console.log(`[JSASTAnalyzer] Starting parallel analysis of ${modulesToAnalyze.length} modules (${skippedCount} cached)...`);

      if (modulesToAnalyze.length === 0) {
        console.log(`[JSASTAnalyzer] All modules are up-to-date, skipping analysis`);
        return createSuccessResult({ nodes: 0, edges: 0 });
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

      const expressionId = `EXPRESSION#${objectName}.${propertyName}#${module.file}#${line}:${initExpression.start}`;

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
        line: line
      });
      return;
    }

    // 8. BinaryExpression
    if (initExpression.type === 'BinaryExpression') {
      const expressionId = `EXPRESSION#binary#${module.file}#${line}:${initExpression.start}`;

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'BinaryExpression',
        operator: initExpression.operator,
        leftSourceName: initExpression.left.type === 'Identifier' ? initExpression.left.name : null,
        rightSourceName: initExpression.right.type === 'Identifier' ? initExpression.right.name : null,
        file: module.file,
        line: line
      });
      return;
    }

    // 9. ConditionalExpression
    if (initExpression.type === 'ConditionalExpression') {
      const expressionId = `EXPRESSION#conditional#${module.file}#${line}:${initExpression.start}`;

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'ConditionalExpression',
        consequentSourceName: initExpression.consequent.type === 'Identifier' ? initExpression.consequent.name : null,
        alternateSourceName: initExpression.alternate.type === 'Identifier' ? initExpression.alternate.name : null,
        file: module.file,
        line: line
      });

      this.trackVariableAssignment(initExpression.consequent, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef);
      this.trackVariableAssignment(initExpression.alternate, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef);
      return;
    }

    // 10. LogicalExpression
    if (initExpression.type === 'LogicalExpression') {
      const expressionId = `EXPRESSION#logical#${module.file}#${line}:${initExpression.start}`;

      variableAssignments.push({
        variableId,
        sourceType: 'EXPRESSION',
        sourceId: expressionId,
        expressionType: 'LogicalExpression',
        operator: initExpression.operator,
        leftSourceName: initExpression.left.type === 'Identifier' ? initExpression.left.name : null,
        rightSourceName: initExpression.right.type === 'Identifier' ? initExpression.right.name : null,
        file: module.file,
        line: line
      });

      this.trackVariableAssignment(initExpression.left, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef);
      this.trackVariableAssignment(initExpression.right, variableId, variableName, module, line, literals, variableAssignments, literalCounterRef);
      return;
    }

    // 11. TemplateLiteral
    if (initExpression.type === 'TemplateLiteral' && initExpression.expressions.length > 0) {
      const expressionId = `EXPRESSION#template#${module.file}#${line}:${initExpression.start}`;

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
        line: line
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

      const ifScopeCounterRef: CounterRef = { value: 0 };
      const scopeCounterRef: CounterRef = { value: 0 };
      const varDeclCounterRef: CounterRef = { value: 0 };
      const callSiteCounterRef: CounterRef = { value: 0 };
      const functionCounterRef: CounterRef = { value: 0 };
      const httpRequestCounterRef: CounterRef = { value: 0 };
      const literalCounterRef: CounterRef = { value: 0 };
      const anonymousFunctionCounterRef: CounterRef = { value: 0 };

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
        this.trackVariableAssignment.bind(this) as TrackVariableAssignmentCallback
      );
      traverse(ast, variableVisitor.getHandlers());
      this.profiler.end('traverse_variables');

      // Module-level scope context for consistent anonymous naming
      const moduleScopeCtx: ScopeContext = {
        semanticPath: module.name!,
        siblingCounters: new Map()
      };

      const allCollections: Collections = {
        functions, parameters, scopes, variableDeclarations, callSites, methodCalls,
        eventListeners, methodCallbacks, callArguments, classInstantiations, classDeclarations,
        httpRequests, literals, variableAssignments,
        // TypeScript-specific collections
        interfaces, typeAliases, enums, decorators,
        ifScopeCounterRef, scopeCounterRef, varDeclCounterRef,
        callSiteCounterRef, functionCounterRef, httpRequestCounterRef,
        literalCounterRef, anonymousFunctionCounterRef, processedNodes,
        imports, exports, moduleScopeCtx, code,
        // VisitorCollections compatibility
        classes: classDeclarations,
        methods: [],
        variables: variableDeclarations,
        sideEffects: [],
        variableCounterRef: varDeclCounterRef
      };

      // Functions
      this.profiler.start('traverse_functions');
      const functionVisitor = new FunctionVisitor(
        module,
        allCollections,
        this.analyzeFunctionBody.bind(this)
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
            const functionId = `FUNCTION#${functionName}#${module.file}#${assignNode.loc!.start.line}:${assignNode.loc!.start.column}`;

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
            // Create scope context for analyzing the function body
            const funcScopeCtx: ScopeContext = {
              semanticPath: functionName,
              siblingCounters: new Map()
            };
            this.analyzeFunctionBody(funcPath, funcBodyScopeId, module, allCollections, funcScopeCtx);
          }
        }
      });
      this.profiler.end('traverse_assignments');

      // Classes
      this.profiler.start('traverse_classes');
      const classVisitor = new ClassVisitor(
        module,
        allCollections,
        this.analyzeFunctionBody.bind(this)
      );
      traverse(ast, classVisitor.getHandlers());
      this.profiler.end('traverse_classes');

      // TypeScript-specific constructs (interfaces, type aliases, enums)
      this.profiler.start('traverse_typescript');
      const typescriptVisitor = new TypeScriptVisitor(module, allCollections);
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
            const funcName = funcNode.id ? funcNode.id.name : this.generateAnonymousName(moduleScopeCtx);
            const functionId = `FUNCTION#${funcName}#${module.file}#${funcNode.loc!.start.line}:${funcNode.loc!.start.column}`;

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

            // Create scope context for analyzing the callback body
            const callbackScopeCtx: ScopeContext = {
              semanticPath: funcName,
              siblingCounters: new Map()
            };
            this.analyzeFunctionBody(funcPath, callbackScopeId, module, allCollections, callbackScopeCtx);
            funcPath.skip();
          }
        }
      });
      this.profiler.end('traverse_callbacks');

      // Call expressions
      this.profiler.start('traverse_calls');
      const callExpressionVisitor = new CallExpressionVisitor(module, allCollections);
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
          const ifSemanticId = this.generateSemanticId('if_statement', moduleScopeCtx);

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
            const elseSemanticId = this.generateSemanticId('else_statement', moduleScopeCtx);

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
        decorators
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
   * Helper to generate semantic ID for a scope and update counters
   */
  private generateSemanticId(
    scopeType: string,
    scopeCtx: ScopeContext | undefined
  ): string | undefined {
    if (!scopeCtx) return undefined;

    const siblingIndex = scopeCtx.siblingCounters.get(scopeType) || 0;
    scopeCtx.siblingCounters.set(scopeType, siblingIndex + 1);
    return `${scopeCtx.semanticPath}:${scopeType}[${siblingIndex}]`;
  }

  /**
   * Helper to create child scope context from a semantic ID
   */
  private createChildScopeContext(semanticId: string | undefined): ScopeContext | undefined {
    if (!semanticId) return undefined;
    return {
      semanticPath: semanticId,
      siblingCounters: new Map()
    };
  }

  /**
   * Generate a unique anonymous function name within the current scope
   * Uses scopeCtx.siblingCounters to ensure stability across JS/TS versions
   */
  private generateAnonymousName(scopeCtx: ScopeContext | undefined): string {
    if (!scopeCtx) return 'anonymous';
    const index = scopeCtx.siblingCounters.get('anonymous') || 0;
    scopeCtx.siblingCounters.set('anonymous', index + 1);
    return `anonymous[${index}]`;
  }

  /**
   * Анализирует тело функции и извлекает переменные, вызовы, условные блоки
   */
  analyzeFunctionBody(
    funcPath: NodePath<t.Function>,
    parentScopeId: string,
    module: VisitorModule,
    collections: VisitorCollections,
    scopeCtx?: ScopeContext
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

    funcPath.traverse({
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

            const varId = shouldBeConstant
              ? `CONSTANT#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${varDeclCounterRef.value++}`
              : `VARIABLE#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${varDeclCounterRef.value++}`;

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
      },

      ForStatement: (forPath: NodePath<t.ForStatement>) => {
        const forNode = forPath.node;
        const scopeId = `SCOPE#for-loop#${module.file}#${forNode.loc!.start.line}:${scopeCounterRef.value++}`;
        const semanticId = this.generateSemanticId('for-loop', scopeCtx);
        scopes.push({
          id: scopeId,
          type: 'SCOPE',
          scopeType: 'for-loop',
          semanticId,
          file: module.file,
          line: forNode.loc!.start.line,
          parentScopeId
        });
      },

      ForInStatement: (forPath: NodePath<t.ForInStatement>) => {
        const forNode = forPath.node;
        const scopeId = `SCOPE#for-in-loop#${module.file}#${forNode.loc!.start.line}:${scopeCounterRef.value++}`;
        const semanticId = this.generateSemanticId('for-in-loop', scopeCtx);
        scopes.push({
          id: scopeId,
          type: 'SCOPE',
          scopeType: 'for-in-loop',
          semanticId,
          file: module.file,
          line: forNode.loc!.start.line,
          parentScopeId
        });
      },

      ForOfStatement: (forPath: NodePath<t.ForOfStatement>) => {
        const forNode = forPath.node;
        const scopeId = `SCOPE#for-of-loop#${module.file}#${forNode.loc!.start.line}:${scopeCounterRef.value++}`;
        const semanticId = this.generateSemanticId('for-of-loop', scopeCtx);
        scopes.push({
          id: scopeId,
          type: 'SCOPE',
          scopeType: 'for-of-loop',
          semanticId,
          file: module.file,
          line: forNode.loc!.start.line,
          parentScopeId
        });
      },

      WhileStatement: (whilePath: NodePath<t.WhileStatement>) => {
        const whileNode = whilePath.node;
        const scopeId = `SCOPE#while-loop#${module.file}#${whileNode.loc!.start.line}:${scopeCounterRef.value++}`;
        const semanticId = this.generateSemanticId('while-loop', scopeCtx);
        scopes.push({
          id: scopeId,
          type: 'SCOPE',
          scopeType: 'while-loop',
          semanticId,
          file: module.file,
          line: whileNode.loc!.start.line,
          parentScopeId
        });
      },

      DoWhileStatement: (doPath: NodePath<t.DoWhileStatement>) => {
        const doNode = doPath.node;
        const scopeId = `SCOPE#do-while-loop#${module.file}#${doNode.loc!.start.line}:${scopeCounterRef.value++}`;
        const semanticId = this.generateSemanticId('do-while-loop', scopeCtx);
        scopes.push({
          id: scopeId,
          type: 'SCOPE',
          scopeType: 'do-while-loop',
          semanticId,
          file: module.file,
          line: doNode.loc!.start.line,
          parentScopeId
        });
      },

      TryStatement: (tryPath: NodePath<t.TryStatement>) => {
        const tryNode = tryPath.node;

        const tryScopeId = `SCOPE#try-block#${module.file}#${tryNode.loc!.start.line}:${scopeCounterRef.value++}`;
        const trySemanticId = this.generateSemanticId('try-block', scopeCtx);
        scopes.push({
          id: tryScopeId,
          type: 'SCOPE',
          scopeType: 'try-block',
          semanticId: trySemanticId,
          file: module.file,
          line: tryNode.loc!.start.line,
          parentScopeId
        });

        if (tryNode.handler) {
          const catchBlock = tryNode.handler;
          const catchScopeId = `SCOPE#catch-block#${module.file}#${catchBlock.loc!.start.line}:${scopeCounterRef.value++}`;
          const catchSemanticId = this.generateSemanticId('catch-block', scopeCtx);

          scopes.push({
            id: catchScopeId,
            type: 'SCOPE',
            scopeType: 'catch-block',
            semanticId: catchSemanticId,
            file: module.file,
            line: catchBlock.loc!.start.line,
            parentScopeId
          });

          if (catchBlock.param) {
            const errorVarInfo = this.extractVariableNamesFromPattern(catchBlock.param);

            errorVarInfo.forEach(varInfo => {
              const varId = `VARIABLE#${varInfo.name}#${module.file}#${varInfo.loc.start.line}:${varInfo.loc.start.column}:${varDeclCounterRef.value++}`;

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
        }

        if (tryNode.finalizer) {
          const finallyScopeId = `SCOPE#finally-block#${module.file}#${tryNode.finalizer.loc!.start.line}:${scopeCounterRef.value++}`;
          const finallySemanticId = this.generateSemanticId('finally-block', scopeCtx);

          scopes.push({
            id: finallyScopeId,
            type: 'SCOPE',
            scopeType: 'finally-block',
            semanticId: finallySemanticId,
            file: module.file,
            line: tryNode.finalizer.loc!.start.line,
            parentScopeId
          });
        }
      },

      SwitchStatement: (switchPath: NodePath<t.SwitchStatement>) => {
        const switchNode = switchPath.node;
        const scopeId = `SCOPE#switch-case#${module.file}#${switchNode.loc!.start.line}:${scopeCounterRef.value++}`;
        const semanticId = this.generateSemanticId('switch-case', scopeCtx);

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
        const funcName = node.id ? node.id.name : this.generateAnonymousName(scopeCtx);
        const functionId = `FUNCTION#${funcName}#${module.file}#${node.loc!.start.line}:${node.loc!.start.column}:${functionCounterRef.value++}`;

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
        const closureSemanticId = this.generateSemanticId('closure', scopeCtx);
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

        // For nested function, create new context with function name as semantic path
        const nestedFuncCtx: ScopeContext = {
          semanticPath: scopeCtx ? `${scopeCtx.semanticPath}.${funcName}` : funcName,
          siblingCounters: new Map()
        };
        this.analyzeFunctionBody(funcPath, nestedScopeId, module, collections, nestedFuncCtx);
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
          funcName = this.generateAnonymousName(scopeCtx);
        }

        const functionId = `FUNCTION#${funcName}:${line}:${column}:${functionCounterRef.value++}`;

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
          const arrowSemanticId = this.generateSemanticId('arrow_body', scopeCtx);
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

          // For arrow function, create new context with function name as semantic path
          const arrowFuncCtx: ScopeContext = {
            semanticPath: scopeCtx ? `${scopeCtx.semanticPath}.${funcName}` : funcName,
            siblingCounters: new Map()
          };
          this.analyzeFunctionBody(arrowPath, nestedScopeId, module, collections, arrowFuncCtx);
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
      IfStatement: (ifPath: NodePath<t.IfStatement>) => {
        const ifNode = ifPath.node;
        const sourceCode = collections.code ?? '';
        const condition = sourceCode.substring(ifNode.test.start!, ifNode.test.end!) || 'condition';
        const counterId = ifScopeCounterRef.value++;
        const ifScopeId = `SCOPE#if#${module.file}#${ifNode.loc!.start.line}:${ifNode.loc!.start.column}:${counterId}`;

        // Parse condition to extract constraints
        const constraints = ConditionParser.parse(ifNode.test);
        const ifSemanticId = this.generateSemanticId('if_statement', scopeCtx);

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

        // Обходим содержимое if-блока (consequent)
        ifPath.get('consequent').traverse({
          CallExpression: (callPath: NodePath<t.CallExpression>) => {
            const callNode = callPath.node;
            if (callNode.callee.type === 'Identifier') {
              const nodeKey = `${callNode.start}:${callNode.end}`;
              if (processedCallSites.has(nodeKey)) {
                return;
              }
              processedCallSites.add(nodeKey);

              callSites.push({
                id: `CALL#${callNode.callee.name}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`,
                type: 'CALL',
                name: callNode.callee.name,
                file: module.file,
                line: callNode.loc!.start.line,
                parentScopeId: ifScopeId,
                targetFunctionName: callNode.callee.name
              });
            }
          },
          NewExpression: (newPath: NodePath<t.NewExpression>) => {
            const newNode = newPath.node;
            if (newNode.callee.type === 'Identifier') {
              const nodeKey = `new:${newNode.start}:${newNode.end}`;
              if (processedCallSites.has(nodeKey)) {
                return;
              }
              processedCallSites.add(nodeKey);

              callSites.push({
                id: `CALL#new:${newNode.callee.name}#${module.file}#${newNode.loc!.start.line}:${newNode.loc!.start.column}:${callSiteCounterRef.value++}`,
                type: 'CALL',
                name: newNode.callee.name,
                file: module.file,
                line: newNode.loc!.start.line,
                parentScopeId: ifScopeId,
                targetFunctionName: newNode.callee.name,
                isNew: true
              });
            }
          }
        });

        // Handle else branch if present
        if (ifNode.alternate) {
          const elseCounterId = ifScopeCounterRef.value++;
          const elseScopeId = `SCOPE#else#${module.file}#${ifNode.alternate.loc!.start.line}:${ifNode.alternate.loc!.start.column}:${elseCounterId}`;

          // Negate constraints for else branch
          const negatedConstraints = constraints.length > 0 ? ConditionParser.negate(constraints) : undefined;
          const elseSemanticId = this.generateSemanticId('else_statement', scopeCtx);

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

          // Traverse else block
          ifPath.get('alternate').traverse({
            CallExpression: (callPath: NodePath<t.CallExpression>) => {
              const callNode = callPath.node;
              if (callNode.callee.type === 'Identifier') {
                const nodeKey = `${callNode.start}:${callNode.end}`;
                if (processedCallSites.has(nodeKey)) {
                  return;
                }
                processedCallSites.add(nodeKey);

                callSites.push({
                  id: `CALL#${callNode.callee.name}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`,
                  type: 'CALL',
                  name: callNode.callee.name,
                  file: module.file,
                  line: callNode.loc!.start.line,
                  parentScopeId: elseScopeId,
                  targetFunctionName: callNode.callee.name
                });
              }
            },
            NewExpression: (newPath: NodePath<t.NewExpression>) => {
              const newNode = newPath.node;
              if (newNode.callee.type === 'Identifier') {
                const nodeKey = `new:${newNode.start}:${newNode.end}`;
                if (processedCallSites.has(nodeKey)) {
                  return;
                }
                processedCallSites.add(nodeKey);

                callSites.push({
                  id: `CALL#new:${newNode.callee.name}#${module.file}#${newNode.loc!.start.line}:${newNode.loc!.start.column}:${callSiteCounterRef.value++}`,
                  type: 'CALL',
                  name: newNode.callee.name,
                  file: module.file,
                  line: newNode.loc!.start.line,
                  parentScopeId: elseScopeId,
                  targetFunctionName: newNode.callee.name,
                  isNew: true
                });
              }
            }
          });
        }

        // Останавливаем дальнейший обход, чтобы не обрабатывать вызовы дважды
        ifPath.skip();
      },

      // Вызовы функций на безусловном уровне (вне if/for/while)
      CallExpression: (callPath: NodePath<t.CallExpression>) => {
        // Проверяем что вызов не внутри if/for/while (их мы обрабатываем отдельно)
        const parent = callPath.parent;
        if (parent.type !== 'IfStatement' && parent.type !== 'ForStatement' && parent.type !== 'WhileStatement') {
          const callNode = callPath.node;

          // Обычные вызовы функций (greet(), main())
          if (callNode.callee.type === 'Identifier') {
            const nodeKey = `${callNode.start}:${callNode.end}`;
            if (processedCallSites.has(nodeKey)) {
              return;
            }
            processedCallSites.add(nodeKey);

            callSites.push({
              id: `CALL#${callNode.callee.name}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`,
              type: 'CALL',
              name: callNode.callee.name,
              file: module.file,
              line: callNode.loc!.start.line,
              parentScopeId,
              targetFunctionName: callNode.callee.name
            });
          }
        }
      },

      // NewExpression на безусловном уровне
      NewExpression: (newPath: NodePath<t.NewExpression>) => {
        const parent = newPath.parent;
        if (parent.type !== 'IfStatement' && parent.type !== 'ForStatement' && parent.type !== 'WhileStatement') {
          const newNode = newPath.node;
          if (newNode.callee.type === 'Identifier') {
            const nodeKey = `new:${newNode.start}:${newNode.end}`;
            if (processedCallSites.has(nodeKey)) {
              return;
            }
            processedCallSites.add(nodeKey);

            callSites.push({
              id: `CALL#new:${newNode.callee.name}#${module.file}#${newNode.loc!.start.line}:${newNode.loc!.start.column}:${callSiteCounterRef.value++}`,
              type: 'CALL',
              name: newNode.callee.name,
              file: module.file,
              line: newNode.loc!.start.line,
              parentScopeId,
              targetFunctionName: newNode.callee.name,
              isNew: true
            });
          }
        }
      }
    });
  }
}
