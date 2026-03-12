/**
 * MCP Dataflow Handlers
 *
 * Delegates BFS tracing to @grafema/util's shared traceDataflow module.
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
import {
  traceDataflow,
  renderTraceNarrative,
  type DataflowBackend,
  type TraceDetail,
} from '@grafema/util';

// === TRACE ALIAS (unchanged) ===

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

    // Resolve REFERENCE → declaration transparently (don't add to chain)
    if (current.type === 'REFERENCE') {
      const resolveEdges = await db.getOutgoingEdges(current.id, ['READS_FROM']);
      if (resolveEdges.length > 0) {
        current = await db.getNode(resolveEdges[0].dst);
        continue;
      }
      break;
    }

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

// === TRACE DATAFLOW ===

export async function handleTraceDataFlow(args: TraceDataFlowArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { source, file, direction = 'forward', max_depth = 10, limit = 50, detail } = args;

  // Find source node
  let sourceNode: GraphNode | null = await db.getNode(source);
  if (!sourceNode) {
    // Search by name, preferring nodes that match the file filter
    let fallbackNode: GraphNode | null = null;
    for await (const node of db.queryNodes({ name: source })) {
      if (file && !node.file?.includes(file)) {
        // Keep first match as fallback in case no file-matching node is found
        if (!fallbackNode) fallbackNode = node;
        continue;
      }
      sourceNode = node;
      break;
    }
    // Also try PARAMETER type nodes (often the real entry point for dataflow)
    if (!sourceNode) {
      for await (const node of db.queryNodes({ type: 'PARAMETER', name: source })) {
        if (file && !node.file?.includes(file)) {
          if (!fallbackNode) fallbackNode = node;
          continue;
        }
        sourceNode = node;
        break;
      }
    }
    // Use fallback (first name match regardless of file) if no file-specific match
    if (!sourceNode && fallbackNode) {
      sourceNode = fallbackNode;
    }
  }
  if (!sourceNode) {
    return errorResult(`Source "${source}" not found`);
  }

  // Cast db to DataflowBackend — runtime types are compatible
  const dfDb = db as unknown as DataflowBackend;

  const traceResults = await traceDataflow(dfDb, sourceNode.id, {
    direction: direction as 'forward' | 'backward' | 'both',
    maxDepth: max_depth,
    limit,
  });

  const sourceName = sourceNode.name || source;
  return textResult(renderTraceNarrative(traceResults, sourceName, {
    detail: (detail as TraceDetail) || 'normal',
  }));
}

// === CHECK INVARIANT (unchanged) ===

export async function handleCheckInvariant(args: CheckInvariantArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { rule, name: description } = args;

  if (!('checkGuarantee' in db)) {
    return errorResult('Backend does not support Datalog queries');
  }

  try {
    const checkFn = (db as unknown as { checkGuarantee: (q: string) => Promise<Array<{ bindings: Array<{ name: string; value: string }> }>> }).checkGuarantee;
    const violations = await checkFn.call(db, rule);
    const total = violations.length;

    if (total === 0) {
      return textResult(`Invariant holds: ${description || 'No violations found'}`);
    }

    const enrichedViolations: unknown[] = [];
    for (const v of violations.slice(0, 20)) {
      const xBinding = v.bindings?.find((b: { name: string; value: string }) => b.name === 'X');
      if (xBinding) {
        const node = await db.getNode(xBinding.value);
        if (node) {
          enrichedViolations.push({
            id: xBinding.value,
            type: node.type,
            name: node.name,
            file: node.file,
            line: node.line,
          });
        } else {
          const bindingsMap: Record<string, string> = {};
          for (const b of v.bindings!) {
            bindingsMap[b.name] = b.value;
          }
          enrichedViolations.push(bindingsMap);
        }
      }
    }

    return textResult(
      `${total} violation(s) found:\n\n${JSON.stringify(
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
