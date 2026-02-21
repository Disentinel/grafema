/**
 * ClosureCaptureEnricher - tracks transitive closure captures
 *
 * Problem: CAPTURES edges only exist for immediate parent scope (depth=1).
 * Multi-level captures (grandparent, great-grandparent) are not tracked.
 *
 * Solution: Walk scope chains upward to find ALL captured variables,
 * creating CAPTURES edges with depth metadata.
 *
 * USES:
 * - SCOPE nodes with scopeType='closure'
 * - SCOPE.parentScopeId for scope chain navigation
 * - VARIABLE nodes with parentScopeId
 * - CONSTANT nodes with parentScopeId
 * - PARAMETER nodes with parentFunctionId (resolved via HAS_SCOPE)
 *
 * CREATES:
 * - SCOPE -> CAPTURES -> VARIABLE/CONSTANT/PARAMETER (with metadata: { depth: N })
 *
 * NOTE: Depth=1 edges are created by JSASTAnalyzer without depth metadata.
 * This enricher only creates edges for depth > 1.
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';

interface ScopeNode extends BaseNodeRecord {
  scopeType?: string;
  parentScopeId?: string;
  capturesFrom?: string;
}

interface VariableNode extends BaseNodeRecord {
  parentScopeId?: string;
}

interface ParameterNode extends BaseNodeRecord {
  parentFunctionId?: string;
}

interface ScopeChainEntry {
  scopeId: string;
  depth: number;
}

export class ClosureCaptureEnricher extends Plugin {
  static MAX_DEPTH = 10;

  get metadata(): PluginMetadata {
    return {
      name: 'ClosureCaptureEnricher',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],
        edges: ['CAPTURES']
      },
      dependencies: ['JSASTAnalyzer'], // Requires SCOPE and VARIABLE nodes
      consumes: [],
      produces: ['CAPTURES']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const factory = this.getFactory(context);
    const logger = this.log(context);

    logger.info('Starting transitive capture resolution');

    let closuresProcessed = 0;
    let capturesCreated = 0;
    let existingCapturesSkipped = 0;

    // Step 1: Build scope index for fast lookup
    const scopeIndex = await this.buildScopeIndex(graph);
    logger.debug('Indexed scopes', { count: scopeIndex.size });

    // Step 2: Build variable index (scopeId -> variables/constants/parameters)
    const variablesByScopeIndex = await this.buildVariablesByScopeIndex(graph);
    logger.debug('Indexed variables by scope', { scopes: variablesByScopeIndex.size });

    // Step 3: Find all closure scopes
    const closureScopes: ScopeNode[] = [];
    for await (const node of graph.queryNodes({ type: 'SCOPE' })) {
      const scope = node as ScopeNode;
      if (scope.scopeType === 'closure') {
        closureScopes.push(scope);
      }
    }

    logger.info('Found closure scopes', { count: closureScopes.length });

    // Step 4: Build existing CAPTURES edge set to avoid duplicates
    const existingCaptures = await this.buildExistingCapturesSet(graph);
    logger.debug('Existing CAPTURES edges', { count: existingCaptures.size });

    // Step 5: Process each closure
    for (const closure of closureScopes) {
      closuresProcessed++;

      // Progress reporting
      if (onProgress && closuresProcessed % 50 === 0) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'ClosureCaptureEnricher',
          message: `Processing closures ${closuresProcessed}/${closureScopes.length}`,
          totalFiles: closureScopes.length,
          processedFiles: closuresProcessed
        });
      }

      // Walk scope chain upward
      const ancestors = this.walkScopeChain(closure.id, scopeIndex);

      // For each ancestor scope (depth > 1), find variables and create edges
      for (const ancestor of ancestors) {
        if (ancestor.depth <= 1) continue; // Skip immediate parent (already handled by JSASTAnalyzer)

        const variables = variablesByScopeIndex.get(ancestor.scopeId) || [];

        for (const variable of variables) {
          const edgeKey = `${closure.id}:${variable.id}`;

          if (existingCaptures.has(edgeKey)) {
            existingCapturesSkipped++;
            continue;
          }

          await factory!.link({
            src: closure.id,
            dst: variable.id,
            type: 'CAPTURES',
            metadata: { depth: ancestor.depth }
          });

          capturesCreated++;
          existingCaptures.add(edgeKey); // Track to avoid duplicates
        }
      }
    }

    const summary = {
      closuresProcessed,
      capturesCreated,
      existingCapturesSkipped
    };

    logger.info('Summary', summary);

    return createSuccessResult({ nodes: 0, edges: capturesCreated }, summary);
  }

  /**
   * Build index: scopeId -> ScopeNode
   */
  private async buildScopeIndex(graph: PluginContext['graph']): Promise<Map<string, ScopeNode>> {
    const index = new Map<string, ScopeNode>();

    for await (const node of graph.queryNodes({ type: 'SCOPE' })) {
      index.set(node.id, node as ScopeNode);
    }

    return index;
  }

  /**
   * Build index: scopeId -> VariableNode[]
   * Includes VARIABLE, CONSTANT, and PARAMETER nodes
   */
  private async buildVariablesByScopeIndex(graph: PluginContext['graph']): Promise<Map<string, VariableNode[]>> {
    const index = new Map<string, VariableNode[]>();

    // Index VARIABLE nodes via parentScopeId
    for await (const node of graph.queryNodes({ type: 'VARIABLE' })) {
      const variable = node as VariableNode;
      if (!variable.parentScopeId) continue;

      const vars = index.get(variable.parentScopeId) || [];
      vars.push(variable);
      index.set(variable.parentScopeId, vars);
    }

    // Index CONSTANT nodes via parentScopeId
    for await (const node of graph.queryNodes({ type: 'CONSTANT' })) {
      const constant = node as VariableNode;
      if (!constant.parentScopeId) continue;

      const vars = index.get(constant.parentScopeId) || [];
      vars.push(constant);
      index.set(constant.parentScopeId, vars);
    }

    // Index PARAMETER nodes via parentFunctionId -> HAS_SCOPE lookup
    for await (const node of graph.queryNodes({ type: 'PARAMETER' })) {
      const param = node as ParameterNode;
      if (!param.parentFunctionId) continue;

      // Find the function's scope via HAS_SCOPE edge
      // FUNCTION -[HAS_SCOPE]-> SCOPE
      const scopeEdges = await graph.getOutgoingEdges(param.parentFunctionId, ['HAS_SCOPE']);
      if (scopeEdges.length === 0) continue;

      const scopeId = scopeEdges[0].dst;
      const params = index.get(scopeId) || [];
      params.push(param as unknown as VariableNode);
      index.set(scopeId, params);
    }

    return index;
  }

  /**
   * Build set of existing CAPTURES edges: "srcId:dstId"
   */
  private async buildExistingCapturesSet(graph: PluginContext['graph']): Promise<Set<string>> {
    const set = new Set<string>();

    // Query all SCOPE nodes and get their CAPTURES edges
    for await (const node of graph.queryNodes({ type: 'SCOPE' })) {
      const edges = await graph.getOutgoingEdges(node.id, ['CAPTURES']);
      for (const edge of edges) {
        set.add(`${edge.src}:${edge.dst}`);
      }
    }

    return set;
  }

  /**
   * Walk scope chain upward from startScopeId
   * Returns ancestor scopes with depth (1 = immediate parent, 2 = grandparent, etc.)
   *
   * Walks ALL scopes in the chain (including if/for/while blocks),
   * not just closures.
   */
  private walkScopeChain(
    startScopeId: string,
    scopeIndex: Map<string, ScopeNode>
  ): ScopeChainEntry[] {
    const result: ScopeChainEntry[] = [];
    const visited = new Set<string>();

    const currentScope = scopeIndex.get(startScopeId);
    if (!currentScope) return result;

    // Start walking from the closure's capturesFrom (immediate parent) or parentScopeId
    let parentId = currentScope.capturesFrom || currentScope.parentScopeId;
    let depth = 1;

    while (parentId && depth <= ClosureCaptureEnricher.MAX_DEPTH) {
      // Cycle protection
      if (visited.has(parentId)) break;
      visited.add(parentId);

      result.push({ scopeId: parentId, depth });

      // Get parent scope
      const parentScope = scopeIndex.get(parentId);
      if (!parentScope) break;

      // Move up the chain via parentScopeId
      parentId = parentScope.parentScopeId;
      depth++;
    }

    return result;
  }
}
