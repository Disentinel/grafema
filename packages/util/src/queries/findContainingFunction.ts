/**
 * Find the FUNCTION, CLASS, or MODULE that contains a node.
 *
 * Supports two graph layouts:
 *
 * Layout A (scope chain — legacy JS analyzer):
 * ```
 * CALL <- CONTAINS <- SCOPE <- ... <- SCOPE <- HAS_SCOPE <- FUNCTION
 * VARIABLE <- DECLARES <- SCOPE <- ... <- SCOPE <- HAS_SCOPE <- FUNCTION
 * ```
 *
 * Layout B (direct edges — Rust orchestrator):
 * ```
 * CALL <- AWAITS|RETURNS|THROWS <- FUNCTION
 * ```
 * The orchestrator links functions directly to their call nodes via
 * semantic edge types. These incoming edges on a CALL node point
 * directly back to the containing FUNCTION.
 *
 * Algorithm:
 * 1. BFS up via CONTAINS, HAS_SCOPE, DECLARES (Layout A)
 * 2. Also follow AWAITS, RETURNS, THROWS incoming edges (Layout B)
 * 3. Stop when we find FUNCTION, CLASS, or MODULE
 * 4. Prefer FUNCTION over MODULE (FUNCTION is more specific)
 *
 * @module queries/findContainingFunction
 */

import type { CallerInfo } from './types.js';

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
  } | null>;
  getIncomingEdges(
    nodeId: string,
    edgeTypes: string[] | null
  ): Promise<Array<{ src: string; dst: string; type: string }>>;
}

/**
 * Maximum BFS depth for upward containment traversal.
 *
 * Each depth level = one CONTAINS/HAS_SCOPE/DECLARES hop.
 * Typical real-world nesting: 3-7 levels (function body → if → loop → try → ...).
 * Set to 15 to handle pathological cases (deeply nested callbacks, complex control flow)
 * while still bounding traversal in malformed graphs.
 */
const DEFAULT_MAX_DEPTH = 15;

/**
 * Find the FUNCTION, CLASS, or MODULE that contains a node.
 *
 * @param backend - Graph backend for queries
 * @param nodeId - ID of the node to find container for
 * @param maxDepth - Maximum traversal depth (default: {@link DEFAULT_MAX_DEPTH}).
 *   Traversal visits depths 0 through maxDepth inclusive.
 * @returns CallerInfo or null if no container found within maxDepth hops
 */
export async function findContainingFunction(
  backend: GraphBackend,
  nodeId: string,
  maxDepth: number = DEFAULT_MAX_DEPTH
): Promise<CallerInfo | null> {
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

  // Collect all candidates so we can prefer FUNCTION over MODULE
  let bestCandidate: CallerInfo | null = null;

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    // Layout A edges: CONTAINS, HAS_SCOPE, DECLARES (scope chain traversal)
    // Layout B edges: AWAITS, RETURNS, THROWS (direct function-to-call edges)
    const edges = await backend.getIncomingEdges(id, [
      'CONTAINS', 'HAS_SCOPE', 'DECLARES',
      'AWAITS', 'RETURNS', 'THROWS',
    ]);

    for (const edge of edges) {
      const parentNode = await backend.getNode(edge.src);
      if (!parentNode || visited.has(parentNode.id)) continue;

      // Found container!
      if (parentNode.type === 'FUNCTION' || parentNode.type === 'CLASS' || parentNode.type === 'MODULE') {
        const candidate: CallerInfo = {
          id: parentNode.id,
          name: parentNode.name || '<anonymous>',
          type: parentNode.type,
          file: parentNode.file,
          line: parentNode.line,
        };

        // FUNCTION/CLASS is most specific — return immediately
        if (parentNode.type === 'FUNCTION' || parentNode.type === 'CLASS') {
          return candidate;
        }

        // MODULE is less specific — keep as fallback, continue searching
        if (!bestCandidate) {
          bestCandidate = candidate;
        }

        continue;
      }

      // Continue searching
      queue.push({ id: parentNode.id, depth: depth + 1 });
    }
  }

  return bestCandidate;
}
