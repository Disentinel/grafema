/**
 * Query command - Search the code graph
 *
 * Supports patterns like:
 *   grafema query "function authenticate"
 *   grafema query "class UserService"
 *   grafema query "authenticate"  (searches all types)
 *
 * For raw Datalog queries, use --raw flag
 */

import { Command } from 'commander';
import { resolve, join, relative } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend } from '@grafema/core';
import { formatNodeDisplay, formatNodeInline } from '../utils/formatNode.js';
import { exitWithError } from '../utils/errorFormatter.js';

interface QueryOptions {
  project: string;
  json?: boolean;
  limit: string;
  raw?: boolean;
}

interface NodeInfo {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
  [key: string]: unknown;
}

export const queryCommand = new Command('query')
  .description('Search the code graph')
  .argument('<pattern>', 'Search pattern: "function X", "class Y", or just "X"')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-l, --limit <n>', 'Limit results', '10')
  .option('--raw', 'Execute raw Datalog query')
  .action(async (pattern: string, options: QueryOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    try {
      // Raw Datalog mode
      if (options.raw) {
        await executeRawQuery(backend, pattern, options);
        return;
      }

      // Parse pattern
      const { type, name } = parsePattern(pattern);
      const limit = parseInt(options.limit, 10);

      // Find matching nodes
      const nodes = await findNodes(backend, type, name, limit);

      if (nodes.length === 0) {
        console.log(`No results for "${pattern}"`);
        if (type) {
          console.log(`  → Try: grafema query "${name}" (search all types)`);
        }
        return;
      }

      if (options.json) {
        const results = await Promise.all(
          nodes.map(async (node) => ({
            ...node,
            calledBy: await getCallers(backend, node.id, 5),
            calls: await getCallees(backend, node.id, 5),
          }))
        );
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      // Display results
      for (const node of nodes) {
        console.log('');
        displayNode(node, projectPath);

        // Show callers and callees for functions
        if (node.type === 'FUNCTION' || node.type === 'CLASS') {
          const callers = await getCallers(backend, node.id, 5);
          const callees = await getCallees(backend, node.id, 5);

          if (callers.length > 0) {
            console.log('');
            console.log(`Called by (${callers.length}${callers.length >= 5 ? '+' : ''}):`);
            for (const caller of callers) {
              console.log(`  <- ${formatNodeInline(caller)}`);
            }
          }

          if (callees.length > 0) {
            console.log('');
            console.log(`Calls (${callees.length}${callees.length >= 5 ? '+' : ''}):`);
            for (const callee of callees) {
              console.log(`  -> ${formatNodeInline(callee)}`);
            }
          }
        }
      }

      if (nodes.length > 1) {
        console.log('');
        console.log(`Found ${nodes.length} results. Use more specific pattern to narrow.`);
      }

    } finally {
      await backend.close();
    }
  });

/**
 * Parse search pattern like "function authenticate" or just "authenticate"
 */
function parsePattern(pattern: string): { type: string | null; name: string } {
  const words = pattern.trim().split(/\s+/);

  if (words.length >= 2) {
    const typeWord = words[0].toLowerCase();
    const name = words.slice(1).join(' ');

    const typeMap: Record<string, string> = {
      function: 'FUNCTION',
      fn: 'FUNCTION',
      func: 'FUNCTION',
      class: 'CLASS',
      module: 'MODULE',
      variable: 'VARIABLE',
      var: 'VARIABLE',
      const: 'CONSTANT',
      constant: 'CONSTANT',
    };

    if (typeMap[typeWord]) {
      return { type: typeMap[typeWord], name };
    }
  }

  return { type: null, name: pattern.trim() };
}

/**
 * Find nodes by type and name
 */
async function findNodes(
  backend: RFDBServerBackend,
  type: string | null,
  name: string,
  limit: number
): Promise<NodeInfo[]> {
  const results: NodeInfo[] = [];
  const searchTypes = type
    ? [type]
    : ['FUNCTION', 'CLASS', 'MODULE', 'VARIABLE', 'CONSTANT'];

  for (const nodeType of searchTypes) {
    for await (const node of backend.queryNodes({ nodeType: nodeType as any })) {
      const nodeName = node.name || '';
      // Case-insensitive partial match
      if (nodeName.toLowerCase().includes(name.toLowerCase())) {
        results.push({
          id: node.id,
          type: node.type || nodeType,
          name: nodeName,
          file: node.file || '',
          line: node.line,
        });
        if (results.length >= limit) break;
      }
    }
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Get functions that call this node
 *
 * Logic: FUNCTION ← CONTAINS ← CALL → CALLS → TARGET
 * We need to find CALL nodes that CALLS this target,
 * then find the FUNCTION that CONTAINS each CALL
 */
async function getCallers(
  backend: RFDBServerBackend,
  nodeId: string,
  limit: number
): Promise<NodeInfo[]> {
  const callers: NodeInfo[] = [];
  const seen = new Set<string>();

  try {
    // Find CALL nodes that call this target
    const callEdges = await backend.getIncomingEdges(nodeId, ['CALLS']);

    for (const edge of callEdges) {
      if (callers.length >= limit) break;

      const callNode = await backend.getNode(edge.src);
      if (!callNode) continue;

      // Find the FUNCTION that contains this CALL
      const containingFunc = await findContainingFunction(backend, callNode.id);

      if (containingFunc && !seen.has(containingFunc.id)) {
        seen.add(containingFunc.id);
        callers.push({
          id: containingFunc.id,
          type: containingFunc.type || 'FUNCTION',
          name: containingFunc.name || '<anonymous>',
          file: containingFunc.file || '',
          line: containingFunc.line,
        });
      }
    }
  } catch {
    // Ignore errors
  }

  return callers;
}

/**
 * Find the FUNCTION or CLASS that contains a node
 *
 * Path can be: CALL → CONTAINS → SCOPE → CONTAINS → SCOPE → HAS_SCOPE → FUNCTION
 * So we need to follow both CONTAINS and HAS_SCOPE edges
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
      // Get incoming edges: CONTAINS, HAS_SCOPE, and DECLARES (for variables in functions)
      const edges = await backend.getIncomingEdges(id, null);

      for (const edge of edges) {
        const edgeType = (edge as any).edgeType || (edge as any).type;

        // Only follow structural edges
        if (!['CONTAINS', 'HAS_SCOPE', 'DECLARES'].includes(edgeType)) continue;

        const parentNode = await backend.getNode(edge.src);
        if (!parentNode || visited.has(parentNode.id)) continue;

        const parentType = parentNode.type;

        // FUNCTION, CLASS, or MODULE (for top-level calls)
        if (parentType === 'FUNCTION' || parentType === 'CLASS' || parentType === 'MODULE') {
          return {
            id: parentNode.id,
            type: parentType,
            name: parentNode.name || '<anonymous>',
            file: parentNode.file || '',
            line: parentNode.line,
          };
        }

        // Continue searching from this parent
        queue.push({ id: parentNode.id, depth: depth + 1 });
      }
    } catch {
      // Ignore errors
    }
  }

  return null;
}

/**
 * Get functions that this node calls
 *
 * Logic: FUNCTION → CONTAINS → CALL → CALLS → TARGET
 * Find all CALL nodes inside this function, then find what they call
 */
async function getCallees(
  backend: RFDBServerBackend,
  nodeId: string,
  limit: number
): Promise<NodeInfo[]> {
  const callees: NodeInfo[] = [];
  const seen = new Set<string>();

  try {
    // Find all CALL nodes inside this function (via CONTAINS)
    const callNodes = await findCallsInFunction(backend, nodeId);

    for (const callNode of callNodes) {
      if (callees.length >= limit) break;

      // Find what this CALL calls
      const callEdges = await backend.getOutgoingEdges(callNode.id, ['CALLS']);

      for (const edge of callEdges) {
        if (callees.length >= limit) break;

        const targetNode = await backend.getNode(edge.dst);
        if (!targetNode || seen.has(targetNode.id)) continue;

        seen.add(targetNode.id);
        callees.push({
          id: targetNode.id,
          type: targetNode.type || 'UNKNOWN',
          name: targetNode.name || '<anonymous>',
          file: targetNode.file || '',
          line: targetNode.line,
        });
      }
    }
  } catch {
    // Ignore errors
  }

  return callees;
}

/**
 * Find all CALL nodes inside a function (recursively via CONTAINS)
 */
async function findCallsInFunction(
  backend: RFDBServerBackend,
  nodeId: string,
  maxDepth: number = 10
): Promise<NodeInfo[]> {
  const calls: NodeInfo[] = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    try {
      // Get children via CONTAINS
      const edges = await backend.getOutgoingEdges(id, ['CONTAINS']);

      for (const edge of edges) {
        const child = await backend.getNode(edge.dst);
        if (!child) continue;

        const childType = child.type;

        if (childType === 'CALL') {
          calls.push({
            id: child.id,
            type: 'CALL',
            name: child.name || '',
            file: child.file || '',
            line: child.line,
          });
        }

        // Continue searching in children (but not into nested functions)
        if (childType !== 'FUNCTION' && childType !== 'CLASS') {
          queue.push({ id: child.id, depth: depth + 1 });
        }
      }
    } catch {
      // Ignore
    }
  }

  return calls;
}

/**
 * Display a node with semantic ID as primary identifier
 */
function displayNode(node: NodeInfo, projectPath: string): void {
  console.log(formatNodeDisplay(node, { projectPath }));
}

/**
 * Execute raw Datalog query (backwards compat)
 */
async function executeRawQuery(
  backend: RFDBServerBackend,
  query: string,
  options: QueryOptions
): Promise<void> {
  const results = await backend.datalogQuery(query);
  const limit = parseInt(options.limit, 10);
  const limited = results.slice(0, limit);

  if (options.json) {
    console.log(JSON.stringify(limited, null, 2));
  } else {
    if (limited.length === 0) {
      console.log('No results.');
    } else {
      console.log(`Results (${limited.length}${results.length > limit ? ` of ${results.length}` : ''}):`);
      console.log('');
      for (const result of limited) {
        const bindings = result.bindings.map((b) => `${b.name}=${b.value}`).join(', ');
        console.log(`  { ${bindings} }`);
      }
    }
  }
}
