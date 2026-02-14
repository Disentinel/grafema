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
import {
  RFDBServerBackend,
  buildNodeContext,
  getNodeDisplayName,
  formatEdgeMetadata,
  STRUCTURAL_EDGE_TYPES,
} from '@grafema/core';
import type { NodeContext, EdgeGroup } from '@grafema/core';
import type { BaseNodeRecord } from '@grafema/types';
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

/** Extended context with CLASS member expansion (REG-411) */
interface ContextWithMembers extends NodeContext {
  memberContexts?: NodeContext[];
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

      // 2. Build context (with CLASS member expansion)
      const ctx = await buildContextWithMembers(backend, node, { contextLines, edgeTypeFilter });

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
 * Build context with CLASS member expansion (REG-411)
 */
async function buildContextWithMembers(
  backend: RFDBServerBackend,
  node: BaseNodeRecord,
  options: { contextLines: number; edgeTypeFilter: Set<string> | null },
): Promise<ContextWithMembers> {
  const ctx = await buildNodeContext(backend, node, options);

  let memberContexts: NodeContext[] | undefined;
  if (node.type === 'CLASS') {
    const outEdges = await backend.getOutgoingEdges(node.id);
    const containsEdges = outEdges.filter(e => e.type === 'CONTAINS');
    const members: NodeContext[] = [];
    for (const edge of containsEdges) {
      const memberNode = await backend.getNode(edge.dst);
      if (memberNode && (memberNode.type === 'FUNCTION' || memberNode.type === 'METHOD')) {
        const memberCtx = await buildNodeContext(backend, memberNode, options);
        members.push(memberCtx);
      }
    }
    members.sort((a, b) => {
      const lineA = (a.node.line as number | undefined) ?? 0;
      const lineB = (b.node.line as number | undefined) ?? 0;
      return lineA - lineB;
    });
    if (members.length > 0) {
      memberContexts = members;
    }
  }

  return { ...ctx, memberContexts };
}

/**
 * Print context to stdout in grep-friendly format
 */
function printContext(ctx: ContextWithMembers, projectPath: string, contextLines: number): void {
  const { node, source, outgoing, incoming } = ctx;

  // Node header
  const displayName = getNodeDisplayName(node);
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

  // Member methods (CLASS nodes)
  if (ctx.memberContexts && ctx.memberContexts.length > 0) {
    console.log('');
    console.log(`  Methods (${ctx.memberContexts.length}):`);
    for (const memberCtx of ctx.memberContexts) {
      console.log('');
      console.log(`  ── [${memberCtx.node.type}] ${getNodeDisplayName(memberCtx.node)}`);
      const memberLoc = formatLocation(
        memberCtx.node.file,
        memberCtx.node.line as number | undefined,
        projectPath,
      );
      if (memberLoc) {
        console.log(`     Location: ${memberLoc}`);
      }

      // Method source code
      if (memberCtx.source) {
        console.log('');
        console.log(`     Source (lines ${memberCtx.source.startLine}-${memberCtx.source.endLine}):`);
        const formatted = formatCodePreview(
          {
            lines: memberCtx.source.lines,
            startLine: memberCtx.source.startLine,
            endLine: memberCtx.source.endLine,
          },
          memberCtx.node.line as number | undefined,
        );
        for (const line of formatted) {
          console.log(`       ${line}`);
        }
      }

      // Method edges (non-structural only, to avoid clutter)
      const methodOutgoing = memberCtx.outgoing.filter(g => !STRUCTURAL_EDGE_TYPES.has(g.edgeType));
      const methodIncoming = memberCtx.incoming.filter(g => !STRUCTURAL_EDGE_TYPES.has(g.edgeType));

      if (methodOutgoing.length > 0) {
        console.log('');
        console.log('     Outgoing edges:');
        for (const group of methodOutgoing) {
          printEdgeGroup(group, '->', projectPath, contextLines, '       ');
        }
      }
      if (methodIncoming.length > 0) {
        console.log('');
        console.log('     Incoming edges:');
        for (const group of methodIncoming) {
          printEdgeGroup(group, '<-', projectPath, contextLines, '       ');
        }
      }
    }
  }

  // Summary if no edges and no members
  if (outgoing.length === 0 && incoming.length === 0 && !ctx.memberContexts?.length) {
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
  indent = '    ',
): void {
  const isStructural = STRUCTURAL_EDGE_TYPES.has(group.edgeType);

  console.log(`${indent}${group.edgeType} (${group.edges.length}):`);

  for (const { edge, node } of group.edges) {
    if (!node) {
      const danglingId = direction === '->' ? edge.dst : edge.src;
      console.log(`${indent}  ${direction} [dangling] ${danglingId}`);
      continue;
    }

    const displayName = getNodeDisplayName(node);
    const loc = formatLocation(node.file, node.line as number | undefined, projectPath);
    const locStr = loc ? `  (${loc})` : '';

    // Edge metadata inline (if present and useful)
    const metaStr = formatEdgeMetadata(edge);

    console.log(`${indent}  ${direction} [${node.type}] ${displayName}${locStr}${metaStr}`);

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
          console.log(`${indent}       ${line}`);
        }
      }
    }
  }
}
