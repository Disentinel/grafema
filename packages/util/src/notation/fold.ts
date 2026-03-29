/**
 * Notation Fold Engine — structural compression of sibling blocks
 *
 * Pure function: NotationBlock[] → NotationBlock[]
 * Fold is a view-layer transform, not part of DSL grammar.
 *
 * Implements 11 rules from notation-folding.md:
 *   Rules 1-5: structural (language-agnostic)
 *   Rules 6-7: cleanup (dedup, artifacts)
 *   Rules 8-11: semantic (derivation/call patterns)
 *
 * Pipeline order matters — chains/dispatch collapse adjacent siblings first,
 * making the remaining set more amenable to group folding.
 *
 * @module notation/fold
 */

import type { NotationBlock } from './types.js';

/** Minimum group size to trigger folding */
const FOLD_THRESHOLD = 3;

// === Node Rendering Roles ===

type NodeRole = 'actor' | 'container' | 'binding' | 'datum' | 'shape' | 'control';

const CONTAINER_TYPES = new Set(['MODULE', 'CLASS', 'OBJECT', 'NAMESPACE', 'PROGRAM']);
const BINDING_TYPES = new Set(['IMPORT', 'IMPORT_BINDING', 'EXPORT', 'EXPORT_BINDING']);
const SHAPE_TYPES = new Set(['INTERFACE', 'TYPE_ALIAS', 'ENUM', 'ENUM_MEMBER']);
const CONTROL_TYPES = new Set(['LOOP', 'BRANCH', 'CASE', 'CONDITIONAL', 'SWITCH', 'TRY']);
const BEHAVIOR_OPERATORS = new Set(['>', '=>', '>x', '~>>']);

/**
 * Classify a block's rendering role based on node type + edge content.
 *
 * Roles (determined by graph shape, not AST type alone):
 *   Actor     — has behavior edges (calls, writes, throws...) → Block
 *   Container — MODULE, CLASS, etc. → Block
 *   Binding   — IMPORT, EXPORT → Line
 *   Datum     — VARIABLE/CONSTANT with only passive edges → Inline `name < verb source`
 *   Shape     — INTERFACE, TYPE_ALIAS, ENUM → Block or Name
 *   Control   — LOOP, BRANCH, CASE → Modifier
 *
 * No suppression: all nodes with edges are preserved (Inv-2 Side Effect Visibility).
 */
function classifyRole(block: NotationBlock): NodeRole {
  const type = block.nodeType;

  if (CONTAINER_TYPES.has(type)) return 'container';
  if (BINDING_TYPES.has(type)) return 'binding';
  if (SHAPE_TYPES.has(type)) return 'shape';
  if (CONTROL_TYPES.has(type)) return 'control';

  // Check for behavior edges
  const hasBehavior = block.lines.some(l => BEHAVIOR_OPERATORS.has(l.operator));
  if (hasBehavior) return 'actor';

  // VARIABLE/CONSTANT/PARAMETER with only passive edges → datum
  if (type === 'VARIABLE' || type === 'CONSTANT' || type === 'PARAMETER') {
    return 'datum';
  }

  // FUNCTION/METHOD → actor (even without visible behavior)
  if (type === 'FUNCTION' || type === 'METHOD') return 'actor';

  return 'actor';
}

/**
 * Apply role-based transforms: datum → inline (preserves archetype operator and verb).
 */
function applyRoleTransforms(blocks: NotationBlock[]): NotationBlock[] {
  const result: NotationBlock[] = [];

  for (const block of blocks) {
    if (block.foldMeta) {
      result.push(block);
      continue;
    }

    const role = classifyRole(block);

    switch (role) {
      case 'datum': {
        // Inline: render as "name < verb source" — no braces, preserves archetype
        const inlineName = formatDatumInline(block);
        result.push({
          ...block,
          displayName: inlineName,
          lines: [],
          children: [],
          foldMeta: { kind: 'datum-inline', count: 1 },
        });
        break;
      }

      default:
        result.push(block);
    }
  }

  return result;
}

/**
 * Format a datum block as a single inline string: "name < verb source"
 * Preserves the archetype operator and verb — no information loss.
 */
function formatDatumInline(block: NotationBlock): string {
  // Find the first flow_in line
  for (const line of block.lines) {
    if (line.operator && line.targets.length > 0) {
      const mod = line.modifier ? `${line.modifier} ` : '';
      return `${block.displayName} ${mod}${line.operator} ${line.verb} ${line.targets.join(', ')}`;
    }
  }
  return block.displayName;
}

// === Block Signature ===

interface BlockSignature {
  nodeType: string;
  lineKeys: string[];
  childCount: number;
}

function computeSignature(block: NotationBlock): BlockSignature {
  return {
    nodeType: block.nodeType,
    lineKeys: block.lines
      .map(l => `${l.modifier ?? ''}|${l.operator}|${l.verb}`)
      .sort(),
    childCount: block.children.length,
  };
}

function signatureKey(sig: BlockSignature): string {
  return `${sig.nodeType}|${sig.lineKeys.join(';')}|${sig.childCount}`;
}

// === Main fold function ===

/**
 * Apply all folding rules to a list of sibling blocks.
 * Returns a new list where repetitive structures are compressed.
 *
 * Folding is recursive — children of non-folded blocks are also folded.
 */
export function foldBlocks(blocks: NotationBlock[]): NotationBlock[] {
  // Rule 4: Dedup by nodeId (per-block cleanup, always applies)
  let current = dedup(blocks);

  // Rule 6: Target dedup within each block's lines (per-block cleanup, always applies)
  current = current.map(dedupTargets);

  if (current.length <= 1) {
    // Role transforms still apply to single blocks
    current = applyRoleTransforms(current);
    // Still recurse into children
    return current.map(b => {
      if (b.foldMeta || b.children.length === 0) return b;
      return { ...b, children: foldBlocks(b.children) };
    });
  }

  // Rules 8/9: Chain detection and linearization (before role transforms — needs REFERENCE blocks)
  const chainResult = detectChains(current);
  current = [...chainResult.chains, ...chainResult.remaining];

  // Rule 11: Case dispatch detection
  const dispatchResult = detectDispatch(current);
  current = [...dispatchResult.dispatches, ...dispatchResult.remaining];

  // Rule 10: Repetitive call fold
  const callResult = detectRepetitiveCalls(current);
  current = [...callResult.folds, ...callResult.remaining];

  // Role transforms: datum → inline, internal → suppress (after semantic rules)
  current = applyRoleTransforms(current);

  // Separate already-folded from remaining
  const alreadyFolded = current.filter(b => b.foldMeta);
  const unfolded = current.filter(b => !b.foldMeta);

  // Rule 7: Repeated leaf fold
  const leafResult = repeatedLeafFold(unfolded);

  // Rule 5: Structural suppression
  const trivialResult = structuralSuppression(leafResult.remaining);

  // Rules 1-3: Group fold with anomaly preservation and source aggregation
  const groupResult = groupFold(trivialResult.remaining);

  // Combine: early folds, group folds, leaf folds, trivial groups, anomalies
  const result = [
    ...alreadyFolded,
    ...groupResult.folded,
    ...leafResult.folds,
    ...trivialResult.groups,
    ...groupResult.anomalies,
  ];

  // Recurse: fold children of non-folded blocks
  return result.map(b => {
    if (b.foldMeta || b.children.length === 0) return b;
    return { ...b, children: foldBlocks(b.children) };
  });
}

// === Rule 4: Dedup ===

function dedup(blocks: NotationBlock[]): NotationBlock[] {
  const seen = new Map<string, NotationBlock>();
  for (const block of blocks) {
    const existing = seen.get(block.nodeId);
    if (!existing) {
      seen.set(block.nodeId, block);
    } else {
      // Keep the richer block (more lines, children, and targets)
      const richness = (b: NotationBlock) =>
        b.lines.length + b.children.length + b.lines.reduce((s, l) => s + l.targets.length, 0);
      if (richness(block) > richness(existing)) {
        seen.set(block.nodeId, block);
      }
    }
  }
  return [...seen.values()];
}

// === Rule 6: Target dedup within lines ===

function dedupTargets(block: NotationBlock): NotationBlock {
  const hasDupes = block.lines.some(l => l.targets.length !== new Set(l.targets).size);
  if (!hasDupes) return block;

  return {
    ...block,
    lines: block.lines.map(line => ({
      ...line,
      targets: [...new Set(line.targets)],
    })),
  };
}

// === Rules 8/9: Chain detection and linearization ===

function detectChains(
  blocks: NotationBlock[],
): { chains: NotationBlock[]; remaining: NotationBlock[] } {
  if (blocks.length < 3) return { chains: [], remaining: blocks };

  const consumed = new Set<number>();
  const chainBlocks: NotationBlock[] = [];

  // Find all blocks with "derived from" lines
  const derivesFrom = new Map<number, string>();
  for (let i = 0; i < blocks.length; i++) {
    for (const line of blocks[i].lines) {
      if (line.verb === 'derived from' && line.targets.length > 0) {
        derivesFrom.set(i, line.targets[0]);
        break;
      }
    }
  }

  if (derivesFrom.size < 2) return { chains: [], remaining: blocks };

  // Group blocks by location
  const locationGroups = new Map<string, number[]>();
  for (let i = 0; i < blocks.length; i++) {
    const loc = blocks[i].location;
    if (!loc) continue;
    if (!locationGroups.has(loc)) locationGroups.set(loc, []);
    locationGroups.get(loc)!.push(i);
  }

  for (const [loc, indices] of locationGroups) {
    if (indices.length < 3) continue;

    // Build name → indices map within this location group
    const nameToIndices = new Map<string, number[]>();
    for (const idx of indices) {
      const name = blocks[idx].displayName;
      if (!nameToIndices.has(name)) nameToIndices.set(name, []);
      nameToIndices.get(name)!.push(idx);
    }

    // Build name derivation graph: name → derives from name
    const nameDerivesFrom = new Map<string, string>();
    for (const idx of indices) {
      if (derivesFrom.has(idx) && nameToIndices.has(derivesFrom.get(idx)!)) {
        nameDerivesFrom.set(blocks[idx].displayName, derivesFrom.get(idx)!);
      }
    }

    if (nameDerivesFrom.size < 2) continue;

    // Find chain roots: names derived FROM but don't derive from anything
    const derivedFromNames = new Set(nameDerivesFrom.values());
    const derivingNames = new Set(nameDerivesFrom.keys());
    const roots = [...derivedFromNames].filter(n => !derivingNames.has(n));

    for (const root of roots) {
      // Build chain from root forward
      const steps: string[] = [root];
      let current = root;
      const visited = new Set<string>([root]);

      while (true) {
        let next: string | undefined;
        for (const [name, from] of nameDerivesFrom) {
          if (from === current && !visited.has(name)) {
            next = name;
            break;
          }
        }
        if (!next) break;
        steps.push(next);
        visited.add(next);
        current = next;
      }

      if (steps.length < 3) continue;

      // Mark all blocks in this chain as consumed
      for (const name of steps) {
        const idxs = nameToIndices.get(name);
        if (idxs) {
          for (const idx of idxs) consumed.add(idx);
        }
      }

      // Check if last step has "reads" line for source
      let chainSource: string | undefined;
      const lastIdxs = nameToIndices.get(steps[steps.length - 1]) ?? [];
      for (const idx of lastIdxs) {
        for (const line of blocks[idx].lines) {
          if (line.verb === 'reads' && line.targets.length > 0) {
            chainSource = line.targets[0];
          }
        }
      }

      chainBlocks.push({
        nodeId: `chain:${steps.join(':')}`,
        displayName: steps.join(' \u2218 ') + (chainSource ? `(${chainSource})` : ''),
        nodeType: blocks[indices[0]].nodeType,
        lines: [],
        children: [],
        location: loc,
        foldMeta: {
          kind: 'chain',
          count: steps.length,
          chainSteps: steps,
          chainSource,
        },
      });
    }
  }

  const remaining = blocks.filter((_, i) => !consumed.has(i));
  return { chains: chainBlocks, remaining };
}

// === Rule 11: Case dispatch detection ===

function detectDispatch(
  blocks: NotationBlock[],
): { dispatches: NotationBlock[]; remaining: NotationBlock[] } {
  if (blocks.length < 8) return { dispatches: [], remaining: blocks };

  // Find blocks with "derived from case" lines
  const caseIndices: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    for (const line of blocks[i].lines) {
      if (line.verb === 'derived from' && line.targets.includes('case')) {
        caseIndices.push(i);
        break;
      }
    }
  }

  if (caseIndices.length < FOLD_THRESHOLD) return { dispatches: [], remaining: blocks };

  // Each case block has a pattern block before it
  const consumed = new Set<number>();
  const branches: Array<{ pattern: string; handler: string; indices: number[] }> = [];

  for (const idx of caseIndices) {
    if (consumed.has(idx)) continue;

    const handler = blocks[idx];
    // Pattern node is at idx-1 with no edges/children
    if (idx > 0 && !consumed.has(idx - 1) &&
        blocks[idx - 1].lines.length === 0 && blocks[idx - 1].children.length === 0) {
      const pattern = blocks[idx - 1];
      // Only consume the pattern + handler pair; dup/arg blocks handled by dedup/leaf rules
      branches.push({
        pattern: pattern.displayName,
        handler: handler.displayName,
        indices: [idx - 1, idx],
      });

      consumed.add(idx - 1);
      consumed.add(idx);
    }
  }

  if (branches.length < FOLD_THRESHOLD) return { dispatches: [], remaining: blocks };

  // Exemplar: first branch's blocks as children
  const exemplarBlocks = branches[0].indices.map(i => blocks[i]);
  const summaryBranches = branches.slice(1).map(b => ({
    pattern: b.pattern,
    handler: b.handler,
  }));

  const dispatch: NotationBlock = {
    nodeId: `dispatch:${branches[0].pattern}`,
    displayName: `${branches[0].pattern} \u2192 ${branches[0].handler}`,
    nodeType: 'DISPATCH',
    lines: [],
    children: exemplarBlocks,
    foldMeta: {
      kind: 'dispatch',
      count: branches.length,
      branches: summaryBranches,
    },
  };

  // Summary block after exemplar
  const branchList = summaryBranches.slice(0, 3)
    .map(b => `${b.pattern} \u2192 ${b.handler}`)
    .join(', ');
  const suffix = summaryBranches.length > 3
    ? `, ...+${summaryBranches.length - 3} more`
    : '';

  const summary: NotationBlock = {
    nodeId: `dispatch-summary:${branches[0].pattern}`,
    displayName: `...+${branches.length - 1} more branches: ${branchList}${suffix}`,
    nodeType: 'DISPATCH',
    lines: [],
    children: [],
    foldMeta: {
      kind: 'dispatch',
      count: branches.length - 1,
      branches: summaryBranches,
    },
  };

  const remaining = blocks.filter((_, i) => !consumed.has(i));
  return { dispatches: [dispatch, summary], remaining };
}

// === Rule 10: Repetitive call fold ===

function detectRepetitiveCalls(
  blocks: NotationBlock[],
): { folds: NotationBlock[]; remaining: NotationBlock[] } {
  // Group non-leaf blocks by (name + signature) — same function called repeatedly
  const groups = new Map<string, number[]>();

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.foldMeta) continue;
    if (block.lines.length === 0 && block.children.length === 0) continue; // Skip leaves

    const sig = computeSignature(block);
    const key = `call:${block.displayName}|${signatureKey(sig)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(i);
  }

  const consumed = new Set<number>();
  const folds: NotationBlock[] = [];

  for (const [, indices] of groups) {
    if (indices.length <= FOLD_THRESHOLD) continue;

    const exemplar = blocks[indices[0]];

    // Exemplar shown expanded
    folds.push(exemplar);

    // Fold summary
    folds.push({
      nodeId: `callfold:${exemplar.displayName}`,
      displayName: `...+${indices.length - 1} more ${exemplar.displayName}`,
      nodeType: exemplar.nodeType,
      lines: [],
      children: [],
      foldMeta: {
        kind: 'fold',
        count: indices.length,
        label: exemplar.displayName,
      },
    });

    for (const idx of indices) consumed.add(idx);
  }

  const remaining = blocks.filter((_, i) => !consumed.has(i));
  return { folds, remaining };
}

// === Rule 7: Repeated leaf fold ===

function repeatedLeafFold(
  blocks: NotationBlock[],
): { folds: NotationBlock[]; remaining: NotationBlock[] } {
  // Group leaf blocks (no lines, no children) by name
  const leafGroups = new Map<string, number[]>();
  const nonLeafIndices = new Set<number>();

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.foldMeta) {
      nonLeafIndices.add(i);
      continue;
    }
    if (block.lines.length === 0 && block.children.length === 0) {
      const name = block.displayName;
      if (!leafGroups.has(name)) leafGroups.set(name, []);
      leafGroups.get(name)!.push(i);
    } else {
      nonLeafIndices.add(i);
    }
  }

  const foldedLeafIndices = new Set<number>();
  const folds: NotationBlock[] = [];

  for (const [name, indices] of leafGroups) {
    if (indices.length <= FOLD_THRESHOLD) continue;

    for (const idx of indices) foldedLeafIndices.add(idx);

    folds.push({
      nodeId: `leafrepeat:${name}`,
      displayName: `${name} \u00d7${indices.length}`,
      nodeType: blocks[indices[0]].nodeType,
      lines: [],
      children: [],
      location: blocks[indices[0]].location,
      foldMeta: {
        kind: 'leaf-repeat',
        count: indices.length,
        label: name,
      },
    });
  }

  const remaining = blocks.filter((_, i) =>
    nonLeafIndices.has(i) || (leafGroups.get(blocks[i].displayName)?.length ?? 0) <= FOLD_THRESHOLD,
  );

  return { folds, remaining };
}

// === Rule 5: Structural suppression ===

function structuralSuppression(
  blocks: NotationBlock[],
): { groups: NotationBlock[]; remaining: NotationBlock[] } {
  const trivialByType = new Map<string, NotationBlock[]>();
  const nonTrivialBlocks: NotationBlock[] = [];

  for (const block of blocks) {
    if (block.foldMeta) {
      nonTrivialBlocks.push(block);
      continue;
    }

    const isTrivial =
      (block.lines.length === 0 && block.children.length === 0) ||
      block.lines.every(l => l.operator === '');

    if (isTrivial) {
      if (!trivialByType.has(block.nodeType)) trivialByType.set(block.nodeType, []);
      trivialByType.get(block.nodeType)!.push(block);
    } else {
      nonTrivialBlocks.push(block);
    }
  }

  const groups: NotationBlock[] = [];

  for (const [type, trivials] of trivialByType) {
    if (trivials.length > FOLD_THRESHOLD) {
      const nameList = trivials.map(b => b.displayName).join(', ');
      groups.push({
        nodeId: `trivial:${type}`,
        displayName: `[${type.toLowerCase()}: ${nameList}]`,
        nodeType: type,
        lines: [],
        children: [],
        foldMeta: {
          kind: 'trivial-group',
          count: trivials.length,
          names: trivials.map(b => b.displayName),
        },
      });
    } else {
      nonTrivialBlocks.push(...trivials);
    }
  }

  return { groups, remaining: nonTrivialBlocks };
}

// === Rules 1-3: Group fold with anomaly preservation and source aggregation ===

function groupFold(
  blocks: NotationBlock[],
): { folded: NotationBlock[]; anomalies: NotationBlock[] } {
  const unfoldedBlocks = blocks.filter(b => !b.foldMeta);
  const alreadyFolded = blocks.filter(b => b.foldMeta);

  if (unfoldedBlocks.length <= FOLD_THRESHOLD) {
    return { folded: alreadyFolded, anomalies: unfoldedBlocks };
  }

  // Group by signature
  const sigGroups = new Map<string, NotationBlock[]>();
  for (const block of unfoldedBlocks) {
    const sig = computeSignature(block);
    const key = signatureKey(sig);
    if (!sigGroups.has(key)) sigGroups.set(key, []);
    sigGroups.get(key)!.push(block);
  }

  const folded: NotationBlock[] = [...alreadyFolded];
  const anomalies: NotationBlock[] = [];

  for (const [, group] of sigGroups) {
    if (group.length > FOLD_THRESHOLD) {
      const exemplar = group[0];

      // Rule 3: Source aggregation — check if all share same source
      const sourceSummary = findCommonSource(group);
      const label = inferLabel(group);
      const summaryParts = [`...+${group.length - 1} more ${label}`];
      if (sourceSummary) summaryParts.push(`from ${sourceSummary}`);

      // Exemplar shown expanded
      folded.push(exemplar);

      // Fold summary
      folded.push({
        nodeId: `fold:${exemplar.nodeId}`,
        displayName: summaryParts.join(' '),
        nodeType: exemplar.nodeType,
        lines: [],
        children: [],
        foldMeta: {
          kind: 'fold',
          count: group.length,
          label,
          sourceSummary,
        },
      });
    } else {
      // Rule 2: Anomaly — too few to fold
      anomalies.push(...group);
    }
  }

  return { folded, anomalies };
}

// === Helpers ===

function findCommonSource(blocks: NotationBlock[]): string | undefined {
  const sources = new Set<string>();

  for (const block of blocks) {
    for (const line of block.lines) {
      if (line.targets.length > 0) {
        for (const t of line.targets) sources.add(t);
      }
    }
  }

  if (sources.size === 1) return [...sources][0];
  return undefined;
}

function inferLabel(group: NotationBlock[]): string {
  if (group.length === 0) return '';

  const type = group[0].nodeType.toLowerCase();
  if (type.endsWith('s')) return type;
  return type + 's';
}
