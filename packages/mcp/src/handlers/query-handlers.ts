/**
 * MCP Query Handlers
 */

import { ensureAnalyzed } from '../analysis.js';
import {
  normalizeLimit,
  formatPaginationInfo,
  guardResponseSize,
  serializeBigInt,
  findSimilarTypes,
  textResult,
  errorResult,
} from '../utils.js';
import type {
  ToolResult,
  QueryGraphArgs,
  FindCallsArgs,
  FindNodesArgs,
  GraphNode,
  DatalogBinding,
  CallResult,
} from '../types.js';

// === QUERY HANDLERS ===

export async function handleQueryGraph(args: QueryGraphArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { query, limit: requestedLimit, offset: requestedOffset, format: _format, explain: _explain } = args;

  const limit = normalizeLimit(requestedLimit);
  const offset = Math.max(0, requestedOffset || 0);

  try {
    // Check if backend supports Datalog queries
    if (!('checkGuarantee' in db)) {
      return errorResult('Backend does not support Datalog queries');
    }

    const checkFn = (db as unknown as { checkGuarantee: (q: string) => Promise<Array<{ bindings: Array<{ name: string; value: string }> }>> }).checkGuarantee;
    const results = await checkFn(query);
    const total = results.length;

    if (total === 0) {
      const nodeCounts = await db.countNodesByType();
      const totalNodes = Object.values(nodeCounts).reduce((a, b) => a + b, 0);

      const typeMatch = query.match(/node\([^,]+,\s*"([^"]+)"\)/);
      const queriedType = typeMatch ? typeMatch[1] : null;

      let hint = '';
      if (queriedType && !nodeCounts[queriedType]) {
        const availableTypes = Object.keys(nodeCounts);
        const similar = findSimilarTypes(queriedType, availableTypes);
        if (similar.length > 0) {
          hint = `\n💡 Did you mean: ${similar.join(', ')}?`;
        } else {
          hint = `\n💡 Available types: ${availableTypes.slice(0, 10).join(', ')}${availableTypes.length > 10 ? '...' : ''}`;
        }
      }

      return textResult(
        `Query returned no results.${hint}\n📊 Graph: ${totalNodes.toLocaleString()} nodes`
      );
    }

    const paginatedResults = results.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    const enrichedResults: unknown[] = [];
    for (const result of paginatedResults) {
      const nodeId = result.bindings?.find((b: DatalogBinding) => b.name === 'X')?.value;
      if (nodeId) {
        const node = await db.getNode(nodeId);
        if (node) {
          enrichedResults.push({
            ...node,
            id: nodeId,
            file: node.file,
            line: node.line,
          });
        }
      }
    }

    const paginationInfo = formatPaginationInfo({
      limit,
      offset,
      returned: enrichedResults.length,
      total,
      hasMore,
    });

    const responseText = `Found ${total} result(s):${paginationInfo}\n\n${JSON.stringify(
      serializeBigInt(enrichedResults),
      null,
      2
    )}`;

    return textResult(guardResponseSize(responseText));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(message);
  }
}

export async function handleFindCalls(args: FindCallsArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { target: name, limit: requestedLimit, offset: requestedOffset, className } = args;

  const limit = normalizeLimit(requestedLimit);
  const offset = Math.max(0, requestedOffset || 0);

  const calls: CallResult[] = [];
  let skipped = 0;
  let totalMatched = 0;

  for await (const node of db.queryNodes({ type: 'CALL' })) {
    if (node.name !== name && node['method'] !== name) continue;
    if (className && node['object'] !== className) continue;

    totalMatched++;

    if (skipped < offset) {
      skipped++;
      continue;
    }

    if (calls.length >= limit) continue;

    const callsEdges = await db.getOutgoingEdges(node.id, ['CALLS']);
    const isResolved = callsEdges.length > 0;

    let target = null;
    if (isResolved) {
      const targetNode = await db.getNode(callsEdges[0].dst);
      target = targetNode
        ? {
            type: targetNode.type,
            name: targetNode.name ?? '',
            file: targetNode.file,
            line: targetNode.line,
          }
        : null;
    }

    calls.push({
      id: node.id,
      name: node.name,
      object: node['object'] as string | undefined,
      file: node.file,
      line: node.line,
      resolved: isResolved,
      target,
    });
  }

  if (totalMatched === 0) {
    return textResult(`No calls found for "${className ? className + '.' : ''}${name}"`);
  }

  const resolved = calls.filter(c => c.resolved).length;
  const unresolved = calls.length - resolved;
  const hasMore = offset + calls.length < totalMatched;

  const paginationInfo = formatPaginationInfo({
    limit,
    offset,
    returned: calls.length,
    total: totalMatched,
    hasMore,
  });

  const responseText =
    `Found ${totalMatched} call(s) to "${className ? className + '.' : ''}${name}":${paginationInfo}\n` +
    `- Resolved: ${resolved}\n` +
    `- Unresolved: ${unresolved}\n\n` +
    JSON.stringify(serializeBigInt(calls), null, 2);

  return textResult(guardResponseSize(responseText));
}

export async function handleFindNodes(args: FindNodesArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { type, name, file, limit: requestedLimit, offset: requestedOffset } = args;

  const limit = normalizeLimit(requestedLimit);
  const offset = Math.max(0, requestedOffset || 0);

  const filter: Record<string, unknown> = {};
  if (type) filter.type = type;
  if (name) filter.name = name;
  if (file) filter.file = file;

  const nodes: GraphNode[] = [];
  let skipped = 0;
  let totalMatched = 0;

  for await (const node of db.queryNodes(filter)) {
    totalMatched++;

    if (skipped < offset) {
      skipped++;
      continue;
    }

    if (nodes.length < limit) {
      nodes.push(node);
    }
  }

  if (totalMatched === 0) {
    return textResult('No nodes found matching criteria');
  }

  const hasMore = offset + nodes.length < totalMatched;
  const paginationInfo = formatPaginationInfo({
    limit,
    offset,
    returned: nodes.length,
    total: totalMatched,
    hasMore,
  });

  return textResult(
    `Found ${totalMatched} node(s):${paginationInfo}\n\n${JSON.stringify(
      serializeBigInt(nodes),
      null,
      2
    )}`
  );
}
