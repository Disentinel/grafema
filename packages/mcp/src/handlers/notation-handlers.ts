/**
 * MCP Notation Handlers — describe tool
 */

import { ensureAnalyzed } from '../analysis.js';
import { renderNotation, extractSubgraph } from '@grafema/util';
import type { Archetype, DescribeOptions } from '@grafema/util';
import { textResult, errorResult } from '../utils.js';
import type { ToolResult, DescribeArgs } from '../types.js';

/** Perspective presets map to archetype filters */
const PERSPECTIVES: Record<string, Archetype[]> = {
  security: ['write', 'exception'],
  data: ['flow_out', 'flow_in', 'write'],
  errors: ['exception'],
  api: ['flow_out', 'publishes', 'depends'],
  events: ['publishes'],
};

export async function handleDescribe(
  args: DescribeArgs,
): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { target, depth = 1, perspective } = args;

  // Step 1: Resolve target → node ID
  let node = await db.getNode(target);

  // If not found by semantic ID, try queryNodes for file path or name
  if (!node) {
    // Try as file path (MODULE node)
    for await (const n of db.queryNodes({ file: target, type: 'MODULE' })) {
      node = n;
      break;
    }
  }
  if (!node) {
    // Try by name (any type)
    for await (const n of db.queryNodes({ name: target })) {
      node = n;
      break;
    }
  }

  if (!node) {
    return errorResult(
      `Target not found: "${target}"\n` +
      `Try: semantic ID (from find_nodes), file path, or node name.`,
    );
  }

  // Step 2: Extract subgraph
  const subgraph = await extractSubgraph(db, node.id, depth);

  // Step 3: Build options
  const options: DescribeOptions = {
    depth,
    includeLocations: depth >= 2,
  };
  if (perspective && PERSPECTIVES[perspective]) {
    options.archetypeFilter = PERSPECTIVES[perspective];
  }

  // Step 4: Render
  const notation = renderNotation(subgraph, options);

  if (!notation.trim()) {
    return textResult(
      `[${node.type}] ${node.name ?? node.id}\nNo relationships found at depth=${depth}.`,
    );
  }

  return textResult(notation);
}
