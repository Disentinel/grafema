/**
 * Notation Renderer — pure function: SubgraphData → DSL string
 *
 * Pipeline:
 * 1. Classify edges via EDGE_ARCHETYPE_MAP
 * 2. Separate containment from operator edges
 * 3. Group operator edges by source node
 * 4. Sort lines by sortOrder
 * 5. Merge same-operator same-verb targets
 * 6. Serialize to indented DSL text
 *
 * @module notation/renderer
 */

import type { EdgeRecord, BaseNodeRecord } from '@grafema/types';
import type { DescribeOptions, NotationBlock, NotationLine, SubgraphData } from './types.js';
import { lookupEdge } from './archetypes.js';
import { getNodeDisplayName } from '../queries/NodeContext.js';

/**
 * Render a subgraph as compact DSL notation.
 *
 * Example output:
 * ```
 * login {
 *   o- imports bcrypt
 *   > calls UserDB.findByEmail, createToken
 *   < reads config.auth
 *   => writes session
 *   >x throws AuthError
 *   ~>> emits 'auth:login'
 * }
 * ```
 */
export function renderNotation(
  input: SubgraphData,
  options: DescribeOptions = {},
): string {
  const { depth = 1, archetypeFilter, budget = 7, includeLocations = false } = options;

  const blocks = buildBlocks(input, depth, archetypeFilter, budget, includeLocations);
  return serializeBlocks(blocks, 0);
}

// ---------------------------------------------------------------------------
// Block building
// ---------------------------------------------------------------------------

function buildBlocks(
  input: SubgraphData,
  depth: number,
  archetypeFilter: DescribeOptions['archetypeFilter'],
  budget: number,
  includeLocations: boolean,
): NotationBlock[] {
  const { rootNodes, edges, nodeMap } = input;

  // Index: src → edges, containment edges (src → child node IDs)
  const outgoingBySource = new Map<string, EdgeRecord[]>();
  const childrenOf = new Map<string, string[]>();

  for (const edge of edges) {
    const mapping = lookupEdge(edge.type);

    if (mapping.archetype === 'contains') {
      // Containment defines tree structure
      if (!childrenOf.has(edge.src)) childrenOf.set(edge.src, []);
      childrenOf.get(edge.src)!.push(edge.dst);
    } else {
      if (!outgoingBySource.has(edge.src)) outgoingBySource.set(edge.src, []);
      outgoingBySource.get(edge.src)!.push(edge);
    }
  }

  // Build set of node IDs that are descendants of LOOP nodes in containment tree
  const insideLoopNodes = buildLoopDescendants(childrenOf, nodeMap);

  return rootNodes.map(node =>
    buildBlock(node, outgoingBySource, childrenOf, nodeMap, depth, archetypeFilter, budget, includeLocations, insideLoopNodes),
  );
}

/**
 * Collect all node IDs that are descendants of LOOP-type nodes in the containment tree.
 * Uses BFS from each LOOP node, traversing containment children recursively.
 */
function buildLoopDescendants(
  childrenOf: Map<string, string[]>,
  nodeMap: Map<string, BaseNodeRecord>,
): Set<string> {
  const result = new Set<string>();

  // Find all LOOP nodes and collect their descendants
  for (const [parentId, children] of childrenOf) {
    const parentNode = nodeMap.get(parentId);
    if (parentNode?.type === 'LOOP') {
      // BFS to collect all descendants of this LOOP node
      const queue = [...children];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (result.has(id)) continue;
        result.add(id);
        const grandchildren = childrenOf.get(id);
        if (grandchildren) {
          queue.push(...grandchildren);
        }
      }
    }
  }

  return result;
}

function buildBlock(
  node: BaseNodeRecord,
  outgoingBySource: Map<string, EdgeRecord[]>,
  childrenOf: Map<string, string[]>,
  nodeMap: Map<string, BaseNodeRecord>,
  depth: number,
  archetypeFilter: DescribeOptions['archetypeFilter'],
  budget: number,
  includeLocations: boolean,
  insideLoopNodes: Set<string>,
): NotationBlock {
  const displayName = getNodeDisplayName(node);
  const location = includeLocations && node.file
    ? `${node.file}${node.line ? ':' + node.line : ''}`
    : undefined;

  // LOD 0: names only — no edges, no children
  if (depth <= 0) {
    return { nodeId: node.id, displayName, nodeType: node.type, lines: [], children: [], location };
  }

  // LOD 1+: build edge lines
  const nodeEdges = outgoingBySource.get(node.id) ?? [];
  const lines = buildLines(nodeEdges, nodeMap, archetypeFilter, budget);

  // Apply [] loop modifier if this node is inside a LOOP
  // Combines with existing modifiers: [] ?? > calls foo
  if (insideLoopNodes.has(node.id)) {
    for (const line of lines) {
      line.modifier = line.modifier ? `[] ${line.modifier}` : '[]';
    }
  }

  // LOD 2+: recurse into contained children
  let children: NotationBlock[] = [];
  if (depth >= 2) {
    const childIds = childrenOf.get(node.id) ?? [];
    children = childIds
      .map(id => nodeMap.get(id))
      .filter((n): n is BaseNodeRecord => n != null)
      .map(child =>
        buildBlock(child, outgoingBySource, childrenOf, nodeMap, depth - 1, archetypeFilter, budget, includeLocations, insideLoopNodes),
      );
  }

  return { nodeId: node.id, displayName, nodeType: node.type, lines, children, location };
}

// ---------------------------------------------------------------------------
// Line building — group, sort, merge
// ---------------------------------------------------------------------------

function buildLines(
  edges: EdgeRecord[],
  nodeMap: Map<string, BaseNodeRecord>,
  archetypeFilter: DescribeOptions['archetypeFilter'],
  budget: number,
): NotationLine[] {
  // Group by modifier+operator+verb key (modifier separates certain from uncertain)
  const groups = new Map<string, { operator: string; verb: string; targets: string[]; sortOrder: number; modifier?: string }>();

  for (const edge of edges) {
    const mapping = lookupEdge(edge.type);

    // Apply archetype filter
    if (archetypeFilter && !archetypeFilter.includes(mapping.archetype)) continue;

    const targetNode = nodeMap.get(edge.dst);
    const targetName = targetNode ? getNodeDisplayName(targetNode) : edge.dst;

    // Detect dynamic/uncertain edges
    const modifier = isDynamicEdge(edge) ? '??' : undefined;

    const key = `${modifier ?? ''}|${mapping.operator}|${mapping.verb}`;
    if (!groups.has(key)) {
      groups.set(key, {
        operator: mapping.operator,
        verb: mapping.verb,
        targets: [],
        sortOrder: mapping.sortOrder,
        modifier,
      });
    }
    groups.get(key)!.targets.push(targetName);
  }

  // Sort by sortOrder
  const sorted = Array.from(groups.values()).sort((a, b) => a.sortOrder - b.sortOrder);

  // Apply budget: show top-N, summarize rest
  if (sorted.length > budget) {
    const shown = sorted.slice(0, budget);
    const hidden = sorted.slice(budget);
    const hiddenCount = hidden.reduce((sum, g) => sum + g.targets.length, 0);
    shown.push({
      operator: '',
      verb: `...+${hiddenCount} more`,
      targets: [],
      sortOrder: 999,
    });
    return shown.map(g => ({
      operator: g.operator,
      verb: g.verb,
      targets: g.targets,
      sortOrder: g.sortOrder,
      modifier: g.modifier,
    }));
  }

  return sorted.map(g => ({
    operator: g.operator,
    verb: g.verb,
    targets: g.targets,
    sortOrder: g.sortOrder,
    modifier: g.modifier,
  }));
}

// ---------------------------------------------------------------------------
// Edge metadata helpers
// ---------------------------------------------------------------------------

/**
 * Check if an edge is dynamic/uncertain based on its metadata.
 *
 * An edge is dynamic/uncertain if any of these hold:
 * - metadata.resolved === false (unresolved reference)
 * - metadata.confidence exists and is < 1.0 (low-confidence inference)
 * - metadata.dynamic === true (dynamic dispatch)
 */
function isDynamicEdge(edge: EdgeRecord): boolean {
  const meta = edge.metadata;
  if (!meta) return false;

  if (meta.resolved === false) return true;
  if (typeof meta.confidence === 'number' && meta.confidence < 1.0) return true;
  if (meta.dynamic === true) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeBlocks(blocks: NotationBlock[], indentLevel: number): string {
  return blocks.map(block => serializeBlock(block, indentLevel)).join('\n');
}

function serializeBlock(block: NotationBlock, indentLevel: number): string {
  const indent = '  '.repeat(indentLevel);
  const hasContent = block.lines.length > 0 || block.children.length > 0;

  // Header
  const loc = block.location ? `  (${block.location})` : '';
  let result: string;

  if (!hasContent) {
    // Leaf node — just name
    result = `${indent}${block.displayName}${loc}`;
  } else {
    result = `${indent}${block.displayName}${loc} {\n`;

    // Lines
    for (const line of block.lines) {
      result += serializeLine(line, indentLevel + 1);
    }

    // Children
    if (block.children.length > 0) {
      result += serializeBlocks(block.children, indentLevel + 1) + '\n';
    }

    result += `${indent}}`;
  }

  return result;
}

function serializeLine(line: NotationLine, indentLevel: number): string {
  const indent = '  '.repeat(indentLevel);
  const mod = line.modifier ? `${line.modifier} ` : '';
  const prefix = line.operator ? `${line.operator} ` : '';

  if (line.targets.length === 0) {
    return `${indent}${mod}${prefix}${line.verb}\n`;
  }

  return `${indent}${mod}${prefix}${line.verb} ${line.targets.join(', ')}\n`;
}
