/**
 * Impact command - Change impact analysis
 *
 * Usage:
 *   grafema impact "function authenticate"
 *   grafema impact "class UserService"
 */

import { Command } from 'commander';
import { resolve, join, dirname } from 'path';
import { relative } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend } from '@grafema/core';
import { formatNodeDisplay, formatNodeInline } from '../utils/formatNode.js';
import { exitWithError } from '../utils/errorFormatter.js';

interface ImpactOptions {
  project: string;
  json?: boolean;
  depth: string;
}

interface NodeInfo {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
}

interface ImpactResult {
  target: NodeInfo;
  directCallers: NodeInfo[];
  transitiveCallers: NodeInfo[];
  affectedModules: Map<string, number>;
  callChains: string[][];
}

export const impactCommand = new Command('impact')
  .description('Analyze change impact for a function or class')
  .argument('<pattern>', 'Target: "function X" or "class Y" or just "X"')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-d, --depth <n>', 'Max traversal depth', '10')
  .action(async (pattern: string, options: ImpactOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    try {
      const { type, name } = parsePattern(pattern);
      const maxDepth = parseInt(options.depth, 10);

      console.log(`Analyzing impact of changing ${name}...`);
      console.log('');

      // Find target node
      const target = await findTarget(backend, type, name);

      if (!target) {
        console.log(`No ${type || 'node'} "${name}" found`);
        return;
      }

      // Analyze impact
      const impact = await analyzeImpact(backend, target, maxDepth, projectPath);

      if (options.json) {
        console.log(JSON.stringify({
          target: impact.target,
          directCallers: impact.directCallers.length,
          transitiveCallers: impact.transitiveCallers.length,
          affectedModules: Object.fromEntries(impact.affectedModules),
          callChains: impact.callChains.slice(0, 5),
        }, null, 2));
        return;
      }

      // Display results
      displayImpact(impact, projectPath);

    } finally {
      await backend.close();
    }
  });

/**
 * Parse pattern like "function authenticate"
 */
function parsePattern(pattern: string): { type: string | null; name: string } {
  const words = pattern.trim().split(/\s+/);

  if (words.length >= 2) {
    const typeWord = words[0].toLowerCase();
    const name = words.slice(1).join(' ');

    const typeMap: Record<string, string> = {
      function: 'FUNCTION',
      fn: 'FUNCTION',
      class: 'CLASS',
      module: 'MODULE',
    };

    if (typeMap[typeWord]) {
      return { type: typeMap[typeWord], name };
    }
  }

  return { type: null, name: pattern.trim() };
}

/**
 * Find target node
 */
async function findTarget(
  backend: RFDBServerBackend,
  type: string | null,
  name: string
): Promise<NodeInfo | null> {
  const searchTypes = type ? [type] : ['FUNCTION', 'CLASS'];

  for (const nodeType of searchTypes) {
    for await (const node of backend.queryNodes({ nodeType: nodeType as any })) {
      const nodeName = (node as any).name || '';
      if (nodeName.toLowerCase() === name.toLowerCase()) {
        return {
          id: node.id,
          type: (node as any).type || nodeType,
          name: nodeName,
          file: (node as any).file || '',
          line: (node as any).line,
        };
      }
    }
  }

  return null;
}

/**
 * Analyze impact of changing a node
 */
async function analyzeImpact(
  backend: RFDBServerBackend,
  target: NodeInfo,
  maxDepth: number,
  projectPath: string
): Promise<ImpactResult> {
  const directCallers: NodeInfo[] = [];
  const transitiveCallers: NodeInfo[] = [];
  const affectedModules = new Map<string, number>();
  const callChains: string[][] = [];
  const visited = new Set<string>();

  // BFS to find all callers
  const queue: Array<{ id: string; depth: number; chain: string[] }> = [
    { id: target.id, depth: 0, chain: [target.name] }
  ];

  while (queue.length > 0) {
    const { id, depth, chain } = queue.shift()!;

    if (visited.has(id)) continue;
    visited.add(id);

    if (depth > maxDepth) continue;

    try {
      // Find what calls this node
      // First, find CALL nodes that have this as target
      const containingCalls = await findCallsToNode(backend, id);

      for (const callNode of containingCalls) {
        // Find the function containing this call
        const container = await findContainingFunction(backend, callNode.id);

        if (container && !visited.has(container.id)) {
          const caller: NodeInfo = {
            id: container.id,
            type: container.type,
            name: container.name,
            file: container.file,
            line: container.line,
          };

          if (depth === 0) {
            directCallers.push(caller);
          } else {
            transitiveCallers.push(caller);
          }

          // Track affected modules
          const modulePath = getModulePath(caller.file, projectPath);
          affectedModules.set(modulePath, (affectedModules.get(modulePath) || 0) + 1);

          // Track call chain
          const newChain = [...chain, caller.name];
          if (newChain.length <= 4) {
            callChains.push(newChain);
          }

          // Continue BFS
          queue.push({ id: container.id, depth: depth + 1, chain: newChain });
        }
      }
    } catch {
      // Ignore errors
    }
  }

  // Sort call chains by length
  callChains.sort((a, b) => b.length - a.length);

  return {
    target,
    directCallers,
    transitiveCallers,
    affectedModules,
    callChains,
  };
}

/**
 * Find CALL nodes that reference a target
 */
async function findCallsToNode(
  backend: RFDBServerBackend,
  targetId: string
): Promise<NodeInfo[]> {
  const calls: NodeInfo[] = [];

  try {
    // Get incoming CALLS edges
    const edges = await backend.getIncomingEdges(targetId, ['CALLS']);

    for (const edge of edges) {
      const callNode = await backend.getNode(edge.src);
      if (callNode) {
        calls.push({
          id: callNode.id,
          type: (callNode as any).type || 'CALL',
          name: (callNode as any).name || '',
          file: (callNode as any).file || '',
          line: (callNode as any).line,
        });
      }
    }
  } catch {
    // Ignore
  }

  return calls;
}

/**
 * Find the function that contains a call node
 *
 * Path: CALL → CONTAINS → SCOPE → CONTAINS → SCOPE → HAS_SCOPE → FUNCTION
 */
async function findContainingFunction(
  backend: RFDBServerBackend,
  nodeId: string,
  maxDepth: number = 15
): Promise<NodeInfo | null> {
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    try {
      // Get incoming edges: CONTAINS, HAS_SCOPE
      const edges = await backend.getIncomingEdges(id, null);

      for (const edge of edges) {
        const edgeType = (edge as any).edgeType || (edge as any).type;

        // Only follow structural edges
        if (!['CONTAINS', 'HAS_SCOPE', 'DECLARES'].includes(edgeType)) continue;

        const parent = await backend.getNode(edge.src);
        if (!parent || visited.has(parent.id)) continue;

        const parentType = (parent as any).type || (parent as any).nodeType;

        // FUNCTION, CLASS, or MODULE (for top-level calls)
        if (parentType === 'FUNCTION' || parentType === 'CLASS' || parentType === 'MODULE') {
          return {
            id: parent.id,
            type: parentType,
            name: (parent as any).name || '',
            file: (parent as any).file || '',
            line: (parent as any).line,
          };
        }

        queue.push({ id: parent.id, depth: depth + 1 });
      }
    } catch {
      // Ignore
    }
  }

  return null;
}

/**
 * Get module path relative to project
 */
function getModulePath(file: string, projectPath: string): string {
  if (!file) return '<unknown>';
  const relPath = relative(projectPath, file);
  const dir = dirname(relPath);
  return dir === '.' ? relPath : `${dir}/*`;
}

/**
 * Display impact analysis results with semantic IDs
 */
function displayImpact(impact: ImpactResult, projectPath: string): void {
  console.log(formatNodeDisplay(impact.target, { projectPath }));
  console.log('');

  // Direct impact
  console.log('Direct impact:');
  console.log(`  ${impact.directCallers.length} direct callers`);
  console.log(`  ${impact.transitiveCallers.length} transitive callers`);
  console.log(`  ${impact.directCallers.length + impact.transitiveCallers.length} total affected`);
  console.log('');

  // Show direct callers
  if (impact.directCallers.length > 0) {
    console.log('Direct callers:');
    for (const caller of impact.directCallers.slice(0, 10)) {
      console.log(`  <- ${formatNodeInline(caller)}`);
    }
    if (impact.directCallers.length > 10) {
      console.log(`  ... and ${impact.directCallers.length - 10} more`);
    }
    console.log('');
  }

  // Affected modules
  if (impact.affectedModules.size > 0) {
    console.log('Affected modules:');
    const sorted = [...impact.affectedModules.entries()].sort((a, b) => b[1] - a[1]);
    for (const [module, count] of sorted.slice(0, 5)) {
      console.log(`  ├─ ${module} (${count} calls)`);
    }
    if (sorted.length > 5) {
      console.log(`  └─ ... and ${sorted.length - 5} more modules`);
    }
    console.log('');
  }

  // Call chains
  if (impact.callChains.length > 0) {
    console.log('Call chains (sample):');
    for (const chain of impact.callChains.slice(0, 3)) {
      console.log(`  ${chain.join(' → ')}`);
    }
    console.log('');
  }

  // Risk assessment
  const totalAffected = impact.directCallers.length + impact.transitiveCallers.length;
  const moduleCount = impact.affectedModules.size;

  let risk = 'LOW';
  let color = '\x1b[32m'; // green

  if (totalAffected > 20 || moduleCount > 5) {
    risk = 'HIGH';
    color = '\x1b[31m'; // red
  } else if (totalAffected > 5 || moduleCount > 2) {
    risk = 'MEDIUM';
    color = '\x1b[33m'; // yellow
  }

  console.log(`Risk level: ${color}${risk}\x1b[0m`);

  if (risk === 'HIGH') {
    console.log('');
    console.log('Recommendation:');
    console.log('  • Consider adding backward-compatible wrapper');
    console.log('  • Update tests in affected modules');
    console.log('  • Notify team about breaking change');
  }
}

