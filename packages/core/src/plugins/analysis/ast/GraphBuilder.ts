/**
 * GraphBuilder - создание узлов и рёбер графа из собранных AST данных
 * OPTIMIZED: Uses batched writes to reduce FFI overhead
 */

import { dirname, resolve, basename } from 'path';
import type { GraphBackend, AnyBrandedNode } from '@grafema/types';
import { brandNode } from '@grafema/types';
import { ImportNode } from '../../../core/nodes/ImportNode.js';
import { InterfaceNode, type InterfaceNodeRecord } from '../../../core/nodes/InterfaceNode.js';
import { EnumNode, type EnumNodeRecord } from '../../../core/nodes/EnumNode.js';
import { DecoratorNode } from '../../../core/nodes/DecoratorNode.js';
import { NetworkRequestNode } from '../../../core/nodes/NetworkRequestNode.js';
import { NodeFactory } from '../../../core/NodeFactory.js';
import { computeSemanticId, parseSemanticId } from '../../../core/SemanticId.js';
import type {
  ModuleNode,
  FunctionInfo,
  ParameterInfo,
  ScopeInfo,
  BranchInfo,
  CaseInfo,
  LoopInfo,
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
  VariableReassignmentInfo,
  UpdateExpressionInfo,
  ReturnStatementInfo,
  YieldExpressionInfo,
  ObjectLiteralInfo,
  ObjectPropertyInfo,
  ArrayLiteralInfo,
  TryBlockInfo,
  CatchBlockInfo,
  FinallyBlockInfo,
  PromiseResolutionInfo,
  RejectionPatternInfo,
  CatchesFromInfo,
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
   *
   * GraphBuilder creates nodes via validated internal paths.
   * We brand them here before adding to the graph.
   */
  private async _flushNodes(graph: GraphBackend): Promise<number> {
    if (this._nodeBuffer.length > 0) {
      // Brand each node before adding to graph
      // This is safe because GraphBuilder creates nodes through validated paths
      const brandedNodes: AnyBrandedNode[] = this._nodeBuffer.map(node =>
        brandNode(node as import('@grafema/types').BaseNodeRecord)
      );
      await graph.addNodes(brandedNodes);
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
      // Control flow (loops)
      loops = [],
      // Control flow (try/catch/finally) - Phase 4
      tryBlocks = [],
      catchBlocks = [],
      finallyBlocks = [],
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
      // Variable reassignment tracking for FLOWS_INTO edges (REG-290)
      variableReassignments = [],
      // Update expression tracking for UPDATE_EXPRESSION nodes and MODIFIES edges (REG-288, REG-312)
      updateExpressions = [],
      // Return statement tracking for RETURNS edges
      returnStatements = [],
      // Yield expression tracking for YIELDS/DELEGATES_TO edges (REG-270)
      yieldExpressions = [],
      // Promise resolution tracking for RESOLVES_TO edges (REG-334)
      promiseResolutions = [],
      // Object/Array literal tracking
      objectLiterals = [],
      objectProperties = [],
      arrayLiterals = [],
      // REG-311: Rejection pattern tracking for async error analysis
      rejectionPatterns = [],
      // REG-311: CATCHES_FROM tracking for catch parameter error sources
      catchesFromInfos = []
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
      const { parentFunctionId, parentScopeId, capturesFrom, ...scopeData } = scope;
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

    // 2.7. Buffer LOOP nodes
    for (const loop of loops) {
      // Exclude metadata used for edge creation (not stored on node)
      const {
        iteratesOverName, iteratesOverLine, iteratesOverColumn,
        conditionExpressionId, conditionExpressionType, conditionLine, conditionColumn,
        ...loopData
      } = loop;
      this._bufferNode(loopData as GraphNode);
    }

    // 2.8. Buffer TRY_BLOCK nodes (Phase 4)
    for (const tryBlock of tryBlocks) {
      this._bufferNode(tryBlock as GraphNode);
    }

    // 2.9. Buffer CATCH_BLOCK nodes (Phase 4)
    for (const catchBlock of catchBlocks) {
      const { parentTryBlockId, ...catchData } = catchBlock;
      this._bufferNode(catchData as GraphNode);
    }

    // 2.10. Buffer FINALLY_BLOCK nodes (Phase 4)
    for (const finallyBlock of finallyBlocks) {
      const { parentTryBlockId, ...finallyData } = finallyBlock;
      this._bufferNode(finallyData as GraphNode);
    }

    // 3. Buffer variables (keep parentScopeId on node for queries)
    for (const varDecl of variableDeclarations) {
      this._bufferNode(varDecl as unknown as GraphNode);
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

    // 4. Buffer CALL_SITE (keep parentScopeId on node for queries)
    for (const callSite of callSites) {
      const { targetFunctionName, ...callData } = callSite;
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

    // 6.3. Buffer edges for LOOP (HAS_BODY, ITERATES_OVER, CONTAINS)
    this.bufferLoopEdges(loops, scopes, variableDeclarations, parameters);

    // 6.35. Buffer HAS_CONDITION edges for LOOP (REG-280)
    this.bufferLoopConditionEdges(loops, callSites);

    // 6.37. Buffer EXPRESSION nodes for loop conditions (REG-280)
    this.bufferLoopConditionExpressions(loops);

    // 6.5. Buffer edges for BRANCH (needs callSites for CallExpression discriminant lookup)
    // Phase 3 (REG-267): Now includes scopes for if-branches HAS_CONSEQUENT/HAS_ALTERNATE
    this.bufferBranchEdges(branches, callSites, scopes);

    // 6.6. Buffer edges for CASE
    this.bufferCaseEdges(cases);

    // 6.65. Buffer edges for TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK (Phase 4)
    this.bufferTryCatchFinallyEdges(tryBlocks, catchBlocks, finallyBlocks);

    // 6.7. Buffer EXPRESSION nodes for switch discriminants (needs callSites for CallExpression)
    this.bufferDiscriminantExpressions(branches, callSites);

    // 7. Buffer edges for variables
    this.bufferVariableEdges(variableDeclarations);

    // 8. Buffer edges for CALL_SITE
    this.bufferCallSiteEdges(callSites, functions);

    // 9. Buffer METHOD_CALL nodes, CONTAINS edges, and USES edges (REG-262)
    this.bufferMethodCalls(methodCalls, variableDeclarations, parameters);

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
    // REG-329: Pass variableDeclarations and parameters for scope-aware variable resolution
    this.bufferObjectPropertyEdges(objectProperties, variableDeclarations, parameters);

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

    // 28. Buffer FLOWS_INTO edges for variable reassignments (REG-290)
    this.bufferVariableReassignmentEdges(variableReassignments, variableDeclarations, callSites, methodCalls, parameters);

    // 29. Buffer RETURNS edges for return statements
    this.bufferReturnEdges(returnStatements, callSites, methodCalls, variableDeclarations, parameters);

    // 30. Buffer UPDATE_EXPRESSION nodes and MODIFIES edges (REG-288, REG-312)
    this.bufferUpdateExpressionEdges(updateExpressions, variableDeclarations, parameters, classDeclarations);

    // 31. Buffer RESOLVES_TO edges for Promise data flow (REG-334)
    this.bufferPromiseResolutionEdges(promiseResolutions);

    // 32. Buffer YIELDS/DELEGATES_TO edges for generator yields (REG-270)
    this.bufferYieldEdges(yieldExpressions, callSites, methodCalls, variableDeclarations, parameters);

    // 33. Buffer REJECTS edges for async error tracking (REG-311)
    this.bufferRejectionEdges(functions, rejectionPatterns);

    // 34. Buffer CATCHES_FROM edges linking catch blocks to error sources (REG-311)
    this.bufferCatchesFromEdges(catchesFromInfos);

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
      const { parentFunctionId, parentScopeId, capturesFrom, ...scopeData } = scope;

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

      // REG-288: MODIFIES edges removed - now come from UPDATE_EXPRESSION nodes
    }
  }

  /**
   * Buffer LOOP edges (CONTAINS, HAS_BODY, ITERATES_OVER)
   *
   * Creates edges for:
   * - Parent -> CONTAINS -> LOOP
   * - LOOP -> HAS_BODY -> body SCOPE
   * - LOOP -> ITERATES_OVER -> collection VARIABLE/PARAMETER (for for-in/for-of)
   *
   * Scope-aware variable lookup for ITERATES_OVER:
   * For for-of/for-in, finds the iterated variable preferring:
   * 1. Variables declared before the loop on same or earlier line (closest first)
   * 2. Parameters (function arguments)
   */
  private bufferLoopEdges(
    loops: LoopInfo[],
    scopes: ScopeInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[]
  ): void {
    for (const loop of loops) {
      // Parent -> CONTAINS -> LOOP
      if (loop.parentScopeId) {
        this._bufferEdge({
          type: 'CONTAINS',
          src: loop.parentScopeId,
          dst: loop.id
        });
      }

      // LOOP -> HAS_BODY -> body SCOPE
      // Find the body scope by matching parentScopeId to loop.id
      const bodyScope = scopes.find(s => s.parentScopeId === loop.id);
      if (bodyScope) {
        this._bufferEdge({
          type: 'HAS_BODY',
          src: loop.id,
          dst: bodyScope.id
        });
      }

      // LOOP -> ITERATES_OVER -> collection VARIABLE/PARAMETER (for for-in/for-of)
      if (loop.iteratesOverName && (loop.loopType === 'for-in' || loop.loopType === 'for-of')) {
        // For MemberExpression iterables (obj.items), extract base object
        const iterableName = loop.iteratesOverName.includes('.')
          ? loop.iteratesOverName.split('.')[0]
          : loop.iteratesOverName;

        // Scope-aware lookup: prefer parameters over variables
        // Parameters are function-local and shadow outer variables
        const param = parameters.find(p =>
          p.name === iterableName && p.file === loop.file
        );

        // Determine iteration type: for-in iterates keys, for-of iterates values
        const iterates = loop.loopType === 'for-in' ? 'keys' : 'values';

        if (param) {
          // Parameter found - most local binding
          this._bufferEdge({
            type: 'ITERATES_OVER',
            src: loop.id,
            dst: param.id,
            metadata: { iterates }
          });
        } else {
          // Find variable by name and line proximity (scope-aware heuristic)
          // Prefer variables declared before the loop in the same file
          const candidateVars = variableDeclarations.filter(v =>
            v.name === iterableName &&
            v.file === loop.file &&
            (v.line ?? 0) <= loop.line  // Declared before or on loop line
          );

          // Sort by line descending to find closest declaration
          candidateVars.sort((a, b) => (b.line ?? 0) - (a.line ?? 0));

          if (candidateVars.length > 0) {
            this._bufferEdge({
              type: 'ITERATES_OVER',
              src: loop.id,
              dst: candidateVars[0].id,
              metadata: { iterates }
            });
          }
        }
      }

      // REG-282: LOOP (for) -> HAS_INIT -> VARIABLE (let i = 0)
      if (loop.loopType === 'for' && loop.initVariableName && loop.initLine) {
        // Find the variable declared in the init on this line
        const initVar = variableDeclarations.find(v =>
          v.name === loop.initVariableName &&
          v.file === loop.file &&
          v.line === loop.initLine
        );
        if (initVar) {
          this._bufferEdge({
            type: 'HAS_INIT',
            src: loop.id,
            dst: initVar.id
          });
        }
      }

      // REG-282: LOOP -> HAS_CONDITION -> EXPRESSION (i < 10 or condition for while/do-while)
      if (loop.testExpressionId && loop.testExpressionType) {
        // Create EXPRESSION node for the test
        this._bufferNode({
          id: loop.testExpressionId,
          type: 'EXPRESSION',
          name: loop.testExpressionType,
          file: loop.file,
          line: loop.testLine,
          column: loop.testColumn,
          expressionType: loop.testExpressionType
        });

        this._bufferEdge({
          type: 'HAS_CONDITION',
          src: loop.id,
          dst: loop.testExpressionId
        });
      }

      // REG-282: LOOP (for) -> HAS_UPDATE -> EXPRESSION (i++)
      if (loop.loopType === 'for' && loop.updateExpressionId && loop.updateExpressionType) {
        // Create EXPRESSION node for the update
        this._bufferNode({
          id: loop.updateExpressionId,
          type: 'EXPRESSION',
          name: loop.updateExpressionType,
          file: loop.file,
          line: loop.updateLine,
          column: loop.updateColumn,
          expressionType: loop.updateExpressionType
        });

        this._bufferEdge({
          type: 'HAS_UPDATE',
          src: loop.id,
          dst: loop.updateExpressionId
        });
      }
    }
  }

  /**
   * Buffer HAS_CONDITION edges from LOOP to condition EXPRESSION/CALL nodes.
   * Also creates EXPRESSION nodes for non-CallExpression conditions.
   *
   * REG-280: For while/do-while/for loops, creates HAS_CONDITION edge to the
   * condition expression. For-in/for-of loops don't have conditions (use ITERATES_OVER).
   *
   * For CallExpression conditions, links to existing CALL_SITE node by coordinates.
   */
  private bufferLoopConditionEdges(loops: LoopInfo[], callSites: CallSiteInfo[]): void {
    for (const loop of loops) {
      // Skip for-in/for-of loops - they don't have test expressions
      if (loop.loopType === 'for-in' || loop.loopType === 'for-of') {
        continue;
      }

      // Skip if no condition (e.g., infinite for loop: for(;;))
      if (!loop.conditionExpressionId) {
        continue;
      }

      // LOOP -> HAS_CONDITION -> EXPRESSION/CALL
      let targetId = loop.conditionExpressionId;

      // For CallExpression conditions, look up the actual CALL_SITE by coordinates
      // because CALL_SITE uses semantic IDs that don't match the generated ID
      if (loop.conditionExpressionType === 'CallExpression' && loop.conditionLine && loop.conditionColumn !== undefined) {
        const callSite = callSites.find(cs =>
          cs.file === loop.file &&
          cs.line === loop.conditionLine &&
          cs.column === loop.conditionColumn
        );
        if (callSite) {
          targetId = callSite.id;
        }
      }

      this._bufferEdge({
        type: 'HAS_CONDITION',
        src: loop.id,
        dst: targetId
      });
    }
  }

  /**
   * Buffer EXPRESSION nodes for loop condition expressions (non-CallExpression).
   * Similar to bufferDiscriminantExpressions but for loops.
   *
   * REG-280: Creates EXPRESSION nodes for while/do-while/for loop conditions.
   * CallExpression conditions use existing CALL_SITE nodes (no EXPRESSION created).
   */
  private bufferLoopConditionExpressions(loops: LoopInfo[]): void {
    for (const loop of loops) {
      // Skip for-in/for-of loops - they don't have test expressions
      if (loop.loopType === 'for-in' || loop.loopType === 'for-of') {
        continue;
      }

      if (loop.conditionExpressionId && loop.conditionExpressionType) {
        // Skip CallExpression - we link to existing CALL_SITE in bufferLoopConditionEdges
        if (loop.conditionExpressionType === 'CallExpression') {
          continue;
        }

        // Only create if it looks like an EXPRESSION ID
        if (loop.conditionExpressionId.includes(':EXPRESSION:')) {
          this._bufferNode({
            id: loop.conditionExpressionId,
            type: 'EXPRESSION',
            name: loop.conditionExpressionType,
            file: loop.file,
            line: loop.conditionLine,
            column: loop.conditionColumn,
            expressionType: loop.conditionExpressionType
          });
        }
      }
    }
  }

  /**
   * Buffer BRANCH edges (CONTAINS, HAS_CONDITION, HAS_CONSEQUENT, HAS_ALTERNATE)
   *
   * REG-275: For CallExpression discriminants (switch(getType())), looks up the
   * actual CALL_SITE node by coordinates since the CALL_SITE uses semantic IDs.
   *
   * Phase 3 (REG-267): For if-branches, creates HAS_CONSEQUENT and HAS_ALTERNATE edges
   * pointing to the if-body and else-body SCOPEs.
   */
  private bufferBranchEdges(branches: BranchInfo[], callSites: CallSiteInfo[], scopes: ScopeInfo[]): void {
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

      // Phase 3: For if-branches, create HAS_CONSEQUENT and HAS_ALTERNATE edges
      if (branch.branchType === 'if') {
        // Find consequent (if-body) scope - parentScopeId matches branch.id, scopeType is 'if_statement'
        const consequentScope = scopes.find(s =>
          s.parentScopeId === branch.id && s.scopeType === 'if_statement'
        );
        if (consequentScope) {
          this._bufferEdge({
            type: 'HAS_CONSEQUENT',
            src: branch.id,
            dst: consequentScope.id
          });
        }

        // Find alternate (else-body) scope - parentScopeId matches branch.id, scopeType is 'else_statement'
        const alternateScope = scopes.find(s =>
          s.parentScopeId === branch.id && s.scopeType === 'else_statement'
        );
        if (alternateScope) {
          this._bufferEdge({
            type: 'HAS_ALTERNATE',
            src: branch.id,
            dst: alternateScope.id
          });
        }

        // For else-if chains: if this branch is the alternate of another branch
        // This is handled differently - see below
      }

      // REG-287: For ternary branches, create HAS_CONSEQUENT and HAS_ALTERNATE edges to expressions
      if (branch.branchType === 'ternary') {
        if (branch.consequentExpressionId) {
          this._bufferEdge({
            type: 'HAS_CONSEQUENT',
            src: branch.id,
            dst: branch.consequentExpressionId
          });
        }
        if (branch.alternateExpressionId) {
          this._bufferEdge({
            type: 'HAS_ALTERNATE',
            src: branch.id,
            dst: branch.alternateExpressionId
          });
        }
      }

      // Phase 3: For else-if chains, create HAS_ALTERNATE from parent branch to this branch
      if (branch.isAlternateOfBranchId) {
        this._bufferEdge({
          type: 'HAS_ALTERNATE',
          src: branch.isAlternateOfBranchId,
          dst: branch.id
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
   * Buffer edges for TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK nodes (Phase 4)
   *
   * Creates edges for:
   * - Parent -> CONTAINS -> TRY_BLOCK
   * - TRY_BLOCK -> HAS_CATCH -> CATCH_BLOCK
   * - TRY_BLOCK -> HAS_FINALLY -> FINALLY_BLOCK
   */
  private bufferTryCatchFinallyEdges(
    tryBlocks: TryBlockInfo[],
    catchBlocks: CatchBlockInfo[],
    finallyBlocks: FinallyBlockInfo[]
  ): void {
    // Buffer TRY_BLOCK edges
    for (const tryBlock of tryBlocks) {
      // Parent -> CONTAINS -> TRY_BLOCK
      if (tryBlock.parentScopeId) {
        this._bufferEdge({
          type: 'CONTAINS',
          src: tryBlock.parentScopeId,
          dst: tryBlock.id
        });
      }
    }

    // Buffer CATCH_BLOCK edges (HAS_CATCH from TRY_BLOCK)
    for (const catchBlock of catchBlocks) {
      // TRY_BLOCK -> HAS_CATCH -> CATCH_BLOCK
      this._bufferEdge({
        type: 'HAS_CATCH',
        src: catchBlock.parentTryBlockId,
        dst: catchBlock.id
      });
    }

    // Buffer FINALLY_BLOCK edges (HAS_FINALLY from TRY_BLOCK)
    for (const finallyBlock of finallyBlocks) {
      // TRY_BLOCK -> HAS_FINALLY -> FINALLY_BLOCK
      this._bufferEdge({
        type: 'HAS_FINALLY',
        src: finallyBlock.parentTryBlockId,
        dst: finallyBlock.id
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
      const { parentScopeId, isClassProperty, ...varData } = varDecl;

      // REG-271: Skip class properties - they get HAS_PROPERTY edges from CLASS, not DECLARES from SCOPE
      if (isClassProperty) {
        continue;
      }

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

  private bufferMethodCalls(
    methodCalls: MethodCallInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[]
  ): void {
    for (const methodCall of methodCalls) {
      // Keep parentScopeId on node for queries
      this._bufferNode(methodCall as unknown as GraphNode);

      // SCOPE -> CONTAINS -> METHOD_CALL
      this._bufferEdge({
        type: 'CONTAINS',
        src: methodCall.parentScopeId as string,
        dst: methodCall.id
      });

      // REG-262: Create USES edge from METHOD_CALL to receiver variable
      // Skip 'this' - it's not a variable node
      if (methodCall.object && methodCall.object !== 'this') {
        // Handle nested member expressions: obj.nested.method() -> use base 'obj'
        const receiverName = methodCall.object.includes('.')
          ? methodCall.object.split('.')[0]
          : methodCall.object;

        // Find receiver variable in current file
        const receiverVar = variableDeclarations.find(v =>
          v.name === receiverName && v.file === methodCall.file
        );

        if (receiverVar) {
          this._bufferEdge({
            type: 'USES',
            src: methodCall.id,
            dst: receiverVar.id
          });
        } else {
          // Check parameters (function arguments)
          const receiverParam = parameters.find(p =>
            p.name === receiverName && p.file === methodCall.file
          );

          if (receiverParam) {
            this._bufferEdge({
              type: 'USES',
              src: methodCall.id,
              dst: receiverParam.id
            });
          }
        }
      }
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
      const { id, type, name, file, line, column, superClass, methods, properties, staticBlocks } = classDecl;

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

      // REG-271: Buffer HAS_PROPERTY edges: CLASS -> VARIABLE (private fields)
      if (properties) {
        for (const propertyId of properties) {
          this._bufferEdge({
            type: 'HAS_PROPERTY',
            src: id,
            dst: propertyId
          });
        }
      }

      // REG-271: Buffer CONTAINS edges: CLASS -> SCOPE (static blocks)
      if (staticBlocks) {
        for (const staticBlockId of staticBlocks) {
          this._bufferEdge({
            type: 'CONTAINS',
            src: id,
            dst: staticBlockId
          });
        }
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
      const { source, specifiers, line, column, isDynamic, isResolvable, dynamicPath } = imp;

      // REG-273: Handle side-effect-only imports (no specifiers)
      if (specifiers.length === 0) {
        // Side-effect import: import './polyfill.js'
        const importNode = ImportNode.create(
          source,               // name = source (no local binding)
          module.file,          // file
          line,                 // line (stored as field, not in ID)
          column || 0,          // column
          source,               // source module
          {
            imported: '*',      // no specific export
            local: source,      // source becomes local
            sideEffect: true    // mark as side-effect import
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
      } else {
        // Regular imports with specifiers
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
              local: spec.local,
              sideEffect: false,  // regular imports are not side-effects
              // importType is auto-detected from imported field
              // Dynamic import fields
              isDynamic,
              isResolvable,
              dynamicPath
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
    // Note: No longer using Map-based cache - scope-aware lookup requires scope chain walk

    for (const mutation of arrayMutations) {
      const { arrayName, mutationScopePath, mutationMethod, insertedValues, file, isNested, baseObjectName, propertyName } = mutation;

      const scopePath = mutationScopePath ?? [];

      // REG-117: For nested mutations (obj.arr.push), resolve target node
      let targetNodeId: string | null = null;
      let nestedProperty: string | undefined;

      if (isNested && baseObjectName) {
        // Skip 'this.items.push' - 'this' is not a variable node
        if (baseObjectName === 'this') continue;

        // Nested mutation: try base object lookup with scope chain (REG-309)
        const baseVar = this.resolveVariableInScope(baseObjectName, scopePath, file, variableDeclarations);
        const baseParam = !baseVar ? this.resolveParameterInScope(baseObjectName, scopePath, file, parameters) : null;
        targetNodeId = baseVar?.id ?? baseParam?.id ?? null;
        nestedProperty = propertyName;
      } else {
        // Direct mutation: arr.push() (REG-309)
        const arrayVar = this.resolveVariableInScope(arrayName, scopePath, file, variableDeclarations);
        const arrayParam = !arrayVar ? this.resolveParameterInScope(arrayName, scopePath, file, parameters) : null;
        targetNodeId = arrayVar?.id ?? arrayParam?.id ?? null;
      }

      if (!targetNodeId) continue;

      // Create FLOWS_INTO edges for each inserted value
      for (const arg of insertedValues) {
        if (arg.valueType === 'VARIABLE' && arg.valueName) {
          // Scope-aware lookup for source variable (REG-309)
          const sourceVar = this.resolveVariableInScope(arg.valueName, scopePath, file, variableDeclarations);
          const sourceParam = !sourceVar ? this.resolveParameterInScope(arg.valueName, scopePath, file, parameters) : null;
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
      const { objectName, mutationScopePath, propertyName, mutationType, computedPropertyVar, value, file, enclosingClassName } = mutation;

      const scopePath = mutationScopePath ?? [];

      // Find the target node (object variable, parameter, or class for 'this')
      let objectNodeId: string | null = null;
      let effectiveMutationType: 'property' | 'computed' | 'assign' | 'spread' | 'this_property' = mutationType;

      if (objectName !== 'this') {
        // Regular object - find variable, parameter, or function using scope chain (REG-309)
        const objectVar = this.resolveVariableInScope(objectName, scopePath, file, variableDeclarations);
        const objectParam = !objectVar ? this.resolveParameterInScope(objectName, scopePath, file, parameters) : null;
        const objectFunc = !objectVar && !objectParam ? functions.find(f => f.name === objectName && f.file === file) : null;
        objectNodeId = objectVar?.id ?? objectParam?.id ?? objectFunc?.id ?? null;
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
        // Find the source: can be variable, parameter, or function using scope chain (REG-309)
        const sourceVar = this.resolveVariableInScope(value.valueName, scopePath, file, variableDeclarations);
        const sourceParam = !sourceVar ? this.resolveParameterInScope(value.valueName, scopePath, file, parameters) : null;
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
   * Resolve variable by name using scope chain lookup (REG-309).
   * Mirrors JavaScript lexical scoping: search current scope, then parent, then grandparent, etc.
   *
   * @param name - Variable name
   * @param scopePath - Scope path where reference occurs (from ScopeTracker)
   * @param file - File path
   * @param variables - All variable declarations
   * @returns Variable declaration or null if not found
   */
  private resolveVariableInScope(
    name: string,
    scopePath: string[],
    file: string,
    variables: VariableDeclarationInfo[]
  ): VariableDeclarationInfo | null {
    // Try current scope, then parent, then grandparent, etc.
    for (let i = scopePath.length; i >= 0; i--) {
      const searchScopePath = scopePath.slice(0, i);

      const matchingVar = variables.find(v => {
        if (v.name !== name || v.file !== file) return false;

        // Variable ID IS the semantic ID (when scopeTracker was available during analysis)
        // Format: file->scope1->scope2->TYPE->name
        // Legacy format: VARIABLE#name#file#line:column:counter

        // Try parsing as semantic ID
        const parsed = parseSemanticId(v.id);
        // REG-329: Check for both VARIABLE and CONSTANT (const declarations)
        if (parsed && (parsed.type === 'VARIABLE' || parsed.type === 'CONSTANT')) {
          // FIXED (REG-309): Handle module-level scope matching
          // Empty search scope [] should match semantic ID scope ['global']
          if (searchScopePath.length === 0) {
            return parsed.scopePath.length === 1 && parsed.scopePath[0] === 'global';
          }
          // Non-empty scope: exact match
          return this.scopePathsMatch(parsed.scopePath, searchScopePath);
        }

        // Legacy ID - assume module-level if no semantic ID
        return searchScopePath.length === 0;
      });

      if (matchingVar) return matchingVar;
    }

    return null;
  }

  /**
   * Resolve parameter by name using scope chain lookup (REG-309).
   * Same semantics as resolveVariableInScope but for parameters.
   *
   * @param name - Parameter name
   * @param scopePath - Scope path where reference occurs (from ScopeTracker)
   * @param file - File path
   * @param parameters - All parameter declarations
   * @returns Parameter declaration or null if not found
   */
  private resolveParameterInScope(
    name: string,
    scopePath: string[],
    file: string,
    parameters: ParameterInfo[]
  ): ParameterInfo | null {
    // Parameters have semanticId field populated (unlike variables which use id field)
    return parameters.find(p => {
      if (p.name !== name || p.file !== file) return false;

      if (p.semanticId) {
        const parsed = parseSemanticId(p.semanticId);
        if (parsed && parsed.type === 'PARAMETER') {
          // Check if parameter's scope matches any scope in the chain
          for (let i = scopePath.length; i >= 0; i--) {
            const searchScopePath = scopePath.slice(0, i);

            // FIXED (REG-309): Handle module-level scope matching for parameters
            if (searchScopePath.length === 0) {
              if (parsed.scopePath.length === 1 && parsed.scopePath[0] === 'global') {
                return true;
              }
            } else {
              if (this.scopePathsMatch(parsed.scopePath, searchScopePath)) {
                return true;
              }
            }
          }
        }
      }
      return false;
    }) ?? null;
  }

  /**
   * Check if two scope paths match (REG-309).
   * Handles: ['foo', 'if#0'] vs ['foo', 'if#0']
   */
  private scopePathsMatch(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((item, idx) => item === b[idx]);
  }

  /**
   * Buffer FLOWS_INTO edges for variable reassignments.
   * Handles: x = y, x += y (when x is already declared, not initialization)
   *
   * Edge patterns:
   * - Simple assignment (=): source --FLOWS_INTO--> variable
   * - Compound operators (+=, -=, etc.):
   *   - source --FLOWS_INTO--> variable (write new value)
   *   - variable --READS_FROM--> variable (self-loop: reads current value before write)
   *
   * REG-309: Uses scope-aware variable lookup via resolveVariableInScope().
   *
   * REG-290: Complete implementation with inline node creation (no continue statements).
   */
  private bufferVariableReassignmentEdges(
    variableReassignments: VariableReassignmentInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    parameters: ParameterInfo[]
  ): void {
    // Note: No longer using Map-based cache - scope-aware lookup requires scope chain walk
    // Performance: O(n*m*s) where s = scope depth (typically 2-3), acceptable for correctness

    for (const reassignment of variableReassignments) {
      const {
        variableName,
        mutationScopePath,
        valueType,
        valueName,
        valueId,
        callLine,
        callColumn,
        operator,
        literalValue,
        expressionType,
        expressionMetadata,
        file,
        line,
        column
      } = reassignment;

      // Find target variable node using scope chain resolution (REG-309)
      const scopePath = mutationScopePath ?? [];
      const targetVar = this.resolveVariableInScope(variableName, scopePath, file, variableDeclarations);
      const targetParam = !targetVar ? this.resolveParameterInScope(variableName, scopePath, file, parameters) : null;
      const targetNodeId = targetVar?.id ?? targetParam?.id;

      if (!targetNodeId) {
        // Variable not found - could be external reference
        continue;
      }

      // Resolve source node based on value type
      let sourceNodeId: string | null = null;

      // LITERAL: Create node inline (NO CONTINUE STATEMENT)
      if (valueType === 'LITERAL' && valueId) {
        // Create LITERAL node
        this._bufferNode({
          type: 'LITERAL',
          id: valueId,
          value: literalValue,
          file,
          line,
          column
        });
        sourceNodeId = valueId;
      }
      // VARIABLE: Look up existing variable/parameter node using scope chain (REG-309)
      else if (valueType === 'VARIABLE' && valueName) {
        const sourceVar = this.resolveVariableInScope(valueName, scopePath, file, variableDeclarations);
        const sourceParam = !sourceVar ? this.resolveParameterInScope(valueName, scopePath, file, parameters) : null;
        sourceNodeId = sourceVar?.id ?? sourceParam?.id ?? null;
      }
      // CALL_SITE: Look up existing call node
      else if (valueType === 'CALL_SITE' && callLine && callColumn) {
        const callSite = callSites.find(cs =>
          cs.line === callLine && cs.column === callColumn && cs.file === file
        );
        sourceNodeId = callSite?.id ?? null;
      }
      // METHOD_CALL: Look up existing method call node
      else if (valueType === 'METHOD_CALL' && callLine && callColumn) {
        const methodCall = methodCalls.find(mc =>
          mc.line === callLine && mc.column === callColumn && mc.file === file
        );
        sourceNodeId = methodCall?.id ?? null;
      }
      // EXPRESSION: Create node inline (NO CONTINUE STATEMENT)
      else if (valueType === 'EXPRESSION' && valueId && expressionType) {
        // Create EXPRESSION node using NodeFactory
        const expressionNode = NodeFactory.createExpressionFromMetadata(
          expressionType,
          file,
          line,
          column,
          {
            id: valueId,  // ID from JSASTAnalyzer
            object: expressionMetadata?.object,
            property: expressionMetadata?.property,
            computed: expressionMetadata?.computed,
            computedPropertyVar: expressionMetadata?.computedPropertyVar ?? undefined,
            operator: expressionMetadata?.operator
          }
        );

        this._bufferNode(expressionNode);
        sourceNodeId = valueId;
      }

      // Create edges if source found
      if (sourceNodeId && targetNodeId) {
        // For compound operators (operator !== '='), LHS reads its own current value
        // Create READS_FROM self-loop (Linus requirement)
        if (operator !== '=') {
          this._bufferEdge({
            type: 'READS_FROM',
            src: targetNodeId,  // Variable reads from...
            dst: targetNodeId   // ...itself (self-loop)
          });
        }

        // RHS flows into LHS (write side)
        this._bufferEdge({
          type: 'FLOWS_INTO',
          src: sourceNodeId,
          dst: targetNodeId
        });
      }
    }
  }

  /**
   * Buffer RETURNS edges connecting return expressions to their containing functions.
   *
   * Edge direction: returnExpression --RETURNS--> function
   *
   * This enables tracing data flow through function calls:
   * - Query: "What does formatDate return?"
   * - Answer: Follow RETURNS edges from function to see all possible return values
   */
  private bufferReturnEdges(
    returnStatements: ReturnStatementInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[]
  ): void {
    for (const ret of returnStatements) {
      const { parentFunctionId, returnValueType, file } = ret;

      // Skip if no value returned (bare return;)
      if (returnValueType === 'NONE') {
        continue;
      }

      let sourceNodeId: string | null = null;

      switch (returnValueType) {
        case 'LITERAL':
          // Direct reference to literal node
          sourceNodeId = ret.returnValueId ?? null;
          break;

        case 'VARIABLE': {
          // Find variable declaration by name in same file
          const varName = ret.returnValueName;
          if (varName) {
            const sourceVar = variableDeclarations.find(v =>
              v.name === varName && v.file === file
            );
            if (sourceVar) {
              sourceNodeId = sourceVar.id;
            } else {
              // Check parameters
              const sourceParam = parameters.find(p =>
                p.name === varName && p.file === file
              );
              if (sourceParam) {
                sourceNodeId = sourceParam.id;
              }
            }
          }
          break;
        }

        case 'CALL_SITE': {
          // Find call site by coordinates
          const { returnValueLine, returnValueColumn, returnValueCallName } = ret;
          if (returnValueLine && returnValueColumn) {
            const callSite = callSites.find(cs =>
              cs.line === returnValueLine &&
              cs.column === returnValueColumn &&
              (returnValueCallName ? cs.name === returnValueCallName : true)
            );
            if (callSite) {
              sourceNodeId = callSite.id;
            }
          }
          break;
        }

        case 'METHOD_CALL': {
          // Find method call by coordinates and method name
          const { returnValueLine, returnValueColumn, returnValueCallName } = ret;
          if (returnValueLine && returnValueColumn) {
            const methodCall = methodCalls.find(mc =>
              mc.line === returnValueLine &&
              mc.column === returnValueColumn &&
              mc.file === file &&
              (returnValueCallName ? mc.method === returnValueCallName : true)
            );
            if (methodCall) {
              sourceNodeId = methodCall.id;
            }
          }
          break;
        }

        case 'EXPRESSION': {
          // REG-276: Create EXPRESSION node and DERIVES_FROM edges for return expressions
          const {
            expressionType,
            returnValueId,
            returnValueLine,
            returnValueColumn,
            operator,
            object,
            property,
            computed,
            objectSourceName,
            leftSourceName,
            rightSourceName,
            consequentSourceName,
            alternateSourceName,
            expressionSourceNames,
            unaryArgSourceName
          } = ret;

          // Skip if no expression ID was generated
          if (!returnValueId) {
            break;
          }

          // Create EXPRESSION node using NodeFactory
          const expressionNode = NodeFactory.createExpressionFromMetadata(
            expressionType || 'Unknown',
            file,
            returnValueLine || ret.line,
            returnValueColumn || ret.column,
            {
              id: returnValueId,
              object,
              property,
              computed,
              operator
            }
          );

          this._bufferNode(expressionNode);
          sourceNodeId = returnValueId;

          // Buffer DERIVES_FROM edges based on expression type
          // Helper function to find source variable or parameter
          const findSource = (name: string): string | null => {
            const variable = variableDeclarations.find(v =>
              v.name === name && v.file === file
            );
            if (variable) return variable.id;

            const param = parameters.find(p =>
              p.name === name && p.file === file
            );
            if (param) return param.id;

            return null;
          };

          // MemberExpression: derives from the object
          if (expressionType === 'MemberExpression' && objectSourceName) {
            const sourceId = findSource(objectSourceName);
            if (sourceId) {
              this._bufferEdge({
                type: 'DERIVES_FROM',
                src: returnValueId,
                dst: sourceId
              });
            }
          }

          // BinaryExpression / LogicalExpression: derives from left and right operands
          if (expressionType === 'BinaryExpression' || expressionType === 'LogicalExpression') {
            if (leftSourceName) {
              const sourceId = findSource(leftSourceName);
              if (sourceId) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: returnValueId,
                  dst: sourceId
                });
              }
            }
            if (rightSourceName) {
              const sourceId = findSource(rightSourceName);
              if (sourceId) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: returnValueId,
                  dst: sourceId
                });
              }
            }
          }

          // ConditionalExpression: derives from consequent and alternate
          if (expressionType === 'ConditionalExpression') {
            if (consequentSourceName) {
              const sourceId = findSource(consequentSourceName);
              if (sourceId) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: returnValueId,
                  dst: sourceId
                });
              }
            }
            if (alternateSourceName) {
              const sourceId = findSource(alternateSourceName);
              if (sourceId) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: returnValueId,
                  dst: sourceId
                });
              }
            }
          }

          // UnaryExpression: derives from the argument
          if (expressionType === 'UnaryExpression' && unaryArgSourceName) {
            const sourceId = findSource(unaryArgSourceName);
            if (sourceId) {
              this._bufferEdge({
                type: 'DERIVES_FROM',
                src: returnValueId,
                dst: sourceId
              });
            }
          }

          // TemplateLiteral: derives from all embedded expressions
          if (expressionType === 'TemplateLiteral' && expressionSourceNames && expressionSourceNames.length > 0) {
            for (const sourceName of expressionSourceNames) {
              const sourceId = findSource(sourceName);
              if (sourceId) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: returnValueId,
                  dst: sourceId
                });
              }
            }
          }

          break;
        }
      }

      // Create RETURNS edge if we found a source node
      if (sourceNodeId && parentFunctionId) {
        this._bufferEdge({
          type: 'RETURNS',
          src: sourceNodeId,
          dst: parentFunctionId
        });
      }
    }
  }

  /**
   * Buffer YIELDS and DELEGATES_TO edges connecting yield expressions to their generator functions.
   *
   * Edge direction:
   * - For yield:  yieldedExpression --YIELDS--> generatorFunction
   * - For yield*: delegatedCall --DELEGATES_TO--> generatorFunction
   *
   * This enables tracing data flow through generator functions:
   * - Query: "What does this generator yield?"
   * - Answer: Follow YIELDS edges from function to see all possible yielded values
   * - Query: "What generators does this delegate to?"
   * - Answer: Follow DELEGATES_TO edges from function
   *
   * REG-270: Generator yield tracking
   */
  private bufferYieldEdges(
    yieldExpressions: YieldExpressionInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[]
  ): void {
    for (const yld of yieldExpressions) {
      const { parentFunctionId, yieldValueType, file, isDelegate } = yld;

      // Skip if no value yielded (bare yield;)
      if (yieldValueType === 'NONE') {
        continue;
      }

      let sourceNodeId: string | null = null;

      switch (yieldValueType) {
        case 'LITERAL':
          // Direct reference to literal node
          sourceNodeId = yld.yieldValueId ?? null;
          break;

        case 'VARIABLE': {
          // Find variable declaration by name in same file
          const varName = yld.yieldValueName;
          if (varName) {
            const sourceVar = variableDeclarations.find(v =>
              v.name === varName && v.file === file
            );
            if (sourceVar) {
              sourceNodeId = sourceVar.id;
            } else {
              // Check parameters
              const sourceParam = parameters.find(p =>
                p.name === varName && p.file === file
              );
              if (sourceParam) {
                sourceNodeId = sourceParam.id;
              }
            }
          }
          break;
        }

        case 'CALL_SITE': {
          // Find call site by coordinates
          const { yieldValueLine, yieldValueColumn, yieldValueCallName } = yld;
          if (yieldValueLine && yieldValueColumn) {
            const callSite = callSites.find(cs =>
              cs.line === yieldValueLine &&
              cs.column === yieldValueColumn &&
              (yieldValueCallName ? cs.name === yieldValueCallName : true)
            );
            if (callSite) {
              sourceNodeId = callSite.id;
            }
          }
          break;
        }

        case 'METHOD_CALL': {
          // Find method call by coordinates and method name
          const { yieldValueLine, yieldValueColumn, yieldValueCallName } = yld;
          if (yieldValueLine && yieldValueColumn) {
            const methodCall = methodCalls.find(mc =>
              mc.line === yieldValueLine &&
              mc.column === yieldValueColumn &&
              mc.file === file &&
              (yieldValueCallName ? mc.method === yieldValueCallName : true)
            );
            if (methodCall) {
              sourceNodeId = methodCall.id;
            }
          }
          break;
        }

        case 'EXPRESSION': {
          // Create EXPRESSION node and DERIVES_FROM edges for yield expressions
          const {
            expressionType,
            yieldValueId,
            yieldValueLine,
            yieldValueColumn,
            operator,
            object,
            property,
            computed,
            objectSourceName,
            leftSourceName,
            rightSourceName,
            consequentSourceName,
            alternateSourceName,
            expressionSourceNames,
            unaryArgSourceName
          } = yld;

          // Skip if no expression ID was generated
          if (!yieldValueId) {
            break;
          }

          // Create EXPRESSION node using NodeFactory
          const expressionNode = NodeFactory.createExpressionFromMetadata(
            expressionType || 'Unknown',
            file,
            yieldValueLine || yld.line,
            yieldValueColumn || yld.column,
            {
              id: yieldValueId,
              object,
              property,
              computed,
              operator
            }
          );

          this._bufferNode(expressionNode);
          sourceNodeId = yieldValueId;

          // Buffer DERIVES_FROM edges based on expression type
          // Helper function to find source variable or parameter
          const findSource = (name: string): string | null => {
            const variable = variableDeclarations.find(v =>
              v.name === name && v.file === file
            );
            if (variable) return variable.id;

            const param = parameters.find(p =>
              p.name === name && p.file === file
            );
            if (param) return param.id;

            return null;
          };

          // MemberExpression: derives from the object
          if (expressionType === 'MemberExpression' && objectSourceName) {
            const srcId = findSource(objectSourceName);
            if (srcId) {
              this._bufferEdge({
                type: 'DERIVES_FROM',
                src: yieldValueId,
                dst: srcId
              });
            }
          }

          // BinaryExpression / LogicalExpression: derives from left and right operands
          if (expressionType === 'BinaryExpression' || expressionType === 'LogicalExpression') {
            if (leftSourceName) {
              const srcId = findSource(leftSourceName);
              if (srcId) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: yieldValueId,
                  dst: srcId
                });
              }
            }
            if (rightSourceName) {
              const srcId = findSource(rightSourceName);
              if (srcId) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: yieldValueId,
                  dst: srcId
                });
              }
            }
          }

          // ConditionalExpression: derives from consequent and alternate
          if (expressionType === 'ConditionalExpression') {
            if (consequentSourceName) {
              const srcId = findSource(consequentSourceName);
              if (srcId) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: yieldValueId,
                  dst: srcId
                });
              }
            }
            if (alternateSourceName) {
              const srcId = findSource(alternateSourceName);
              if (srcId) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: yieldValueId,
                  dst: srcId
                });
              }
            }
          }

          // UnaryExpression: derives from the argument
          if (expressionType === 'UnaryExpression' && unaryArgSourceName) {
            const srcId = findSource(unaryArgSourceName);
            if (srcId) {
              this._bufferEdge({
                type: 'DERIVES_FROM',
                src: yieldValueId,
                dst: srcId
              });
            }
          }

          // TemplateLiteral: derives from all embedded expressions
          if (expressionType === 'TemplateLiteral' && expressionSourceNames && expressionSourceNames.length > 0) {
            for (const sourceName of expressionSourceNames) {
              const srcId = findSource(sourceName);
              if (srcId) {
                this._bufferEdge({
                  type: 'DERIVES_FROM',
                  src: yieldValueId,
                  dst: srcId
                });
              }
            }
          }

          break;
        }
      }

      // Create YIELDS or DELEGATES_TO edge if we found a source node
      if (sourceNodeId && parentFunctionId) {
        const edgeType = isDelegate ? 'DELEGATES_TO' : 'YIELDS';
        this._bufferEdge({
          type: edgeType,
          src: sourceNodeId,
          dst: parentFunctionId
        });
      }
    }
  }

  /**
   * Buffer UPDATE_EXPRESSION nodes and edges for increment/decrement operations.
   *
   * Handles two target types:
   * - IDENTIFIER: Simple variable (i++, --count)
   * - MEMBER_EXPRESSION: Object property (obj.prop++, arr[i]++, this.count++)
   *
   * Creates:
   * - UPDATE_EXPRESSION node with operator and target metadata
   * - MODIFIES edge: UPDATE_EXPRESSION -> target (VARIABLE, PARAMETER, or CLASS)
   * - READS_FROM self-loop: target -> target (reads current value before update)
   * - CONTAINS edge: SCOPE -> UPDATE_EXPRESSION
   *
   * REG-288: Initial implementation for IDENTIFIER targets
   * REG-312: Extended for MEMBER_EXPRESSION targets
   */
  private bufferUpdateExpressionEdges(
    updateExpressions: UpdateExpressionInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[],
    classDeclarations: ClassDeclarationInfo[]
  ): void {
    // Build lookup caches: O(n) instead of O(n*m)
    const varLookup = new Map<string, VariableDeclarationInfo>();
    for (const v of variableDeclarations) {
      varLookup.set(`${v.file}:${v.name}`, v);
    }

    const paramLookup = new Map<string, ParameterInfo>();
    for (const p of parameters) {
      paramLookup.set(`${p.file}:${p.name}`, p);
    }

    for (const update of updateExpressions) {
      if (update.targetType === 'IDENTIFIER') {
        // REG-288: Simple identifier (i++, --count)
        this.bufferIdentifierUpdate(update, varLookup, paramLookup);
      } else if (update.targetType === 'MEMBER_EXPRESSION') {
        // REG-312: Member expression (obj.prop++, arr[i]++)
        this.bufferMemberExpressionUpdate(update, varLookup, paramLookup, classDeclarations);
      }
    }
  }

  /**
   * Buffer UPDATE_EXPRESSION node and edges for simple identifier updates (i++, --count)
   * REG-288: Original implementation extracted for clarity
   */
  private bufferIdentifierUpdate(
    update: UpdateExpressionInfo,
    varLookup: Map<string, VariableDeclarationInfo>,
    paramLookup: Map<string, ParameterInfo>
  ): void {
    const {
      variableName,
      operator,
      prefix,
      file,
      line,
      column,
      parentScopeId
    } = update;

    if (!variableName) return;

    // Find target variable node
    const targetVar = varLookup.get(`${file}:${variableName}`);
    const targetParam = !targetVar ? paramLookup.get(`${file}:${variableName}`) : null;
    const targetNodeId = targetVar?.id ?? targetParam?.id;

    if (!targetNodeId) {
      // Variable not found - could be module-level or external reference
      return;
    }

    // Create UPDATE_EXPRESSION node
    const updateId = `${file}:UPDATE_EXPRESSION:${operator}:${line}:${column}`;

    this._bufferNode({
      type: 'UPDATE_EXPRESSION',
      id: updateId,
      name: `${prefix ? operator : ''}${variableName}${prefix ? '' : operator}`,
      targetType: 'IDENTIFIER',
      operator,
      prefix,
      variableName,
      file,
      line,
      column
    } as GraphNode);

    // Create READS_FROM self-loop
    this._bufferEdge({
      type: 'READS_FROM',
      src: targetNodeId,
      dst: targetNodeId
    });

    // Create MODIFIES edge
    this._bufferEdge({
      type: 'MODIFIES',
      src: updateId,
      dst: targetNodeId
    });

    // Create CONTAINS edge
    if (parentScopeId) {
      this._bufferEdge({
        type: 'CONTAINS',
        src: parentScopeId,
        dst: updateId
      });
    }
  }

  /**
   * Buffer UPDATE_EXPRESSION node and edges for member expression updates (obj.prop++, arr[i]++)
   * REG-312: New implementation for member expression targets
   *
   * Creates:
   * - UPDATE_EXPRESSION node with member expression metadata
   * - MODIFIES edge: UPDATE_EXPRESSION -> VARIABLE(object) or CLASS (for this.prop++)
   * - READS_FROM self-loop: VARIABLE(object) -> VARIABLE(object)
   * - CONTAINS edge: SCOPE -> UPDATE_EXPRESSION
   */
  private bufferMemberExpressionUpdate(
    update: UpdateExpressionInfo,
    varLookup: Map<string, VariableDeclarationInfo>,
    paramLookup: Map<string, ParameterInfo>,
    classDeclarations: ClassDeclarationInfo[]
  ): void {
    const {
      objectName,
      propertyName,
      mutationType,
      computedPropertyVar,
      enclosingClassName,
      operator,
      prefix,
      file,
      line,
      column,
      parentScopeId
    } = update;

    if (!objectName || !propertyName) return;

    // Find target object node
    let objectNodeId: string | null = null;

    if (objectName !== 'this') {
      // Regular object: obj.prop++, arr[i]++
      const targetVar = varLookup.get(`${file}:${objectName}`);
      const targetParam = !targetVar ? paramLookup.get(`${file}:${objectName}`) : null;
      objectNodeId = targetVar?.id ?? targetParam?.id ?? null;
    } else {
      // this.prop++ - follow REG-152 pattern from bufferObjectMutationEdges
      if (!enclosingClassName) return;

      const fileBasename = basename(file);
      const classDecl = classDeclarations.find(c =>
        c.name === enclosingClassName && c.file === fileBasename
      );
      objectNodeId = classDecl?.id ?? null;
    }

    if (!objectNodeId) {
      // Object not found - external reference or scope issue
      return;
    }

    // Create UPDATE_EXPRESSION node
    const updateId = `${file}:UPDATE_EXPRESSION:${operator}:${line}:${column}`;

    // Display name: "obj.prop++" or "this.count++" or "arr[i]++"
    const displayName = (() => {
      const opStr = prefix ? operator : '';
      const postOpStr = prefix ? '' : operator;

      if (objectName === 'this') {
        return `${opStr}this.${propertyName}${postOpStr}`;
      }
      if (mutationType === 'computed') {
        const computedPart = computedPropertyVar || '?';
        return `${opStr}${objectName}[${computedPart}]${postOpStr}`;
      }
      return `${opStr}${objectName}.${propertyName}${postOpStr}`;
    })();

    this._bufferNode({
      type: 'UPDATE_EXPRESSION',
      id: updateId,
      name: displayName,
      targetType: 'MEMBER_EXPRESSION',
      operator,
      prefix,
      objectName,
      propertyName,
      mutationType,
      computedPropertyVar,
      enclosingClassName,
      file,
      line,
      column
    } as GraphNode);

    // Create READS_FROM self-loop (object reads from itself)
    this._bufferEdge({
      type: 'READS_FROM',
      src: objectNodeId,
      dst: objectNodeId
    });

    // Create MODIFIES edge (UPDATE_EXPRESSION modifies object)
    this._bufferEdge({
      type: 'MODIFIES',
      src: updateId,
      dst: objectNodeId
    });

    // Create CONTAINS edge
    if (parentScopeId) {
      this._bufferEdge({
        type: 'CONTAINS',
        src: parentScopeId,
        dst: updateId
      });
    }
  }

  /**
   * Buffer RESOLVES_TO edges for Promise resolution data flow (REG-334).
   *
   * Links resolve/reject CALL nodes to their parent Promise CONSTRUCTOR_CALL.
   * This enables traceValues to follow Promise data flow:
   *
   * Example:
   * ```
   * const result = new Promise((resolve) => {
   *   resolve(42);  // CALL[resolve] --RESOLVES_TO--> CONSTRUCTOR_CALL[Promise]
   * });
   * ```
   *
   * The edge direction (CALL -> CONSTRUCTOR_CALL) matches data flow semantics:
   * data flows FROM resolve(value) TO the Promise result.
   */
  private bufferPromiseResolutionEdges(promiseResolutions: PromiseResolutionInfo[]): void {
    for (const resolution of promiseResolutions) {
      this._bufferEdge({
        type: 'RESOLVES_TO',
        src: resolution.callId,
        dst: resolution.constructorCallId,
        metadata: {
          isReject: resolution.isReject
        }
      });
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
   *
   * REG-329: Adds scope-aware variable resolution for VARIABLE property values.
   * Uses the same resolveVariableInScope infrastructure as mutation handlers.
   */
  private bufferObjectPropertyEdges(
    objectProperties: ObjectPropertyInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[]
  ): void {
    for (const prop of objectProperties) {
      // REG-329: Handle VARIABLE value types with scope resolution
      if (prop.valueType === 'VARIABLE' && prop.valueName) {
        const scopePath = prop.valueScopePath ?? [];
        const file = prop.file;

        // Resolve variable using scope chain
        const resolvedVar = this.resolveVariableInScope(
          prop.valueName, scopePath, file, variableDeclarations
        );
        const resolvedParam = !resolvedVar
          ? this.resolveParameterInScope(prop.valueName, scopePath, file, parameters)
          : null;

        const resolvedNodeId = resolvedVar?.id ?? resolvedParam?.semanticId ?? resolvedParam?.id;

        if (resolvedNodeId) {
          this._bufferEdge({
            type: 'HAS_PROPERTY',
            src: prop.objectId,
            dst: resolvedNodeId,
            propertyName: prop.propertyName
          });
        }
        continue;
      }

      // Existing logic for non-VARIABLE types
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

  /**
   * Buffer REJECTS edges for async error tracking (REG-311).
   *
   * Creates edges from FUNCTION nodes to error CLASS nodes they can reject.
   * This enables tracking which async functions can throw which error types:
   *
   * - Promise.reject(new Error()) -> FUNCTION --REJECTS--> CLASS[Error]
   * - reject(new ValidationError()) in executor -> FUNCTION --REJECTS--> CLASS[ValidationError]
   * - throw new AuthError() in async function -> FUNCTION --REJECTS--> CLASS[AuthError]
   *
   * Also stores rejectionPatterns in function metadata for downstream enrichers.
   *
   * @param functions - All function infos from analysis
   * @param rejectionPatterns - Collected rejection patterns from analysis
   */
  private bufferRejectionEdges(functions: FunctionInfo[], rejectionPatterns: RejectionPatternInfo[]): void {
    // Group rejection patterns by functionId for efficient lookup
    const patternsByFunction = new Map<string, RejectionPatternInfo[]>();
    for (const pattern of rejectionPatterns) {
      const existing = patternsByFunction.get(pattern.functionId);
      if (existing) {
        existing.push(pattern);
      } else {
        patternsByFunction.set(pattern.functionId, [pattern]);
      }
    }

    // Process each function that has rejection patterns
    for (const [functionId, patterns] of patternsByFunction) {
      // Collect unique error class names from this function's rejection patterns
      const errorClassNames = new Set<string>();
      for (const pattern of patterns) {
        if (pattern.errorClassName) {
          errorClassNames.add(pattern.errorClassName);
        }
      }

      // Create REJECTS edges to error class nodes
      // Note: These edges target computed CLASS IDs - they will be dangling
      // if the class isn't declared, but that's expected behavior for
      // built-in classes like Error, TypeError, etc.
      for (const errorClassName of errorClassNames) {
        // Find the function's file to compute the class ID
        const func = functions.find(f => f.id === functionId);
        const file = func?.file ?? '';

        // Compute potential class ID at global scope
        // For built-in errors, this will be a dangling reference (expected)
        const globalContext = { file, scopePath: [] as string[] };
        const classId = computeSemanticId('CLASS', errorClassName, globalContext);

        this._bufferEdge({
          type: 'REJECTS',
          src: functionId,
          dst: classId,
          metadata: {
            errorClassName
          }
        });
      }

      // Store rejection patterns in function metadata for downstream enrichers
      // Find and update the function node in the buffer
      for (const node of this._nodeBuffer) {
        if (node.id === functionId) {
          // Store in metadata field for proper persistence and test compatibility
          if (!node.metadata) {
            node.metadata = {};
          }
          (node.metadata as Record<string, unknown>).rejectionPatterns = patterns.map(p => ({
            rejectionType: p.rejectionType,
            errorClassName: p.errorClassName,
            line: p.line,
            column: p.column,
            sourceVariableName: p.sourceVariableName,
            tracePath: p.tracePath
          }));
          break;
        }
      }
    }
  }

  /**
   * Buffer CATCHES_FROM edges linking catch blocks to error sources (REG-311).
   *
   * Creates edges from CATCH_BLOCK nodes to potential error sources within
   * their corresponding try blocks. This enables tracking which catch blocks
   * can handle which exceptions:
   *
   * - try { await fetch() } catch(e) -> CATCH_BLOCK --CATCHES_FROM--> CALL[fetch]
   * - try { throw new Error() } catch(e) -> CATCH_BLOCK --CATCHES_FROM--> THROW_STATEMENT
   *
   * The sourceType metadata helps distinguish different error source kinds
   * for more precise error flow analysis.
   *
   * @param catchesFromInfos - Collected CATCHES_FROM info from analysis
   */
  private bufferCatchesFromEdges(catchesFromInfos: CatchesFromInfo[]): void {
    for (const info of catchesFromInfos) {
      this._bufferEdge({
        type: 'CATCHES_FROM',
        src: info.catchBlockId,
        dst: info.sourceId,
        metadata: {
          parameterName: info.parameterName,
          sourceType: info.sourceType,
          sourceLine: info.sourceLine
        }
      });
    }
  }
}
