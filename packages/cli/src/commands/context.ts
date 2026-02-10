/**
 * Context command — Show deep context for a graph node
 *
 * Displays the full graph neighborhood: source code + all incoming/outgoing edges
 * with code context at each connected node's location.
 *
 * Works for ANY node type: FUNCTION, VARIABLE, MODULE, http:route, CALL, etc.
 *
 * Output is grep-friendly with stable prefixes:
 *   -> outgoing edges
 *   <- incoming edges
 *   >  highlighted source lines
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend } from '@grafema/core';
import type { EdgeRecord, BaseNodeRecord } from '@grafema/types';
import { getCodePreview, formatCodePreview } from '../utils/codePreview.js';
import { formatLocation } from '../utils/formatNode.js';
import { exitWithError } from '../utils/errorFormatter.js';
import { Spinner } from '../utils/spinner.js';

interface ContextOptions {
  project: string;
  json?: boolean;
  lines: string;
  edgeType?: string;
}

/**
 * Edge types that are structural/containment — shown in compact form by default.
 * These describe HOW code is nested, not WHAT it does.
 */
const STRUCTURAL_EDGE_TYPES = new Set([
  'CONTAINS',
  'HAS_SCOPE',
  'DECLARES',
  'DEFINES',
  'HAS_CONDITION',
  'HAS_CASE',
  'HAS_DEFAULT',
  'HAS_CONSEQUENT',
  'HAS_ALTERNATE',
  'HAS_BODY',
  'HAS_INIT',
  'HAS_UPDATE',
  'HAS_CATCH',
  'HAS_FINALLY',
  'HAS_PARAMETER',
  'HAS_PROPERTY',
  'HAS_ELEMENT',
  'USES',
  'GOVERNS',
  'VIOLATES',
  'AFFECTS',
  'UNKNOWN',
]);

interface EdgeWithNode {
  edge: EdgeRecord;
  node: BaseNodeRecord | null;
}

interface EdgeGroup {
  edgeType: string;
  edges: EdgeWithNode[];
}

export interface NodeContext {
  node: BaseNodeRecord;
  source: { file: string; startLine: number; endLine: number; lines: string[] } | null;
  outgoing: EdgeGroup[];
  incoming: EdgeGroup[];
}

export const contextCommand = new Command('context')
  .description('Show deep context for a graph node: source code + graph neighborhood')
  .argument('<semanticId>', 'Semantic ID of the node (exact match)')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON (full dump, no filtering)')
  .option('-l, --lines <n>', 'Context lines around each code reference', '3')
  .option(
    '-e, --edge-type <type>',
    `Filter edges by type (e.g., CALLS, ASSIGNED_FROM, DEPENDS_ON)

Multiple types can be comma-separated: --edge-type CALLS,ASSIGNED_FROM

Examples:
  grafema context <id> --edge-type CALLS
  grafema context <id> -e DEPENDS_ON,IMPORTS_FROM`
  )
  .addHelpText('after', `
Output format (grep-friendly):
  ->  outgoing edge (this node points to)
  <-  incoming edge (points to this node)
  >   highlighted source line

Examples:
  grafema context "src/app.js->global->FUNCTION->main"
  grafema context "http:route#POST#/api/users" --edge-type ROUTES_TO,HANDLED_BY
  grafema context <id> --json
  grafema context <id> | grep "CALLS"
  grafema context <id> | grep "<-"
`)
  .action(async (semanticId: string, options: ContextOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    const spinner = new Spinner('Loading context...');
    spinner.start();

    try {
      const contextLines = parseInt(options.lines, 10);
      const edgeTypeFilter = options.edgeType
        ? new Set(options.edgeType.split(',').map(t => t.trim().toUpperCase()))
        : null;

      // 1. Look up node by exact semantic ID
      const node = await backend.getNode(semanticId);
      if (!node) {
        spinner.stop();
        exitWithError(`Node not found: "${semanticId}"`, [
          'Use: grafema query "<name>" to find the correct semantic ID',
        ]);
      }

      // 2. Build context
      const ctx = await buildNodeContext(backend, node, contextLines, edgeTypeFilter);

      spinner.stop();

      // 3. Output
      if (options.json) {
        console.log(JSON.stringify(ctx, null, 2));
      } else {
        printContext(ctx, projectPath, contextLines);
      }
    } finally {
      spinner.stop();
      await backend.close();
    }
  });

/**
 * Build full node context: source + all edges with connected nodes
 */
async function buildNodeContext(
  backend: RFDBServerBackend,
  node: BaseNodeRecord,
  contextLines: number,
  edgeTypeFilter: Set<string> | null,
): Promise<NodeContext> {
  // Source code preview
  let source: NodeContext['source'] = null;
  if (node.file && node.line) {
    const preview = getCodePreview({
      file: node.file,
      line: node.line as number,
      contextBefore: contextLines,
      contextAfter: contextLines + 12, // show more after the highlighted line
    });
    if (preview) {
      source = {
        file: node.file,
        startLine: preview.startLine,
        endLine: preview.endLine,
        lines: preview.lines,
      };
    }
  }

  // Outgoing edges
  const rawOutgoing = await backend.getOutgoingEdges(node.id);
  const outgoing = await groupEdges(backend, rawOutgoing, 'dst', edgeTypeFilter);

  // Incoming edges
  const rawIncoming = await backend.getIncomingEdges(node.id);
  const incoming = await groupEdges(backend, rawIncoming, 'src', edgeTypeFilter);

  return { node, source, outgoing, incoming };
}

/**
 * Group edges by type and resolve connected nodes
 */
async function groupEdges(
  backend: RFDBServerBackend,
  edges: EdgeRecord[],
  nodeField: 'src' | 'dst',
  edgeTypeFilter: Set<string> | null,
): Promise<EdgeGroup[]> {
  const groups = new Map<string, EdgeWithNode[]>();

  for (const edge of edges) {
    const edgeType = edge.type || 'UNKNOWN';

    // Apply edge type filter
    if (edgeTypeFilter && !edgeTypeFilter.has(edgeType)) continue;

    const connectedId = edge[nodeField];
    const connectedNode = await backend.getNode(connectedId);

    if (!groups.has(edgeType)) {
      groups.set(edgeType, []);
    }
    groups.get(edgeType)!.push({ edge, node: connectedNode });
  }

  // Sort groups: primary edges first, then structural
  return Array.from(groups.entries())
    .sort(([a], [b]) => {
      const aStructural = STRUCTURAL_EDGE_TYPES.has(a);
      const bStructural = STRUCTURAL_EDGE_TYPES.has(b);
      if (aStructural !== bStructural) return aStructural ? 1 : -1;
      return a.localeCompare(b);
    })
    .map(([edgeType, edges]) => ({ edgeType, edges }));
}

/**
 * Print context to stdout in grep-friendly format
 */
function printContext(ctx: NodeContext, projectPath: string, contextLines: number): void {
  const { node, source, outgoing, incoming } = ctx;

  // Node header
  const displayName = getDisplayName(node);
  console.log(`[${node.type}] ${displayName}`);
  console.log(`  ID: ${node.id}`);

  const loc = formatLocation(node.file, node.line as number | undefined, projectPath);
  if (loc) {
    console.log(`  Location: ${loc}`);
  }

  // Source code
  if (source) {
    console.log('');
    console.log(`  Source (lines ${source.startLine}-${source.endLine}):`);
    const formatted = formatCodePreview(
      { lines: source.lines, startLine: source.startLine, endLine: source.endLine },
      node.line as number | undefined,
    );
    for (const line of formatted) {
      console.log(`    ${line}`);
    }
  }

  // Outgoing edges
  if (outgoing.length > 0) {
    console.log('');
    console.log('  Outgoing edges:');
    for (const group of outgoing) {
      printEdgeGroup(group, '->', projectPath, contextLines);
    }
  }

  // Incoming edges
  if (incoming.length > 0) {
    console.log('');
    console.log('  Incoming edges:');
    for (const group of incoming) {
      printEdgeGroup(group, '<-', projectPath, contextLines);
    }
  }

  // Summary if no edges
  if (outgoing.length === 0 && incoming.length === 0) {
    console.log('');
    console.log('  No edges found.');
  }
}

/**
 * Print a group of edges with the same type
 */
function printEdgeGroup(
  group: EdgeGroup,
  direction: '->' | '<-',
  projectPath: string,
  contextLines: number,
): void {
  const isStructural = STRUCTURAL_EDGE_TYPES.has(group.edgeType);

  console.log(`    ${group.edgeType} (${group.edges.length}):`);

  for (const { edge, node } of group.edges) {
    if (!node) {
      const danglingId = direction === '->' ? edge.dst : edge.src;
      console.log(`      ${direction} [dangling] ${danglingId}`);
      continue;
    }

    const displayName = getDisplayName(node);
    const loc = formatLocation(node.file, node.line as number | undefined, projectPath);
    const locStr = loc ? `  (${loc})` : '';

    // Edge metadata inline (if present and useful)
    const metaStr = formatEdgeMetadata(edge);

    console.log(`      ${direction} [${node.type}] ${displayName}${locStr}${metaStr}`);

    // Code context for non-structural edges
    if (!isStructural && node.file && node.line && contextLines > 0) {
      const preview = getCodePreview({
        file: node.file,
        line: node.line as number,
        contextBefore: Math.min(contextLines, 2),
        contextAfter: Math.min(contextLines, 2),
      });
      if (preview) {
        const formatted = formatCodePreview(preview, node.line as number);
        for (const line of formatted) {
          console.log(`           ${line}`);
        }
      }
    }
  }
}

/**
 * Format edge metadata for inline display (only meaningful fields)
 */
function formatEdgeMetadata(edge: EdgeRecord): string {
  const parts: string[] = [];
  const meta = edge.metadata || {};

  if (edge.type === 'PASSES_ARGUMENT' || edge.type === 'RECEIVES_ARGUMENT') {
    if ('argIndex' in meta) {
      parts.push(`arg${meta.argIndex}`);
    }
  }
  if (edge.type === 'FLOWS_INTO') {
    if ('mutationMethod' in meta) parts.push(`via ${meta.mutationMethod}`);
  }
  if (edge.type === 'HAS_PROPERTY') {
    if ('propertyName' in meta) parts.push(`key: ${meta.propertyName}`);
  }
  if (edge.type === 'ITERATES_OVER') {
    if ('iterates' in meta) parts.push(`${meta.iterates}`);
  }

  return parts.length > 0 ? `  [${parts.join(', ')}]` : '';
}

/**
 * Get display name for a node based on its type
 */
function getDisplayName(node: BaseNodeRecord): string {
  // HTTP nodes: method + path/url
  if (node.type === 'http:route') {
    const method = node.method as string | undefined;
    const path = node.path as string | undefined;
    if (method && path) return `${method} ${path}`;
  }
  if (node.type === 'http:request') {
    const method = node.method as string | undefined;
    const url = node.url as string | undefined;
    if (method && url) return `${method} ${url}`;
  }

  // Socket.IO: event name
  if (node.type === 'socketio:emit' || node.type === 'socketio:on') {
    const event = node.event as string | undefined;
    if (event) return event;
  }

  // Default: name or ID fallback
  if (node.name && !node.name.startsWith('{')) return node.name;
  return node.id;
}
