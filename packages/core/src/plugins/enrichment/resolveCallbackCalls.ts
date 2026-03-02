/**
 * resolveCallbackCalls - creates CALLS edges for parameter callback invocations
 *
 * When a function parameter receives a callable argument (FUNCTION, IMPORT, VARIABLE),
 * finds inner CALL nodes that invoke that parameter and creates transitive CALLS edges.
 *
 * Called from ArgumentParameterLinker after creating each RECEIVES_ARGUMENT edge.
 * Zero additional graph iteration -- piggybacks on existing CALL loop.
 */

import type { GraphBackend, NodeRecord } from '@grafema/types';

/** Minimal parameter node shape expected by this function */
interface ParameterNodeInfo {
  id: string;
  name?: string;
  index?: number;
  file?: string;
}

/** Info about the RECEIVES_ARGUMENT edge that triggered callback resolution */
interface ReceivesArgEdgeInfo {
  dst: string;
  metadata?: Record<string, unknown>;
}

/** Maximum depth for ASSIGNED_FROM chain traversal (prevents cycles in degenerate cases) */
const MAX_ASSIGNED_FROM_DEPTH = 5;

/**
 * Resolve an IMPORT node to the target FUNCTION ID by following the import chain:
 * IMPORT -> IMPORTS_FROM -> EXPORT -> find FUNCTION by export's local name and file.
 */
async function resolveImportToFunction(
  graph: GraphBackend,
  importNodeId: string
): Promise<string | null> {
  const importsFromEdges = await graph.getOutgoingEdges(importNodeId, ['IMPORTS_FROM']);
  if (importsFromEdges.length === 0) return null;

  const exportNode = await graph.getNode(importsFromEdges[0].dst);
  if (!exportNode || exportNode.type !== 'EXPORT') return null;

  const targetFile = exportNode.file;
  // EXPORT nodes carry `local` as a top-level field (set by ExportNode.create/createWithContext)
  const localField = exportNode['local'];
  const targetFunctionName = (typeof localField === 'string' ? localField : null)
    || exportNode.name;
  if (!targetFile || !targetFunctionName) return null;

  // Find FUNCTION node in target file with matching name
  for await (const node of graph.queryNodes({ nodeType: 'FUNCTION', file: targetFile })) {
    if (node.name === targetFunctionName) {
      return node.id;
    }
  }

  return null;
}

/**
 * Resolve a VARIABLE node to a FUNCTION ID by following ASSIGNED_FROM edges.
 * Walks the chain up to MAX_ASSIGNED_FROM_DEPTH to prevent infinite loops.
 */
async function resolveVariableToFunction(
  graph: GraphBackend,
  variableNodeId: string
): Promise<string | null> {
  const visited = new Set<string>();
  let currentId = variableNodeId;

  for (let depth = 0; depth < MAX_ASSIGNED_FROM_DEPTH; depth++) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);

    const assignedFromEdges = await graph.getOutgoingEdges(currentId, ['ASSIGNED_FROM']);
    if (assignedFromEdges.length === 0) return null;

    const targetNode = await graph.getNode(assignedFromEdges[0].dst);
    if (!targetNode) return null;

    if (targetNode.type === 'FUNCTION') {
      return targetNode.id;
    }

    if (targetNode.type === 'IMPORT') {
      return resolveImportToFunction(graph, targetNode.id);
    }

    if (targetNode.type === 'VARIABLE') {
      currentId = targetNode.id;
      continue;
    }

    return null;
  }

  return null;
}

/**
 * Collect callable names for scope-tree matching.
 * Starts with the parameter name, then adds names of VARIABLE nodes
 * that have ASSIGNED_FROM edges pointing to the parameter (aliases).
 */
async function collectCallableNames(
  graph: GraphBackend,
  parameterNodeId: string,
  parameterName: string
): Promise<Set<string>> {
  const names = new Set<string>();
  names.add(parameterName);

  // Find variables that are assigned from this parameter (aliases)
  const incomingAssigned = await graph.getIncomingEdges(parameterNodeId, ['ASSIGNED_FROM']);
  for (const edge of incomingAssigned) {
    const node = await graph.getNode(edge.src);
    if (node && node.name) {
      names.add(node.name);
    }
  }

  return names;
}

/**
 * Walk the scope tree of a function recursively, collecting CALL nodes
 * whose name matches any of the callable names.
 *
 * Traversal:
 * - FUNCTION -> HAS_SCOPE -> SCOPE
 * - SCOPE -> CONTAINS -> CALL (check name match)
 * - SCOPE -> CONTAINS -> SCOPE (nested scopes: if/for/try) -> recurse
 * - SCOPE -> CONTAINS -> FUNCTION (nested closures) -> HAS_SCOPE -> SCOPE -> recurse
 */
async function findMatchingCallsInScope(
  graph: GraphBackend,
  scopeId: string,
  callableNames: Set<string>,
  visited: Set<string>
): Promise<NodeRecord[]> {
  if (visited.has(scopeId)) return [];
  visited.add(scopeId);

  const matchingCalls: NodeRecord[] = [];
  const containsEdges = await graph.getOutgoingEdges(scopeId, ['CONTAINS']);

  for (const edge of containsEdges) {
    const childNode = await graph.getNode(edge.dst);
    if (!childNode) continue;

    if (childNode.type === 'CALL' && childNode.name && callableNames.has(childNode.name)) {
      matchingCalls.push(childNode);
    } else if (childNode.type === 'SCOPE') {
      // Recurse into nested scopes (if/for/try blocks)
      const nested = await findMatchingCallsInScope(graph, childNode.id, callableNames, visited);
      matchingCalls.push(...nested);
    } else if (childNode.type === 'FUNCTION') {
      // Check if the nested function shadows any callable name via its own parameters
      const paramEdges = await graph.getOutgoingEdges(childNode.id, ['HAS_PARAMETER']);
      const shadowedNames = new Set<string>();
      for (const pe of paramEdges) {
        const paramNode = await graph.getNode(pe.dst);
        if (paramNode?.name && callableNames.has(paramNode.name)) {
          shadowedNames.add(paramNode.name);
        }
      }

      // Only recurse with names that are NOT shadowed by the nested function
      const effectiveNames = shadowedNames.size === 0
        ? callableNames
        : new Set([...callableNames].filter(n => !shadowedNames.has(n)));

      if (effectiveNames.size > 0) {
        const hasScopeEdges = await graph.getOutgoingEdges(childNode.id, ['HAS_SCOPE']);
        for (const scopeEdge of hasScopeEdges) {
          const nested = await findMatchingCallsInScope(graph, scopeEdge.dst, effectiveNames, visited);
          matchingCalls.push(...nested);
        }
      }
    }
  }

  return matchingCalls;
}

/**
 * Creates CALLS edges for parameter callback invocations.
 *
 * When a function parameter receives a callable argument (FUNCTION, IMPORT, VARIABLE),
 * this function finds inner CALL nodes that invoke that parameter and creates
 * transitive CALLS edges from those inner calls to the resolved function.
 *
 * @param graph - The graph backend
 * @param parameterNode - The PARAMETER node receiving the argument
 * @param receivesArgEdge - Info about the RECEIVES_ARGUMENT edge (dst is the argument source)
 * @param existingCallsEdges - Set of "src:dst" keys for deduplication across multiple calls
 * @returns Number of CALLS edges created
 */
export async function resolveCallbackCalls(
  graph: GraphBackend,
  parameterNode: ParameterNodeInfo,
  receivesArgEdge: ReceivesArgEdgeInfo,
  existingCallsEdges?: Set<string>
): Promise<number> {
  const dedup = existingCallsEdges ?? new Set<string>();

  // Step 1: Get the dst node (the argument source)
  const dstNode = await graph.getNode(receivesArgEdge.dst);
  if (!dstNode) return 0;

  // Only process callable types
  if (dstNode.type !== 'FUNCTION' && dstNode.type !== 'IMPORT' && dstNode.type !== 'VARIABLE') {
    return 0;
  }

  // Step 2: Resolve dst -> FUNCTION id
  let resolvedFunctionId: string | null = null;

  if (dstNode.type === 'FUNCTION') {
    resolvedFunctionId = dstNode.id;
  } else if (dstNode.type === 'IMPORT') {
    resolvedFunctionId = await resolveImportToFunction(graph, dstNode.id);
  } else if (dstNode.type === 'VARIABLE') {
    resolvedFunctionId = await resolveVariableToFunction(graph, dstNode.id);
  }

  if (!resolvedFunctionId) return 0;

  // Parameter must have a name to match against inner CALL nodes
  if (!parameterNode.name) return 0;

  // Step 3: Find parent FUNCTION via incoming HAS_PARAMETER edges
  const hasParameterEdges = await graph.getIncomingEdges(parameterNode.id, ['HAS_PARAMETER']);
  if (hasParameterEdges.length === 0) return 0;

  const parentFunctionId = hasParameterEdges[0].src;

  // Step 4: Collect callable names (parameter name + aliases)
  const callableNames = await collectCallableNames(
    graph,
    parameterNode.id,
    parameterNode.name
  );

  // Step 5: Walk the parent function's scope tree
  const hasScopeEdges = await graph.getOutgoingEdges(parentFunctionId, ['HAS_SCOPE']);
  const visited = new Set<string>();
  const matchingCalls: NodeRecord[] = [];

  for (const scopeEdge of hasScopeEdges) {
    const calls = await findMatchingCallsInScope(
      graph,
      scopeEdge.dst,
      callableNames,
      visited
    );
    matchingCalls.push(...calls);
  }

  // Step 6: Create CALLS edges for each matching inner call
  let edgesCreated = 0;

  for (const innerCall of matchingCalls) {
    const edgeKey = `${innerCall.id}:${resolvedFunctionId}`;
    if (dedup.has(edgeKey)) continue;

    // Check if edge already exists in graph (idempotency)
    const existingEdges = await graph.getOutgoingEdges(innerCall.id, ['CALLS']);
    const alreadyExists = existingEdges.some(e => e.dst === resolvedFunctionId);
    if (alreadyExists) {
      dedup.add(edgeKey);
      continue;
    }

    await graph.addEdge({
      type: 'CALLS',
      src: innerCall.id,
      dst: resolvedFunctionId,
      metadata: { callType: 'callback' }
    });

    dedup.add(edgeKey);
    edgesCreated++;
  }

  return edgesCreated;
}
