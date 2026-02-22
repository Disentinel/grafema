/**
 * GraphBuilder - orchestrator that delegates to domain-specific builders
 * Writes nodes/edges directly to graph during RFDBClient batch window.
 * Only FUNCTION nodes are deferred (pending metadata mutation by ModuleRuntimeBuilder).
 */

import type { GraphBackend, NodeRecord } from '@grafema/types';
import { brandNodeInternal } from '../../../core/brandNodeInternal.js';
import { parseSemanticId } from '../../../core/SemanticId.js';
import type {
  ModuleNode,
  FunctionInfo,
  ParameterInfo,
  VariableDeclarationInfo,
  VariableAssignmentInfo,
  PropertyAccessInfo,
  ASTCollections,
  GraphNode,
  GraphEdge,
  BuildResult,
} from './types.js';
import type { BuilderContext } from './builders/types.js';
import {
  CoreBuilder,
  ControlFlowBuilder,
  AssignmentBuilder,
  CallFlowBuilder,
  MutationBuilder,
  UpdateExpressionBuilder,
  ReturnBuilder,
  YieldBuilder,
  TypeSystemBuilder,
  ModuleRuntimeBuilder,
} from './builders/index.js';

export class GraphBuilder {
  // Track singleton nodes to avoid duplicates (net:stdio, net:request, etc.)
  private _createdSingletons: Set<string> = new Set();

  // Graph reference for direct writes (set during build(), cleared after)
  private _graph: GraphBackend | null = null;

  // Pending function nodes (deferred until domain builders can mutate metadata)
  private _pendingFunctions: Map<string, GraphNode> = new Map();

  // Sync batch mode: push directly to RFDBClient batch arrays (no intermediate buffer)
  private _useSyncBatch: boolean = false;
  private _directNodeCount: number = 0;
  private _directEdgeCount: number = 0;

  // Fallback buffers (when graph.batchNode is not available)
  private _nodeBuffer: unknown[] = [];
  private _edgeBuffer: GraphEdge[] = [];

  // Domain builders
  private readonly _coreBuilder: CoreBuilder;
  private readonly _controlFlowBuilder: ControlFlowBuilder;
  private readonly _assignmentBuilder: AssignmentBuilder;
  private readonly _callFlowBuilder: CallFlowBuilder;
  private readonly _mutationBuilder: MutationBuilder;
  private readonly _updateExpressionBuilder: UpdateExpressionBuilder;
  private readonly _returnBuilder: ReturnBuilder;
  private readonly _yieldBuilder: YieldBuilder;
  private readonly _typeSystemBuilder: TypeSystemBuilder;
  private readonly _moduleRuntimeBuilder: ModuleRuntimeBuilder;

  constructor() {
    const ctx = this._createContext();
    this._coreBuilder = new CoreBuilder(ctx);
    this._controlFlowBuilder = new ControlFlowBuilder(ctx);
    this._assignmentBuilder = new AssignmentBuilder(ctx);
    this._callFlowBuilder = new CallFlowBuilder(ctx);
    this._mutationBuilder = new MutationBuilder(ctx);
    this._updateExpressionBuilder = new UpdateExpressionBuilder(ctx);
    this._returnBuilder = new ReturnBuilder(ctx);
    this._yieldBuilder = new YieldBuilder(ctx);
    this._typeSystemBuilder = new TypeSystemBuilder(ctx);
    this._moduleRuntimeBuilder = new ModuleRuntimeBuilder(ctx);
  }

  private _createContext(): BuilderContext {
    return {
      bufferNode: (node) => this._bufferNode(node),
      bufferEdge: (edge) => this._bufferEdge(edge),
      isCreated: (key) => this._createdSingletons.has(key),
      markCreated: (key) => { this._createdSingletons.add(key); },
      findBufferedNode: (id) => this._pendingFunctions.get(id),
      findFunctionByName: (functions, name, file, callScopeId) =>
        this.findFunctionByName(functions, name, file, callScopeId),
      resolveVariableInScope: (name, scopePath, file, variables) =>
        this.resolveVariableInScope(name, scopePath, file, variables),
      resolveParameterInScope: (name, scopePath, file, parameters) =>
        this.resolveParameterInScope(name, scopePath, file, parameters),
      scopePathsMatch: (a, b) => this.scopePathsMatch(a, b),
    };
  }

  /**
   * Buffer a node for batched writing.
   * INVARIANT: Only FUNCTION nodes are deferred (stored in _pendingFunctions)
   * because ModuleRuntimeBuilder mutates their metadata (rejectionPatterns)
   * after buffering. All other nodes go to sync batch or fallback buffer.
   */
  private _bufferNode(node: GraphNode): void {
    if (!this._graph) throw new Error('_bufferNode called outside build() — _graph is null');
    const branded = brandNodeInternal(node as unknown as NodeRecord);
    if ((node as Record<string, unknown>).type === 'FUNCTION') {
      this._pendingFunctions.set(node.id, branded as unknown as GraphNode);
    } else if (this._useSyncBatch) {
      this._graph.batchNode!(branded as unknown as Parameters<NonNullable<GraphBackend['batchNode']>>[0]);
      this._directNodeCount++;
    } else {
      this._nodeBuffer.push(branded);
    }
  }

  /**
   * Buffer an edge for batched writing.
   */
  private _bufferEdge(edge: GraphEdge): void {
    if (!this._graph) throw new Error('_bufferEdge called outside build() — _graph is null');
    if (this._useSyncBatch) {
      this._graph.batchEdge!(edge as unknown as Parameters<NonNullable<GraphBackend['batchEdge']>>[0]);
      this._directEdgeCount++;
    } else {
      this._edgeBuffer.push(edge);
    }
  }

  /**
   * Flush pending function nodes to the graph.
   * In sync batch mode, pushes each to batchNode. In fallback mode, uses addNodes.
   * Returns count of function nodes flushed.
   */
  private async _flushPendingFunctions(graph: GraphBackend): Promise<number> {
    const pendingFunctions = Array.from(this._pendingFunctions.values());
    if (pendingFunctions.length === 0) return 0;

    // Nodes already branded in _bufferNode() — no need to brand again
    if (this._useSyncBatch) {
      for (const node of pendingFunctions) {
        graph.batchNode!(node as unknown as Parameters<NonNullable<GraphBackend['batchNode']>>[0]);
      }
    } else {
      await graph.addNodes(pendingFunctions as unknown as Parameters<GraphBackend['addNodes']>[0]);
    }

    const count = pendingFunctions.length;
    this._pendingFunctions.clear();
    return count;
  }

  /**
   * Flush fallback buffers (only used when sync batch is not available).
   */
  private async _flushFallbackBuffers(graph: GraphBackend): Promise<{ nodes: number; edges: number }> {
    let nodesCreated = 0;
    if (this._nodeBuffer.length > 0) {
      await graph.addNodes(this._nodeBuffer as unknown as Parameters<GraphBackend['addNodes']>[0]);
      nodesCreated = this._nodeBuffer.length;
    }

    let edgesCreated = 0;
    if (this._edgeBuffer.length > 0) {
      await graph.addEdges(this._edgeBuffer as unknown as Parameters<GraphBackend['addEdges']>[0], true);
      edgesCreated = this._edgeBuffer.length;
    }

    this._nodeBuffer = [];
    this._edgeBuffer = [];
    return { nodes: nodesCreated, edges: edgesCreated };
  }

  /**
   * Создаёт ноды и рёбра в графе (BATCHED VERSION)
   */
  async build(module: ModuleNode, graph: GraphBackend, projectPath: string, data: ASTCollections): Promise<BuildResult> {
    // Phase 1 node buffering + post-flush fields only; builders receive `data` directly
    const {
      functions,
      parameters = [],
      scopes,
      branches = [],
      cases = [],
      loops = [],
      tryBlocks = [],
      catchBlocks = [],
      finallyBlocks = [],
      variableDeclarations,
      callSites,
      constructorCalls = [],
      // Post-flush fields
      variableAssignments = [],
      propertyAccesses = [],
      hasTopLevelAwait = false
    } = data;

    // Reset state for this build
    this._graph = graph;
    this._pendingFunctions.clear();
    this._useSyncBatch = typeof graph.batchNode === 'function' && typeof graph.batchEdge === 'function';
    this._directNodeCount = 0;
    this._directEdgeCount = 0;
    this._nodeBuffer = [];
    this._edgeBuffer = [];

    // 1. Buffer all functions (without edges)
    // REG-401: Strip invokesParamIndexes from node data and store in metadata
    for (const func of functions) {
      const { parentScopeId: _parentScopeId, invokesParamIndexes: _invokesParamIndexes, invokesParamBindings: _invokesParamBindings, ...funcData } = func;
      const node = funcData as GraphNode;
      if (_invokesParamIndexes && _invokesParamIndexes.length > 0) {
        if (!node.metadata) {
          node.metadata = {};
        }
        (node.metadata as Record<string, unknown>).invokesParamIndexes = _invokesParamIndexes;
      }
      // REG-417: Store property paths for destructured param bindings
      if (_invokesParamBindings && _invokesParamBindings.length > 0) {
        if (!node.metadata) {
          node.metadata = {};
        }
        (node.metadata as Record<string, unknown>).invokesParamBindings = _invokesParamBindings;
      }
      this._bufferNode(node);
    }

    // 2. Buffer all SCOPE (without edges)
    for (const scope of scopes) {
      const { parentFunctionId: _parentFunctionId, parentScopeId: _parentScopeId, capturesFrom: _capturesFrom, ...scopeData } = scope;
      this._bufferNode(scopeData as GraphNode);
    }

    // 2.5. Buffer BRANCH nodes
    // Note: parentScopeId is kept on node for query support (REG-275 test requirement)
    for (const branch of branches) {
      const { discriminantExpressionId: _discriminantExpressionId, discriminantExpressionType: _discriminantExpressionType, discriminantLine: _discriminantLine, discriminantColumn: _discriminantColumn, ...branchData } = branch;
      this._bufferNode(branchData as GraphNode);
    }

    // 2.6. Buffer CASE nodes
    for (const caseInfo of cases) {
      const { parentBranchId: _parentBranchId, ...caseData } = caseInfo;
      this._bufferNode(caseData as GraphNode);
    }

    // 2.7. Buffer LOOP nodes
    for (const loop of loops) {
      // Exclude metadata used for edge creation (not stored on node)
      const {
        iteratesOverName: _iteratesOverName, iteratesOverLine: _iteratesOverLine, iteratesOverColumn: _iteratesOverColumn,
        conditionExpressionId: _conditionExpressionId, conditionExpressionType: _conditionExpressionType, conditionLine: _conditionLine, conditionColumn: _conditionColumn,
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
      const { parentTryBlockId: _parentTryBlockId, ...catchData } = catchBlock;
      this._bufferNode(catchData as GraphNode);
    }

    // 2.10. Buffer FINALLY_BLOCK nodes (Phase 4)
    for (const finallyBlock of finallyBlocks) {
      const { parentTryBlockId: _parentTryBlockId2, ...finallyData } = finallyBlock;
      this._bufferNode(finallyData as GraphNode);
    }

    // 3. Buffer variables (keep parentScopeId on node for queries)
    // REG-552: Move accessibility, isReadonly, and tsType into metadata for class property fields
    for (const varDecl of variableDeclarations) {
      const { accessibility: _accessibility, isReadonly: _isReadonly, tsType: _tsType, ...varData } = varDecl;
      const node = varData as unknown as GraphNode;
      if (_accessibility !== undefined || _isReadonly || _tsType) {
        if (!node.metadata) node.metadata = {};
        if (_accessibility !== undefined) (node.metadata as Record<string, unknown>).accessibility = _accessibility;
        if (_isReadonly) (node.metadata as Record<string, unknown>).readonly = true;
        if (_tsType) (node.metadata as Record<string, unknown>).tsType = _tsType;
      }
      this._bufferNode(node);
    }

    // 3.5. Buffer PARAMETER nodes and HAS_PARAMETER edges
    for (const param of parameters) {
      const { functionId: _functionId, ...paramData } = param;
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
      const { targetFunctionName: _targetFunctionName, ...callData } = callSite;
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

      // SCOPE -> CONTAINS -> CONSTRUCTOR_CALL
      if (constructorCall.parentScopeId) {
        this._bufferEdge({
          type: 'CONTAINS',
          src: constructorCall.parentScopeId,
          dst: constructorCall.id
        });
      }
    }

    // Phase 2: Delegate to domain builders
    this._coreBuilder.buffer(module, data);
    this._controlFlowBuilder.buffer(module, data);
    this._callFlowBuilder.buffer(module, data);
    this._assignmentBuilder.buffer(module, data);
    this._mutationBuilder.buffer(module, data);
    this._updateExpressionBuilder.buffer(module, data);
    this._returnBuilder.buffer(module, data);
    this._yieldBuilder.buffer(module, data);
    this._typeSystemBuilder.buffer(module, data);
    this._moduleRuntimeBuilder.buffer(module, data);

    // FLUSH: Write pending function nodes (after domain builders mutated metadata)
    const functionsCount = await this._flushPendingFunctions(graph);

    // Flush fallback buffers if not using sync batch
    let fallbackNodes = 0;
    let fallbackEdges = 0;
    if (!this._useSyncBatch) {
      const fallback = await this._flushFallbackBuffers(graph);
      fallbackNodes = fallback.nodes;
      fallbackEdges = fallback.edges;
    }

    const nodesCreated = this._useSyncBatch ? this._directNodeCount + functionsCount : fallbackNodes + functionsCount;
    const edgesCreated = this._useSyncBatch ? this._directEdgeCount : fallbackEdges;

    // Handle async operations for ASSIGNED_FROM with CLASS lookups
    const classAssignmentEdges = await this.createClassAssignmentEdges(variableAssignments, graph);

    // REG-300: Update MODULE node with import.meta metadata
    const importMetaProps = this.collectImportMetaProperties(propertyAccesses);
    await this.updateModuleImportMetaMetadata(module, graph, importMetaProps);

    // REG-297: Update MODULE node with hasTopLevelAwait metadata
    await this.updateModuleTopLevelAwaitMetadata(module, graph, hasTopLevelAwait);

    this._graph = null; // release reference

    return { nodes: nodesCreated, edges: edgesCreated + classAssignmentEdges };
  }

  // ============= SHARED UTILITY METHODS =============

  /**
   * Scope-aware function lookup: when multiple functions share the same name
   * (e.g., inner function shadows outer), prefer the one in the same scope.
   * Falls back to module-level function if no scope match found.
   */
  private findFunctionByName(
    functions: FunctionInfo[],
    name: string | undefined,
    file: string,
    callScopeId: string
  ): FunctionInfo | undefined {
    if (!name) return undefined;

    // Find all functions with matching name in the same file
    const candidates = functions.filter(f => f.name === name && f.file === file);

    if (candidates.length === 0) {
      // Fallback: try without file constraint (legacy behavior)
      return functions.find(f => f.name === name);
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    // Multiple candidates: prefer same scope, then module-level
    const sameScope = candidates.find(f => f.parentScopeId === callScopeId);
    if (sameScope) return sameScope;

    // Fallback: prefer module-level function (parentScopeId contains MODULE)
    const moduleLevel = candidates.find(f =>
      (f.parentScopeId as string)?.includes(':MODULE:')
    );
    return moduleLevel || candidates[0];
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

        // REG-464: v2 path — use scopePath field if available (set by visitors)
        if (v.scopePath) {
          if (searchScopePath.length === 0) {
            return v.scopePath.length === 0;
          }
          return this.scopePathsMatch(v.scopePath, searchScopePath);
        }

        // v1 fallback: parse semanticId
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

      // REG-464: v2 path — use scopePath field if available (set by visitors)
      if (p.scopePath) {
        for (let i = scopePath.length; i >= 0; i--) {
          const searchScopePath = scopePath.slice(0, i);
          if (searchScopePath.length === 0) {
            if (p.scopePath.length === 0) return true;
          } else {
            if (this.scopePathsMatch(p.scopePath, searchScopePath)) return true;
          }
        }
        return false;
      }

      // v1 fallback: parse semanticId
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

  // ============= POST-FLUSH METHODS (need graph queries) =============

  /**
   * Collect unique import.meta property names from property accesses (REG-300).
   * Returns deduplicated array of property names (e.g., ["url", "env"]).
   */
  private collectImportMetaProperties(propertyAccesses: PropertyAccessInfo[]): string[] {
    const metaProps = new Set<string>();
    for (const propAccess of propertyAccesses) {
      if (propAccess.objectName === 'import.meta') {
        metaProps.add(propAccess.propertyName);
      }
    }
    return [...metaProps];
  }

  /**
   * Update MODULE node with import.meta metadata (REG-300).
   * Reads existing MODULE node, adds importMeta property list, re-adds it.
   */
  private async updateModuleImportMetaMetadata(
    module: ModuleNode,
    graph: GraphBackend,
    importMetaProps: string[]
  ): Promise<void> {
    if (importMetaProps.length === 0) return;

    const existingNode = await graph.getNode(module.id);
    if (!existingNode) return;

    // Re-add with importMeta at top level — addNode is upsert in RFDB,
    // and backend spreads metadata fields to top level on read
    await graph.addNode({
      ...existingNode,
      importMeta: importMetaProps
    } as unknown as Parameters<GraphBackend['addNode']>[0]);
  }

  /**
   * Update MODULE node with hasTopLevelAwait metadata (REG-297).
   * Reads existing MODULE node, adds hasTopLevelAwait flag, re-adds it.
   */
  private async updateModuleTopLevelAwaitMetadata(
    module: ModuleNode,
    graph: GraphBackend,
    hasTopLevelAwait: boolean
  ): Promise<void> {
    if (!hasTopLevelAwait) return;

    const existingNode = await graph.getNode(module.id);
    if (!existingNode) return;

    await graph.addNode({
      ...existingNode,
      hasTopLevelAwait: true
    } as unknown as Parameters<GraphBackend['addNode']>[0]);
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
        for await (const node of graph.queryNodes(file ? { type: 'CLASS', name: className, file } : { type: 'CLASS', name: className })) {
          classNode = node as { id: string; name: string; file?: string };
          break;
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
