/**
 * Impact command - Change impact analysis
 *
 * Usage:
 *   grafema impact "function authenticate"
 *   grafema impact "class UserService"
 */

import { Command } from 'commander';
import { isAbsolute, resolve, join, dirname, relative } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend, findContainingFunction as findContainingFunctionCore } from '@grafema/core';
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
  .addHelpText('after', `
Examples:
  grafema impact "authenticate"          Analyze impact of changing authenticate
  grafema impact "function login"        Impact of specific function
  grafema impact "class UserService"     Impact of class changes
  grafema impact "validate" -d 3         Limit analysis depth to 3 levels
  grafema impact "auth" --json           Output impact analysis as JSON
`)
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

      if (!options.json) {
        console.log(`Analyzing impact of changing ${name}...`);
        console.log('');
      }

      // Find target node
      const target = await findTarget(backend, type, name);

      if (!target) {
        if (options.json) {
          process.stderr.write(`No ${type || 'node'} "${name}" found\n`);
        } else {
          console.log(`No ${type || 'node'} "${name}" found`);
        }
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
      const nodeName = node.name || '';
      if (nodeName.toLowerCase() === name.toLowerCase()) {
        return {
          id: node.id,
          type: node.type || nodeType,
          name: nodeName,
          file: node.file || '',
          line: node.line,
        };
      }
    }
  }

  return null;
}

/**
 * Extract bare method name from a possibly-qualified name.
 * "RFDBServerBackend.addNode" -> "addNode"
 * "addNode" -> "addNode"
 */
function extractMethodName(fullName: string): string {
  if (!fullName) return '';
  const dotIdx = fullName.lastIndexOf('.');
  return dotIdx >= 0 ? fullName.slice(dotIdx + 1) : fullName;
}

/**
 * Find the FUNCTION child node ID for `methodName` in a CLASS node.
 * Returns the concrete function node ID if found, null otherwise.
 */
async function findMethodInClass(
  backend: RFDBServerBackend,
  classId: string,
  methodName: string
): Promise<string | null> {
  const containsEdges = await backend.getOutgoingEdges(classId, ['CONTAINS']);
  for (const edge of containsEdges) {
    const child = await backend.getNode(edge.dst);
    if (child && child.type === 'FUNCTION' && child.name === methodName) {
      return child.id;
    }
  }
  return null;
}

/**
 * Check whether `methodName` is declared in an INTERFACE node's `properties` array.
 *
 * Interface method signatures are stored as JSON on the INTERFACE node itself,
 * NOT as separate FUNCTION graph nodes. There are no CALLS edges pointing to them.
 * When found, returns the INTERFACE node's own ID as a proxy: including it in
 * initialTargetIds causes the findByAttr fallback to fire and surface unresolved
 * call sites whose receiver was typed as this interface.
 *
 * Returns the interface node ID (proxy) if declared, null otherwise.
 */
async function findInterfaceMethodProxy(
  backend: RFDBServerBackend,
  interfaceId: string,
  methodName: string
): Promise<string | null> {
  const node = await backend.getNode(interfaceId);
  if (!node) return null;
  const properties = (node as any).properties;
  if (Array.isArray(properties)) {
    for (const prop of properties) {
      if (prop && prop.name === methodName) return interfaceId;
    }
  }
  return null;
}

/**
 * Collect all ancestor class/interface IDs by walking outgoing DERIVES_FROM and
 * IMPLEMENTS edges upward through the hierarchy.
 *
 * Depth-bounded to 5 hops. Visited set prevents infinite loops on malformed data.
 */
async function collectAncestors(
  backend: RFDBServerBackend,
  classId: string,
  visited = new Set<string>(),
  depth = 0
): Promise<string[]> {
  if (depth > 5 || visited.has(classId)) return [];
  visited.add(classId);
  const ancestors: string[] = [];

  const outgoing = await backend.getOutgoingEdges(classId, ['DERIVES_FROM', 'IMPLEMENTS']);
  for (const edge of outgoing) {
    ancestors.push(edge.dst);
    const more = await collectAncestors(backend, edge.dst, visited, depth + 1);
    ancestors.push(...more);
  }
  return ancestors;
}

/**
 * Collect all descendant class IDs by recursively walking incoming DERIVES_FROM
 * and IMPLEMENTS edges downward through the hierarchy.
 *
 * Depth-bounded to 5 hops. Visited set prevents infinite loops on malformed data.
 */
async function collectDescendants(
  backend: RFDBServerBackend,
  classId: string,
  visited = new Set<string>(),
  depth = 0
): Promise<string[]> {
  if (depth > 5 || visited.has(classId)) return [];
  visited.add(classId);
  const descendants: string[] = [];
  const incoming = await backend.getIncomingEdges(classId, ['DERIVES_FROM', 'IMPLEMENTS']);
  for (const edge of incoming) {
    descendants.push(edge.src);
    const more = await collectDescendants(backend, edge.src, visited, depth + 1);
    descendants.push(...more);
  }
  return descendants;
}

/**
 * Given a concrete method node, find all related nodes in the class hierarchy
 * that represent the same conceptual method (parent interfaces, abstract methods,
 * sibling and descendant implementations).
 *
 * This enables CHA-style impact analysis: callers that type their receiver
 * as an interface or abstract class will have CALLS edges pointing to the abstract
 * node, not to the concrete one. Including those abstract nodes in the initial target
 * set lets the BFS reach those call sites.
 *
 * Returns a set of node IDs:
 * - The original targetId
 * - FUNCTION child node IDs from CLASS ancestors/descendants that declare the method
 * - INTERFACE node IDs (findByAttr-trigger proxies) from INTERFACE ancestors
 */
async function expandTargetSet(
  backend: RFDBServerBackend,
  targetId: string,
  methodName: string
): Promise<Set<string>> {
  const result = new Set<string>([targetId]);

  if (!methodName) return result;

  try {
    // Find the containing class or interface
    const containsEdges = await backend.getIncomingEdges(targetId, ['CONTAINS']);
    const parentIds: string[] = [];
    for (const edge of containsEdges) {
      const parent = await backend.getNode(edge.src);
      if (parent && (parent.type === 'CLASS' || parent.type === 'INTERFACE')) {
        parentIds.push(parent.id);
      }
    }

    // For each parent, walk the full hierarchy (ancestors + all descendants)
    for (const classId of parentIds) {
      const ancestors = await collectAncestors(backend, classId);
      for (const ancestorId of ancestors) {
        const ancestorNode = await backend.getNode(ancestorId);
        if (!ancestorNode) continue;

        if (ancestorNode.type === 'CLASS') {
          const method = await findMethodInClass(backend, ancestorId, methodName);
          if (method) result.add(method);
          // All descendants of this ancestor may implement the method too
          const descendants = await collectDescendants(backend, ancestorId);
          for (const descId of descendants) {
            const descNode = await backend.getNode(descId);
            if (!descNode) continue;
            if (descNode.type === 'CLASS') {
              const descMethod = await findMethodInClass(backend, descId, methodName);
              if (descMethod) result.add(descMethod);
            } else if (descNode.type === 'INTERFACE') {
              const proxy = await findInterfaceMethodProxy(backend, descId, methodName);
              if (proxy) result.add(proxy);
            }
          }
        } else if (ancestorNode.type === 'INTERFACE') {
          const proxy = await findInterfaceMethodProxy(backend, ancestorId, methodName);
          if (proxy) result.add(proxy);
        }
      }
    }
  } catch (err) {
    process.stderr.write(`[grafema impact] Warning: hierarchy expansion failed: ${err}\n`);
  }

  return result;
}

/**
 * Determine the initial set of nodes to BFS from and the per-node method names
 * for the findByAttr fallback.
 *
 * For CLASS targets: seeds from the class node + all its method nodes.
 * For function/method targets: CHA-style expansion via expandTargetSet.
 */
async function resolveTargetSet(
  backend: RFDBServerBackend,
  target: NodeInfo
): Promise<{ targetIds: string[]; targetMethodNames: Map<string, string> }> {
  const targetMethodNames = new Map<string, string>();

  if (target.type === 'CLASS') {
    const methods = await getClassMethods(backend, target.id);
    for (const m of methods) {
      if (m.name) targetMethodNames.set(m.id, m.name);
    }
    return { targetIds: [target.id, ...methods.map(m => m.id)], targetMethodNames };
  }

  const methodName = extractMethodName(target.name);
  const expanded = await expandTargetSet(backend, target.id, methodName);
  const targetIds = [...expanded];
  if (methodName) {
    for (const id of targetIds) targetMethodNames.set(id, methodName);
  }
  return { targetIds, targetMethodNames };
}

/**
 * BFS over caller graph starting from `targetIds`, collecting direct and transitive
 * callers up to `maxDepth` hops.
 *
 * The `initialTargetIds` set gates the findByAttr fallback: it runs only for nodes
 * in the initial seed, never for callers discovered during traversal.
 */
async function collectCallersBFS(
  backend: RFDBServerBackend,
  target: NodeInfo,
  targetIds: string[],
  targetMethodNames: Map<string, string>,
  maxDepth: number,
  projectPath: string
): Promise<{ directCallers: NodeInfo[]; transitiveCallers: NodeInfo[]; affectedModules: Map<string, number>; callChains: string[][] }> {
  const directCallers: NodeInfo[] = [];
  const transitiveCallers: NodeInfo[] = [];
  const affectedModules = new Map<string, number>();
  const callChains: string[][] = [];
  const visited = new Set<string>();
  const initialTargetIds = new Set(targetIds);

  const queue: Array<{ id: string; depth: number; chain: string[] }> = targetIds.map(id => ({
    id,
    depth: 0,
    chain: [target.name],
  }));

  while (queue.length > 0) {
    const { id, depth, chain } = queue.shift()!;

    if (visited.has(id)) continue;
    visited.add(id);

    if (depth > maxDepth) continue;

    try {
      const containingCalls = await findCallsToNode(
        backend,
        id,
        initialTargetIds.has(id) ? targetMethodNames.get(id) : undefined
      );

      for (const callNode of containingCalls) {
        const container = await findContainingFunctionCore(backend, callNode.id);

        if (container && !visited.has(container.id)) {
          // Skip internal callers (methods of the same class being analyzed)
          if (target.type === 'CLASS' && targetIds.includes(container.id)) continue;

          const caller: NodeInfo = {
            id: container.id,
            type: container.type,
            name: container.name,
            file: container.file || '',
            line: container.line,
          };

          if (depth === 0) {
            directCallers.push(caller);
          } else {
            transitiveCallers.push(caller);
          }

          const modulePath = getModulePath(caller.file, projectPath);
          affectedModules.set(modulePath, (affectedModules.get(modulePath) || 0) + 1);

          const newChain = [...chain, caller.name];
          if (newChain.length <= 4) callChains.push(newChain);

          queue.push({ id: container.id, depth: depth + 1, chain: newChain });
        }
      }
    } catch (err) {
      process.stderr.write(`[grafema impact] Warning: query failed for node ${id}: ${err}\n`);
    }
  }

  callChains.sort((a, b) => b.length - a.length);
  return { directCallers, transitiveCallers, affectedModules, callChains };
}

/**
 * Analyze impact of changing a node: resolve the target set, then BFS for callers.
 */
async function analyzeImpact(
  backend: RFDBServerBackend,
  target: NodeInfo,
  maxDepth: number,
  projectPath: string
): Promise<ImpactResult> {
  const { targetIds, targetMethodNames } = await resolveTargetSet(backend, target);
  const { directCallers, transitiveCallers, affectedModules, callChains } =
    await collectCallersBFS(backend, target, targetIds, targetMethodNames, maxDepth, projectPath);

  return { target, directCallers, transitiveCallers, affectedModules, callChains };
}

/**
 * Get method nodes for a class (id + name pairs for findByAttr fallback)
 */
async function getClassMethods(
  backend: RFDBServerBackend,
  classId: string
): Promise<Array<{ id: string; name: string }>> {
  const methods: Array<{ id: string; name: string }> = [];

  try {
    const edges = await backend.getOutgoingEdges(classId, ['CONTAINS']);

    for (const edge of edges) {
      const node = await backend.getNode(edge.dst);
      if (node && node.type === 'FUNCTION') {
        methods.push({ id: node.id, name: node.name || '' });
      }
    }
  } catch (err) {
    process.stderr.write(`[grafema impact] Warning: method enumeration failed for ${classId}: ${err}\n`);
  }

  return methods;
}

/**
 * Find CALL nodes that reference a target via CALLS edges.
 *
 * If methodName is provided, also searches for unresolved CALL nodes that
 * have a matching `method` attribute but no CALLS edge (e.g., calls through
 * abstract-typed or parameter-typed receivers that MethodCallResolver could
 * not resolve).
 *
 * IMPORTANT: Only pass methodName for initial target IDs (depth 0 in BFS),
 * never for transitive callers. The findByAttr query scans the entire graph
 * and returns the same results regardless of which node is being queried --
 * running it for every BFS node is redundant and costly.
 *
 * Known imprecision: findByAttr matches by bare method name only, not by
 * class. All call sites for any method with the same name across all classes
 * are returned. This is intentionally conservative (sound but imprecise).
 */
async function findCallsToNode(
  backend: RFDBServerBackend,
  targetId: string,
  methodName?: string
): Promise<NodeInfo[]> {
  const calls: NodeInfo[] = [];
  const seen = new Set<string>();

  try {
    const edges = await backend.getIncomingEdges(targetId, ['CALLS']);

    for (const edge of edges) {
      const callNode = await backend.getNode(edge.src);
      if (callNode && !seen.has(callNode.id)) {
        seen.add(callNode.id);
        calls.push({
          id: callNode.id,
          type: callNode.type || 'CALL',
          name: callNode.name || '',
          file: callNode.file || '',
          line: callNode.line,
        });
      }
    }
  } catch (err) {
    process.stderr.write(`[grafema impact] Warning: CALLS edge query failed for ${targetId}: ${err}\n`);
  }

  // Fallback: CALL nodes with matching method attribute but no CALLS edge.
  // Only runs when methodName is provided (i.e., for initial target IDs only).
  // Known imprecision: matches by bare method name across all classes — may include
  // call sites from unrelated classes that happen to share the method name.
  if (methodName) {
    try {
      const callNodeIds = await backend.findByAttr({ nodeType: 'CALL', method: methodName });
      const newMatches: string[] = [];
      for (const id of callNodeIds) {
        if (!seen.has(id)) {
          seen.add(id);
          newMatches.push(id);
          const callNode = await backend.getNode(id);
          if (callNode) {
            calls.push({
              id: callNode.id,
              type: callNode.type || 'CALL',
              name: callNode.name || '',
              file: callNode.file || '',
              line: callNode.line,
            });
          }
        }
      }
      if (newMatches.length > 0) {
        process.stderr.write(
          `[grafema impact] Note: name-only fallback matched ${newMatches.length} unresolved call(s) for '${methodName}' — may include calls from unrelated classes\n`
        );
      }
    } catch (err) {
      process.stderr.write(`[grafema impact] Warning: findByAttr fallback failed for '${methodName}': ${err}\n`);

    }
  }

  return calls;
}

/**
 * Get module path relative to project
 */
function getModulePath(file: string, projectPath: string): string {
  if (!file) return '<unknown>';
  const relPath = isAbsolute(file) ? relative(projectPath, file) : file;
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

