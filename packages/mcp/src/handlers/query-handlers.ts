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
  extractQueriedTypes,
  textResult,
  errorResult,
} from '../utils.js';
import type { DatalogExplainResult, CypherResult, FactWitness, GapWitness, SimEdge, SimNode } from '@grafema/types';
import type {
  ToolResult,
  QueryGraphArgs,
  FindCallsArgs,
  FindNodesArgs,
  GraphNode,
  DatalogBinding,
  CallResult,
  ExplainFactArgs,
  ExplainGapArgs,
  SimDatalogArgs,
} from '../types.js';

// === QUERY HANDLERS ===

export async function handleQueryGraph(args: QueryGraphArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { query, language, limit: requestedLimit, offset: requestedOffset, format: _format, explain, count } = args;

  const limit = normalizeLimit(requestedLimit);
  const offset = Math.max(0, requestedOffset || 0);

  try {
    // Cypher query path
    if (language === 'cypher') {
      if (!('cypherQuery' in db)) {
        return errorResult('Backend does not support Cypher queries');
      }
      const cypherFn = (db as unknown as { cypherQuery: (q: string) => Promise<CypherResult> }).cypherQuery;
      const result = await cypherFn.call(db, query);

      if (count) {
        return textResult(`Count: ${result.rowCount}`);
      }

      if (result.rowCount === 0) {
        return textResult('Query returned no results.');
      }

      const paginatedRows = result.rows.slice(offset, offset + limit);
      const hasMore = offset + limit < result.rowCount;

      const paginationInfo = formatPaginationInfo({
        limit,
        offset,
        returned: paginatedRows.length,
        total: result.rowCount,
        hasMore,
      });

      // Format as table
      const lines: string[] = [];
      lines.push(`Found ${result.rowCount} row(s):${paginationInfo}`);
      lines.push('');

      // Column widths
      const colWidths = result.columns.map((col, i) => {
        let maxWidth = col.length;
        for (const row of paginatedRows) {
          const cellLen = String(row[i] ?? '').length;
          if (cellLen > maxWidth) maxWidth = cellLen;
        }
        return Math.min(maxWidth, 60);
      });

      lines.push(result.columns.map((col, i) => col.padEnd(colWidths[i])).join('  '));
      lines.push(colWidths.map(w => '-'.repeat(w)).join('  '));

      for (const row of paginatedRows) {
        const line = row.map((cell, i) => {
          const s = String(cell ?? '');
          return s.length > colWidths[i] ? s.slice(0, colWidths[i] - 1) + '\u2026' : s.padEnd(colWidths[i]);
        }).join('  ');
        lines.push(line);
      }

      return textResult(guardResponseSize(lines.join('\n')));
    }

    // Check if backend supports Datalog queries
    if (!('checkGuarantee' in db)) {
      return errorResult('Backend does not support Datalog queries');
    }

    // Explain mode — separate path with step-by-step trace
    if (explain) {
      const checkFn = (db as unknown as { checkGuarantee: (q: string, explain: true) => Promise<DatalogExplainResult> }).checkGuarantee;
      const result = await checkFn.call(db, query, true);
      return textResult(guardResponseSize(formatExplainOutput(result)));
    }

    const checkFn = (db as unknown as { checkGuarantee: (q: string) => Promise<Array<{ bindings: Array<{ name: string; value: string }> }>> }).checkGuarantee;
    const results = await checkFn.call(db, query);
    const total = results.length;

    if (count) {
      return textResult(`Count: ${total}`);
    }

    if (total === 0) {
      const { nodeTypes, edgeTypes } = extractQueriedTypes(query);
      const hasQueriedTypes = nodeTypes.length > 0 || edgeTypes.length > 0;

      const nodeCounts = await db.countNodesByType();
      const edgeCounts = edgeTypes.length > 0 ? await db.countEdgesByType() : {};
      const availableNodeTypes = Object.keys(nodeCounts);
      const availableEdgeTypes = Object.keys(edgeCounts);

      let hint = '';
      if (hasQueriedTypes) {
        const hintLines: string[] = [];

        if (nodeTypes.length > 0 && availableNodeTypes.length === 0) {
          hintLines.push('Graph has no nodes');
        } else {
          for (const queriedType of nodeTypes) {
            if (!nodeCounts[queriedType]) {
              const similar = findSimilarTypes(queriedType, availableNodeTypes);
              if (similar.length > 0) {
                hintLines.push(`Did you mean: ${similar.join(', ')}? (node type)`);
              } else {
                const typeList = availableNodeTypes.slice(0, 10).join(', ');
                const more = availableNodeTypes.length > 10 ? '...' : '';
                hintLines.push(`Available node types: ${typeList}${more}`);
              }
            }
          }
        }

        if (edgeTypes.length > 0 && availableEdgeTypes.length === 0) {
          hintLines.push('Graph has no edges');
        } else {
          for (const queriedType of edgeTypes) {
            if (!edgeCounts[queriedType]) {
              const similar = findSimilarTypes(queriedType, availableEdgeTypes);
              if (similar.length > 0) {
                hintLines.push(`Did you mean: ${similar.join(', ')}? (edge type)`);
              } else {
                const typeList = availableEdgeTypes.slice(0, 10).join(', ');
                const more = availableEdgeTypes.length > 10 ? '...' : '';
                hintLines.push(`Available edge types: ${typeList}${more}`);
              }
            }
          }
        }

        if (hintLines.length > 0) {
          hint = '\n' + hintLines.map(l => `Hint: ${l}`).join('\n');
        }
      }

      const totalNodes = Object.values(nodeCounts).reduce((a, b) => a + b, 0);

      return textResult(`Query returned no results.${hint}\nGraph: ${totalNodes.toLocaleString()} nodes`);
    }

    const paginatedResults = results.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    const enrichedResults: unknown[] = [];
    for (const result of paginatedResults) {
      const xBinding = result.bindings?.find((b: DatalogBinding) => b.name === 'X');
      if (xBinding) {
        const node = await db.getNode(xBinding.value);
        if (node) {
          enrichedResults.push({
            ...node,
            id: xBinding.value,
            file: node.file,
            line: node.line,
          });
        } else {
          // Non-node-ID binding (e.g. attr() string value) — return raw bindings map
          const bindingsMap: Record<string, string> = {};
          for (const b of result.bindings!) {
            bindingsMap[b.name] = b.value;
          }
          enrichedResults.push(bindingsMap);
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
  const { name, limit: requestedLimit, offset: requestedOffset, className } = args;

  const limit = normalizeLimit(requestedLimit);
  const offset = Math.max(0, requestedOffset || 0);

  const calls: CallResult[] = [];
  let skipped = 0;
  let totalMatched = 0;

  for await (const node of db.queryNodes({ type: 'CALL' })) {
    const nodeName = node.name ?? '';
    // Method calls are stored as "receiver.method" (e.g., "kb.queryNodes", "<obj>.load").
    // Extract the method part so find_calls("queryNodes") matches "kb.queryNodes".
    const dotIdx = nodeName.lastIndexOf('.');
    const methodPart = dotIdx >= 0 ? nodeName.slice(dotIdx + 1) : null;
    const receiverPart = dotIdx >= 0 ? nodeName.slice(0, dotIdx) : null;

    if (nodeName !== name && methodPart !== name) continue;
    if (className && receiverPart !== className) continue;

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

  // Also find callback usages: where the function is passed as argument
  // Pattern: CALL "action" → PASSES_ARGUMENT → REFERENCE "analyzeAction" → READS_FROM → FUNCTION
  // Search: REFERENCE nodes with matching name that have incoming PASSES_ARGUMENT
  if (totalMatched === 0 || calls.length < limit) {
    for await (const ref of db.queryNodes({ type: 'REFERENCE', name })) {
      const inEdges = await db.getIncomingEdges(ref.id, ['PASSES_ARGUMENT' as any]);
      if (inEdges.length === 0) continue;

      totalMatched++;
      if (skipped < offset) { skipped++; continue; }
      if (calls.length >= limit) continue;

      const callerNode = await db.getNode(inEdges[0].src);
      calls.push({
        id: ref.id,
        name: `${callerNode?.name ?? '?'}(${name})`,
        object: undefined,
        file: ref.file,
        line: ref.line,
        resolved: true,
        target: callerNode ? {
          type: callerNode.type,
          name: callerNode.name ?? '',
          file: callerNode.file,
          line: callerNode.line,
        } : null,
      });
    }
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

function formatExplainOutput(result: DatalogExplainResult): string {
  const lines: string[] = [];

  lines.push(`Query returned ${result.bindings.length} result(s).\n`);

  if (result.explainSteps.length > 0) {
    lines.push('Step-by-step execution:');
    const maxSteps = 50;
    const stepsToShow = result.explainSteps.slice(0, maxSteps);
    for (const step of stepsToShow) {
      const args = step.args.join(', ');
      lines.push(`  ${step.step}. [${step.operation}] ${step.predicate}(${args}) \u2192 ${step.resultCount} result(s) (${step.durationUs} \u00b5s)`);
      if (step.details) {
        lines.push(`     ${step.details}`);
      }
    }
    if (result.explainSteps.length > maxSteps) {
      lines.push(`  ... ${result.explainSteps.length - maxSteps} more steps`);
    }
    lines.push('');
  }

  lines.push('Statistics:');
  lines.push(`  Nodes visited:    ${result.stats.nodesVisited}`);
  lines.push(`  Edges traversed:  ${result.stats.edgesTraversed}`);
  lines.push(`  Rule evaluations: ${result.stats.ruleEvaluations}`);
  lines.push(`  Total results:    ${result.stats.totalResults}`);
  lines.push(`  Duration:         ${result.profile.totalDurationUs} \u00b5s`);
  lines.push('');

  if (result.bindings.length > 0) {
    lines.push('Bindings:');
    const maxBindings = 20;
    const bindingsToShow = result.bindings.slice(0, maxBindings);
    for (const row of bindingsToShow) {
      const pairs = Object.entries(row).map(([k, v]) => `${k}=${v}`).join(', ');
      lines.push(`  { ${pairs} }`);
    }
    if (result.bindings.length > maxBindings) {
      lines.push(`  ... ${result.bindings.length - maxBindings} more results`);
    }
  }

  return lines.join('\n');
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
  filter.substringMatch = true;
  filter.fuzzyNameFallback = true;

  const nodes: GraphNode[] = [];
  let skipped = 0;
  let totalMatched = 0;

  for await (const node of db.queryNodes(filter)) {
    totalMatched++;
    if (skipped < offset) { skipped++; continue; }
    if (nodes.length < limit) nodes.push(node);
  }

  // === Progressive fallback chain ===
  let fallbackLevel = 'exact';

  // Level 2: type relaxation ("did you mean?")
  if (totalMatched === 0 && type && name) {
    fallbackLevel = 'type_relaxed';
    const relaxedFilter: Record<string, unknown> = {};
    if (name) relaxedFilter.name = name;
    if (file) relaxedFilter.file = file;
    relaxedFilter.substringMatch = true;
    relaxedFilter.fuzzyNameFallback = true;

    for await (const node of db.queryNodes(relaxedFilter)) {
      totalMatched++;
      if (nodes.length < 5) nodes.push(node);
    }
  }

  // Level 3: grep fallback — search source files, enrich with nearest graph nodes
  if (totalMatched === 0 && name) {
    fallbackLevel = 'grep_enriched';
    const grepResults = await grepAndEnrich(db, name, file);
    if (grepResults.length > 0) {
      const typeList = [...new Set(grepResults.map(r => r.type).filter(Boolean))].join(', ');
      return textResult(
        `No graph nodes matched "${name}"${type ? ` (type: ${type})` : ''}. ` +
        `Found ${grepResults.length} match(es) via text search, enriched with graph context (${typeList || 'unresolved'}):\n\n` +
        JSON.stringify(serializeBigInt(grepResults), null, 2)
      );
    }
  }

  if (totalMatched === 0) {
    return textResult('No nodes found matching criteria');
  }

  // === Rich context enrichment ===
  // For each found node, add structural context (methods, calls, imports)
  // Only enrich when result set is small enough (≤10 nodes) to avoid latency
   
  const enriched = nodes.length <= 10
    ? await enrichNodes(db as any, nodes)
    : nodes;

  const hasMore = offset + nodes.length < totalMatched;
  const paginationInfo = formatPaginationInfo({
    limit, offset, returned: nodes.length, total: totalMatched, hasMore,
  });

  const fallbackNote = fallbackLevel === 'type_relaxed'
    ? `No ${type} nodes found matching "${name}". Showing results without type filter:\n`
    : '';

  return textResult(
    `${fallbackNote}Found ${totalMatched} node(s):${paginationInfo}\n\n${JSON.stringify(
      serializeBigInt(enriched), null, 2
    )}`
  );
}

/** Enrich nodes with structural context from graph edges */
async function enrichNodes(
  db: { getOutgoingEdges(id: string, types?: string[] | null): Promise<Array<Record<string, unknown>>>; getIncomingEdges(id: string, types?: string[] | null): Promise<Array<Record<string, unknown>>> },
  nodes: GraphNode[]
): Promise<Array<GraphNode & { _context?: Record<string, unknown> }>> {
  const result = [];
  for (const node of nodes) {
    const nodeId = node.id;
    if (!nodeId) { result.push(node); continue; }

    const context: Record<string, unknown> = {};
    try {
      // Get key outgoing edges (what this node uses/calls/contains)
      const outEdges = await db.getOutgoingEdges(nodeId, null);
      const edgeType = (e: Record<string, unknown>) => String(e.type || '');
      const edgeSrc = (e: Record<string, unknown>) => String(e.src || '');

      const containsCount = outEdges.filter(e => edgeType(e) === 'CONTAINS').length;
      const callsOut = outEdges.filter(e => edgeType(e) === 'CALLS');
      const imports = outEdges.filter(e => edgeType(e) === 'IMPORTS_FROM');

      const inEdges = await db.getIncomingEdges(nodeId, null);
      const callsIn = inEdges.filter(e => edgeType(e) === 'CALLS');
      const containedBy = inEdges.filter(e => edgeType(e) === 'CONTAINS');

      if (containsCount > 0) context.contains = containsCount;
      if (callsOut.length > 0) context.calls_out = callsOut.length;
      if (callsIn.length > 0) {
        context.called_by = callsIn.length;
        context.callers = callsIn.slice(0, 3).map(e => humanReadableId(edgeSrc(e)));
      }
      if (imports.length > 0) context.imports = imports.length;
      if (containedBy.length > 0) {
        context.parent = humanReadableId(edgeSrc(containedBy[0]));
      }

      // For CLASS/INTERFACE nodes: list methods and properties
      const nodeType = String(node.type || '');
      if (nodeType === 'CLASS' || nodeType === 'INTERFACE') {
        const edgeDst = (e: Record<string, unknown>) => String(e.dst || '');
        const methodEdges = outEdges.filter(e => edgeType(e) === 'HAS_METHOD');
        const containsEdges = outEdges.filter(e => edgeType(e) === 'CONTAINS');
        const memberEdges = methodEdges.length > 0 ? methodEdges : containsEdges;
        if (memberEdges.length > 0 && memberEdges.length <= 30) {
          const members = memberEdges
            .map(e => humanReadableId(edgeDst(e)))
            .filter(n => n !== '?');
          if (members.length > 0) context.members = members.slice(0, 15);
        } else if (memberEdges.length > 30) {
          context.member_count = memberEdges.length;
        }
      }
    } catch {
      // Edge queries may fail for some node types — skip enrichment silently
    }

    if (Object.keys(context).length > 0) {
      result.push({ ...node, _context: context });
    } else {
      result.push(node);
    }
  }
  return result;
}

/** Convert a semantic ID to human-readable "name in file.ts" format.
 * Handles: grafema://host/path/file.ts#TYPE->name[scope], path/file.ts#TYPE->name,
 * TYPE-%3Ename (URL-encoded, no file prefix), or raw node IDs.
 *
 * Exported for unit testing.
 * @internal */
export function humanReadableId(semanticId: string): string {
  if (!semanticId) return '?';

  // Split file path from node descriptor on the FIRST literal '#' of the RAW
  // (still percent-encoded) id, BEFORE decoding. The grafema:// URI form encodes
  // the disambiguation counter ('#N', appended by computeSemanticIdV2 for hash
  // collisions) as '%23N' inside the fragment. Decoding first and then splitting
  // on the LAST '#' would mistake that counter for the path/fragment boundary and
  // corrupt the label. A file path never contains a literal '#'. This mirrors the
  // canonical parseSemanticIdV2 (packages/util/src/core/SemanticId.ts).
  const hashIdx = semanticId.indexOf('#');
  let rawFile = '';
  let rawNode = semanticId;
  if (hashIdx !== -1) {
    rawFile = semanticId.slice(0, hashIdx);
    rawNode = semanticId.slice(hashIdx + 1);
  }

  const decode = (s: string): string => {
    try { return decodeURIComponent(s); } catch { return s; }
  };
  const filePart = decode(rawFile);
  // Strip the trailing disambiguation counter ('#N') from the decoded descriptor.
  const nodePart = decode(rawNode).replace(/#\d+$/, '');

  const fileName = filePart ? (filePart.split('/').pop() || '') : '';

  // Extract name from TYPE->name or TYPE->name[in:scope,h:hash]
  const arrowIdx = nodePart.indexOf('->');
  if (arrowIdx === -1) return fileName || nodePart;

  let name = nodePart.slice(arrowIdx + 2);
  // Strip scope/hash info [in:xxx,h:xxx]
  const bracketIdx = name.indexOf('[');
  let scope = '';
  if (bracketIdx > 0) {
    const scopeStr = name.slice(bracketIdx + 1, -1);
    const inMatch = scopeStr.match(/in:([^,]+)/);
    if (inMatch) scope = inMatch[1];
    name = name.slice(0, bracketIdx);
  }

  // Build readable string: "name" or "name (in scope)" or "name in file.ts"
  if (scope && scope !== name) {
    return fileName ? `${name} (in ${scope}) in ${fileName}` : `${name} (in ${scope})`;
  }
  return fileName ? `${name} in ${fileName}` : name || '?';
}

/** Grep source files for a name, then find nearest graph nodes for each match */
async function grepAndEnrich(
  db: { queryNodes(filter: Record<string, unknown>): AsyncIterable<GraphNode> },
  name: string,
  filePattern?: string
): Promise<Array<{ file: string; line: number; match: string; type?: string; node_name?: string; node_id?: string }>> {
  const { execFileSync } = await import('child_process');
  const { getProjectPath } = await import('../state.js');
  const projectRoot = getProjectPath();
  if (!projectRoot) return [];

  try {
    const args = ['-rn', '--include=*.ts', '--include=*.js', '--include=*.tsx', '-l', name];
    if (filePattern) args.push(filePattern);
    else args.push(projectRoot);

    const output = execFileSync('grep', args, {
      timeout: 5000,
      maxBuffer: 50000,
      encoding: 'utf-8',
    }).trim();
    if (!output) return [];

    const files = output.split('\n').slice(0, 5);
    const results = [];

    for (const matchFile of files) {
      // Find graph nodes in this file
      const relPath = matchFile.replace(projectRoot + '/', '');
      const fileNodes: GraphNode[] = [];
      for await (const node of db.queryNodes({ file: relPath, substringMatch: true })) {
        if (fileNodes.length < 3) fileNodes.push(node);
        else break;
      }

      if (fileNodes.length > 0) {
        for (const n of fileNodes) {
          results.push({
            file: relPath,
            line: n.line || 0,
            match: name,
            type: n.type,
            node_name: n.name,
            node_id: n.id,
          });
        }
      } else {
        results.push({ file: relPath, line: 0, match: name });
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * explain_fact (why(), spec §11): explain WHY a derived fact holds — return the rule that derived
 * it and the supporting body facts. Empty `source` ⇒ the bundled depends.dl (so `explain_fact`
 * with predicate "depends" explains a DEPENDS_ON edge). v2-only.
 */
export async function handleExplainFact(args: ExplainFactArgs): Promise<ToolResult> {
  const { predicate, key, source } = args;
  if (!predicate || !Array.isArray(key)) {
    return errorResult('explain_fact requires `predicate` (string) and `key` (array of wire-string terms).');
  }

  const db = await ensureAnalyzed();
  if (!('explainDatalogFact' in db)) {
    return errorResult('Backend does not support explain_fact (needs the RFDB v2 server with RFDB_DATALOG_V2 enabled).');
  }
  const fn = (db as unknown as {
    explainDatalogFact: (s: string, p: string, k: string[]) => Promise<FactWitness | null>;
  }).explainDatalogFact;

  let witness: FactWitness | null;
  try {
    witness = await fn.call(db, source ?? '', predicate, key.map(String));
  } catch (e) {
    return errorResult(`explain_fact failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const factStr = `${predicate}(${key.join(', ')})`;
  if (!witness) {
    return textResult(
      `No derivation: ${factStr} is not derivable by the program (it does not hold as a derived fact).`,
    );
  }

  const lines = [`${factStr} holds — derived by rule ${witness.ruleAstHash}:`];
  if (witness.body.length === 0) {
    lines.push('  (the rule body has no positive facts — supported by builtins/constants alone)');
  } else {
    for (const f of witness.body) {
      lines.push(`  • ${f.predicate}(${f.tuple.join(', ')})`);
    }
  }
  return textResult(guardResponseSize(lines.join('\n')));
}

/**
 * sim_datalog (what-if, spec §6): predict the NEW `predicate` facts a hypothetical overlay of
 * nodes+edges would create — WITHOUT committing anything. Empty `source` ⇒ the bundled
 * depends.dl (so the common use is "which NEW module dependencies would this import create?").
 * v2-only. The companion to explain_gap: gap names the missing premise, sim verifies that
 * adding it produces the fact.
 */
export async function handleSimDatalog(args: SimDatalogArgs): Promise<ToolResult> {
  const { predicate, nodes, edges, source } = args;
  if (!predicate) {
    return errorResult('sim_datalog requires `predicate` (string).');
  }
  const hypNodes: SimNode[] = (nodes ?? []).map((n) => ({
    id: String(n.id),
    nodeType: n.nodeType,
    name: n.name ?? '',
    file: n.file ?? '',
  }));
  const hypEdges: SimEdge[] = (edges ?? []).map((e) => ({
    src: String(e.src),
    dst: String(e.dst),
    edgeType: e.edgeType,
  }));
  if (hypNodes.length === 0 && hypEdges.length === 0) {
    return errorResult('sim_datalog requires at least one hypothetical node or edge.');
  }

  const db = await ensureAnalyzed();
  if (!('simDatalog' in db)) {
    return errorResult('Backend does not support sim_datalog (needs the RFDB v2 server with RFDB_DATALOG_V2 enabled).');
  }
  const fn = (db as unknown as {
    simDatalog: (s: string, p: string, n: SimNode[], e: SimEdge[]) => Promise<string[][]>;
  }).simDatalog;

  let rows: string[][];
  try {
    rows = await fn.call(db, source ?? '', predicate, hypNodes, hypEdges);
  } catch (e) {
    return errorResult(`sim_datalog failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (rows.length === 0) {
    return textResult(
      `No new facts: the hypothetical change creates no NEW ${predicate}() facts (anything it derives already holds).`,
    );
  }
  const lines = [`${rows.length} NEW ${predicate}() fact(s) the hypothetical change would create:`];
  for (const row of rows) {
    lines.push(`  • ${predicate}(${row.join(', ')})`);
  }
  return textResult(guardResponseSize(lines.join('\n')));
}

/**
 * explain_gap (why-not, spec §6): explain why a fact is NOT derived — the satisfied premise
 * prefix and the first premise no binding satisfies. Empty `source` ⇒ the bundled depends.dl
 * (so the common use is "why is there NO dependency A→B?"). v2-only.
 */
export async function handleExplainGap(args: ExplainGapArgs): Promise<ToolResult> {
  const { predicate, key, source } = args;
  if (!predicate || !Array.isArray(key)) {
    return errorResult('explain_gap requires `predicate` (string) and `key` (array of wire-string terms).');
  }

  const db = await ensureAnalyzed();
  if (!('explainDatalogGap' in db)) {
    return errorResult('Backend does not support explain_gap (needs the RFDB v2 server with RFDB_DATALOG_V2 enabled).');
  }
  const fn = (db as unknown as {
    explainDatalogGap: (s: string, p: string, k: string[]) => Promise<GapWitness | null>;
  }).explainDatalogGap;

  let gap: GapWitness | null;
  try {
    gap = await fn.call(db, source ?? '', predicate, key.map(String));
  } catch (e) {
    return errorResult(`explain_gap failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const factStr = `${predicate}(${key.join(', ')})`;
  if (!gap) {
    return textResult(
      `No gap: ${factStr} is derivable (it holds — use explain_fact for its derivation), or no rule head matches this key.`,
    );
  }

  const lines = [`${factStr} does NOT hold — gap in rule ${gap.ruleAstHash}:`];
  if (gap.satisfied.length === 0) {
    lines.push('  satisfied premises: (none)');
  } else {
    lines.push('  satisfied premises:');
    for (const f of gap.satisfied) {
      lines.push(`    • ${f.predicate}(${f.tuple.join(', ')})`);
    }
  }
  if (gap.failingIsNegative) {
    lines.push(
      `  blocking premise: NOT ${gap.failingPredicate}(…) — a PRESENT fact blocks the derivation; the gap closes by REMOVING it.`,
    );
  } else {
    lines.push(
      `  missing premise: ${gap.failingPredicate}(…) — no binding satisfies it; the gap closes by ADDING such a fact (verify with sim_datalog).`,
    );
  }
  return textResult(guardResponseSize(lines.join('\n')));
}
