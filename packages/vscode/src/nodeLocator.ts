/**
 * Node Locator
 *
 * Finds graph nodes at a given cursor position in a file.
 */

import type { BaseRFDBClient } from '@grafema/rfdb-client';
import type { WireNode } from '@grafema/types';
import { parseNodeMetadata } from './types';

/**
 * Find the most specific node at the given cursor position.
 *
 * Strategy:
 * 1. Query all nodes in the file
 * 2. Filter to nodes that contain the cursor position
 * 3. Return the most specific (smallest scope) node
 */
export async function findNodeAtCursor(
  client: BaseRFDBClient,
  filePath: string,
  line: number,
  column: number
): Promise<WireNode | null> {
  // Get all nodes in this file
  const fileNodes = await client.getAllNodes({ file: filePath });

  if (fileNodes.length === 0) {
    return null;
  }

  // Find nodes that contain the cursor position
  const matchingNodes: Array<{ node: WireNode; specificity: number }> = [];

  for (const node of fileNodes) {
    const metadata = parseNodeMetadata(node);
    const nodeLine = metadata.line;

    if (nodeLine === undefined) {
      continue;
    }

    // Simple matching: node line matches cursor line
    // More sophisticated matching could use startLine/endLine ranges
    if (nodeLine === line) {
      // Prefer nodes with column info closer to cursor
      const nodeColumn = metadata.column ?? 0;
      const distance = Math.abs(nodeColumn - column);

      matchingNodes.push({
        node,
        specificity: 1000 - distance, // Higher specificity for closer matches
      });
    }

    // Also check for range-based matching if we have endLine
    const endLine = metadata.endLine;
    if (endLine !== undefined && nodeLine <= line && endLine >= line) {
      // Node spans multiple lines and contains cursor
      const span = endLine - nodeLine + 1;
      matchingNodes.push({
        node,
        specificity: 500 - span, // Prefer smaller spans (more specific)
      });
    }
  }

  if (matchingNodes.length === 0) {
    // Fallback: find closest node by line number
    let closest: WireNode | null = null;
    let closestDistance = Infinity;

    for (const node of fileNodes) {
      const metadata = parseNodeMetadata(node);
      const nodeLine = metadata.line;

      if (nodeLine === undefined) {
        continue;
      }

      const distance = Math.abs(nodeLine - line);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = node;
      }
    }

    return closest;
  }

  // Sort by specificity (higher is more specific)
  matchingNodes.sort((a, b) => b.specificity - a.specificity);

  return matchingNodes[0].node;
}

/**
 * Find all nodes in a file (for caching purposes)
 */
export async function findNodesInFile(client: BaseRFDBClient, filePath: string): Promise<WireNode[]> {
  return client.getAllNodes({ file: filePath });
}
