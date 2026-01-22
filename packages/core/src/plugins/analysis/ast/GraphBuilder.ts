/**
 * GraphBuilder - создание узлов и рёбер графа из собранных AST данных
 * OPTIMIZED: Uses batched writes to reduce FFI overhead
 */

import { dirname, resolve } from 'path';
import type { GraphBackend } from '@grafema/types';
import { ImportNode } from '../../../core/nodes/ImportNode.js';
import { InterfaceNode, type InterfaceNodeRecord } from '../../../core/nodes/InterfaceNode.js';
import { EnumNode, type EnumNodeRecord } from '../../../core/nodes/EnumNode.js';
import { NodeFactory } from '../../../core/NodeFactory.js';
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
  ArrayMutationInfo,
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
      variableDeclarations,
      callSites,
      methodCalls = [],
      eventListeners = [],
      classInstantiations = [],
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
      arrayMutations = []
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

    // 5. Buffer edges for functions
    this.bufferFunctionEdges(module, functions);

    // 6. Buffer edges for SCOPE
    this.bufferScopeEdges(scopes, variableDeclarations);

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
    this.bufferArrayMutationEdges(arrayMutations, variableDeclarations);

    // FLUSH: Write all nodes first, then edges in single batch calls
    const nodesCreated = await this._flushNodes(graph);
    const edgesCreated = await this._flushEdges(graph);

    // Handle async operations that need graph queries (IMPORTS_FROM edges)
    const importExportEdges = await this.createImportExportEdges(module, imports, exports, graph, projectPath);

    // Handle async operations for ASSIGNED_FROM with CLASS lookups
    const classAssignmentEdges = await this.createClassAssignmentEdges(variableAssignments, graph);

    return { nodes: nodesCreated, edges: edgesCreated + importExportEdges + classAssignmentEdges };
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
      const stdioId = 'net:stdio#__stdio__';
      // Buffer net:stdio node only once (singleton)
      if (!this._createdSingletons.has(stdioId)) {
        this._bufferNode({
          id: stdioId,
          type: 'net:stdio',
          name: '__stdio__',
          description: 'Standard input/output stream'
        });
        this._createdSingletons.add(stdioId);
      }

      // Buffer WRITES_TO edges for console.log/error
      for (const methodCall of consoleIOMethods) {
        this._bufferEdge({
          type: 'WRITES_TO',
          src: methodCall.id,
          dst: stdioId
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
        // Compute superclass ID using same format as ClassNode (line 0 = unknown location)
        // Assume superclass is in same file (most common case)
        // When superclass is in different file, edge will be dangling until that file analyzed
        const superClassId = `${file}:CLASS:${superClass}:0`;

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
    const declarationMap = new Map<string, string>();
    for (const decl of classDeclarations) {
      if (decl.file === module.file) {
        declarationMap.set(decl.name, decl.id);
      }
    }

    for (const instantiation of classInstantiations) {
      const { variableId, className, line } = instantiation;

      let classId = declarationMap.get(className);

      if (!classId) {
        // External class - compute ID using ClassNode format (line 0 = unknown location)
        // Assume class is in same file (most common case)
        // When class is in different file, edge will be dangling until that file analyzed
        classId = `${module.file}:CLASS:${className}:0`;

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
      const networkId = 'net:request#__network__';

      if (!this._createdSingletons.has(networkId)) {
        this._bufferNode({
          id: networkId,
          type: 'net:request',
          name: '__network__'
        });
        this._createdSingletons.add(networkId);
      }

      for (const request of httpRequests) {
        const { parentScopeId, ...requestData } = request;

        this._bufferNode(requestData as GraphNode);

        this._bufferEdge({
          type: 'CALLS',
          src: request.id,
          dst: networkId
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
        className
      } = assignment;

      // Skip CLASS sourceType - handled async in createClassAssignmentEdges
      if (sourceType === 'CLASS') {
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
        const varIdParts = variableId.split('#');
        const varFile = varIdParts.length >= 3 ? varIdParts[2] : null;
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
      // EXPRESSION node creation
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
          line: exprLine
        } = assignment;

        const expressionNode: GraphNode = {
          id: sourceId,
          type: 'EXPRESSION',
          expressionType,
          file: exprFile,
          line: exprLine
        };

        if (expressionType === 'MemberExpression') {
          expressionNode.object = object;
          expressionNode.property = property;
          expressionNode.computed = computed;
          if (computedPropertyVar) {
            expressionNode.computedPropertyVar = computedPropertyVar;
          }
          expressionNode.name = `${object}.${property}`;
        } else if (expressionType === 'BinaryExpression' || expressionType === 'LogicalExpression') {
          expressionNode.operator = operator;
          expressionNode.name = `<${expressionType}>`;
        } else if (expressionType === 'ConditionalExpression') {
          expressionNode.name = '<ternary>';
        } else if (expressionType === 'TemplateLiteral') {
          expressionNode.name = '<template>';
        }

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
      // Buffer DECORATOR node
      this._bufferNode({
        id: decorator.id,
        type: 'DECORATOR',
        name: decorator.name,
        file: decorator.file,
        line: decorator.line,
        column: decorator.column,
        arguments: decorator.arguments,
        targetType: decorator.targetType
      });

      // TARGET -> DECORATED_BY -> DECORATOR
      this._bufferEdge({
        type: 'DECORATED_BY',
        src: decorator.targetId,
        dst: decorator.id
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
            this._bufferEdge({
              type: 'IMPLEMENTS',
              src: classDecl.id,
              dst: iface.id
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
   */
  private bufferArrayMutationEdges(
    arrayMutations: ArrayMutationInfo[],
    variableDeclarations: VariableDeclarationInfo[]
  ): void {
    for (const mutation of arrayMutations) {
      const { arrayName, mutationMethod, insertedValues, file } = mutation;

      // Find the array variable in the same file
      const arrayVar = variableDeclarations.find(v => v.name === arrayName && v.file === file);
      if (!arrayVar) continue;

      // Create FLOWS_INTO edges for each inserted value
      for (const arg of insertedValues) {
        if (arg.valueType === 'VARIABLE' && arg.valueName) {
          // Find the source variable
          const sourceVar = variableDeclarations.find(v => v.name === arg.valueName && v.file === file);
          if (sourceVar) {
            const edgeData: GraphEdge = {
              type: 'FLOWS_INTO',
              src: sourceVar.id,
              dst: arrayVar.id,
              mutationMethod,
              argIndex: arg.argIndex
            };
            if (arg.isSpread) {
              edgeData.isSpread = true;
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

  /**
   * Create IMPORTS_FROM edges linking imports to their target exports
   */
  private async createImportExportEdges(
    module: ModuleNode,
    imports: ImportInfo[],
    _exports: ExportInfo[],
    graph: GraphBackend,
    _projectPath: string
  ): Promise<number> {
    let edgesCreated = 0;

    for (const imp of imports) {
      const { source, specifiers, line } = imp;

      // Только для относительных импортов
      const isRelative = source.startsWith('./') || source.startsWith('../');
      if (!isRelative) {
        continue;
      }

      // Резолвим целевой модуль
      const currentDir = dirname(module.file);
      let targetPath = resolve(currentDir, source);

      // Пытаемся найти файл с расширениями .js, .ts, .jsx, .tsx
      const extensions = ['', '.js', '.ts', '.jsx', '.tsx', '/index.js', '/index.ts'];
      let targetModule: { id: string; file: string } | null = null;

      // Ищем MODULE ноду по file атрибуту (не по ID, т.к. формат ID изменился)
      for (const ext of extensions) {
        const testPath = targetPath + ext;

        // Ищем MODULE с этим file path
        for await (const node of graph.queryNodes({ type: 'MODULE' })) {
          if (node.file === testPath) {
            targetModule = node as { id: string; file: string };
            targetPath = testPath;
            break;
          }
        }
        if (targetModule) break;
      }

      if (!targetModule) {
        // Целевой модуль не найден в графе
        continue;
      }

      // Создаём IMPORTS edge от MODULE к MODULE (для совместимости с тестами)
      await graph.addEdge({
        type: 'IMPORTS',
        src: module.id,
        dst: targetModule.id
      });
      edgesCreated++;

      // Для каждого импортированного идентификатора создаём ребро к соответствующему EXPORT
      for (const spec of specifiers) {
        const importId = `${module.file}:IMPORT:${source}:${spec.local}:${line}`;
        const importType = spec.imported === 'default' ? 'default' :
                          spec.imported === '*' ? 'namespace' : 'named';

        if (importType === 'namespace') {
          // import * as foo - связываем со всем модулем
          await graph.addEdge({
            type: 'IMPORTS_FROM',
            src: importId,
            dst: targetModule.id
          });
          edgesCreated++;
        } else if (importType === 'default') {
          // Находим EXPORT default в целевом модуле
          const targetExports: { id: string }[] = [];
          for await (const node of graph.queryNodes({ type: 'EXPORT' })) {
            const exportNode = node as { id: string; file?: string; exportType?: string };
            if (exportNode.file === targetPath && exportNode.exportType === 'default') {
              targetExports.push(exportNode);
            }
          }

          if (targetExports.length > 0) {
            await graph.addEdge({
              type: 'IMPORTS_FROM',
              src: importId,
              dst: targetExports[0].id
            });
            edgesCreated++;
          }
        } else {
          // Named import - находим соответствующий named export
          const targetExports: { id: string }[] = [];
          for await (const node of graph.queryNodes({ type: 'EXPORT' })) {
            const exportNode = node as { id: string; file?: string; exportType?: string; name?: string };
            if (exportNode.file === targetPath && exportNode.exportType === 'named' && exportNode.name === spec.imported) {
              targetExports.push(exportNode);
            }
          }

          if (targetExports.length > 0) {
            await graph.addEdge({
              type: 'IMPORTS_FROM',
              src: importId,
              dst: targetExports[0].id
            });
            edgesCreated++;
          }
        }
      }
    }

    return edgesCreated;
  }
}
