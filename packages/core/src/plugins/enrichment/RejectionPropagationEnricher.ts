/**
 * RejectionPropagationEnricher - propagates rejection types through await chains
 *
 * REG-311: When function A awaits function B, and B can reject with ErrorX,
 * then A also can reject with ErrorX (unless the await is inside try/catch).
 *
 * USES:
 * - FUNCTION nodes with async=true
 * - CALL nodes with isAwaited/isInsideTry metadata
 * - CALLS edges to find call targets
 * - REJECTS edges to find function rejection types
 *
 * CREATES:
 * - FUNCTION -> REJECTS -> CLASS (propagated edges with metadata: { rejectionType: 'propagated', propagatedFrom })
 *
 * Priority: 70 (after FunctionCallResolver at 80, needs CALLS edges resolved)
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord, EdgeRecord } from '@grafema/types';

interface FunctionNode extends BaseNodeRecord {
  async?: boolean;
}

interface CallNode extends BaseNodeRecord {
  isAwaited?: boolean;
  isInsideTry?: boolean;
}

export class RejectionPropagationEnricher extends Plugin {
  static MAX_ITERATIONS = 10;

  get metadata(): PluginMetadata {
    return {
      name: 'RejectionPropagationEnricher',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],
        edges: ['REJECTS']
      },
      dependencies: ['JSASTAnalyzer'], // Needs FUNCTION, CALL nodes with metadata
      consumes: ['CALLS', 'REJECTS', 'CONTAINS', 'HAS_SCOPE'],
      produces: ['REJECTS']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    logger.info('Starting rejection propagation through await chains');

    let totalEdgesCreated = 0;
    let iterations = 0;

    // Step 1: Build function index (id -> FunctionNode)
    const functionIndex = new Map<string, FunctionNode>();
    const asyncFunctions: FunctionNode[] = [];

    for await (const node of graph.queryNodes({ type: 'FUNCTION' })) {
      const funcNode = node as FunctionNode;
      functionIndex.set(node.id, funcNode);
      if (funcNode.async) {
        asyncFunctions.push(funcNode);
      }
    }

    logger.info('Indexed functions', { total: functionIndex.size, async: asyncFunctions.length });

    if (asyncFunctions.length === 0) {
      logger.info('No async functions found, skipping propagation');
      return createSuccessResult({ nodes: 0, edges: 0 }, { reason: 'no_async_functions' });
    }

    // Step 2: Build REJECTS index (functionId -> Set<errorClassId>)
    const rejectsByFunction = new Map<string, Set<string>>();

    for (const [funcId] of functionIndex) {
      const rejectsEdges = await graph.getOutgoingEdges(funcId, ['REJECTS']);
      if (rejectsEdges.length > 0) {
        const rejectsSet = new Set<string>();
        for (const edge of rejectsEdges) {
          rejectsSet.add(edge.dst);
        }
        rejectsByFunction.set(funcId, rejectsSet);
      }
    }

    logger.debug('Indexed REJECTS edges', { functionsWithRejects: rejectsByFunction.size });

    // Step 3: Build CALLS index (callNodeId -> targetFunctionIds)
    const callTargets = new Map<string, string[]>();

    // Step 4: Build call-to-containing-function mapping and CALLS index
    const callsByFunction = new Map<string, CallNode[]>();

    for await (const node of graph.queryNodes({ type: 'CALL' })) {
      const callNode = node as CallNode;

      // Build CALLS index for this call node
      const callsEdges = await graph.getOutgoingEdges(callNode.id, ['CALLS']);
      if (callsEdges.length > 0) {
        const targets: string[] = [];
        for (const edge of callsEdges) {
          targets.push(edge.dst);
        }
        callTargets.set(callNode.id, targets);
      }

      // Find containing function by walking up CONTAINS/HAS_SCOPE edges
      const containingFunctionId = await this.findContainingFunction(
        callNode.id,
        functionIndex,
        graph
      );

      if (containingFunctionId) {
        if (!callsByFunction.has(containingFunctionId)) {
          callsByFunction.set(containingFunctionId, []);
        }
        callsByFunction.get(containingFunctionId)!.push(callNode);
      }
    }

    logger.debug('Mapped calls to functions', { functionsWithCalls: callsByFunction.size, callsWithTargets: callTargets.size });

    // Step 5: Iterate until fixpoint
    let changed = true;

    while (changed && iterations < RejectionPropagationEnricher.MAX_ITERATIONS) {
      iterations++;
      changed = false;
      let iterationEdges = 0;

      if (onProgress) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'RejectionPropagationEnricher',
          message: `Propagation iteration ${iterations}`,
          processedFiles: iterations,
          totalFiles: RejectionPropagationEnricher.MAX_ITERATIONS
        });
      }

      for (const asyncFunc of asyncFunctions) {
        const calls = callsByFunction.get(asyncFunc.id) || [];

        for (const call of calls) {
          // Only propagate for awaited calls NOT inside try
          if (!call.isAwaited || call.isInsideTry) {
            continue;
          }

          const targets = callTargets.get(call.id) || [];

          for (const targetId of targets) {
            const targetRejects = rejectsByFunction.get(targetId);
            if (!targetRejects || targetRejects.size === 0) {
              continue;
            }

            // Ensure caller has a rejection set
            if (!rejectsByFunction.has(asyncFunc.id)) {
              rejectsByFunction.set(asyncFunc.id, new Set());
            }
            const callerRejects = rejectsByFunction.get(asyncFunc.id)!;

            // Propagate each rejection type
            for (const errorClassId of targetRejects) {
              if (!callerRejects.has(errorClassId)) {
                // Use addEdges with skipValidation=true because the dst (CLASS node)
                // may not exist as a graph node (e.g., built-in Error classes)
                const graphWithAddEdges = graph as unknown as {
                  addEdges(edges: EdgeRecord[], skipValidation?: boolean): Promise<void>
                };
                await graphWithAddEdges.addEdges([{
                  type: 'REJECTS',
                  src: asyncFunc.id,
                  dst: errorClassId,
                  metadata: {
                    rejectionType: 'propagated',
                    propagatedFrom: targetId
                  }
                }], true /* skipValidation */);

                callerRejects.add(errorClassId);
                iterationEdges++;
                totalEdgesCreated++;
                changed = true;
              }
            }
          }
        }
      }

      logger.debug('Propagation iteration completed', { iteration: iterations, edgesCreated: iterationEdges });
    }

    const summary = {
      iterations,
      asyncFunctionsProcessed: asyncFunctions.length,
      edgesCreated: totalEdgesCreated
    };

    logger.info('Rejection propagation completed', summary);

    return createSuccessResult({ nodes: 0, edges: totalEdgesCreated }, summary);
  }

  /**
   * Find the containing FUNCTION node for a given node ID.
   * Walks up CONTAINS and HAS_SCOPE edges until a FUNCTION is found.
   */
  private async findContainingFunction(
    nodeId: string,
    functionIndex: Map<string, FunctionNode>,
    graph: PluginContext['graph']
  ): Promise<string | null> {
    const visited = new Set<string>();
    let currentId = nodeId;
    const maxDepth = 20;
    let depth = 0;

    while (depth < maxDepth) {
      depth++;

      if (visited.has(currentId)) {
        break; // Cycle detected
      }
      visited.add(currentId);

      // Get incoming CONTAINS and HAS_SCOPE edges
      // SCOPE -> CONTAINS -> CALL
      // FUNCTION -> HAS_SCOPE -> SCOPE
      const incomingEdges = await graph.getIncomingEdges(currentId, ['CONTAINS', 'HAS_SCOPE']);

      if (incomingEdges.length === 0) {
        break; // No more parents
      }

      const parentId = incomingEdges[0].src;

      // Check if parent is a FUNCTION
      if (functionIndex.has(parentId)) {
        return parentId;
      }

      currentId = parentId;
    }

    return null;
  }
}
