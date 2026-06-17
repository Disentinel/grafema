/**
 * MCP Context Handlers
 */

import { ensureAnalyzed } from '../analysis.js';
import { getProjectPath } from '../state.js';
import { findCallsInFunction, findContainingFunction, FileOverview, buildNodeContext, getNodeDisplayName, formatEdgeMetadata, STRUCTURAL_EDGE_TYPES, isGrafemaUri, toCompactSemanticId, getShape } from '@grafema/util';
import type { ClassIndex } from '@grafema/util';
import type { CallInfo, CallerInfo, NodeContext } from '@grafema/util';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import {
  serializeBigInt,
  textResult,
  errorResult,
} from '../utils.js';
import type {
  ToolResult,
  GetFunctionDetailsArgs,
  GetContextArgs,
  GetFileOverviewArgs,
  GraphNode,
} from '../types.js';

// === GET FUNCTION DETAILS (REG-254) ===

/**
 * Get comprehensive function details including calls made and callers.
 *
 * Supports two graph layouts (see findCallsInFunction for details):
 * - Layout A: FUNCTION -> HAS_SCOPE -> SCOPE -> CONTAINS -> CALL (legacy)
 * - Layout B: FUNCTION -> AWAITS|RETURNS|THROWS -> CALL (Rust orchestrator)
 *
 * In both layouts: CALL -[CALLS]-> FUNCTION (target)
 *
 * This is the core tool for understanding function behavior.
 * Use transitive=true to follow call chains (A -> B -> C).
 */
export async function handleGetFunctionDetails(
  args: GetFunctionDetailsArgs
): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { name, file, transitive = false } = args;

  // Step 1: Find the function (search both FUNCTION and METHOD nodes)
  const candidates: GraphNode[] = [];
  for (const nodeType of ['FUNCTION', 'METHOD']) {
    for await (const node of db.queryNodes({ type: nodeType })) {
      if (node.name !== name) continue;
      if (file && !node.file?.includes(file)) continue;
      candidates.push(node);
    }
  }

  // Fallback: search for const-bound arrow functions
  // Pattern: CONSTANT("create_search_handler") -[ASSIGNED_FROM]-> FUNCTION("<arrow>")
  if (candidates.length === 0) {
    for (const nodeType of ['CONSTANT', 'VARIABLE']) {
      for await (const node of db.queryNodes({ type: nodeType })) {
        if (node.name !== name) continue;
        if (file && !node.file?.includes(file)) continue;
        // Check if this variable/constant is assigned from a function
        const assignedEdges = await db.getOutgoingEdges(node.id, ['ASSIGNED_FROM']);
        for (const edge of assignedEdges) {
          const target = await db.getNode(edge.dst);
          if (target && (target.type === 'FUNCTION' || target.type === 'METHOD')) {
            // Use the function node but keep the const name for display
            const fnNode = { ...target, name: node.name } as GraphNode;
            candidates.push(fnNode);
          }
        }
      }
    }
  }

  if (candidates.length === 0) {
    return errorResult(
      `Function "${name}" not found.` +
      (file ? ` (searched in files matching "${file}")` : '')
    );
  }

  if (candidates.length > 1 && !file) {
    const locations = candidates.map(f => `${f.file}:${f.line}`).join(', ');
    return errorResult(
      `Multiple functions named "${name}" found: ${locations}. ` +
      `Use the "file" parameter to disambiguate.`
    );
  }

  const targetFunction = candidates[0];

  // Step 2: Find calls using shared utility
  const calls = await findCallsInFunction(db, targetFunction.id, {
    transitive,
    transitiveDepth: 5,
  });

  // Step 3: Find callers
  const calledBy: CallerInfo[] = [];
  const incomingCalls = await db.getIncomingEdges(targetFunction.id, ['CALLS']);
  const seenCallers = new Set<string>();

  for (const edge of incomingCalls) {
    const caller = await findContainingFunction(db, edge.src);
    if (caller && !seenCallers.has(caller.id)) {
      seenCallers.add(caller.id);
      calledBy.push(caller);
    }
  }

  // Step 4: Build result
  const result = {
    id: targetFunction.id,
    name: targetFunction.name,
    file: targetFunction.file,
    line: targetFunction.line as number | undefined,
    async: targetFunction.async as boolean | undefined,
    calls,
    calledBy,
  };

  // Format output
  const summary = [
    `Function: ${result.name}`,
    `File: ${result.file || 'unknown'}:${result.line || '?'}`,
    `Async: ${result.async || false}`,
    `Transitive: ${transitive}`,
    '',
    `Calls (${calls.length}):`,
    ...formatCallsForDisplay(calls),
    '',
    `Called by (${calledBy.length}):`,
    ...calledBy.map(c => `  - ${c.name} (${c.file}:${c.line})`),
  ].join('\n');

  return textResult(
    summary + '\n\n' +
    JSON.stringify(serializeBigInt(result), null, 2)
  );
}

/**
 * Format calls for display, grouped by depth if transitive
 */
function formatCallsForDisplay(calls: CallInfo[]): string[] {
  const directCalls = calls.filter(c => (c.depth || 0) === 0);
  const transitiveCalls = calls.filter(c => (c.depth || 0) > 0);

  const lines: string[] = [];

  // Direct calls
  for (const c of directCalls) {
    const target = c.resolved
      ? ` -> ${c.target?.name} (${c.target?.file}:${c.target?.line})`
      : ' (unresolved)';
    const prefix = c.type === 'METHOD_CALL' ? `${c.object}.` : '';
    // R2: annotate non-precise resolutions so the reader sees the sound-superset
    // fan-out (the precise default stays silent to avoid noise).
    const prec = c.precision && c.precision.precision !== 'precise'
      ? ` [${c.precision.precision}: ${c.precision.candidateCount} candidates]`
      : '';
    lines.push(`  - ${prefix}${c.name}()${target}${prec}`);
  }

  // Transitive calls (grouped by depth)
  if (transitiveCalls.length > 0) {
    lines.push('');
    lines.push('  Transitive calls:');

    const byDepth = new Map<number, CallInfo[]>();
    for (const c of transitiveCalls) {
      const depth = c.depth || 1;
      if (!byDepth.has(depth)) byDepth.set(depth, []);
      byDepth.get(depth)!.push(c);
    }

    for (const [depth, depthCalls] of Array.from(byDepth.entries()).sort((a, b) => a[0] - b[0])) {
      for (const c of depthCalls) {
        const indent = '  '.repeat(depth + 1);
        const prefix = c.type === 'METHOD_CALL' ? `${c.object}.` : '';
        const target = c.resolved ? ` -> ${c.target?.name}` : '';
        lines.push(`${indent}[depth=${depth}] ${prefix}${c.name}()${target}`);
      }
    }
  }

  return lines;
}

// === NODE CONTEXT (REG-406) ===

export async function handleGetContext(
  args: GetContextArgs
): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { semanticId, contextLines: ctxLines = 3, edgeType } = args;

  // Accept both grafema:// URI and compact format
  const displayId = isGrafemaUri(semanticId) ? toCompactSemanticId(semanticId) : semanticId;

  // 1. Look up node
  const node = await db.getNode(semanticId);
  if (!node) {
    return errorResult(
      `Node not found: "${displayId}"\n` +
      `Use find_nodes or query_graph to find the correct semantic ID.`
    );
  }

  const edgeTypeFilter = edgeType
    ? new Set(edgeType.split(',').map(t => t.trim().toUpperCase()))
    : null;

  // 2. Build context using shared logic
  const projectPath = getProjectPath();
  const ctx: NodeContext = await buildNodeContext(db, node, {
    contextLines: ctxLines,
    edgeTypeFilter,
    readFileContent: (filePath: string) => {
      const absPath = isAbsolute(filePath) ? filePath : join(projectPath, filePath);
      if (!existsSync(absPath)) return null;
      try { return readFileSync(absPath, 'utf-8'); } catch { return null; }
    },
  });

  // 3. Format text output
  const relFile = node.file ? (isAbsolute(node.file) ? relative(projectPath, node.file) : node.file) : undefined;
  const lines: string[] = [];

  lines.push(`[${node.type}] ${getNodeDisplayName(node)}`);
  lines.push(`  ID: ${node.id}`);
  if (relFile) {
    lines.push(`  Location: ${relFile}${node.line ? `:${node.line}` : ''}`);
  }

  // Source
  if (ctx.source) {
    lines.push('');
    lines.push(`  Source (lines ${ctx.source.startLine}-${ctx.source.endLine}):`);
    const maxLineNum = ctx.source.endLine;
    const lineNumWidth = String(maxLineNum).length;
    for (let i = 0; i < ctx.source.lines.length; i++) {
      const lineNum = ctx.source.startLine + i;
      const paddedNum = String(lineNum).padStart(lineNumWidth, ' ');
      const prefix = lineNum === (node.line as number) ? '>' : ' ';
      const displayLine = ctx.source.lines[i].length > 120
        ? ctx.source.lines[i].slice(0, 117) + '...'
        : ctx.source.lines[i];
      lines.push(`    ${prefix}${paddedNum} | ${displayLine}`);
    }
  }

  const formatEdgeSection = (groups: NodeContext['outgoing'], dir: '->' | '<-') => {
    for (const group of groups) {
      const isStructural = STRUCTURAL_EDGE_TYPES.has(group.edgeType);
      lines.push(`    ${group.edgeType} (${group.edges.length}):`);
      for (const { edge, node: connNode } of group.edges) {
        if (!connNode) {
          const danglingId = dir === '->' ? edge.dst : edge.src;
          lines.push(`      ${dir} [dangling] ${danglingId}`);
          continue;
        }
        const nFile = connNode.file ? (isAbsolute(connNode.file) ? relative(projectPath, connNode.file) : connNode.file) : '';
        const nLoc = nFile ? (connNode.line ? `${nFile}:${connNode.line}` : nFile) : '';
        const locStr = nLoc ? `  (${nLoc})` : '';
        const metaStr = formatEdgeMetadata(edge);
        lines.push(`      ${dir} [${connNode.type}] ${getNodeDisplayName(connNode)}${locStr}${metaStr}`);

        // Code context for non-structural edges
        if (!isStructural && connNode.file && connNode.line && ctxLines > 0) {
          const absoluteConnFile = !isAbsolute(connNode.file) ? join(projectPath, connNode.file) : connNode.file;
          if (existsSync(absoluteConnFile)) {
            try {
              const content = readFileSync(absoluteConnFile, 'utf-8');
              const allFileLines = content.split('\n');
              const nLine = connNode.line as number;
              const sLine = Math.max(1, nLine - Math.min(ctxLines, 2));
              const eLine = Math.min(allFileLines.length, nLine + Math.min(ctxLines, 2));
              const w = String(eLine).length;
              for (let i = sLine; i <= eLine; i++) {
                const p = i === nLine ? '>' : ' ';
                const ln = String(i).padStart(w, ' ');
                const displayLn = allFileLines[i - 1].length > 120
                  ? allFileLines[i - 1].slice(0, 117) + '...'
                  : allFileLines[i - 1];
                lines.push(`           ${p}${ln} | ${displayLn}`);
              }
            } catch { /* ignore */ }
          }
        }
      }
    }
  };

  if (ctx.outgoing.length > 0) {
    lines.push('');
    lines.push('  Outgoing edges:');
    formatEdgeSection(ctx.outgoing, '->');
  }

  if (ctx.incoming.length > 0) {
    lines.push('');
    lines.push('  Incoming edges:');
    formatEdgeSection(ctx.incoming, '<-');
  }

  if (ctx.outgoing.length === 0 && ctx.incoming.length === 0) {
    lines.push('');
    lines.push('  No edges found.');
  }

  // Build JSON result alongside text
  const jsonResult = {
    node: { id: node.id, type: node.type, name: node.name, file: relFile, line: node.line },
    source: ctx.source ? {
      startLine: ctx.source.startLine,
      endLine: ctx.source.endLine,
      lines: ctx.source.lines,
    } : null,
    outgoing: Object.fromEntries(ctx.outgoing.map(g => [g.edgeType, g.edges])),
    incoming: Object.fromEntries(ctx.incoming.map(g => [g.edgeType, g.edges])),
  };

  return textResult(
    lines.join('\n') + '\n\n' + JSON.stringify(serializeBigInt(jsonResult), null, 2)
  );
}

// === FILE OVERVIEW (REG-412) ===

export async function handleGetFileOverview(
  args: GetFileOverviewArgs
): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const projectPath = getProjectPath();
  const { file, include_edges: includeEdges = true } = args;

  let filePath = file;

  if (!filePath.startsWith('/')) {
    filePath = join(projectPath, filePath);
  }

  if (!existsSync(filePath)) {
    return errorResult(
      `File not found: ${file}\n` +
      `Resolved to: ${filePath}\n` +
      `Project root: ${projectPath}`
    );
  }

  const absolutePath = realpathSync(filePath);
  const relativePath = relative(projectPath, absolutePath);

  try {
    const overview = new FileOverview(db);
    const result = await overview.getOverview(relativePath, {
      includeEdges,
    });

    result.file = relativePath;

    if (result.status === 'NOT_ANALYZED') {
      return textResult(
        `File not analyzed: ${relativePath}\n` +
        `Run analyze_project to build the graph.`
      );
    }

    const lines: string[] = [];

    lines.push(`Module: ${result.file}`);

    if (result.imports.length > 0) {
      const sources = result.imports.map(i => i.source);
      lines.push(`Imports: ${sources.join(', ')}`);
    }

    if (result.exports.length > 0) {
      const names = result.exports.map(e =>
        e.isDefault ? `${e.name} (default)` : e.name
      );
      lines.push(`Exports: ${names.join(', ')}`);
    }

    if (result.classes.length > 0) {
      lines.push('');
      lines.push('Classes:');
      for (const cls of result.classes) {
        const ext = cls.extends ? ` extends ${cls.extends}` : '';
        lines.push(`  ${cls.name}${ext} (line ${cls.line ?? '?'})`);
        for (const m of cls.methods) {
          const calls = m.calls.length > 0
            ? `  -> ${m.calls.join(', ')}`
            : '';
          const params = m.params
            ? `(${m.params.join(', ')})`
            : '()';
          lines.push(`    ${m.name}${params}${calls}`);
        }
      }
    }

    if (result.functions.length > 0) {
      lines.push('');
      lines.push('Functions:');
      for (const fn of result.functions) {
        const calls = fn.calls.length > 0
          ? `  -> ${fn.calls.join(', ')}`
          : '';
        const params = fn.params
          ? `(${fn.params.join(', ')})`
          : '()';
        const asyncStr = fn.async ? 'async ' : '';
        lines.push(
          `  ${asyncStr}${fn.name}${params}${calls}  (line ${fn.line ?? '?'})`
        );
      }
    }

    if (result.variables.length > 0) {
      lines.push('');
      lines.push('Variables:');
      for (const v of result.variables) {
        const assign = v.assignedFrom ? ` = ${v.assignedFrom}` : '';
        lines.push(
          `  ${v.kind} ${v.name}${assign}  (line ${v.line ?? '?'})`
        );
      }
    }

    return textResult(
      lines.join('\n') + '\n\n' +
      JSON.stringify(serializeBigInt(result), null, 2)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to get file overview: ${message}`);
  }
}

// === GET SHAPE ===

export async function handleGetShape(args: { target: string; file?: string }): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const { target, file } = args;

  // Find the target node
  let targetNode: GraphNode | null = await db.getNode(target);
  if (!targetNode) {
    // Search by name, preferring CLASS/INTERFACE
    for (const type of ['CLASS', 'INTERFACE', 'VARIABLE', 'CONSTANT', 'PARAMETER']) {
      for await (const node of db.queryNodes({ type, name: target })) {
        if (file && !node.file?.includes(file)) continue;
        targetNode = node;
        break;
      }
      if (targetNode) break;
    }
  }
  if (!targetNode) {
    return errorResult(`Target "${target}" not found. Provide a CLASS, INTERFACE, or typed variable name.`);
  }

  // Build class index for EXTENDS chain walking
  const classIndex: ClassIndex = new Map();
  for await (const node of db.queryNodes({ type: 'CLASS' })) {
    if (node.name) classIndex.set(node.name, String(node.id));
  }
  for await (const node of db.queryNodes({ type: 'INTERFACE' })) {
    if (node.name) classIndex.set(node.name, String(node.id));
  }

  const backend = {
    getNode: (id: string) => db.getNode(id),
    getOutgoingEdges: (id: string) => db.getOutgoingEdges(id),
    getIncomingEdges: (id: string) => db.getIncomingEdges(id),
  };

  const shape = await getShape(backend as never, String(targetNode.id), classIndex);
  if (!shape) {
    return errorResult(`Could not determine shape for "${target}". It may not be a CLASS, INTERFACE, or typed variable.`);
  }

  // Format output
  const lines: string[] = [];
  lines.push(`## Shape: ${shape.name} (${shape.nodeType})`);
  if (shape.file) lines.push(`File: ${shape.file}`);
  if (shape.extends.length > 0) lines.push(`Extends: ${shape.extends.join(' → ')}`);
  if (shape.implements.length > 0) lines.push(`Implements: ${shape.implements.join(', ')}`);
  lines.push(`Confidence: ${shape.confidence}`);
  lines.push('');

  // Group members by source
  const bySource = new Map<string, typeof shape.members>();
  for (const m of shape.members) {
    if (!bySource.has(m.from)) bySource.set(m.from, []);
    bySource.get(m.from)!.push(m);
  }

  for (const [source, members] of bySource) {
    const label = source === shape.name ? 'Own members' : `Inherited from ${source}`;
    lines.push(`### ${label} (${members.length})`);
    const methods = members.filter(m => m.kind === 'method' || m.kind === 'method_signature');
    const props = members.filter(m => m.kind === 'property' || m.kind === 'property_signature');
    if (methods.length > 0) {
      lines.push(`Methods: ${methods.map(m => m.name).join(', ')}`);
    }
    if (props.length > 0) {
      lines.push(`Properties: ${props.map(m => m.name).join(', ')}`);
    }
    lines.push('');
  }

  lines.push(`Total: ${shape.members.length} members`);

  return textResult(lines.join('\n'));
}
