/**
 * Topological sort for plugin dependency ordering (REG-367).
 *
 * Uses Kahn's algorithm (BFS-based) to sort items by their declared dependencies.
 * Dependencies not present in the input set are silently ignored (cross-phase deps).
 * When multiple items have zero in-degree, they are emitted in input order
 * (registration order tiebreaker).
 *
 * Time complexity:  O(V + E)
 * Space complexity: O(V + E)
 */

/**
 * Thrown when a dependency cycle is detected during topological sort.
 */
export class CycleError extends Error {
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    this.name = 'CycleError';
    this.cycle = cycle;
  }
}

/**
 * Input item for topological sort.
 */
export interface ToposortItem {
  id: string;
  dependencies: string[];
}

/**
 * Topologically sort items by their dependencies using Kahn's algorithm.
 *
 * Dependencies not present in the input set are silently ignored (cross-phase).
 * Throws CycleError if a dependency cycle exists among the items.
 * Items with no dependency relationship are emitted in their original input order.
 *
 * @param items - Array of items with id and dependencies
 * @returns Array of IDs in topological order (dependencies first)
 * @throws CycleError if a dependency cycle exists
 */
export function toposort(items: ToposortItem[]): string[] {
  if (items.length === 0) return [];

  // Build the set of known IDs for filtering cross-phase deps
  const knownIds = new Set(items.map(item => item.id));

  // adjacency: dep -> list of items that depend on it (successors)
  const successors = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  // Initialize
  for (const item of items) {
    successors.set(item.id, []);
    inDegree.set(item.id, 0);
  }

  // Build edges: for each item's dependency that is in the same set,
  // add edge from dependency -> item (dependency must execute first)
  for (const item of items) {
    for (const dep of item.dependencies) {
      if (!knownIds.has(dep)) continue; // cross-phase, ignore
      successors.get(dep)!.push(item.id);
      inDegree.set(item.id, inDegree.get(item.id)! + 1);
    }
  }

  // Initialize queue with all zero-in-degree items, preserving input order
  const queue: string[] = [];
  for (const item of items) {
    if (inDegree.get(item.id) === 0) {
      queue.push(item.id);
    }
  }

  // Process queue (FIFO for registration-order tiebreaker)
  const result: string[] = [];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    result.push(current);

    for (const successor of successors.get(current)!) {
      const newDegree = inDegree.get(successor)! - 1;
      inDegree.set(successor, newDegree);
      if (newDegree === 0) {
        queue.push(successor);
      }
    }
  }

  // If not all items were processed, there's a cycle
  if (result.length < items.length) {
    const cycle = findCycle(items, knownIds, result);
    throw new CycleError(cycle);
  }

  return result;
}

/**
 * Find a cycle among unprocessed items using DFS.
 * Returns the cycle as an array of IDs ending with a repeat of the first.
 */
function findCycle(items: ToposortItem[], knownIds: Set<string>, processed: string[]): string[] {
  const processedSet = new Set(processed);
  const unprocessed = items.filter(item => !processedSet.has(item.id));

  // Build adjacency for unprocessed items only
  const deps = new Map<string, string[]>();
  for (const item of unprocessed) {
    deps.set(item.id, item.dependencies.filter(d => knownIds.has(d) && !processedSet.has(d)));
  }

  // DFS to find cycle
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  for (const item of unprocessed) {
    const cycle = dfs(item.id, deps, visiting, visited, path);
    if (cycle) return cycle;
  }

  // Fallback: shouldn't reach here, but return the unprocessed IDs
  return [...unprocessed.map(i => i.id), unprocessed[0].id];
}

function dfs(
  node: string,
  deps: Map<string, string[]>,
  visiting: Set<string>,
  visited: Set<string>,
  path: string[]
): string[] | null {
  if (visited.has(node)) return null;

  if (visiting.has(node)) {
    // Found cycle — extract it from path
    const cycleStart = path.indexOf(node);
    return [...path.slice(cycleStart), node];
  }

  visiting.add(node);
  path.push(node);

  for (const dep of deps.get(node) ?? []) {
    const cycle = dfs(dep, deps, visiting, visited, path);
    if (cycle) return cycle;
  }

  path.pop();
  visiting.delete(node);
  visited.add(node);
  return null;
}
