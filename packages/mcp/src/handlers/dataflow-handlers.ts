/**
 * MCP Dataflow Handlers
 *
 * Delegates BFS tracing to @grafema/util's shared traceDataflow module.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { ensureAnalyzed } from '../analysis.js';
import { getProjectPath } from '../state.js';
import {
  serializeBigInt,
  textResult,
  errorResult,
} from '../utils.js';
import { isGrafemaUri, toCompactSemanticId } from '@grafema/util';
import type {
  ToolResult,
  TraceAliasArgs,
  TraceDataFlowArgs,
  TraceCallChainArgs,
  TraceEffectsArgs,
  CheckInvariantArgs,
  GraphNode,
} from '../types.js';
import {
  traceDataflow,
  renderTraceNarrative,
  traceCallChain,
  traceEffects,
  EffectsLookup,
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

export async function handleTraceDataflow(args: TraceDataFlowArgs): Promise<ToolResult> {
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
    const displaySource = isGrafemaUri(source) ? toCompactSemanticId(source) : source;
    return errorResult(`Source "${displaySource}" not found`);
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

// === TRACE CALL CHAIN ===

export async function handleTraceCalls(args: TraceCallChainArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { source, file, direction = 'forward', max_depth = 10 } = args;

  // Find source node (same resolution logic as trace_dataflow)
  let sourceNode: GraphNode | null = await db.getNode(source);
  if (!sourceNode) {
    let fallbackNode: GraphNode | null = null;
    for (const type of ['FUNCTION', 'METHOD']) {
      for await (const node of db.queryNodes({ type, name: source })) {
        if (file && !node.file?.includes(file)) {
          if (!fallbackNode) fallbackNode = node;
          continue;
        }
        sourceNode = node;
        break;
      }
      if (sourceNode) break;
    }
    if (!sourceNode && fallbackNode) {
      sourceNode = fallbackNode;
    }
  }
  if (!sourceNode) {
    const displaySource = isGrafemaUri(source) ? toCompactSemanticId(source) : source;
    return errorResult(`Source "${displaySource}" not found. Provide a FUNCTION or METHOD name.`);
  }

  const results = await traceCallChain(db as never, sourceNode.id, {
    direction: direction as 'forward' | 'backward' | 'both',
    maxDepth: max_depth,
    limit: 100,
  });

  // Render as indented call tree
  const lines: string[] = [];
  const sourceName = sourceNode.name || source;
  const sourceFile = sourceNode.file ? sourceNode.file.split('/').pop() : '';

  for (const result of results) {
    lines.push(`## ${result.direction === 'forward' ? 'Outgoing calls from' : 'Incoming callers of'} ${sourceName} (${sourceFile}:${sourceNode.line ?? '?'})`);
    lines.push('');

    if (result.chain.length === 0) {
      lines.push('  (no calls found)');
      continue;
    }

    for (const hop of result.chain) {
      const indent = '  '.repeat(hop.depth + 1);
      const prefix = hop.remote ? '> calls_remote' : '> calls';
      const shortFile = hop.file ? hop.file.split('/').pop() : '?';
      const loc = hop.line ? `${shortFile}:${hop.line}` : shortFile;
      const unresolvedTag = hop.resolved ? '' : ' [unresolved]';
      lines.push(`${indent}${prefix} ${hop.name} (${loc})${unresolvedTag}`);
    }

    lines.push('');
    lines.push(`${result.totalFound} hop(s) found`);
  }

  lines.push('');
  lines.push('Legend: > calls = local call, > calls_remote = cross-process/language boundary');

  return textResult(lines.join('\n'));
}

// === EXPLAIN (graph data + LLM prompt injection) ===

export interface ExplainArgs {
  target: string;
  file?: string;
  question?: string;
}

export async function handleExplain(args: ExplainArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { target, file, question } = args;

  // 1. Find the target node
  let targetNode: GraphNode | null = await db.getNode(target);
  if (!targetNode) {
    for await (const node of db.queryNodes({ name: target })) {
      if (file && !node.file?.includes(file)) continue;
      targetNode = node;
      break;
    }
  }
  if (!targetNode) {
    // Try PARAMETER, CONSTANT
    for (const type of ['PARAMETER', 'CONSTANT', 'IMPORT_BINDING']) {
      for await (const node of db.queryNodes({ type, name: target })) {
        if (file && !node.file?.includes(file)) continue;
        targetNode = node;
        break;
      }
      if (targetNode) break;
    }
  }
  if (!targetNode) {
    return errorResult(`Target "${target}" not found`);
  }

  // 2. Gather graph context based on question type
  const dfDb = db as unknown as DataflowBackend;
  const sections: string[] = [];

  // RFDBServerBackend._parseNode emits the canonical `type` field and strips
  // `nodeType`, so read `type` (the old `nodeType ||` prefix was always undefined).
  const nodeType = targetNode.type;
  const nodeName = targetNode.name || target;
  const nodeFile = targetNode.file || '';

  sections.push(`## ${nodeType} "${nodeName}" in ${nodeFile}`);

  // Always include dataflow (both directions)
  const trace = await traceDataflow(dfDb, targetNode.id, {
    direction: 'both',
    maxDepth: 8,
    limit: 30,
  });
  const traceText = renderTraceNarrative(trace, nodeName, { detail: 'normal' });
  sections.push(`### Dataflow\n${traceText}`);

  // Include structure context if it's a function
  if (nodeType === 'FUNCTION') {
    const allOutEdges = await db.getOutgoingEdges(targetNode.id);
    const allInEdges = await db.getIncomingEdges(targetNode.id);
    const outSummary: string[] = [];
    const inSummary: string[] = [];
    for (const edge of allOutEdges.slice(0, 15)) {
      if (['CALLS', 'CONTAINS', 'HAS_SCOPE'].includes(edge.type)) {
        const dst = await db.getNode(edge.dst);
        if (dst) outSummary.push(`${edge.type} → ${dst.type} "${dst.name}"`);
      }
    }
    for (const edge of allInEdges.slice(0, 15)) {
      if (['CALLS', 'CONTAINS'].includes(edge.type)) {
        const src = await db.getNode(edge.src);
        if (src) inSummary.push(`${edge.type} ← ${src.type} "${src.name}"`);
      }
    }
    if (outSummary.length) sections.push(`### Outgoing\n${outSummary.join('\n')}`);
    if (inSummary.length) sections.push(`### Incoming\n${inSummary.join('\n')}`);
  }

  // 3. Prompt injection — instruct the calling LLM to summarize
  const questionText = question || `what is "${nodeName}" and how is it used?`;
  const prompt = `
---
INSTRUCTION: Based on the graph data above, answer the user's question in 2-3 concise sentences.
Question: "${questionText}"
Focus on: data origins, transformations, and where the value ends up.
Use concrete names from the trace (function names, variable names, file paths).
Do NOT repeat the raw graph data — synthesize it into a human-readable explanation.
---`;

  sections.push(prompt);

  return textResult(sections.join('\n\n'));
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

// === TRACE EFFECTS ===

let _effectsLookup: EffectsLookup | null = null;

function getEffectsLookup(): EffectsLookup {
  if (!_effectsLookup) {
    // Find effects-db directory relative to the project
    // The effects-db is at the project root: <repo>/effects-db/
    // Also check node_modules for installed packages
    const candidates = [
      join(getProjectPath(), 'effects-db'),
      join(getProjectPath(), 'node_modules', '@grafema', 'effects-db'),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        _effectsLookup = EffectsLookup.load(candidate);
        break;
      }
    }

    if (!_effectsLookup) {
      _effectsLookup = EffectsLookup.empty();
    }
  }
  return _effectsLookup;
}

export async function handleTraceEffects(args: TraceEffectsArgs): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { node, file, max_depth = 10 } = args;

  // Find source node (same pattern as handleTraceCalls)
  let sourceNode: GraphNode | null = await db.getNode(node);
  if (!sourceNode) {
    let fallbackNode: GraphNode | null = null;
    for (const type of ['FUNCTION', 'METHOD', 'CONSTRUCTOR']) {
      for await (const n of db.queryNodes({ type, name: node })) {
        if (file && !n.file?.includes(file)) {
          if (!fallbackNode) fallbackNode = n;
          continue;
        }
        sourceNode = n;
        break;
      }
      if (sourceNode) break;
    }
    if (!sourceNode && fallbackNode) {
      sourceNode = fallbackNode;
    }
  }
  if (!sourceNode) {
    const displaySource = isGrafemaUri(node) ? toCompactSemanticId(node) : node;
    return errorResult(`Source "${displaySource}" not found. Provide a FUNCTION or METHOD name.`);
  }

  const effectsLookup = getEffectsLookup();
  const dfDb = db as unknown as DataflowBackend;

  const result = await traceEffects(dfDb, sourceNode.id, effectsLookup, { maxDepth: max_depth });

  if (!result) {
    return errorResult(`Could not trace effects for "${sourceNode.name || node}"`);
  }

  // Format as readable text
  const lines: string[] = [];
  const name = result.node.name;
  const fileShort = result.node.file ? result.node.file.split('/').pop() : '?';

  lines.push(`## Effects of ${name} (${fileShort}:${result.node.line ?? '?'})`);
  lines.push('');

  lines.push(`**Direct effects:** ${result.direct.join(', ') || 'PURE'}`);
  lines.push(`**Transitive effects:** ${result.transitive.join(', ')}`);
  lines.push('');

  if (result.leaf_sources.length > 0) {
    lines.push(`### Leaf sources (${result.leaf_sources.length})`);
    for (const leaf of result.leaf_sources) {
      const leafFile = leaf.file ? leaf.file.split('/').pop() : '';
      const loc = leafFile ? ` (${leafFile})` : '';
      lines.push(`  depth ${leaf.depth}: ${leaf.node}${loc} → ${leaf.effects.join(', ')}`);
    }
    lines.push('');
  }

  if (result.boundary_crossings.length > 0) {
    lines.push(`### Boundary crossings (${result.boundary_crossings.length})`);
    for (const bc of result.boundary_crossings) {
      const fromShort = bc.from_file.split('/').pop();
      const toShort = bc.to_file.split('/').pop();
      lines.push(`  ${bc.caller} (${fromShort}) → ${bc.callee} (${toShort}): ${bc.effects.join(', ')}`);
    }
    lines.push('');
  }

  lines.push(`---`);
  lines.push(`Nodes visited: ${result.nodes_visited}, max depth: ${result.max_depth}${result.max_depth_reached ? ' (TRUNCATED — some paths marked UNKNOWN)' : ''}`);

  return textResult(lines.join('\n'));
}
