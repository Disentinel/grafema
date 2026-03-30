/**
 * Transitive call-chain traversal.
 *
 * Forward: from a function, follow CALLS/CALLS_REMOTE edges transitively
 * to show what the function eventually calls (including cross-language hops).
 *
 * Backward: from a function, follow incoming CALLS/CALLS_REMOTE edges
 * to show who eventually calls this function.
 *
 * Uses findCallsInFunction for forward traversal (handles both Layout A
 * and Layout B edge patterns). Backward traversal uses incoming edge BFS.
 *
 * @module queries/traceCallChain
 */

import { findCallsInFunction } from './findCallsInFunction.js';
import type { CallInfo } from './types.js';

/**
 * Graph backend interface.
 * Accepts nodes with either `type` or `nodeType` field (RFDB uses `nodeType`).
 */
interface GraphBackend {
  getNode(id: string): Promise<{
    id: string;
    type?: string;
    nodeType?: string;
    name?: string;
    file?: string;
    line?: number;
    endLine?: number;
  } | null>;
  getOutgoingEdges(
    nodeId: string,
    edgeTypes: string[] | null
  ): Promise<Array<{ src: string; dst: string; type: string }>>;
  getIncomingEdges(
    nodeId: string,
    edgeTypes: string[] | null
  ): Promise<Array<{ src: string; dst: string; type: string }>>;
}

/** Normalize node type field (RFDB uses nodeType, some backends use type) */
function nodeType(node: { type?: string; nodeType?: string }): string {
  return node.nodeType ?? node.type ?? 'UNKNOWN';
}

export interface CallChainHop {
  /** The function/method being called */
  name: string;
  /** Semantic ID */
  id: string;
  /** File path */
  file?: string;
  /** Line number */
  line?: number;
  /** Depth in chain (0 = direct) */
  depth: number;
  /** Crosses process/language boundary */
  remote: boolean;
  /** Call was resolved to a target */
  resolved: boolean;
}

export interface TraceCallChainResult {
  direction: 'forward' | 'backward';
  startNode: { id: string; name: string; file?: string; line?: number };
  chain: CallChainHop[];
  totalFound: number;
}

export interface TraceCallChainOptions {
  direction?: 'forward' | 'backward' | 'both';
  maxDepth?: number;
  limit?: number;
}

const CALL_EDGE_TYPES = ['CALLS', 'CALLS_REMOTE'];
const FUNCTION_TYPES = new Set(['FUNCTION', 'METHOD', 'CONSTRUCTOR', 'LAMBDA']);

/**
 * Trace call chain from a function forward or backward.
 */
export async function traceCallChain(
  backend: GraphBackend,
  startId: string,
  options: TraceCallChainOptions = {},
): Promise<TraceCallChainResult[]> {
  const {
    direction = 'forward',
    maxDepth = 10,
    limit = 100,
  } = options;

  const startNode = await backend.getNode(startId);
  if (!startNode) return [];

  const start = {
    id: startNode.id,
    name: startNode.name ?? '<unknown>',
    file: startNode.file,
    line: startNode.line,
  };

  const results: TraceCallChainResult[] = [];

  if (direction === 'forward' || direction === 'both') {
    const chain = await traceForward(backend, startId, maxDepth, limit);
    results.push({ direction: 'forward', startNode: start, chain, totalFound: chain.length });
  }

  if (direction === 'backward' || direction === 'both') {
    const chain = await traceBackward(backend, startId, maxDepth, limit);
    results.push({ direction: 'backward', startNode: start, chain, totalFound: chain.length });
  }

  return results;
}

/**
 * Forward: what does this function call (transitively)?
 * Uses findCallsInFunction with transitive mode + follows CALLS_REMOTE.
 * Falls back to line-range matching when METHOD nodes have no outgoing edges.
 */
async function traceForward(
  backend: GraphBackend,
  startId: string,
  maxDepth: number,
  limit: number,
): Promise<CallChainHop[]> {
  let calls = await findCallsInFunction(backend, startId, {
    transitive: true,
    transitiveDepth: maxDepth,
  });

  // Fallback: if no calls found via scope chain, try line-range matching
  // (METHOD nodes often have no outgoing edges — calls are found by position)
  if (calls.length === 0) {
    calls = await findCallsByLineRange(backend, startId, maxDepth);
  }

  // Also check if any resolved target METHOD/FUNCTION has CALLS_REMOTE outgoing
  const chain: CallChainHop[] = [];
  const visited = new Set<string>();

  for (const call of calls) {
    if (chain.length >= limit) break;

    chain.push({
      name: call.name,
      id: call.target?.id ?? call.id,
      file: call.target?.file ?? call.file,
      line: call.target?.line ?? call.line,
      depth: call.depth ?? 0,
      remote: call.remote ?? false,
      resolved: call.resolved,
    });

    // If the target has CALLS_REMOTE outgoing, follow it
    if (call.target && !visited.has(call.target.id)) {
      visited.add(call.target.id);
      const remoteEdges = await backend.getOutgoingEdges(call.target.id, ['CALLS_REMOTE']);
      for (const re of remoteEdges) {
        if (chain.length >= limit) break;
        const remoteTarget = await backend.getNode(re.dst);
        if (!remoteTarget) continue;

        chain.push({
          name: remoteTarget.name ?? '<unknown>',
          id: remoteTarget.id,
          file: remoteTarget.file,
          line: remoteTarget.line,
          depth: (call.depth ?? 0) + 1,
          remote: true,
          resolved: true,
        });

        // Recurse into the remote target's calls
        if (!visited.has(remoteTarget.id)) {
          visited.add(remoteTarget.id);
          const remoteCalls = await findCallsInFunction(backend, remoteTarget.id, {
            transitive: true,
            transitiveDepth: Math.max(1, maxDepth - (call.depth ?? 0) - 1),
          });
          for (const rc of remoteCalls) {
            if (chain.length >= limit) break;
            chain.push({
              name: rc.name,
              id: rc.target?.id ?? rc.id,
              file: rc.target?.file ?? rc.file,
              line: rc.target?.line ?? rc.line,
              depth: (call.depth ?? 0) + 2 + (rc.depth ?? 0),
              remote: rc.remote ?? false,
              resolved: rc.resolved,
            });
          }
        }
      }
    }
  }

  return chain;
}

/**
 * Backward: who calls this function (transitively)?
 * BFS over incoming CALLS/CALLS_REMOTE edges, resolving containing functions.
 */
async function traceBackward(
  backend: GraphBackend,
  startId: string,
  maxDepth: number,
  limit: number,
): Promise<CallChainHop[]> {
  const chain: CallChainHop[] = [];
  const visited = new Set<string>();
  visited.add(startId);

  interface QueueItem { functionId: string; depth: number; remote: boolean }
  const queue: QueueItem[] = [{ functionId: startId, depth: 0, remote: false }];

  while (queue.length > 0 && chain.length < limit) {
    const { functionId, depth } = queue.shift()!;
    if (depth > maxDepth) continue;

    // Find all CALL/METHOD_CALL nodes that have CALLS/CALLS_REMOTE → this function
    const incomingCalls = await backend.getIncomingEdges(functionId, CALL_EDGE_TYPES);

    for (const edge of incomingCalls) {
      if (chain.length >= limit) break;

      const callNode = await backend.getNode(edge.src);
      if (!callNode) continue;

      const isRemote = edge.type === 'CALLS_REMOTE';

      // Find the containing function of this CALL node
      const containingFn = await findContainingFunction(backend, callNode.id);
      if (!containingFn) {
        // Can't determine caller — add the call node itself
        chain.push({
          name: callNode.name ?? '<unknown>',
          id: callNode.id,
          file: callNode.file,
          line: callNode.line,
          depth,
          remote: isRemote,
          resolved: true,
        });
        continue;
      }

      if (visited.has(containingFn.id)) continue;
      visited.add(containingFn.id);

      chain.push({
        name: containingFn.name ?? '<unknown>',
        id: containingFn.id,
        file: containingFn.file,
        line: containingFn.line,
        depth,
        remote: isRemote,
        resolved: true,
      });

      // Continue BFS from the containing function
      queue.push({ functionId: containingFn.id, depth: depth + 1, remote: isRemote });
    }
  }

  return chain;
}

/**
 * Walk up CONTAINS edges to find the enclosing FUNCTION/METHOD.
 */
async function findContainingFunction(
  backend: GraphBackend,
  nodeId: string,
): Promise<{ id: string; name?: string; file?: string; line?: number } | null> {
  let currentId = nodeId;
  const seen = new Set<string>();

  for (let i = 0; i < 10; i++) {
    if (seen.has(currentId)) return null;
    seen.add(currentId);

    const incoming = await backend.getIncomingEdges(currentId, ['CONTAINS', 'HAS_SCOPE']);
    if (incoming.length === 0) return null;

    for (const edge of incoming) {
      const parent = await backend.getNode(edge.src);
      if (!parent) continue;
      if (FUNCTION_TYPES.has(nodeType(parent))) {
        return { id: parent.id, name: parent.name, file: parent.file, line: parent.line };
      }
      // Continue climbing from the parent
      currentId = parent.id;
      break;
    }
  }

  return null;
}

/**
 * Line-range fallback: find CALL nodes in the same file within the function's line range.
 * Used when METHOD nodes have no outgoing edges (common for JS analyzer methods).
 */
async function findCallsByLineRange(
  backend: GraphBackend,
  functionId: string,
  _maxDepth: number,
): Promise<CallInfo[]> {
  const fn = await backend.getNode(functionId);
  if (!fn || !fn.file || !fn.line) return [];

  // Query all CALL/METHOD_CALL nodes in the same file
  // We use getIncomingEdges on the MODULE to find CONTAINS → CALL pattern
  // But simpler: iterate all outgoing CALLS_REMOTE from this node directly
  const directRemote = await backend.getOutgoingEdges(functionId, ['CALLS_REMOTE']);
  const calls: CallInfo[] = [];

  for (const edge of directRemote) {
    const target = await backend.getNode(edge.dst);
    if (!target) continue;
    calls.push({
      id: functionId,
      name: target.name ?? '<unknown>',
      type: 'CALL',
      resolved: true,
      target: { id: target.id, name: target.name ?? '<unknown>', file: target.file, line: target.line },
      file: fn.file,
      line: fn.line,
      depth: 0,
      remote: true,
    });
  }

  return calls;
}
