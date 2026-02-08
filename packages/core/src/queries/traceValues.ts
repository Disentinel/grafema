/**
 * Value Tracing Utility (REG-244)
 *
 * Traces a node through ASSIGNED_FROM/DERIVES_FROM edges to find
 * all possible literal values or mark as unknown.
 *
 * Graph structure:
 * ```
 * VARIABLE -[ASSIGNED_FROM]-> LITERAL (concrete value)
 * VARIABLE -[ASSIGNED_FROM]-> PARAMETER (unknown: runtime input)
 * VARIABLE -[ASSIGNED_FROM]-> CALL (unknown: function return)
 * VARIABLE -[DERIVES_FROM]-> EXPRESSION (check nondeterministic patterns)
 * VARIABLE -[ASSIGNED_FROM]-> VARIABLE (chain - recurse)
 * ```
 *
 * Used by:
 * - CLI trace command (sink-based tracing)
 * - ValueDomainAnalyzer (computed member access resolution)
 *
 * @module queries/traceValues
 */

import type {
  TracedValue,
  TraceValuesOptions,
  TraceValuesGraphBackend,
  ValueSetResult,
  NondeterministicPattern,
} from './types.js';

// =============================================================================
// NONDETERMINISTIC PATTERNS (moved from ValueDomainAnalyzer)
// =============================================================================

/**
 * Nondeterministic MemberExpression patterns.
 * object.property combinations that represent external/user input.
 */
export const NONDETERMINISTIC_PATTERNS: NondeterministicPattern[] = [
  // Environment variables
  { object: 'process', property: 'env' },
  // HTTP request data (Express.js patterns)
  { object: 'req', property: 'body' },
  { object: 'req', property: 'query' },
  { object: 'req', property: 'params' },
  { object: 'req', property: 'headers' },
  { object: 'req', property: 'cookies' },
  { object: 'request', property: 'body' },
  { object: 'request', property: 'query' },
  { object: 'request', property: 'params' },
  // Context patterns (Koa, etc.)
  { object: 'ctx', property: 'request' },
  { object: 'ctx', property: 'body' },
  { object: 'ctx', property: 'query' },
  { object: 'ctx', property: 'params' },
];

/**
 * Nondeterministic object prefixes.
 * Any property access on these is nondeterministic.
 */
export const NONDETERMINISTIC_OBJECTS: string[] = [
  'process.env',  // process.env.ANY_VAR
  'req.body',     // req.body.userId
  'req.query',    // req.query.filter
  'req.params',   // req.params.id
  'request.body',
  'ctx.request',
];

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Trace a node to all its possible literal values.
 *
 * Starting from the given node, follows ASSIGNED_FROM (and optionally
 * DERIVES_FROM) edges backwards to find:
 * - LITERAL nodes: concrete values
 * - PARAMETER nodes: runtime inputs (unknown)
 * - CALL nodes: function return values (unknown)
 * - EXPRESSION nodes: checks for nondeterministic patterns
 *
 * @param backend - Graph backend for queries
 * @param nodeId - Starting node ID
 * @param options - Traversal options
 * @returns Array of traced values with sources
 *
 * @example
 * const values = await traceValues(backend, variableId);
 * for (const v of values) {
 *   if (v.isUnknown) {
 *     console.log(`Unknown from ${v.source.file}:${v.source.line} (${v.reason})`);
 *   } else {
 *     console.log(`Value: ${v.value} from ${v.source.file}:${v.source.line}`);
 *   }
 * }
 */
export async function traceValues(
  backend: TraceValuesGraphBackend,
  nodeId: string,
  options?: TraceValuesOptions
): Promise<TracedValue[]> {
  const results: TracedValue[] = [];
  const visited = new Set<string>();

  const maxDepth = options?.maxDepth ?? 10;
  const followDerivesFrom = options?.followDerivesFrom ?? true;
  const detectNondeterministic = options?.detectNondeterministic ?? true;

  await traceRecursive(
    backend,
    nodeId,
    visited,
    0,
    maxDepth,
    followDerivesFrom,
    detectNondeterministic,
    results
  );

  return results;
}

/**
 * Recursive tracing function
 */
async function traceRecursive(
  backend: TraceValuesGraphBackend,
  nodeId: string,
  visited: Set<string>,
  depth: number,
  maxDepth: number,
  followDerivesFrom: boolean,
  detectNondeterministic: boolean,
  results: TracedValue[]
): Promise<void> {
  // Cycle protection
  if (visited.has(nodeId)) {
    return;
  }
  visited.add(nodeId);

  // Get node
  const node = await backend.getNode(nodeId);
  if (!node) {
    return;
  }

  const nodeType = node.type || node.nodeType;
  const source = {
    id: node.id,
    file: node.file || '',
    line: node.line || 0,
  };

  // Depth protection - check after getting node for source info
  if (depth > maxDepth) {
    results.push({
      value: undefined,
      source,
      isUnknown: true,
      reason: 'max_depth',
    });
    return;
  }

  // Terminal: LITERAL - found concrete value
  if (nodeType === 'LITERAL') {
    results.push({
      value: node.value,
      source,
      isUnknown: false,
    });
    return;
  }

  // Terminal: PARAMETER - runtime input
  if (nodeType === 'PARAMETER') {
    results.push({
      value: undefined,
      source,
      isUnknown: true,
      reason: 'parameter',
    });
    return;
  }

  // Terminal: CALL / METHOD_CALL - function return value
  if (nodeType === 'CALL' || nodeType === 'METHOD_CALL') {
    // Check for HTTP_RECEIVES edges (cross-service data flow)
    const httpEdges = await backend.getOutgoingEdges(nodeId, ['HTTP_RECEIVES']);

    if (httpEdges.length > 0) {
      // Follow HTTP boundary to backend response
      for (const edge of httpEdges) {
        await traceRecursive(
          backend,
          edge.dst,
          visited,
          depth + 1,
          maxDepth,
          followDerivesFrom,
          detectNondeterministic,
          results
        );
      }
      return; // Traced through HTTP boundary, don't mark as unknown
    }

    // Original behavior - mark as unknown
    results.push({
      value: undefined,
      source,
      isUnknown: true,
      reason: 'call_result',
    });
    return;
  }

  // Check nondeterministic EXPRESSION patterns
  if (nodeType === 'EXPRESSION' && detectNondeterministic) {
    if (isNondeterministicExpression(node)) {
      results.push({
        value: undefined,
        source,
        isUnknown: true,
        reason: 'nondeterministic',
      });
      return;
    }
  }

  // Terminal: OBJECT_LITERAL - a valid structured value
  // OBJECT_LITERAL without edges is valid (e.g., {} or {key: value})
  if (nodeType === 'OBJECT_LITERAL') {
    results.push({
      value: node.value,
      source,
      isUnknown: false,
    });
    return;
  }

  // REG-334: Special case - CONSTRUCTOR_CALL for Promise
  // Follow RESOLVES_TO edges to find actual data sources from resolve() calls
  if (nodeType === 'CONSTRUCTOR_CALL') {
    const className = (node as { className?: string }).className;

    if (className === 'Promise') {
      // Look for incoming RESOLVES_TO edges (resolve/reject calls)
      const resolveEdges = await backend.getIncomingEdges(nodeId, ['RESOLVES_TO']);

      if (resolveEdges.length > 0) {
        // Follow resolve/reject calls to their arguments
        for (const edge of resolveEdges) {
          // edge.src is the resolve(value) CALL node
          // We need to find what value was passed to resolve()
          // The CALL node should have PASSES_ARGUMENT edge to the value
          const argEdges = await backend.getOutgoingEdges(edge.src, ['PASSES_ARGUMENT']);

          for (const argEdge of argEdges) {
            // Check if this is the first argument (argIndex 0)
            const argIndex = (argEdge.metadata as { argIndex?: number } | undefined)?.argIndex;
            if (argIndex === 0) {
              // Recursively trace the argument value
              await traceRecursive(
                backend,
                argEdge.dst,
                visited,
                depth + 1,
                maxDepth,
                followDerivesFrom,
                detectNondeterministic,
                results
              );
            }
          }
        }
        return; // Traced through resolve, don't mark as unknown
      }
    }

    // Non-Promise constructor or no resolve edges - mark as unknown
    results.push({
      value: undefined,
      source,
      isUnknown: true,
      reason: 'constructor_call',
    });
    return;
  }

  // Get outgoing data flow edges
  const edgeTypes = ['ASSIGNED_FROM'];
  if (followDerivesFrom) {
    edgeTypes.push('DERIVES_FROM');
  }

  const edges = await backend.getOutgoingEdges(nodeId, edgeTypes);

  // No edges case - unknown
  if (edges.length === 0) {
    results.push({
      value: undefined,
      source,
      isUnknown: true,
      reason: 'no_sources',
    });
    return;
  }

  // Recurse through sources
  for (const edge of edges) {
    await traceRecursive(
      backend,
      edge.dst,
      visited,
      depth + 1,
      maxDepth,
      followDerivesFrom,
      detectNondeterministic,
      results
    );
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Check if an EXPRESSION node represents a nondeterministic pattern.
 * E.g., process.env.VAR, req.body.userId, etc.
 */
function isNondeterministicExpression(node: {
  expressionType?: string;
  object?: string;
  property?: string;
}): boolean {
  if (node.expressionType !== 'MemberExpression') {
    return false;
  }

  const object = node.object;
  const property = node.property;

  if (!object || !property) {
    return false;
  }

  // Check exact patterns (object.property)
  for (const pattern of NONDETERMINISTIC_PATTERNS) {
    if (object === pattern.object && property === pattern.property) {
      return true;
    }
  }

  // Check if object is a known nondeterministic prefix
  // e.g., process.env.VAR where object is 'process.env'
  for (const prefix of NONDETERMINISTIC_OBJECTS) {
    if (object === prefix || object.startsWith(prefix + '.')) {
      return true;
    }
  }

  return false;
}

/**
 * Aggregate traced values into a simplified result.
 * Useful for consumers who don't need source locations.
 *
 * Note: null and undefined values are NOT included in the values array.
 * If you need to detect "assigned to null", check the raw TracedValue[] instead.
 *
 * @param traced - Array of traced values
 * @returns Aggregated result with unique values and hasUnknown flag
 */
export function aggregateValues(traced: TracedValue[]): ValueSetResult {
  const valueSet = new Set<unknown>();
  let hasUnknown = false;

  for (const t of traced) {
    if (t.isUnknown) {
      hasUnknown = true;
    } else if (t.value !== undefined && t.value !== null) {
      valueSet.add(t.value);
    }
  }

  return {
    values: Array.from(valueSet),
    hasUnknown,
  };
}
