/**
 * Trace Narrative Renderer
 *
 * Transforms flat TraceDataflowResult[] into module-grouped,
 * operator-annotated narrative using Grafema DSL operators.
 *
 * Same renderer for CLI and MCP — the output is a plain string.
 *
 * LOD levels:
 *   summary — shape + per-file type counts only (always fits on screen)
 *   normal  — auto-tiered compression (default, max 35 lines)
 *   full    — every node listed, grouped by file, no budget
 *
 * Operators are inferred from node type + direction. Since TraceDataflowResult
 * has no edge data, these are approximate — use `describe` for precise
 * edge-based operators.
 *
 * @module notation/traceRenderer
 */

import type { TraceDataflowResult, DataflowNode } from '../queries/traceDataflow.js';
import { generateLegend } from './archetypes.js';

// === PUBLIC TYPES ===

export type TraceDetail = 'summary' | 'normal' | 'full';

export interface TraceNarrativeOptions {
  /** Level of detail: summary, normal (default), full */
  detail?: TraceDetail;
}

// === CONSTANTS ===

/** Node types to skip — internal graph plumbing, not meaningful to users. */
const NOISE_TYPES = new Set(['REFERENCE', 'EXPRESSION', 'LITERAL']);

/** Hard budget for normal detail: maximum lines in body. */
const MAX_LINES = 35;

// === LEGEND (from single source of truth) ===

function lodHint(currentDetail: TraceDetail): string {
  switch (currentDetail) {
    case 'summary':
      return 'Use detail="normal" for node list, detail="full" for complete chain';
    case 'normal':
      return 'Use detail="full" for complete chain, detail="summary" for overview';
    case 'full':
      return 'Use detail="summary" for overview, detail="normal" for compressed view';
  }
}

// === OPERATOR MAPPING ===

/**
 * Unified operator vocabulary — uses the same operators as `describe` tool.
 * Since trace has no edge data, operators are inferred from node type + direction.
 *
 * Operators (from archetypes.ts):
 *   >   flow_out (calls, passes, returns)
 *   <   flow_in (reads, receives, assigned from)
 *   =>  write (persistent side effect)
 *   o-  depends (imports)
 *   >x  exception (throws)
 *   ?|  gates (condition)
 *   {}  contains (class membership)
 */
function getOperator(nodeType: string, direction: 'forward' | 'backward'): string {
  const isForward = direction === 'forward';

  switch (nodeType) {
    case 'PARAMETER':
    case 'VARIABLE':
    case 'CALL':
    case 'RETURN':
    case 'EXPORT':
      return isForward ? '>' : '<';
    case 'IMPORT':
      return isForward ? '<' : '>';
    case 'FUNCTION':
    case 'METHOD':
      return 'o-';
    case 'CLASS':
      return '{}';
    case 'CONSTANT':
      return '=>';
    case 'BRANCH':
      return '?|';
    default:
      return isForward ? '>' : '<';
  }
}

// === SHAPE DETECTION ===

type TraceShape = 'chain' | 'fan-out' | 'fan-in' | 'diamond';

function detectShape(
  startFile: string | undefined,
  fileGroups: Map<string, DataflowNode[]>,
): TraceShape {
  const totalNodes = Array.from(fileGroups.values()).reduce((s, g) => s + g.length, 0);
  const fileCount = fileGroups.size;

  // Chain: ≤2 files, ≤10 nodes
  if (fileCount <= 2 && totalNodes <= 10) return 'chain';

  const startFileGroup = startFile ? fileGroups.get(startFile) : undefined;
  const startFileNodeCount = startFileGroup?.length ?? 0;
  const otherFiles = fileCount - (startFileGroup ? 1 : 0);

  // Fan-out: most nodes from 1 source, 3+ target files
  if (otherFiles >= 3 && startFileNodeCount <= totalNodes * 0.3) return 'fan-out';

  // Fan-in: 3+ source files converging to 1 target
  for (const [, nodes] of fileGroups) {
    if (nodes.length > totalNodes * 0.5 && fileCount >= 3) return 'fan-in';
  }

  // Diamond: fan-out then fan-in (heuristic: 4+ files with spread distribution)
  if (fileCount >= 4) return 'diamond';

  return 'chain';
}

function shapeLabel(shape: TraceShape, fileCount: number, nodeCount: number): string {
  switch (shape) {
    case 'chain': return `chain (${nodeCount} nodes reached)`;
    case 'fan-out': return `fan-out across ${fileCount} modules (${nodeCount} nodes reached)`;
    case 'fan-in': return `fan-in from ${fileCount} modules (${nodeCount} nodes reached)`;
    case 'diamond': return `diamond across ${fileCount} modules (${nodeCount} nodes reached)`;
  }
}

// === COMPRESSION TIERS ===

function getTier(totalReached: number): number {
  if (totalReached <= 5) return 1;
  if (totalReached <= 30) return 2;
  if (totalReached <= 100) return 3;
  if (totalReached <= 300) return 4;
  return 5;
}

// === GROUPING ===

function groupByFile(nodes: DataflowNode[]): Map<string, DataflowNode[]> {
  const groups = new Map<string, DataflowNode[]>();
  for (const node of nodes) {
    const file = node.file || '<unknown>';
    let group = groups.get(file);
    if (!group) {
      group = [];
      groups.set(file, group);
    }
    group.push(node);
  }
  // Sort nodes within each group by line number
  for (const [, group] of groups) {
    group.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  }
  return groups;
}

function groupByDirectory(nodes: DataflowNode[]): Map<string, DataflowNode[]> {
  const groups = new Map<string, DataflowNode[]>();
  for (const node of nodes) {
    const file = node.file || '<unknown>';
    const lastSlash = file.lastIndexOf('/');
    const dir = lastSlash >= 0 ? file.substring(0, lastSlash) : '.';
    let group = groups.get(dir);
    if (!group) {
      group = [];
      groups.set(dir, group);
    }
    group.push(node);
  }
  return groups;
}

function filterNoise(nodes: DataflowNode[]): DataflowNode[] {
  return nodes.filter(n => !NOISE_TYPES.has(n.type));
}

// === PER-FILE TYPE SUMMARY ===

function typeSummary(nodes: DataflowNode[]): string {
  const types = new Map<string, number>();
  for (const n of nodes) {
    types.set(n.type, (types.get(n.type) || 0) + 1);
  }
  return Array.from(types.entries())
    .map(([t, c]) => `${c} ${t}`)
    .join(', ');
}

// === RENDERING ===

function renderNodeLine(node: DataflowNode, direction: 'forward' | 'backward'): string {
  const operator = getOperator(node.type, direction);
  const name = node.name || '(anonymous)';
  return `    ${operator} ${name} (${node.type})`;
}

// --- detail="full": every node, grouped by file, no budget ---

function renderFull(
  fileGroups: Map<string, DataflowNode[]>,
  direction: 'forward' | 'backward',
  lines: string[],
): void {
  for (const [file, nodes] of fileGroups) {
    lines.push('');
    lines.push(`  ${file}`);
    for (const node of nodes) {
      lines.push(renderNodeLine(node, direction));
    }
  }
}

// --- detail="summary": per-file type counts only ---

function renderSummary(
  fileGroups: Map<string, DataflowNode[]>,
  lines: string[],
): void {
  for (const [file, nodes] of fileGroups) {
    lines.push(`  ${file} — ${nodes.length} nodes (${typeSummary(nodes)})`);
  }
}

// --- detail="normal": auto-tiered ---

function renderTier1(
  nodes: DataflowNode[],
  direction: 'forward' | 'backward',
  lines: string[],
): void {
  for (const node of nodes) {
    lines.push(renderNodeLine(node, direction));
  }
}

function renderTier2(
  fileGroups: Map<string, DataflowNode[]>,
  direction: 'forward' | 'backward',
  lines: string[],
): void {
  const budgetForContent = MAX_LINES - 3;
  let remaining = 0;
  let remainingModules = 0;

  for (const [file, nodes] of fileGroups) {
    if (lines.length >= budgetForContent) {
      remaining += nodes.length;
      remainingModules++;
      continue;
    }
    lines.push('');
    lines.push(`  ${file}`);
    for (const node of nodes) {
      if (lines.length >= budgetForContent) {
        remaining += 1;
        continue;
      }
      lines.push(renderNodeLine(node, direction));
    }
  }

  if (remaining > 0) {
    lines.push('');
    lines.push(`  ... and ${remainingModules} more modules (${remaining} nodes)`);
  }
}

function renderTier3(
  fileGroups: Map<string, DataflowNode[]>,
  direction: 'forward' | 'backward',
  lines: string[],
): void {
  const MAX_PER_FILE = 3;
  const budgetForContent = MAX_LINES - 3;
  let remaining = 0;
  let remainingModules = 0;

  for (const [file, nodes] of fileGroups) {
    if (lines.length >= budgetForContent) {
      remaining += nodes.length;
      remainingModules++;
      continue;
    }
    lines.push('');
    lines.push(`  ${file}`);
    const show = nodes.slice(0, MAX_PER_FILE);
    const hidden = nodes.length - show.length;
    for (const node of show) {
      if (lines.length >= budgetForContent) {
        remaining++;
        continue;
      }
      lines.push(renderNodeLine(node, direction));
    }
    if (hidden > 0 && lines.length < budgetForContent) {
      lines.push(`    ... +${hidden} more`);
    }
  }

  if (remaining > 0) {
    lines.push('');
    lines.push(`  ... and ${remainingModules} more modules (${remaining} nodes)`);
  }
}

function renderTier4(
  fileGroups: Map<string, DataflowNode[]>,
  lines: string[],
): void {
  let remainingModules = 0;
  let remainingNodes = 0;

  for (const [file, nodes] of fileGroups) {
    if (lines.length >= MAX_LINES - 2) {
      remainingModules++;
      remainingNodes += nodes.length;
      continue;
    }
    lines.push(`  ${file} — ${nodes.length} nodes (${typeSummary(nodes)})`);
  }

  if (remainingModules > 0) {
    lines.push(`  ... and ${remainingModules} more modules (${remainingNodes} nodes)`);
  }
}

function renderTier5(
  nodes: DataflowNode[],
  lines: string[],
): void {
  const dirGroups = groupByDirectory(nodes);

  let remainingDirs = 0;
  let remainingNodes = 0;

  for (const [dir, dirNodes] of dirGroups) {
    if (lines.length >= MAX_LINES - 2) {
      remainingDirs++;
      remainingNodes += dirNodes.length;
      continue;
    }
    const files = new Set(dirNodes.map(n => n.file || '<unknown>'));
    lines.push(`  ${dir}/ — ${files.size} files, ${dirNodes.length} nodes (${typeSummary(dirNodes)})`);
  }

  if (remainingDirs > 0) {
    lines.push(`  ... and ${remainingDirs} more directories (${remainingNodes} nodes)`);
  }
}

// === MAIN EXPORT ===

/**
 * Render trace dataflow results as a human-readable narrative.
 *
 * Transforms flat BFS results into a module-grouped, operator-annotated
 * narrative using Grafema DSL operators. Infers operators from node type
 * and trace direction since edge info is not available in TraceDataflowResult.
 *
 * @param results - Array of TraceDataflowResult from traceDataflow()
 * @param sourceName - Display name for the seed/source node
 * @param options - Rendering options (detail level)
 * @returns Formatted narrative string with legend and LOD hints
 */
export function renderTraceNarrative(
  results: TraceDataflowResult[],
  sourceName: string,
  options: TraceNarrativeOptions = {},
): string {
  const detail = options.detail ?? 'normal';

  if (results.length === 0) return `No dataflow results for "${sourceName}"`;

  const output: string[] = [];

  for (const result of results) {
    const arrow = result.direction === 'forward' ? '→' : '←';

    // detail="full" shows everything BFS found — no noise filtering
    const displayNodes = detail === 'full' ? result.reached : filterNoise(result.reached);

    if (displayNodes.length === 0) {
      if (result.reached.length > 0) {
        // BFS found nodes but all were noise types — inform the user
        output.push(
          `"${sourceName}" ${arrow} ${result.reached.length} nodes reached (all internal references — use detail="full" to see)`
        );
      } else {
        output.push(
          `"${sourceName}" ${arrow} no reachable nodes`
        );
      }
      output.push('');
      continue;
    }

    const fileGroups = groupByFile(displayNodes);
    const shape = detectShape(result.startNode.file, fileGroups);
    // Use display count in header — matches what user sees in body
    const displayCount = displayNodes.length;

    output.push(
      `"${sourceName}" ${arrow} ${shapeLabel(shape, fileGroups.size, displayCount)}`
    );

    const lines: string[] = [];

    if (detail === 'full') {
      renderFull(fileGroups, result.direction, lines);
    } else if (detail === 'summary') {
      renderSummary(fileGroups, lines);
    } else {
      // normal: auto-tiered
      const tier = getTier(displayCount);
      switch (tier) {
        case 1:
          renderTier1(displayNodes, result.direction, lines);
          break;
        case 2:
          renderTier2(fileGroups, result.direction, lines);
          break;
        case 3:
          renderTier3(fileGroups, result.direction, lines);
          break;
        case 4:
          renderTier4(fileGroups, lines);
          break;
        case 5:
          renderTier5(displayNodes, lines);
          break;
      }
    }

    output.push(...lines);
    output.push('');
  }

  // Trim trailing empty line
  while (output.length > 0 && output[output.length - 1] === '') {
    output.pop();
  }

  // Append legend (from archetypes.ts — single source of truth) + LOD hint
  output.push('');
  output.push(generateLegend());
  output.push(lodHint(detail));

  return output.join('\n');
}
