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
 * 2. Containment-based matching using start/end positions
 * 3. Type precedence: CALL preferred over PROPERTY_ACCESS
 * 4. Fallback to proximity for legacy nodes without end position
 */
export async function findNodeAtCursor(
  client: BaseRFDBClient,
  filePath: string,
  line: number,
  column: number
): Promise<WireNode | null> {
  const fileNodes = await client.getAllNodes({ file: filePath });
  if (fileNodes.length === 0) return null;

  const matchingNodes: Array<{ node: WireNode; specificity: number }> = [];

  for (const node of fileNodes) {
    const metadata = parseNodeMetadata(node);
    const nodeLine = metadata.line;
    if (nodeLine === undefined) continue;

    const nodeColumn = metadata.column ?? 0;
    const endLine = metadata.endLine;
    const endColumn = metadata.endColumn;

    let specificity = -1;

    // Phase 1: Containment-based matching (if end position available and valid)
    if (endLine && endColumn && endLine > 0) {
      if (isWithinSpan(
        { line, column },
        { line: nodeLine, column: nodeColumn },
        { line: endLine, column: endColumn }
      )) {
        const spanSize = computeSpanSize(
          { line: nodeLine, column: nodeColumn },
          { line: endLine, column: endColumn }
        );
        specificity = 10000 - spanSize;
      }
    }
    // Phase 1b: Fallback to proximity (legacy nodes without end position)
    else if (nodeLine === line) {
      const distance = Math.abs(nodeColumn - column);
      specificity = 1000 - distance;
    }

    // Also check multi-line range matching for nodes with endLine but no endColumn
    if (specificity < 0 && endLine !== undefined && nodeLine <= line && endLine >= line) {
      const span = endLine - nodeLine + 1;
      specificity = 500 - span;
    }

    if (specificity < 0) continue;

    // Phase 2: Type precedence — CALL preferred over PROPERTY_ACCESS
    if (node.nodeType === 'CALL') {
      specificity += 100;
    }

    matchingNodes.push({ node, specificity });
  }

  if (matchingNodes.length === 0) {
    // Fallback: closest by line
    let closest: WireNode | null = null;
    let closestDistance = Infinity;
    for (const node of fileNodes) {
      const metadata = parseNodeMetadata(node);
      const nodeLine = metadata.line;
      if (nodeLine === undefined) continue;
      const distance = Math.abs(nodeLine - line);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = node;
      }
    }
    return closest;
  }

  matchingNodes.sort((a, b) => b.specificity - a.specificity);
  return matchingNodes[0].node;
}

function isWithinSpan(
  cursor: { line: number; column: number },
  start: { line: number; column: number },
  end: { line: number; column: number }
): boolean {
  if (start.line === end.line) {
    return cursor.line === start.line &&
           cursor.column >= start.column &&
           cursor.column <= end.column;
  }
  if (cursor.line === start.line) return cursor.column >= start.column;
  if (cursor.line === end.line) return cursor.column <= end.column;
  return cursor.line > start.line && cursor.line < end.line;
}

function computeSpanSize(
  start: { line: number; column: number },
  end: { line: number; column: number }
): number {
  if (start.line === end.line) return end.column - start.column;
  return (end.line - start.line) * 100 + (100 - start.column) + end.column;
}

/**
 * Find all nodes in a file (for caching purposes)
 */
export async function findNodesInFile(client: BaseRFDBClient, filePath: string): Promise<WireNode[]> {
  return client.getAllNodes({ file: filePath });
}
