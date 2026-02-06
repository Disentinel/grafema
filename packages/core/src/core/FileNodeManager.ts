/**
 * FileNodeManager - utility for idempotent file node clearing
 *
 * Problem: Multiple phases create nodes for the same file:
 * - INDEXING creates MODULE nodes
 * - ANALYSIS creates FUNCTION, CLASS, SCOPE, etc. nodes
 *
 * When re-analyzing with forceAnalysis=true, we need to clear existing
 * nodes BEFORE any phase creates new nodes for that file.
 *
 * Solution: Track "touched" files. First touch clears all nodes for that file.
 * Subsequent touches (from other phases) are no-ops.
 */

import type { GraphBackend } from '@grafema/types';

/**
 * Clear all nodes for a file if it hasn't been touched yet in this analysis run.
 *
 * Thread-safety note: The touchedFiles Set is shared across concurrent Promise.all
 * calls, but this is safe because:
 * 1. The check (has) and add are synchronous operations
 * 2. We add to the set BEFORE the async clear operation
 * 3. Other concurrent calls will see the file as touched immediately
 *
 * @param graph - Graph backend with deleteNode support
 * @param file - Absolute file path to clear nodes for
 * @param touchedFiles - Set tracking files already touched in this run
 * @returns Number of nodes deleted (0 if file was already touched or backend doesn't support delete)
 */
export async function clearFileNodesIfNeeded(
  graph: GraphBackend,
  file: string,
  touchedFiles: Set<string>
): Promise<number> {
  // Already touched in this run - nothing to clear
  if (touchedFiles.has(file)) {
    return 0;
  }

  // Mark as touched BEFORE clearing (sync operation, makes subsequent concurrent calls no-op)
  touchedFiles.add(file);

  // Skip if backend doesn't support deletion
  if (!graph.deleteNode) {
    return 0;
  }

  // Collect all nodes for this file
  const nodesToDelete: string[] = [];
  for await (const node of graph.queryNodes({ file })) {
    nodesToDelete.push(node.id);
  }

  // Delete all of them - NO EXCLUSIONS
  // MODULE nodes will be recreated by INDEXING phase
  // FUNCTION/CLASS/etc will be recreated by ANALYSIS phase
  for (const id of nodesToDelete) {
    try {
      await graph.deleteNode(id);
    } catch (err) {
      // Log but continue - node might already be deleted by concurrent operation
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[FileNodeManager] Failed to delete ${id}:`, message);
    }
  }

  if (nodesToDelete.length > 0) {
    const fileName = file.split('/').pop() || file;
    console.log(`[FileNodeManager] Cleared ${nodesToDelete.length} nodes for ${fileName}`);
  }

  return nodesToDelete.length;
}

/**
 * Clear a SERVICE node by ID.
 * SERVICE nodes have file=directory_path (not individual files), so they need
 * explicit clearing separate from file-based clearing.
 *
 * @param graph - Graph backend with deleteNode support
 * @param serviceId - SERVICE node ID (e.g., "SERVICE:apps/api")
 * @returns true if node was deleted, false otherwise
 */
export async function clearServiceNodeIfExists(
  graph: GraphBackend,
  serviceId: string
): Promise<boolean> {
  if (!graph.deleteNode) {
    return false;
  }

  try {
    await graph.deleteNode(serviceId);
    console.log(`[FileNodeManager] Cleared SERVICE node: ${serviceId}`);
    return true;
  } catch (err) {
    // Node might not exist on fresh analysis - that's OK
    return false;
  }
}
