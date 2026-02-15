/**
 * MCP Guard Handlers
 */

import { getOrCreateBackend } from '../state.js';
import {
  serializeBigInt,
  textResult,
  errorResult,
} from '../utils.js';
import type {
  ToolResult,
  FindGuardsArgs,
  GuardInfo,
} from '../types.js';

// === FIND GUARDS (REG-274) ===

/**
 * Find conditional guards protecting a node.
 *
 * Walks up the containment tree via CONTAINS edges, collecting
 * SCOPE nodes that have conditional=true (if_statement, else_statement, etc.).
 *
 * Returns guards in inner-to-outer order.
 */
export async function handleFindGuards(args: FindGuardsArgs): Promise<ToolResult> {
  const db = await getOrCreateBackend();
  const { nodeId } = args;

  // Verify target node exists
  const targetNode = await db.getNode(nodeId);
  if (!targetNode) {
    return errorResult(`Node not found: ${nodeId}`);
  }

  const guards: GuardInfo[] = [];
  const visited = new Set<string>();
  let currentId = nodeId;

  // Walk up the containment tree
  while (true) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    // Get parent via incoming CONTAINS edge
    const incomingEdges = await db.getIncomingEdges(currentId, ['CONTAINS']);
    if (incomingEdges.length === 0) break;

    const parentId = incomingEdges[0].src;
    const parentNode = await db.getNode(parentId);

    if (!parentNode) break;

    // Check if this is a conditional scope
    if (parentNode.conditional) {
      // Parse constraints if stored as string
      let constraints = parentNode.constraints;
      if (typeof constraints === 'string') {
        try {
          constraints = JSON.parse(constraints);
        } catch {
          // Keep as string if not valid JSON
        }
      }

      guards.push({
        scopeId: parentNode.id,
        scopeType: (parentNode.scopeType as string) || 'unknown',
        condition: parentNode.condition as string | undefined,
        constraints: constraints as unknown[] | undefined,
        file: parentNode.file || '',
        line: (parentNode.line as number) || 0,
      });
    }

    currentId = parentId;
  }

  if (guards.length === 0) {
    return textResult(
      `No guards found for node: ${nodeId}\n` +
      `The node is not protected by any conditional scope (if/else/switch/etc.).`
    );
  }

  const summary = guards.map((g, i) => {
    const indent = '  '.repeat(i);
    return `${indent}${i + 1}. ${g.scopeType} at ${g.file}:${g.line}` +
      (g.condition ? `\n${indent}   condition: ${g.condition}` : '');
  }).join('\n');

  return textResult(
    `Found ${guards.length} guard(s) for node: ${nodeId}\n` +
    `(inner to outer order)\n\n` +
    summary +
    `\n\n` +
    JSON.stringify(serializeBigInt(guards), null, 2)
  );
}
