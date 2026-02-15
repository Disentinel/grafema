/**
 * MCP Dataflow Handlers
 */

import { ensureAnalyzed } from '../analysis.js';
import { getProjectPath } from '../state.js';
import {
  serializeBigInt,
  textResult,
  errorResult,
} from '../utils.js';
import type {
  ToolResult,
  TraceAliasArgs,
  TraceDataFlowArgs,
  CheckInvariantArgs,
  GraphNode,
} from '../types.js';

// === TRACE HANDLERS ===

export async function handleTraceAlias(args: TraceAliasArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { variableName, file } = args;
  const _projectPath = getProjectPath();

  let varNode: GraphNode | null = null;

  for await (const node of db.queryNodes({ type: 'VARIABLE' })) {
    if (node.name === variableName && node.file?.includes(file || '')) {
      varNode = node;
      break;
    }
  }

  if (!varNode) {
    for await (const node of db.queryNodes({ type: 'CONSTANT' })) {
      if (node.name === variableName && node.file?.includes(file || '')) {
        varNode = node;
        break;
      }
    }
  }

  if (!varNode) {
    return errorResult(`Variable "${variableName}" not found in ${file || 'project'}`);
  }

  const chain: unknown[] = [];
  const visited = new Set<string>();
  let current: GraphNode | null = varNode;
  const MAX_DEPTH = 20;

  while (current && chain.length < MAX_DEPTH) {
    if (visited.has(current.id)) {
      chain.push({ type: 'CYCLE_DETECTED', id: current.id });
      break;
    }
    visited.add(current.id);

    chain.push({
      type: current.type,
      name: current.name,
      file: current.file,
      line: current.line,
    });

    const edges = await db.getOutgoingEdges(current.id, ['ASSIGNED_FROM']);
    if (edges.length === 0) break;

    current = await db.getNode(edges[0].dst);
  }

  return textResult(
    `Alias chain for "${variableName}" (${chain.length} steps):\n\n${JSON.stringify(
      serializeBigInt(chain),
      null,
      2
    )}`
  );
}

export async function handleTraceDataFlow(args: TraceDataFlowArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { source, direction = 'forward', max_depth = 10 } = args;

  // Find source node
  let sourceNode: GraphNode | null = null;

  // Try to find by ID first
  sourceNode = await db.getNode(source);

  // If not found, search by name
  if (!sourceNode) {
    for await (const node of db.queryNodes({ name: source })) {
      sourceNode = node;
      break;
    }
  }

  if (!sourceNode) {
    return errorResult(`Source "${source}" not found`);
  }

  const visited = new Set<string>();
  const paths: unknown[] = [];

  async function trace(nodeId: string, depth: number, path: string[]): Promise<void> {
    if (depth > max_depth || visited.has(nodeId)) return;
    visited.add(nodeId);

    const newPath = [...path, nodeId];

    if (direction === 'forward' || direction === 'both') {
      const outEdges = await db.getOutgoingEdges(nodeId, [
        'ASSIGNED_FROM',
        'DERIVES_FROM',
        'PASSES_ARGUMENT',
      ]);
      for (const edge of outEdges) {
        await trace(edge.dst, depth + 1, newPath);
      }
    }

    if (direction === 'backward' || direction === 'both') {
      const inEdges = await db.getIncomingEdges(nodeId, [
        'ASSIGNED_FROM',
        'DERIVES_FROM',
        'PASSES_ARGUMENT',
      ]);
      for (const edge of inEdges) {
        await trace(edge.src, depth + 1, newPath);
      }
    }

    if (depth > 0) {
      paths.push(newPath);
    }
  }

  await trace(sourceNode.id, 0, []);

  return textResult(
    `Data flow from "${source}" (${paths.length} paths):\n\n${JSON.stringify(paths, null, 2)}`
  );
}

export async function handleCheckInvariant(args: CheckInvariantArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { rule, name: description } = args;

  if (!('checkGuarantee' in db)) {
    return errorResult('Backend does not support Datalog queries');
  }

  try {
    const checkFn = (db as unknown as { checkGuarantee: (q: string) => Promise<Array<{ bindings: Array<{ name: string; value: string }> }>> }).checkGuarantee;
    const violations = await checkFn(rule);
    const total = violations.length;

    if (total === 0) {
      return textResult(`✅ Invariant holds: ${description || 'No violations found'}`);
    }

    const enrichedViolations: unknown[] = [];
    for (const v of violations.slice(0, 20)) {
      const nodeId = v.bindings?.find((b: any) => b.name === 'X')?.value;
      if (nodeId) {
        const node = await db.getNode(nodeId);
        if (node) {
          enrichedViolations.push({
            id: nodeId,
            type: node.type,
            name: node.name,
            file: node.file,
            line: node.line,
          });
        }
      }
    }

    return textResult(
      `❌ ${total} violation(s) found:\n\n${JSON.stringify(
        serializeBigInt(enrichedViolations),
        null,
        2
      )}${total > 20 ? `\n\n... and ${total - 20} more` : ''}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(message);
  }
}
