/**
 * Find all CALL and METHOD_CALL nodes inside a function.
 *
 * Graph structure:
 * ```
 * FUNCTION -[HAS_SCOPE]-> SCOPE -[CONTAINS]-> CALL
 *                         SCOPE -[CONTAINS]-> METHOD_CALL
 *                         SCOPE -[CONTAINS]-> SCOPE (nested blocks)
 * ```
 *
 * Algorithm:
 * 1. Get function's scope via HAS_SCOPE edge
 * 2. BFS through CONTAINS edges, collecting CALL and METHOD_CALL nodes
 * 3. Stop at nested FUNCTION/CLASS boundaries (don't enter inner functions)
 * 4. For each call, check CALLS edge to determine if resolved
 * 5. If transitive=true, recursively follow resolved CALLS edges
 *
 * Performance: O(S + C) where S = scopes, C = calls
 * For functions with 100 calls, expect ~200 DB operations.
 *
 * @module queries/findCallsInFunction
 */

import type { CallInfo, FindCallsOptions } from './types.js';

/**
 * Graph backend interface (minimal surface)
 */
interface GraphBackend {
  getNode(id: string): Promise<{
    id: string;
    type: string;
    name?: string;
    file?: string;
    line?: number;
    object?: string;
  } | null>;
  getOutgoingEdges(
    nodeId: string,
    edgeTypes: string[] | null
  ): Promise<Array<{ src: string; dst: string; type: string }>>;
}

/**
 * Find all CALL and METHOD_CALL nodes inside a function.
 *
 * @param backend - Graph backend for queries
 * @param functionId - ID of the FUNCTION node
 * @param options - Options for traversal
 * @returns Array of CallInfo objects
 */
export async function findCallsInFunction(
  backend: GraphBackend,
  functionId: string,
  options: FindCallsOptions = {}
): Promise<CallInfo[]> {
  const {
    maxDepth = 10,
    transitive = false,
    transitiveDepth = 5,
  } = options;

  const calls: CallInfo[] = [];
  const visited = new Set<string>();
  const seenTargets = new Set<string>(); // For deduplication in transitive mode

  // Add the starting function to seenTargets to prevent cycles back to it
  if (transitive) {
    seenTargets.add(functionId);
  }

  // Step 1: Get function's scope via HAS_SCOPE
  const hasScopeEdges = await backend.getOutgoingEdges(functionId, ['HAS_SCOPE']);

  // BFS queue: { nodeId, currentDepth }
  const queue: Array<{ id: string; depth: number }> = [];

  for (const edge of hasScopeEdges) {
    queue.push({ id: edge.dst, depth: 0 });
  }

  // Step 2: BFS through scopes
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    const containsEdges = await backend.getOutgoingEdges(id, ['CONTAINS']);

    for (const edge of containsEdges) {
      const child = await backend.getNode(edge.dst);
      if (!child) continue;

      // Collect CALL and METHOD_CALL nodes
      if (child.type === 'CALL' || child.type === 'METHOD_CALL') {
        const callInfo = await buildCallInfo(backend, child, 0);
        calls.push(callInfo);

        // Transitive: follow resolved calls
        if (transitive && callInfo.resolved && callInfo.target) {
          await collectTransitiveCalls(
            backend,
            callInfo.target.id,
            1, // Starting at depth 1
            transitiveDepth,
            calls,
            seenTargets
          );
        }
      }

      // Continue into nested scopes, but NOT into nested functions/classes
      if (child.type === 'SCOPE') {
        queue.push({ id: child.id, depth: depth + 1 });
      }
      // Skip FUNCTION, CLASS - they have their own scope hierarchy
    }
  }

  return calls;
}

/**
 * Build CallInfo from a call node
 */
async function buildCallInfo(
  backend: GraphBackend,
  callNode: { id: string; type: string; name?: string; file?: string; line?: number; object?: string },
  depth: number
): Promise<CallInfo> {
  // Check for CALLS edge (resolved target)
  const callsEdges = await backend.getOutgoingEdges(callNode.id, ['CALLS']);
  const isResolved = callsEdges.length > 0;

  let target = undefined;
  if (isResolved) {
    const targetNode = await backend.getNode(callsEdges[0].dst);
    if (targetNode) {
      target = {
        id: targetNode.id,
        name: targetNode.name ?? '<anonymous>',
        file: targetNode.file,
        line: targetNode.line,
      };
    }
  }

  return {
    id: callNode.id,
    name: callNode.name ?? '<unknown>',
    type: callNode.type as 'CALL' | 'METHOD_CALL',
    object: callNode.object,
    resolved: isResolved,
    target,
    file: callNode.file,
    line: callNode.line,
    depth,
  };
}

/**
 * Recursively collect transitive calls
 *
 * Infinite loop prevention:
 * - Track seen function IDs in seenTargets
 * - Stop when we've seen a function before (handles recursion)
 * - Stop at transitiveDepth limit
 */
async function collectTransitiveCalls(
  backend: GraphBackend,
  functionId: string,
  currentDepth: number,
  maxTransitiveDepth: number,
  calls: CallInfo[],
  seenTargets: Set<string>
): Promise<void> {
  // Prevent infinite loops and limit depth
  if (seenTargets.has(functionId) || currentDepth > maxTransitiveDepth) {
    return;
  }
  seenTargets.add(functionId);

  // Find calls in this function (non-transitive to avoid recursion)
  const innerCalls = await findCallsInFunction(backend, functionId, {
    maxDepth: 10,
    transitive: false,
  });

  for (const call of innerCalls) {
    // Add with updated depth
    calls.push({ ...call, depth: currentDepth });

    // Continue transitively if resolved
    if (call.resolved && call.target) {
      await collectTransitiveCalls(
        backend,
        call.target.id,
        currentDepth + 1,
        maxTransitiveDepth,
        calls,
        seenTargets
      );
    }
  }
}
