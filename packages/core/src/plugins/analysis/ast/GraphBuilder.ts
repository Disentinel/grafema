/**
 * GraphBuilder - создание узлов и рёбер графа из собранных AST данных
 * OPTIMIZED: Uses batched writes to reduce FFI overhead
 */

import { dirname, resolve, basename } from 'path';
import type { GraphBackend } from '@grafema/types';
import { ImportNode } from '../../../core/nodes/ImportNode.js';
import { InterfaceNode, type InterfaceNodeRecord } from '../../../core/nodes/InterfaceNode.js';
import { EnumNode, type EnumNodeRecord } from '../../../core/nodes/EnumNode.js';
import { DecoratorNode } from '../../../core/nodes/DecoratorNode.js';
import { NetworkRequestNode } from '../../../core/nodes/NetworkRequestNode.js';
import { NodeFactory } from '../../../core/NodeFactory.js';
import { computeSemanticId } from '../../../core/SemanticId.js';
import type {
  ModuleNode,
  FunctionInfo,
  ParameterInfo,
  ScopeInfo,
  BranchInfo,
  CaseInfo,
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
  ArrayMutationInfo,
  ObjectMutationInfo,
  ObjectLiteralInfo,
  ObjectPropertyInfo,
  ArrayLiteralInfo,
  ASTCollections,
  GraphNode,
  GraphEdge,
  BuildResult,
} from './types.js';

export class GraphBuilder {
  // Track singleton nodes to avoid duplicates (net:stdio, net:request, etc.)
  private _createdSingletons: Set<string> = new Set();

  // Batching buffers for optimized writes
  private _nodeBuffer: GraphNode[] = [];
  private _edgeBuffer: GraphEdge[] = [];

  /**
   * Buffer a node for batched writing
   */
  private _bufferNode(node: GraphNode): void {
    this._nodeBuffer.push(node);
  }

  /**
   * Buffer an edge for batched writing
   */
  private _bufferEdge(edge: GraphEdge): void {
    this._edgeBuffer.push(edge);
  }

  /**
   * Flush all buffered nodes to the graph
   */
  private async _flushNodes(graph: GraphBackend): Promise<number> {
    if (this._nodeBuffer.length > 0) {
      // Cast to unknown first since GraphNode is more permissive than NodeRecord
      await graph.addNodes(this._nodeBuffer as unknown as import('@grafema/types').NodeRecord[]);
      const count = this._nodeBuffer.length;
      this._nodeBuffer = [];
      return count;
    }
    return 0;
  }

  /**
   * Flush all buffered edges to the graph
   * Note: skip_validation=true because nodes were just flushed
   */
  private async _flushEdges(graph: GraphBackend): Promise<number> {
    if (this._edgeBuffer.length > 0) {
      await (graph as GraphBackend & { addEdges(e: GraphEdge[], skip?: boolean): Promise<void> }).addEdges(this._edgeBuffer, true /* skip_validation */);
      const count = this._edgeBuffer.length;
      this._edgeBuffer = [];
      return count;
    }
    return 0;
  }

  /**
   * Создаёт ноды и рёбра в графе (BATCHED VERSION)
   */
  async build(module: ModuleNode, graph: GraphBackend, projectPath: string, data: ASTCollections): Promise<BuildResult> {
    const {
      functions,
      parameters = [],
      scopes,
      // Branching
      branches = [],
      cases = [],
      variableDeclarations,
      callSites,
      methodCalls = [],
      eventListeners = [],
      classInstantiations = [],
      constructorCalls = [],
      classDeclarations = [],
      methodCallbacks = [],
      callArguments = [],
      imports = [],
      exports = [],
      httpRequests = [],
      literals = [],
      variableAssignments = [],
      // TypeScript-specific collections
      interfaces = [],
      typeAliases = [],
      enums = [],
      decorators = [],
      // Array mutation tracking for FLOWS_INTO edges
      arrayMutations = [],
      // Object mutation tracking for FLOWS_INTO edges
      objectMutations = [],
      // Object/Array literal tracking
      objectLiterals = [],
      objectProperties = [],
      arrayLiterals = []
    } = data;

    // Reset buffers for this build
    this._nodeBuffer = [];
    this._edgeBuffer = [];

    // 1. Buffer all functions (without edges)
    for (const func of functions) {
      const { parentScopeId, ...funcData } = func;
      this._bufferNode(funcData as GraphNode);
    }

    // 2. Buffer all SCOPE (without edges)
    for (const scope of scopes) {
      const { parentFunctionId, parentScopeId, capturesFrom, modifies, ...scopeData } = scope;
      this._bufferNode(scopeData as GraphNode);
    }

    // 2.5. Buffer BRANCH nodes
    // Note: parentScopeId is kept on node for query support (REG-275 test requirement)
    for (const branch of branches) {
      const { discriminantExpressionId, discriminantExpressionType, discriminantLine, discriminantColumn, ...branchData } = branch;
      this._bufferNode(branchData as GraphNode);
    }

    // 2.6. Buffer CASE nodes
    for (const caseInfo of cases) {
      const { parentBranchId, ...caseData } = caseInfo;
      this._bufferNode(caseData as GraphNode);
    }

    // 3. Buffer variables
    for (const varDecl of variableDeclarations) {
      const { parentScopeId, ...varData } = varDecl;
      this._bufferNode(varData as GraphNode);
    }

    // 3.5. Buffer PARAMETER nodes and HAS_PARAMETER edges
    for (const param of parameters) {
      const { functionId, ...paramData } = param;
      // Keep parentFunctionId on the node for queries
      this._bufferNode(paramData as GraphNode);

      if (param.parentFunctionId) {
        this._bufferEdge({
          type: 'HAS_PARAMETER',
          src: param.parentFunctionId,
          dst: param.id,
          index: param.index
        });
      }
    }

    // 4. Buffer CALL_SITE
    for (const callSite of callSites) {
      const { parentScopeId, targetFunctionName, ...callData } = callSite;
      this._bufferNode(callData as GraphNode);
    }

    // 4.5 Buffer CONSTRUCTOR_CALL nodes
    for (const constructorCall of constructorCalls) {
      this._bufferNode({
        id: constructorCall.id,
        type: constructorCall.type,
        name: `new ${constructorCall.className}()`,
        className: constructorCall.className,
        isBuiltin: constructorCall.isBuiltin,
        file: constructorCall.file,
        line: constructorCall.line,
        column: constructorCall.column
      } as GraphNode);
    }

    // 5. Buffer edges for functions
    this.bufferFunctionEdges(module, functions);

    // 6. Buffer edges for SCOPE
    this.bufferScopeEdges(scopes, variableDeclarations);

    // 6.5. Buffer edges for BRANCH (needs callSites for CallExpression discriminant lookup)
    this.bufferBranchEdges(branches, callSites);

    // 6.6. Buffer edges for CASE
    this.bufferCaseEdges(cases);

    // 6.7. Buffer EXPRESSION nodes for switch discriminants (needs callSites for CallExpression)
    this.bufferDiscriminantExpressions(branches, callSites);

    // 7. Buffer edges for variables
    this.bufferVariableEdges(variableDeclarations);

    // 8. Buffer edges for CALL_SITE
    this.bufferCallSiteEdges(callSites, functions);

    // 9. Buffer METHOD_CALL nodes and CONTAINS edges
    this.bufferMethodCalls(methodCalls);

    // 10. Buffer net:stdio and WRITES_TO edges for console.log/error
    this.bufferStdioNodes(methodCalls);

    // 11. Buffer CLASS nodes for class declarations and CONTAINS edges
    this.bufferClassDeclarationNodes(classDeclarations);

    // 12. Buffer CLASS nodes and INSTANCE_OF edges for NewExpression
    this.bufferClassNodes(module, classInstantiations, classDeclarations);

    // 13. Buffer PASSES_ARGUMENT edges (METHOD_CALL -> FUNCTION)
    this.bufferCallbackEdges(methodCallbacks, functions);

    // 14. Buffer IMPORT nodes
    this.bufferImportNodes(module, imports);

    // 15. Buffer EXPORT nodes
    this.bufferExportNodes(module, exports);

    // 16. Buffer EVENT_LISTENER nodes and HANDLED_BY edges
    this.bufferEventListeners(eventListeners, functions);

    // 17. Buffer HTTP requests
    this.bufferHttpRequests(httpRequests, functions);

    // 18. Buffer LITERAL nodes
    this.bufferLiterals(literals);

    // 18.5. Buffer OBJECT_LITERAL nodes (moved before bufferArgumentEdges)
    this.bufferObjectLiteralNodes(objectLiterals);

    // 18.6. Buffer ARRAY_LITERAL nodes (moved before bufferArgumentEdges)
    this.bufferArrayLiteralNodes(arrayLiterals);

    // 18.7. Buffer HAS_PROPERTY edges (OBJECT_LITERAL -> property values)
    this.bufferObjectPropertyEdges(objectProperties);

    // 19. Buffer ASSIGNED_FROM edges for data flow (some need to create EXPRESSION nodes)
    this.bufferAssignmentEdges(variableAssignments, variableDeclarations, callSites, methodCalls, functions, classInstantiations, parameters);

    // 20. Buffer PASSES_ARGUMENT edges (CALL -> argument)
    this.bufferArgumentEdges(callArguments, variableDeclarations, functions, callSites, methodCalls);

    // 21. Buffer INTERFACE nodes and EXTENDS edges
    this.bufferInterfaceNodes(module, interfaces);

    // 22. Buffer TYPE nodes
    this.bufferTypeAliasNodes(module, typeAliases);

    // 23. Buffer ENUM nodes
    this.bufferEnumNodes(module, enums);

    // 24. Buffer DECORATOR nodes and DECORATED_BY edges
    this.bufferDecoratorNodes(decorators);

    // 25. Buffer IMPLEMENTS edges (CLASS -> INTERFACE)
    this.bufferImplementsEdges(classDeclarations, interfaces);

    // 26. Buffer FLOWS_INTO edges for array mutations (push, unshift, splice, indexed assignment)
    this.bufferArrayMutationEdges(arrayMutations, variableDeclarations, parameters);

    // 27. Buffer FLOWS_INTO edges for object mutations (property assignment, Object.assign)
    // REG-152: Now includes classDeclarations for this.prop = value patterns
    this.bufferObjectMutationEdges(objectMutations, variableDeclarations, parameters, functions, classDeclarations);

    // FLUSH: Write all nodes first, then edges in single batch calls
    const nodesCreated = await this._flushNodes(graph);
    const edgesCreated = await this._flushEdges(graph);

    // Handle async operations for ASSIGNED_FROM with CLASS lookups
    const classAssignmentEdges = await this.createClassAssignmentEdges(variableAssignments, graph);

    return { nodes: nodesCreated, edges: edgesCreated + classAssignmentEdges };
  }

  // ============= BUFFERED METHODS (synchronous, no awaits) =============

  private bufferFunctionEdges(module: ModuleNode, functions: FunctionInfo[]): void {
    for (const func of functions) {
      const { parentScopeId, ...funcData } = func;

      // MODULE -> CONTAINS -> FUNCTION (для функций верхнего уровня)
      // или SCOPE -> CONTAINS -> FUNCTION (для вложенных функций)
      if (parentScopeId) {
        this._bufferEdge({
          type: 'CONTAINS',
          src: parentScopeId,
          dst: funcData.id
        });
      } else {
        this._bufferEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: funcData.id
        });
      }
    }
  }

  private bufferScopeEdges(scopes: ScopeInfo[], variableDeclarations: VariableDeclarationInfo[]): void {
    for (const scope of scopes) {
      const { parentFunctionId, parentScopeId, capturesFrom, modifies, ...scopeData } = scope;

      // FUNCTION -> HAS_SCOPE -> SCOPE (для function_body)
      if (parentFunctionId) {
        this._bufferEdge({
          type: 'HAS_SCOPE',
          src: parentFunctionId,
          dst: scopeData.id
        });
      }

      // SCOPE -> CONTAINS -> SCOPE (для вложенных scope, типа if внутри function)
      if (parentScopeId) {
        this._bufferEdge({
          type: 'CONTAINS',
          src: parentScopeId,
          dst: scopeData.id
        });
      }

      // CAPTURES - замыкания захватывают переменные из родительского scope
      if (capturesFrom && scopeData.scopeType === 'closure') {
        const parentVars = variableDeclarations.filter(v => v.parentScopeId === capturesFrom);
        for (const parentVar of parentVars) {
          this._bufferEdge({
            type: 'CAPTURES',
            src: scopeData.id,
            dst: parentVar.id
          });
        }
      }

      // MODIFIES - scope модифицирует переменные (count++)
      if (modifies && modifies.length > 0) {
        for (const mod of modifies) {
          this._bufferEdge({
            type: 'MODIFIES',
            src: scopeData.id,
            dst: mod.variableId
          });
        }
      }
    }
  }

  /**
   * Buffer BRANCH edges (CONTAINS, HAS_CONDITION)
   *
   * REG-275: For CallExpression discriminants (switch(getType())), looks up the
   * actual CALL_SITE node by coordinates since the CALL_SITE uses semantic IDs.
   */
  private bufferBranchEdges(branches: BranchInfo[], callSites: CallSiteInfo[]): void {
    for (const branch of branches) {
      // Parent SCOPE -> CONTAINS -> BRANCH
      if (branch.parentScopeId) {
        this._bufferEdge({
          type: 'CONTAINS',
          src: branch.parentScopeId,
          dst: branch.id
        });
      }

      // BRANCH -> HAS_CONDITION -> EXPRESSION/CALL (discriminant)
      if (branch.discriminantExpressionId) {
        let targetId = branch.discriminantExpressionId;

        // For CallExpression discriminants, look up the actual CALL_SITE by coordinates
        // because CALL_SITE uses semantic IDs that don't match the generated ID
        if (branch.discriminantExpressionType === 'CallExpression' && branch.discriminantLine && branch.discriminantColumn !== undefined) {
          const callSite = callSites.find(cs =>
            cs.file === branch.file &&
            cs.line === branch.discriminantLine &&
            cs.column === branch.discriminantColumn
          );
          if (callSite) {
            targetId = callSite.id;
          }
        }

        this._bufferEdge({
          type: 'HAS_CONDITION',
          src: branch.id,
          dst: targetId
        });
      }
    }
  }

  /**
   * Buffer CASE edges (HAS_CASE, HAS_DEFAULT)
   */
  private bufferCaseEdges(cases: CaseInfo[]): void {
    for (const caseInfo of cases) {
      // BRANCH -> HAS_CASE or HAS_DEFAULT -> CASE
      const edgeType = caseInfo.isDefault ? 'HAS_DEFAULT' : 'HAS_CASE';
      this._bufferEdge({
        type: edgeType,
        src: caseInfo.parentBranchId,
        dst: caseInfo.id
      });
    }
  }

  /**
   * Buffer EXPRESSION nodes for switch discriminants
   * Uses stored metadata directly instead of parsing from ID (Linus improvement)
   *
   * REG-275: For CallExpression discriminants, we don't create nodes here since
   * bufferBranchEdges links to the existing CALL_SITE node by coordinates.
   */
  private bufferDiscriminantExpressions(branches: BranchInfo[], callSites: CallSiteInfo[]): void {
    for (const branch of branches) {
      if (branch.discriminantExpressionId && branch.discriminantExpressionType) {
        // Skip CallExpression - we link to existing CALL_SITE in bufferBranchEdges
        if (branch.discriminantExpressionType === 'CallExpression') {
          continue;
        }

        // Only create if it looks like an EXPRESSION ID
        if (branch.discriminantExpressionId.includes(':EXPRESSION:')) {
          this._bufferNode({
            id: branch.discriminantExpressionId,
            type: 'EXPRESSION',
            name: branch.discriminantExpressionType,
            file: branch.file,
            line: branch.discriminantLine,
            column: branch.discriminantColumn,
            expressionType: branch.discriminantExpressionType
          });
        }
      }
    }
  }

  private bufferVariableEdges(variableDeclarations: VariableDeclarationInfo[]): void {
    for (const varDecl of variableDeclarations) {
      const { parentScopeId, ...varData } = varDecl;

      // SCOPE -> DECLARES -> VARIABLE
      this._bufferEdge({
        type: 'DECLARES',
        src: parentScopeId as string,
        dst: varData.id
      });
    }
  }

  private bufferCallSiteEdges(callSites: CallSiteInfo[], functions: FunctionInfo[]): void {
    for (const callSite of callSites) {
      const { parentScopeId, targetFunctionName, ...callData } = callSite;

      // SCOPE -> CONTAINS -> CALL_SITE
      this._bufferEdge({
        type: 'CONTAINS',
        src: parentScopeId as string,
        dst: callData.id
      });

      // CALL_SITE -> CALLS -> FUNCTION
      const targetFunction = functions.find(f => f.name === targetFunctionName);
      if (targetFunction) {
        this._bufferEdge({
          type: 'CALLS',
          src: callData.id,
          dst: targetFunction.id
        });
      }
    }
  }

  private bufferMethodCalls(methodCalls: MethodCallInfo[]): void {
    for (const methodCall of methodCalls) {
      const { parentScopeId, ...methodData } = methodCall;

      // Buffer METHOD_CALL node
      this._bufferNode(methodData as GraphNode);

      // SCOPE -> CONTAINS -> METHOD_CALL
      this._bufferEdge({
        type: 'CONTAINS',
        src: parentScopeId as string,
        dst: methodData.id
      });
    }
  }

  private bufferStdioNodes(methodCalls: MethodCallInfo[]): void {
    const consoleIOMethods = methodCalls.filter(mc =>
      (mc.object === 'console' && (mc.method === 'log' || mc.method === 'error'))
    );

    if (consoleIOMethods.length > 0) {
      const stdioNode = NodeFactory.createExternalStdio();

      // Buffer net:stdio node only once (singleton)
      if (!this._createdSingletons.has(stdioNode.id)) {
        this._bufferNode(stdioNode as unknown as GraphNode);
        this._createdSingletons.add(stdioNode.id);
      }

      // Buffer WRITES_TO edges for console.log/error
      for (const methodCall of consoleIOMethods) {
        this._bufferEdge({
          type: 'WRITES_TO',
          src: methodCall.id,
          dst: stdioNode.id
        });
      }
    }
  }

  private bufferClassDeclarationNodes(classDeclarations: ClassDeclarationInfo[]): void {
    for (const classDecl of classDeclarations) {
      const { id, type, name, file, line, column, superClass, methods } = classDecl;

      // Buffer CLASS node
      this._bufferNode({
        id,
        type,
        name,
        file,
        line,
        column,
        superClass
      });

      // Buffer CONTAINS edges: CLASS -> METHOD
      for (const methodId of methods) {
        this._bufferEdge({
          type: 'CONTAINS',
          src: id,
          dst: methodId
        });
      }

      // If superClass, buffer DERIVES_FROM edge with computed ID
      if (superClass) {
        // Compute superclass ID using semantic ID format
        // Assume superclass is in same file at global scope (most common case)
        // When superclass is in different file, edge will be dangling until that file analyzed
        const globalContext = { file, scopePath: [] as string[] };
        const superClassId = computeSemanticId('CLASS', superClass, globalContext);

        this._bufferEdge({
          type: 'DERIVES_FROM',
          src: id,
          dst: superClassId
        });
      }
    }
  }

  private bufferClassNodes(module: ModuleNode, classInstantiations: ClassInstantiationInfo[], classDeclarations: ClassDeclarationInfo[]): void {
    // Create lookup map: className → declaration ID
    // Use basename for comparison because CLASS nodes use scopeTracker.file (basename)
    const moduleBasename = basename(module.file);
    const declarationMap = new Map<string, string>();
    for (const decl of classDeclarations) {
      if (decl.file === moduleBasename) {
        declarationMap.set(decl.name, decl.id);
      }
    }

    for (const instantiation of classInstantiations) {
      const { variableId, className, line } = instantiation;

      let classId = declarationMap.get(className);

      if (!classId) {
        // External class - compute semantic ID
        // Use basename to match CLASS node format (scopeTracker uses basename)
        // When class is in different file, edge will be dangling until that file analyzed
        const globalContext = { file: moduleBasename, scopePath: [] as string[] };
        classId = computeSemanticId('CLASS', className, globalContext);

        // NO node creation - node will exist when class file analyzed
      }

      // Buffer INSTANCE_OF edge
      this._bufferEdge({
        type: 'INSTANCE_OF',
        src: variableId,
        dst: classId
      });
    }
  }

  private bufferCallbackEdges(methodCallbacks: MethodCallbackInfo[], functions: FunctionInfo[]): void {
    for (const callback of methodCallbacks) {
      const { methodCallId, callbackLine, callbackColumn } = callback;

      const callbackFunction = functions.find(f =>
        f.line === callbackLine && f.column === callbackColumn
      );

      if (callbackFunction) {
        this._bufferEdge({
          type: 'HAS_CALLBACK',
          src: methodCallId,
          dst: callbackFunction.id
        });
      }
    }
  }

  private bufferImportNodes(module: ModuleNode, imports: ImportInfo[]): void {
    for (const imp of imports) {
      const { source, specifiers, line, column } = imp;

      for (const spec of specifiers) {
        // Use ImportNode factory for proper semantic IDs and field population
        const importNode = ImportNode.create(
          spec.local,           // name = local binding
          module.file,          // file
          line,                 // line (stored as field, not in ID)
          column || 0,          // column
          source,               // source module
          {
            imported: spec.imported,
            local: spec.local
            // importType is auto-detected from imported field
          }
        );

        this._bufferNode(importNode as unknown as GraphNode);

        // MODULE -> CONTAINS -> IMPORT
        this._bufferEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: importNode.id
        });

        // Create EXTERNAL_MODULE node for external modules
        const isRelative = source.startsWith('./') || source.startsWith('../');
        if (!isRelative) {
          const externalModule = NodeFactory.createExternalModule(source);

          // Avoid duplicate EXTERNAL_MODULE nodes
          if (!this._createdSingletons.has(externalModule.id)) {
            this._bufferNode(externalModule as unknown as GraphNode);
            this._createdSingletons.add(externalModule.id);
          }

          this._bufferEdge({
            type: 'IMPORTS',
            src: module.id,
            dst: externalModule.id
          });
        }
      }
    }
  }

  private bufferExportNodes(module: ModuleNode, exports: ExportInfo[]): void {
    for (const exp of exports) {
      const { type, line, name, specifiers, source } = exp;

      if (type === 'default') {
        const exportNode = NodeFactory.createExport(
          'default',
          module.file,
          line,
          0,
          { default: true, exportType: 'default' }
        );

        this._bufferNode(exportNode as unknown as GraphNode);

        this._bufferEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: exportNode.id
        });
      } else if (type === 'named') {
        if (specifiers) {
          for (const spec of specifiers) {
            const exportNode = NodeFactory.createExport(
              spec.exported,
              module.file,
              line,
              0,
              {
                local: spec.local,
                source: source,
                exportType: 'named'
              }
            );

            this._bufferNode(exportNode as unknown as GraphNode);

            this._bufferEdge({
              type: 'CONTAINS',
              src: module.id,
              dst: exportNode.id
            });
          }
        } else if (name) {
          const exportNode = NodeFactory.createExport(
            name,
            module.file,
            line,
            0,
            { exportType: 'named' }
          );

          this._bufferNode(exportNode as unknown as GraphNode);

          this._bufferEdge({
            type: 'CONTAINS',
            src: module.id,
            dst: exportNode.id
          });
        }
      } else if (type === 'all') {
        const exportNode = NodeFactory.createExport(
          '*',
          module.file,
          line,
          0,
          {
            source: source,
            exportType: 'all'
          }
        );

        this._bufferNode(exportNode as unknown as GraphNode);

        this._bufferEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: exportNode.id
        });
      }
    }
  }

  private bufferEventListeners(eventListeners: EventListenerInfo[], functions: FunctionInfo[]): void {
    for (const eventListener of eventListeners) {
      const { parentScopeId, callbackArg, ...listenerData } = eventListener;

      this._bufferNode(listenerData as GraphNode);

      this._bufferEdge({
        type: 'CONTAINS',
        src: parentScopeId as string,
        dst: listenerData.id
      });

      if (callbackArg && callbackArg.type === 'ArrowFunctionExpression') {
        const callbackLine = (callbackArg.loc as { start: { line: number } }).start.line;
        const callbackFunction = functions.find(f =>
          f.line === callbackLine && f.arrowFunction
        );

        if (callbackFunction) {
          this._bufferEdge({
            type: 'HANDLED_BY',
            src: listenerData.id,
            dst: callbackFunction.id
          });
        }
      }
    }
  }

  private bufferHttpRequests(httpRequests: HttpRequestInfo[], functions: FunctionInfo[]): void {
    if (httpRequests.length > 0) {
      // Create net:request singleton using factory
      const networkNode = NetworkRequestNode.create();

      if (!this._createdSingletons.has(networkNode.id)) {
        this._bufferNode(networkNode as unknown as GraphNode);
        this._createdSingletons.add(networkNode.id);
      }

      for (const request of httpRequests) {
        const { parentScopeId, ...requestData } = request;

        this._bufferNode(requestData as GraphNode);

        this._bufferEdge({
          type: 'CALLS',
          src: request.id,
          dst: networkNode.id
        });

        if (parentScopeId) {
          const scopeParts = parentScopeId.split(':');
          if (scopeParts.length >= 3 && scopeParts[1] === 'SCOPE') {
            const functionName = scopeParts[2];
            const file = scopeParts[0];

            const parentFunction = functions.find(f =>
              f.file === file && f.name === functionName
            );

            if (parentFunction) {
              this._bufferEdge({
                type: 'MAKES_REQUEST',
                src: parentFunction.id,
                dst: request.id
              });
            }
          }
        }
      }
    }
  }

  private bufferLiterals(literals: LiteralInfo[]): void {
    for (const literal of literals) {
      const { parentCallId, argIndex, ...literalData } = literal;
      this._bufferNode(literalData as GraphNode);
    }
  }

  private bufferAssignmentEdges(
    variableAssignments: VariableAssignmentInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    functions: FunctionInfo[],
    classInstantiations: ClassInstantiationInfo[],
    parameters: ParameterInfo[]
  ): void {
    for (const assignment of variableAssignments) {
      const {
        variableId,
        sourceId,
        sourceType,
        sourceName,
        sourceLine,
        sourceColumn,
        sourceFile,
        functionName,
        line,
        column,
        className
      } = assignment;

      // Skip CLASS sourceType - handled async in createClassAssignmentEdges
      if (sourceType === 'CLASS') {
        continue;
      }

      // CONSTRUCTOR_CALL: create ASSIGNED_FROM edge to existing node
      // Note: CONSTRUCTOR_CALL nodes are already created from constructorCalls collection in step 4.5
      if (sourceType === 'CONSTRUCTOR_CALL' && className) {
        const constructorLine = line ?? 0;
        const constructorColumn = column ?? 0;
        const constructorFile = assignment.file ?? '';

        // Generate ID matching the one created in NewExpression visitor
        const constructorCallId = NodeFactory.generateConstructorCallId(
          className,
          constructorFile,
          constructorLine,
          constructorColumn
        );

        this._bufferEdge({
          type: 'ASSIGNED_FROM',
          src: variableId,
          dst: constructorCallId
        });
        continue;
      }

      // Direct LITERAL assignment
      if (sourceId && sourceType !== 'EXPRESSION') {
        this._bufferEdge({
          type: 'ASSIGNED_FROM',
          src: variableId,
          dst: sourceId
        });
      }
      // METHOD_CALL by coordinates
      else if (sourceType === 'METHOD_CALL' && sourceLine && sourceColumn) {
        const methodCall = methodCalls.find(mc =>
          mc.line === sourceLine &&
          mc.column === sourceColumn &&
          mc.file === sourceFile
        );

        if (methodCall) {
          this._bufferEdge({
            type: 'ASSIGNED_FROM',
            src: variableId,
            dst: methodCall.id
          });
        }
      }
      // CALL_SITE by coordinates
      else if (sourceType === 'CALL_SITE') {
        const searchLine = sourceLine || assignment.callLine;
        const searchColumn = sourceColumn || assignment.callColumn;
        const searchName = assignment.callName;

        if (searchLine && searchColumn) {
          const callSite = callSites.find(cs =>
            cs.line === searchLine &&
            cs.column === searchColumn &&
            (searchName ? cs.name === searchName : true)
          );

          if (callSite) {
            this._bufferEdge({
              type: 'ASSIGNED_FROM',
              src: variableId,
              dst: callSite.id
            });
          }
        }
      }
      // VARIABLE by name
      else if (sourceType === 'VARIABLE' && sourceName) {
        // Find the current variable's file by looking it up in variableDeclarations
        // (semantic IDs don't have predictable file positions like old hash-based IDs)
        const currentVar = variableDeclarations.find(v => v.id === variableId);
        const varFile = currentVar?.file ?? null;
        const sourceVariable = variableDeclarations.find(v =>
          v.name === sourceName && v.file === varFile
        );

        if (sourceVariable) {
          this._bufferEdge({
            type: 'ASSIGNED_FROM',
            src: variableId,
            dst: sourceVariable.id
          });
        } else {
          const sourceParam = parameters.find(p =>
            p.name === sourceName && p.file === varFile
          );

          if (sourceParam) {
            this._bufferEdge({
              type: 'DERIVES_FROM',
              src: variableId,
              dst: sourceParam.id
            });
          }
        }
      }
      // FUNCTION (arrow function assigned to variable)
      else if (sourceType === 'FUNCTION' && functionName && line) {
        const sourceFunction = functions.find(f =>
          f.name === functionName && f.line === line
        );

        if (sourceFunction) {
          this._bufferEdge({
            type: 'ASSIGNED_FROM',
            src: variableId,
            dst: sourceFunction.id
          });
        }
      }
      // EXPRESSION node creation using NodeFactory
      else if (sourceType === 'EXPRESSION' && sourceId) {
        const {
          expressionType,
          object,
          property,
          computed,
          computedPropertyVar,
          operator,
          objectSourceName,
          leftSourceName,
          rightSourceName,
          consequentSourceName,
          alternateSourceName,
          file: exprFile,
          line: exprLine,
          column: exprColumn,
          // Destructuring support (REG-201)
          path,
          baseName,
          propertyPath,
          arrayIndex
        } = assignment;

        // Create node from upstream metadata using factory
        const expressionNode = NodeFactory.createExpressionFromMetadata(
          expressionType || 'Unknown',
          exprFile || '',
          exprLine || 0,
          exprColumn || 0,
          {
            id: sourceId,  // ID from JSASTAnalyzer
            object,
            property,
            computed,
            computedPropertyVar: computedPropertyVar ?? undefined,
            operator,
            // Destructuring support (REG-201)
            path,
            baseName,
            propertyPath,
            arrayIndex
          }
        );

        this._bufferNode(expressionNode);

        this._bufferEdge({
          type: 'ASSIGNED_FROM',
          src: variableId,
          dst: sourceId
        });

        // Buffer DERIVES_FROM edges
        const varParts = variableId.split('#');
        const varFile = varParts.length >= 3 ? varParts[2] : null;

        if (expressionType === 'MemberExpression' && objectSourceName) {
          const objectVar = variableDeclarations.find(v =>
            v.name === objectSourceName && (!varFile || v.file === varFile)
          );
          if (objectVar) {
            this._bufferEdge({
              type: 'DERIVES_FROM',
              src: sourceId,
              dst: objectVar.id
            });
          }
        }
        // Call-based source lookup (REG-223)
        else if (expressionType === 'MemberExpression' && assignment.callSourceLine !== undefined) {
          const { callSourceLine, callSourceColumn, callSourceName, callSourceFile } = assignment;

          // Try CALL_SITE first (direct function calls)
          const callSite = callSites.find(cs =>
            cs.line === callSourceLine &&
            cs.column === callSourceColumn &&
            (callSourceName ? cs.name === callSourceName : true)
          );

          if (callSite) {
            this._bufferEdge({
              type: 'DERIVES_FROM',
              src: sourceId,
              dst: callSite.id
            });
          }
          // Fall back to methodCalls (arr.map(), obj.getConfig())
          else {
            const methodCall = methodCalls.find(mc =>
              mc.line === callSourceLine &&
              mc.column === callSourceColumn &&
              (callSourceName ? mc.name === callSourceName : true)
            );

            if (methodCall) {
              this._bufferEdge({
                type: 'DERIVES_FROM',
                src: sourceId,
                dst: methodCall.id
              });
            }
            // Log warning when lookup fails (per Linus review - no silent failures)
            else {
              console.warn(
                `[REG-223] DERIVES_FROM lookup failed for EXPRESSION(${assignment.object}.${assignment.property}) ` +
                `at ${callSourceFile}:${callSourceLine}:${callSourceColumn}. ` +
                `Expected CALL_SITE or methodCall for "${callSourceName}". ` +
                `This indicates a coordinate mismatch or missing call node.`
              );
            }
          }
        }

        if ((expressionType === 'BinaryExpression' || expressionType === 'LogicalExpression')) {
          if (leftSourceName) {
            const leftVar = variableDeclarations.find(v =>
              v.name === leftSourceName && (!varFile || v.file === varFile)
            );
            if (leftVar) {
              this._bufferEdge({
                type: 'DERIVES_FROM',
                src: sourceId,
                dst: leftVar.id
              });
            }
          }
          if (rightSourceName) {
            const rightVar = variableDeclarations.find(v =>
              v.name === rightSourceName && (!varFile || v.file === varFile)
            );
            if (rightVar) {
              this._bufferEdge({
                type: 'DERIVES_FROM',
                src: sourceId,
                dst: rightVar.id
              });
            }
          }
        }

        if (expressionType === 'ConditionalExpression') {
          if (consequentSourceName) {
            const consequentVar = variableDeclarations.find(v =>
              v.name === consequentSourceName && (!varFile || v.file === varFile)
            );
            if (consequentVar) {
              this._bufferEdge({
                type: 'DERIVES_FROM',
                src: sourceId,
                dst: consequentVar.id
              });
            }
          }
          if (alternateSourceName) {
            const alternateVar = variableDeclarations.find(v =>
              v.name === alternateSourceName && (!varFile || v.file === varFile)
            );
            if (alternateVar) {
              this._bufferEdge({
                type: 'DERIVES_FROM',
                src: sourceId,
                dst: alternateVar.id
              });
            }
          }
        }

        if (expressionType === 'TemplateLiteral') {
          const { expressionSourceNames } = assignment;
          if (expressionSourceNames && expressionSourceNames.length > 0) {
            for (const exprSourceName of expressionSourceNames) {
              const sourceVar = variableDeclarations.find(v =>
                v.name === exprSourceName && (!varFile || v.file === varFile)
              );
              if (sourceVar) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: sourceId,
                  dst: sourceVar.id
                });
              }
            }
          }
        }
      }
      // DERIVES_FROM_VARIABLE
      else if (sourceType === 'DERIVES_FROM_VARIABLE' && sourceName) {
        const expressionId = variableId;
        const exprParts = expressionId.split('#');
        const exprFile = exprParts.length >= 3 ? exprParts[2] : assignment.file;

        const sourceVariable = variableDeclarations.find(v =>
          v.name === sourceName && v.file === exprFile
        );

        if (sourceVariable) {
          this._bufferEdge({
            type: 'DERIVES_FROM',
            src: expressionId,
            dst: sourceVariable.id
          });
        } else {
          const sourceParam = parameters.find(p =>
            p.name === sourceName && p.file === exprFile
          );

          if (sourceParam) {
            this._bufferEdge({
              type: 'DERIVES_FROM',
              src: expressionId,
              dst: sourceParam.id
            });
          }
        }
      }
    }
  }

  private bufferArgumentEdges(
    callArguments: CallArgumentInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    functions: FunctionInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[]
  ): void {
    for (const arg of callArguments) {
      const {
        callId,
        argIndex,
        targetType,
        targetId,
        targetName,
        file,
        isSpread,
        functionLine,
        functionColumn,
        nestedCallLine,
        nestedCallColumn
      } = arg;

      let targetNodeId = targetId;

      if (targetType === 'VARIABLE' && targetName) {
        const varNode = variableDeclarations.find(v =>
          v.name === targetName && v.file === file
        );
        if (varNode) {
          targetNodeId = varNode.id;
        }
      }
      else if (targetType === 'FUNCTION' && functionLine && functionColumn) {
        const funcNode = functions.find(f =>
          f.file === file && f.line === functionLine && f.column === functionColumn
        );
        if (funcNode) {
          targetNodeId = funcNode.id;
        }
      }
      else if (targetType === 'CALL' && nestedCallLine && nestedCallColumn) {
        const nestedCall = callSites.find(c =>
          c.file === file && c.line === nestedCallLine && c.column === nestedCallColumn
        ) || methodCalls.find(c =>
          c.file === file && c.line === nestedCallLine && c.column === nestedCallColumn
        );
        if (nestedCall) {
          targetNodeId = nestedCall.id;
        }
      }
      else if (targetType === 'LITERAL' ||
               targetType === 'OBJECT_LITERAL' ||
               targetType === 'ARRAY_LITERAL') {
        // targetId is already set by CallExpressionVisitor
        targetNodeId = targetId;
      }

      if (targetNodeId) {
        const edgeData: GraphEdge = {
          type: 'PASSES_ARGUMENT',
          src: callId,
          dst: targetNodeId,
          metadata: { argIndex }
        };

        if (isSpread) {
          edgeData.metadata = { ...edgeData.metadata, isSpread: true };
        }

        this._bufferEdge(edgeData);
      }
    }
  }

  // ============= TypeScript-specific buffer methods =============

  /**
   * Buffer INTERFACE nodes and EXTENDS edges
   *
   * Uses two-pass approach:
   * 1. First pass: create all interface nodes, store in Map
   * 2. Second pass: create EXTENDS edges using stored node IDs
   */
  private bufferInterfaceNodes(module: ModuleNode, interfaces: InterfaceDeclarationInfo[]): void {
    // First pass: create all interface nodes and store them
    const interfaceNodes = new Map<string, InterfaceNodeRecord>();

    for (const iface of interfaces) {
      const interfaceNode = InterfaceNode.create(
        iface.name,
        iface.file,
        iface.line,
        iface.column || 0,
        {
          extends: iface.extends,
          properties: iface.properties
        }
      );
      interfaceNodes.set(iface.name, interfaceNode);
      this._bufferNode(interfaceNode as unknown as GraphNode);

      // MODULE -> CONTAINS -> INTERFACE
      this._bufferEdge({
        type: 'CONTAINS',
        src: module.id,
        dst: interfaceNode.id
      });
    }

    // Second pass: create EXTENDS edges
    for (const iface of interfaces) {
      if (iface.extends && iface.extends.length > 0) {
        const srcNode = interfaceNodes.get(iface.name)!;

        for (const parentName of iface.extends) {
          const parentNode = interfaceNodes.get(parentName);

          if (parentNode) {
            // Same-file interface
            this._bufferEdge({
              type: 'EXTENDS',
              src: srcNode.id,
              dst: parentNode.id
            });
          } else {
            // External interface - create a reference node
            const externalInterface = NodeFactory.createInterface(
              parentName,
              iface.file,
              iface.line,
              0,
              { isExternal: true }
            );
            this._bufferNode(externalInterface as unknown as GraphNode);
            this._bufferEdge({
              type: 'EXTENDS',
              src: srcNode.id,
              dst: externalInterface.id
            });
          }
        }
      }
    }
  }

  /**
   * Buffer TYPE alias nodes
   */
  private bufferTypeAliasNodes(module: ModuleNode, typeAliases: TypeAliasInfo[]): void {
    for (const typeAlias of typeAliases) {
      // Create TYPE node using factory
      const typeNode = NodeFactory.createType(
        typeAlias.name,
        typeAlias.file,
        typeAlias.line,
        typeAlias.column || 0,
        { aliasOf: typeAlias.aliasOf }
      );
      this._bufferNode(typeNode as unknown as GraphNode);

      // MODULE -> CONTAINS -> TYPE
      this._bufferEdge({
        type: 'CONTAINS',
        src: module.id,
        dst: typeNode.id
      });
    }
  }

  /**
   * Buffer ENUM nodes
   * Uses EnumNode.create() to ensure consistent ID format (colon separator)
   */
  private bufferEnumNodes(module: ModuleNode, enums: EnumDeclarationInfo[]): void {
    for (const enumDecl of enums) {
      // Use EnumNode.create() to generate proper ID (colon format)
      // Do NOT use enumDecl.id which has legacy # format from TypeScriptVisitor
      const enumNode = EnumNode.create(
        enumDecl.name,
        enumDecl.file,
        enumDecl.line,
        enumDecl.column || 0,
        {
          isConst: enumDecl.isConst || false,
          members: enumDecl.members || []
        }
      );

      this._bufferNode(enumNode as unknown as GraphNode);

      // MODULE -> CONTAINS -> ENUM
      this._bufferEdge({
        type: 'CONTAINS',
        src: module.id,
        dst: enumNode.id  // Use factory-generated ID (colon format)
      });
    }
  }

  /**
   * Buffer DECORATOR nodes and DECORATED_BY edges
   */
  private bufferDecoratorNodes(decorators: DecoratorInfo[]): void {
    for (const decorator of decorators) {
      // Create DECORATOR node using factory (generates colon-format ID)
      const decoratorNode = DecoratorNode.create(
        decorator.name,
        decorator.file,
        decorator.line,
        decorator.column || 0,
        decorator.targetId,  // Now included in the node!
        decorator.targetType,
        { arguments: decorator.arguments }
      );

      this._bufferNode(decoratorNode as unknown as GraphNode);

      // TARGET -> DECORATED_BY -> DECORATOR
      this._bufferEdge({
        type: 'DECORATED_BY',
        src: decorator.targetId,
        dst: decoratorNode.id  // Use factory-generated ID (colon format)
      });
    }
  }

  /**
   * Buffer IMPLEMENTS edges (CLASS -> INTERFACE)
   */
  private bufferImplementsEdges(classDeclarations: ClassDeclarationInfo[], interfaces: InterfaceDeclarationInfo[]): void {
    for (const classDecl of classDeclarations) {
      if (classDecl.implements && classDecl.implements.length > 0) {
        for (const ifaceName of classDecl.implements) {
          // Try to find the interface in the same file
          const iface = interfaces.find(i => i.name === ifaceName);
          if (iface) {
            // Compute interface ID using same formula as InterfaceNode.create()
            // Format: {file}:INTERFACE:{name}:{line}
            const interfaceId = `${iface.file}:INTERFACE:${iface.name}:${iface.line}`;
            this._bufferEdge({
              type: 'IMPLEMENTS',
              src: classDecl.id,
              dst: interfaceId
            });
          } else {
            // External interface - create a reference node
            const externalInterface = NodeFactory.createInterface(
              ifaceName,
              classDecl.file,
              classDecl.line,
              0,
              { isExternal: true }
            );
            this._bufferNode(externalInterface as unknown as GraphNode);
            this._bufferEdge({
              type: 'IMPLEMENTS',
              src: classDecl.id,
              dst: externalInterface.id
            });
          }
        }
      }
    }
  }

  /**
   * Buffer FLOWS_INTO edges for array mutations (push, unshift, splice, indexed assignment)
   * Creates edges from inserted values to the array variable
   *
   * REG-117: Now handles nested mutations like obj.arr.push(item):
   * - For nested mutations, falls back to base object if array property not found
   * - Adds nestedProperty metadata for tracking
   *
   * OPTIMIZED: Uses Map-based lookup cache for O(1) variable lookups instead of O(n) find()
   */
  private bufferArrayMutationEdges(
    arrayMutations: ArrayMutationInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[]
  ): void {
    // Build lookup cache once: O(n) instead of O(n*m) with find() per mutation
    const varLookup = new Map<string, VariableDeclarationInfo>();
    for (const v of variableDeclarations) {
      varLookup.set(`${v.file}:${v.name}`, v);
    }

    // Build parameter lookup cache for function-level mutations
    const paramLookup = new Map<string, ParameterInfo>();
    for (const p of parameters) {
      paramLookup.set(`${p.file}:${p.name}`, p);
    }

    for (const mutation of arrayMutations) {
      const { arrayName, mutationMethod, insertedValues, file, isNested, baseObjectName, propertyName } = mutation;

      // REG-117: For nested mutations (obj.arr.push), resolve target node
      // First try direct lookup, then fallback to base object
      let targetNodeId: string | null = null;
      let nestedProperty: string | undefined;

      if (isNested && baseObjectName) {
        // Skip 'this.items.push' - 'this' is not a variable node
        if (baseObjectName === 'this') continue;

        // Nested mutation: try base object lookup
        const baseVar = varLookup.get(`${file}:${baseObjectName}`);
        const baseParam = !baseVar ? paramLookup.get(`${file}:${baseObjectName}`) : null;
        targetNodeId = baseVar?.id ?? baseParam?.id ?? null;
        nestedProperty = propertyName;
      } else {
        // Direct mutation: arr.push()
        const arrayVar = varLookup.get(`${file}:${arrayName}`);
        const arrayParam = !arrayVar ? paramLookup.get(`${file}:${arrayName}`) : null;
        targetNodeId = arrayVar?.id ?? arrayParam?.id ?? null;
      }

      if (!targetNodeId) continue;

      // Create FLOWS_INTO edges for each inserted value
      for (const arg of insertedValues) {
        if (arg.valueType === 'VARIABLE' && arg.valueName) {
          // O(1) lookup instead of O(n) find
          const sourceVar = varLookup.get(`${file}:${arg.valueName}`);
          const sourceParam = !sourceVar ? paramLookup.get(`${file}:${arg.valueName}`) : null;
          const sourceNodeId = sourceVar?.id ?? sourceParam?.id;

          if (sourceNodeId) {
            const edgeData: GraphEdge = {
              type: 'FLOWS_INTO',
              src: sourceNodeId,
              dst: targetNodeId,
              mutationMethod,
              argIndex: arg.argIndex
            };
            if (arg.isSpread) {
              edgeData.isSpread = true;
            }
            // REG-117: Add nested property metadata
            if (nestedProperty) {
              edgeData.nestedProperty = nestedProperty;
            }
            this._bufferEdge(edgeData);
          }
        }
        // For literals, object literals, etc. - we could create edges from LITERAL nodes
        // but for now we just track variable -> array flows
      }
    }
  }

  /**
   * Buffer FLOWS_INTO edges for object mutations (property assignment, Object.assign)
   * Creates edges from source values to the object variable being mutated.
   *
   * REG-152: For 'this.prop = value' patterns inside classes, creates edges
   * to the CLASS node with mutationType: 'this_property'.
   */
  private bufferObjectMutationEdges(
    objectMutations: ObjectMutationInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[],
    functions: FunctionInfo[],
    classDeclarations: ClassDeclarationInfo[]
  ): void {
    for (const mutation of objectMutations) {
      const { objectName, propertyName, mutationType, computedPropertyVar, value, file, enclosingClassName } = mutation;

      // Find the target node (object variable, parameter, or class for 'this')
      let objectNodeId: string | null = null;
      let effectiveMutationType: 'property' | 'computed' | 'assign' | 'spread' | 'this_property' = mutationType;

      if (objectName !== 'this') {
        // Regular object - find variable or parameter
        const objectVar = variableDeclarations.find(v => v.name === objectName && v.file === file);
        const objectParam = !objectVar ? parameters.find(p => p.name === objectName && p.file === file) : null;
        objectNodeId = objectVar?.id ?? objectParam?.id ?? null;
        if (!objectNodeId) continue;
      } else {
        // REG-152: 'this' mutations - find the CLASS node
        if (!enclosingClassName) continue;  // Skip if no class context (e.g., standalone function)

        // Compare using basename since classes use scopeTracker.file (basename)
        // but mutations use module.file (full path)
        const fileBasename = basename(file);
        const classDecl = classDeclarations.find(c => c.name === enclosingClassName && c.file === fileBasename);
        objectNodeId = classDecl?.id ?? null;

        if (!objectNodeId) continue;  // Skip if class not found

        // Use special mutation type to distinguish from regular property mutations
        effectiveMutationType = 'this_property';
      }

      // Create FLOWS_INTO edge for VARIABLE value type
      if (value.valueType === 'VARIABLE' && value.valueName) {
        // Find the source: can be variable, parameter, or function (arrow functions assigned to const)
        const sourceVar = variableDeclarations.find(v => v.name === value.valueName && v.file === file);
        const sourceParam = !sourceVar ? parameters.find(p => p.name === value.valueName && p.file === file) : null;
        const sourceFunc = !sourceVar && !sourceParam ? functions.find(f => f.name === value.valueName && f.file === file) : null;
        const sourceNodeId = sourceVar?.id ?? sourceParam?.id ?? sourceFunc?.id;

        if (sourceNodeId && objectNodeId) {
          const edgeData: GraphEdge = {
            type: 'FLOWS_INTO',
            src: sourceNodeId,
            dst: objectNodeId,
            mutationType: effectiveMutationType,
            propertyName,
            computedPropertyVar  // For enrichment phase resolution
          };
          if (value.argIndex !== undefined) {
            edgeData.argIndex = value.argIndex;
          }
          if (value.isSpread) {
            edgeData.isSpread = true;
          }
          this._bufferEdge(edgeData);
        }
      }
      // For literals, object literals, etc. - we just track variable -> object flows for now
    }
  }

  /**
   * Buffer OBJECT_LITERAL nodes to the graph.
   * These are object literals passed as function arguments or nested in other literals.
   */
  private bufferObjectLiteralNodes(objectLiterals: ObjectLiteralInfo[]): void {
    for (const obj of objectLiterals) {
      this._bufferNode({
        id: obj.id,
        type: obj.type,
        name: '<object>',
        file: obj.file,
        line: obj.line,
        column: obj.column,
        parentCallId: obj.parentCallId,
        argIndex: obj.argIndex
      } as GraphNode);
    }
  }

  /**
   * Buffer ARRAY_LITERAL nodes to the graph.
   * These are array literals passed as function arguments or nested in other literals.
   */
  private bufferArrayLiteralNodes(arrayLiterals: ArrayLiteralInfo[]): void {
    for (const arr of arrayLiterals) {
      this._bufferNode({
        id: arr.id,
        type: arr.type,
        name: '<array>',
        file: arr.file,
        line: arr.line,
        column: arr.column,
        parentCallId: arr.parentCallId,
        argIndex: arr.argIndex
      } as GraphNode);
    }
  }

  /**
   * Buffer HAS_PROPERTY edges connecting OBJECT_LITERAL nodes to their property values.
   * Creates edges from object literal to its property value nodes (LITERAL, nested OBJECT_LITERAL, ARRAY_LITERAL, etc.)
   */
  private bufferObjectPropertyEdges(objectProperties: ObjectPropertyInfo[]): void {
    for (const prop of objectProperties) {
      // Only create edge if we have a destination node ID
      if (prop.valueNodeId) {
        this._bufferEdge({
          type: 'HAS_PROPERTY',
          src: prop.objectId,
          dst: prop.valueNodeId,
          propertyName: prop.propertyName
        });
      }
    }
  }

  /**
   * Handle CLASS ASSIGNED_FROM edges asynchronously (needs graph queries)
   */
  private async createClassAssignmentEdges(variableAssignments: VariableAssignmentInfo[], graph: GraphBackend): Promise<number> {
    let edgesCreated = 0;

    for (const assignment of variableAssignments) {
      const { variableId, sourceType, className } = assignment;

      if (sourceType === 'CLASS' && className) {
        const parts = variableId.split('#');
        const file = parts.length >= 3 ? parts[2] : null;

        let classNode: { id: string; name: string; file?: string } | null = null;
        for await (const node of graph.queryNodes({ type: 'CLASS' })) {
          if (node.name === className && (!file || node.file === file)) {
            classNode = node as { id: string; name: string; file?: string };
            break;
          }
        }

        if (classNode) {
          await graph.addEdge({
            type: 'ASSIGNED_FROM',
            src: variableId,
            dst: classNode.id
          });
          edgesCreated++;
        }
      }
    }

    return edgesCreated;
  }
}
