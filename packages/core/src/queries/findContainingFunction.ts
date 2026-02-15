/**
 * Find the FUNCTION, CLASS, or MODULE that contains a node.
 *
 * Graph structure (backward traversal):
 * ```
 * CALL <- CONTAINS <- SCOPE <- ... <- SCOPE <- HAS_SCOPE <- FUNCTION
 * VARIABLE <- DECLARES <- SCOPE <- ... <- SCOPE <- HAS_SCOPE <- FUNCTION
 * ```
 *
 * Algorithm:
 * 1. BFS up the containment tree via CONTAINS and DECLARES edges
 * 2. Also follow HAS_SCOPE edges (connects FUNCTION to its body SCOPE)
 * 3. Stop when we find FUNCTION, CLASS, or MODULE
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

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    // Get incoming edges: CONTAINS, HAS_SCOPE, and DECLARES (for variables)
    const edges = await backend.getIncomingEdges(id, ['CONTAINS', 'HAS_SCOPE', 'DECLARES']);

    for (const edge of edges) {
      const parentNode = await backend.getNode(edge.src);
      if (!parentNode || visited.has(parentNode.id)) continue;

      // Found container!
      if (parentNode.type === 'FUNCTION' || parentNode.type === 'CLASS' || parentNode.type === 'MODULE') {
        return {
          id: parentNode.id,
          name: parentNode.name || '<anonymous>',
          type: parentNode.type,
          file: parentNode.file,
          line: parentNode.line,
        };
      }

      // Continue searching
      queue.push({ id: parentNode.id, depth: depth + 1 });
    }
  }

  return null;
}
