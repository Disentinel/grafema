/**
 * ArgumentParameterLinker - creates RECEIVES_ARGUMENT edges connecting
 * function parameters to call arguments.
 *
 * RECEIVES_ARGUMENT edges connect:
 *   PARAMETER node -> RECEIVES_ARGUMENT -> argument source (VARIABLE, LITERAL, CALL, etc.)
 *
 * This is the inverse of PASSES_ARGUMENT:
 *   - PASSES_ARGUMENT: CALL -> argument (call site perspective)
 *   - RECEIVES_ARGUMENT: PARAMETER -> argument (function perspective)
 *
 * Edge attributes:
 *   - argIndex: position of the argument (0-based)
 *   - callId: ID of the CALL node that passed this argument
 *
 * Algorithm:
 * For each CALL node with PASSES_ARGUMENT edges:
 *   1. Get outgoing CALLS edge to find target function
 *   2. If no CALLS edge -> skip (unresolved call)
 *   3. Get target function's PARAMETER nodes via HAS_PARAMETER edges
 *   4. For each PASSES_ARGUMENT edge:
 *      a. Get argIndex from edge metadata
 *      b. Find PARAMETER with matching index
 *      c. Create RECEIVES_ARGUMENT edge: PARAMETER -> argument_source
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord, EdgeRecord } from '@grafema/types';
import { StrictModeError } from '../../errors/GrafemaError.js';

/**
 * Extended call node type
 */
interface CallNode extends BaseNodeRecord {
  // All properties inherited from BaseNodeRecord
}

/**
 * Extended parameter node type
 */
interface ParameterNode extends BaseNodeRecord {
  index?: number;
}

/**
 * Edge with metadata for PASSES_ARGUMENT
 */
interface PassesArgumentEdge extends EdgeRecord {
  argIndex?: number;
  isSpread?: boolean;
}

/**
 * Edge record with extended fields for RECEIVES_ARGUMENT lookup
 */
interface ExtendedEdgeRecord extends EdgeRecord {
  callId?: string;
}

export class ArgumentParameterLinker extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ArgumentParameterLinker',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],
        edges: ['RECEIVES_ARGUMENT']
      },
      dependencies: ['JSASTAnalyzer', 'MethodCallResolver'], // Requires CALLS edges
      consumes: ['PASSES_ARGUMENT', 'CALLS', 'HAS_PARAMETER', 'RECEIVES_ARGUMENT'],
      produces: ['RECEIVES_ARGUMENT']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    logger.info('Starting argument-parameter linking');

    const startTime = Date.now();

    let callsProcessed = 0;
    let edgesCreated = 0;
    let unresolvedCalls = 0;
    let noParams = 0;
    const errors: Error[] = [];

    // Collect all CALL nodes (both CALL and METHOD_CALL via CALL type check)
    const callNodes: CallNode[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      callNodes.push(node as CallNode);
    }

    logger.info('Found calls to process', { count: callNodes.length });

    // Build a Set of existing RECEIVES_ARGUMENT edges to avoid duplicates
    // Key: `${paramId}:${dstId}:${callId}`
    const existingEdges = new Set<string>();
    for await (const node of graph.queryNodes({ nodeType: 'PARAMETER' })) {
      const edges = await graph.getOutgoingEdges(node.id, ['RECEIVES_ARGUMENT']) as ExtendedEdgeRecord[];
      for (const edge of edges) {
        const callId = edge.callId ?? (edge.metadata?.callId as string | undefined) ?? '';
        existingEdges.add(`${node.id}:${edge.dst}:${callId}`);
      }
    }
    logger.debug('Found existing RECEIVES_ARGUMENT edges', { count: existingEdges.size });

    for (const callNode of callNodes) {
      callsProcessed++;

      // Report progress every 100 calls
      if (onProgress && callsProcessed % 100 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'ArgumentParameterLinker',
          message: `Linking arguments ${callsProcessed}/${callNodes.length} (${elapsed}s)`,
          totalFiles: callNodes.length,
          processedFiles: callsProcessed
        });
      }

      // 1. Get PASSES_ARGUMENT edges from this call
      const passesArgumentEdges = await graph.getOutgoingEdges(callNode.id, ['PASSES_ARGUMENT']);
      if (passesArgumentEdges.length === 0) {
        continue; // No arguments passed, skip
      }

      // 2. Get CALLS edge to find target function
      const callsEdges = await graph.getOutgoingEdges(callNode.id, ['CALLS']);
      if (callsEdges.length === 0) {
        unresolvedCalls++;

        // In strict mode, report unresolved calls that have arguments
        if (context.strictMode) {
          const error = new StrictModeError(
            `Call with arguments has no resolved target: ${callNode.name || callNode.id}`,
            'STRICT_UNRESOLVED_ARGUMENT',
            {
              filePath: callNode.file,
              lineNumber: callNode.line as number | undefined,
              phase: 'ENRICHMENT',
              plugin: 'ArgumentParameterLinker',
              callId: callNode.id,
            },
            `Ensure the called function is imported or defined`
          );
          errors.push(error);
        }
        continue; // Unresolved call, skip
      }

      // Get target function node
      const targetFunctionId = callsEdges[0].dst;
      const targetFunction = await graph.getNode(targetFunctionId);
      if (!targetFunction) {
        unresolvedCalls++;
        continue;
      }

      // 3. Get target function's PARAMETER nodes via HAS_PARAMETER edges
      const hasParameterEdges = await graph.getOutgoingEdges(targetFunctionId, ['HAS_PARAMETER']);
      if (hasParameterEdges.length === 0) {
        noParams++;
        continue; // Function has no parameters
      }

      // Build parameter index map: argIndex -> paramNode
      const paramsByIndex = new Map<number, ParameterNode>();
      for (const paramEdge of hasParameterEdges) {
        const paramNode = await graph.getNode(paramEdge.dst) as ParameterNode | null;
        if (paramNode && typeof paramNode.index === 'number') {
          paramsByIndex.set(paramNode.index, paramNode);
        }
      }

      if (paramsByIndex.size === 0) {
        noParams++;
        continue;
      }

      // 4. For each PASSES_ARGUMENT edge, create RECEIVES_ARGUMENT edge
      for (const passesEdge of passesArgumentEdges as PassesArgumentEdge[]) {
        // Get argIndex from edge (can be top-level or in metadata)
        const argIndex = passesEdge.argIndex ?? (passesEdge.metadata?.argIndex as number | undefined);
        if (argIndex === undefined) {
          continue; // No argIndex, skip
        }

        // Find matching parameter
        const paramNode = paramsByIndex.get(argIndex);
        if (!paramNode) {
          continue; // No parameter for this argument index (extra arg)
        }

        // Check for duplicate
        const edgeKey = `${paramNode.id}:${passesEdge.dst}:${callNode.id}`;
        if (existingEdges.has(edgeKey)) {
          continue; // Already exists
        }

        // Create RECEIVES_ARGUMENT edge: PARAMETER -> argument_source
        await graph.addEdge({
          type: 'RECEIVES_ARGUMENT',
          src: paramNode.id,
          dst: passesEdge.dst,
          metadata: {
            argIndex,
            callId: callNode.id
          }
        });

        existingEdges.add(edgeKey);
        edgesCreated++;
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info('Complete', {
      callsProcessed,
      edgesCreated,
      unresolvedCalls,
      noParams,
      time: `${totalTime}s`
    });

    return createSuccessResult(
      { nodes: 0, edges: edgesCreated },
      {
        callsProcessed,
        edgesCreated,
        unresolvedCalls,
        noParams,
        timeMs: Date.now() - startTime
      },
      errors
    );
  }
}
