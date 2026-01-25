/**
 * Trace command - Data flow analysis
 *
 * Usage:
 *   grafema trace "userId from authenticate"
 *   grafema trace "config"
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend, parseSemanticId } from '@grafema/core';
import { formatNodeDisplay, formatNodeInline } from '../utils/formatNode.js';
import { exitWithError } from '../utils/errorFormatter.js';

interface TraceOptions {
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
  value?: unknown;
}

interface TraceStep {
  node: NodeInfo;
  edgeType: string;
  depth: number;
}

export const traceCommand = new Command('trace')
  .description('Trace data flow for a variable')
  .argument('<pattern>', 'Pattern: "varName from functionName" or just "varName"')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-d, --depth <n>', 'Max trace depth', '10')
  .addHelpText('after', `
Examples:
  grafema trace "userId"                     Trace all variables named "userId"
  grafema trace "userId from authenticate"   Trace userId within authenticate function
  grafema trace "config" --depth 5           Limit trace depth to 5 levels
  grafema trace "apiKey" --json              Output trace as JSON
`)
  .action(async (pattern: string, options: TraceOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    try {
      // Parse pattern: "varName from functionName" or just "varName"
      const { varName, scopeName } = parseTracePattern(pattern);
      const maxDepth = parseInt(options.depth, 10);

      console.log(`Tracing ${varName}${scopeName ? ` from ${scopeName}` : ''}...`);
      console.log('');

      // Find starting variable(s)
      const variables = await findVariables(backend, varName, scopeName);

      if (variables.length === 0) {
        console.log(`No variable "${varName}" found${scopeName ? ` in ${scopeName}` : ''}`);
        return;
      }

      // Trace each variable
      for (const variable of variables) {
        console.log(formatNodeDisplay(variable, { projectPath }));
        console.log('');

        // Trace backwards through ASSIGNED_FROM
        const backwardTrace = await traceBackward(backend, variable.id, maxDepth);

        if (backwardTrace.length > 0) {
          console.log('Data sources (where value comes from):');
          displayTrace(backwardTrace, projectPath, '  ');
        }

        // Trace forward through ASSIGNED_FROM (where this value flows to)
        const forwardTrace = await traceForward(backend, variable.id, maxDepth);

        if (forwardTrace.length > 0) {
          console.log('');
          console.log('Data sinks (where value flows to):');
          displayTrace(forwardTrace, projectPath, '  ');
        }

        // Show value domain if available
        const sources = await getValueSources(backend, variable.id);
        if (sources.length > 0) {
          console.log('');
          console.log('Possible values:');
          for (const src of sources) {
            if (src.type === 'LITERAL' && src.value !== undefined) {
              console.log(`  • ${JSON.stringify(src.value)} (literal)`);
            } else if (src.type === 'PARAMETER') {
              console.log(`  • <parameter ${src.name}> (runtime input)`);
            } else if (src.type === 'CALL') {
              console.log(`  • <return from ${src.name || 'call'}> (computed)`);
            } else {
              console.log(`  • <${src.type.toLowerCase()}> ${src.name || ''}`);
            }
          }
        }

        if (variables.length > 1) {
          console.log('');
          console.log('---');
        }
      }

      if (options.json) {
        // TODO: structured JSON output
      }

    } finally {
      await backend.close();
    }
  });

/**
 * Parse trace pattern
 */
function parseTracePattern(pattern: string): { varName: string; scopeName: string | null } {
  const fromMatch = pattern.match(/^(.+?)\s+from\s+(.+)$/i);
  if (fromMatch) {
    return { varName: fromMatch[1].trim(), scopeName: fromMatch[2].trim() };
  }
  return { varName: pattern.trim(), scopeName: null };
}

/**
 * Find variables by name, optionally scoped to a function
 */
async function findVariables(
  backend: RFDBServerBackend,
  varName: string,
  scopeName: string | null
): Promise<NodeInfo[]> {
  const results: NodeInfo[] = [];
  const lowerScopeName = scopeName ? scopeName.toLowerCase() : null;

  // Search VARIABLE, CONSTANT, PARAMETER
  for (const nodeType of ['VARIABLE', 'CONSTANT', 'PARAMETER']) {
    for await (const node of backend.queryNodes({ nodeType: nodeType as any })) {
      const name = node.name || '';
      if (name.toLowerCase() === varName.toLowerCase()) {
        // If scope specified, check if variable is in that scope
        if (scopeName) {
          const parsed = parseSemanticId(node.id);
          if (!parsed) continue; // Skip nodes with invalid IDs

          // Check if scopeName appears anywhere in the scope chain
          if (!parsed.scopePath.some(s => s.toLowerCase() === lowerScopeName)) {
            continue;
          }
        }

        results.push({
          id: node.id,
          type: node.type || nodeType,
          name: name,
          file: node.file || '',
          line: node.line,
        });

        if (results.length >= 5) break;
      }
    }
    if (results.length >= 5) break;
  }

  return results;
}

/**
 * Trace backward through ASSIGNED_FROM edges
 */
async function traceBackward(
  backend: RFDBServerBackend,
  startId: string,
  maxDepth: number
): Promise<TraceStep[]> {
  const trace: TraceStep[] = [];
  const visited = new Set<string>();
  const seenNodes = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    try {
      const edges = await backend.getOutgoingEdges(id, ['ASSIGNED_FROM', 'DERIVES_FROM']);

      for (const edge of edges) {
        const targetNode = await backend.getNode(edge.dst);
        if (!targetNode) continue;

        if (seenNodes.has(targetNode.id)) continue;
        seenNodes.add(targetNode.id);

        const nodeInfo: NodeInfo = {
          id: targetNode.id,
          type: targetNode.type || 'UNKNOWN',
          name: targetNode.name || '',
          file: targetNode.file || '',
          line: targetNode.line,
          value: targetNode.value,
        };

        trace.push({
          node: nodeInfo,
          edgeType: edge.edgeType || edge.type,
          depth: depth + 1,
        });

        // Continue tracing unless we hit a leaf
        const leafTypes = ['LITERAL', 'PARAMETER', 'EXTERNAL_MODULE'];
        if (!leafTypes.includes(nodeInfo.type)) {
          queue.push({ id: targetNode.id, depth: depth + 1 });
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return trace;
}

/**
 * Trace forward - find what uses this variable
 */
async function traceForward(
  backend: RFDBServerBackend,
  startId: string,
  maxDepth: number
): Promise<TraceStep[]> {
  const trace: TraceStep[] = [];
  const visited = new Set<string>();
  const seenNodes = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;

    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    try {
      // Find nodes that get their value FROM this node
      const edges = await backend.getIncomingEdges(id, ['ASSIGNED_FROM', 'DERIVES_FROM']);

      for (const edge of edges) {
        const sourceNode = await backend.getNode(edge.src);
        if (!sourceNode) continue;

        if (seenNodes.has(sourceNode.id)) continue;
        seenNodes.add(sourceNode.id);

        const nodeInfo: NodeInfo = {
          id: sourceNode.id,
          type: sourceNode.type || 'UNKNOWN',
          name: sourceNode.name || '',
          file: sourceNode.file || '',
          line: sourceNode.line,
        };

        trace.push({
          node: nodeInfo,
          edgeType: edge.edgeType || edge.type,
          depth: depth + 1,
        });

        // Continue forward
        if (depth < maxDepth - 1) {
          queue.push({ id: sourceNode.id, depth: depth + 1 });
        }
      }
    } catch {
      // Ignore errors
    }
  }

  return trace;
}

/**
 * Get immediate value sources (for "possible values" display)
 */
async function getValueSources(
  backend: RFDBServerBackend,
  nodeId: string
): Promise<NodeInfo[]> {
  const sources: NodeInfo[] = [];

  try {
    const edges = await backend.getOutgoingEdges(nodeId, ['ASSIGNED_FROM']);

    for (const edge of edges.slice(0, 5)) {
      const node = await backend.getNode(edge.dst);
      if (node) {
        sources.push({
          id: node.id,
          type: node.type || 'UNKNOWN',
          name: node.name || '',
          file: node.file || '',
          line: node.line,
          value: node.value,
        });
      }
    }
  } catch {
    // Ignore
  }

  return sources;
}

/**
 * Display trace results with semantic IDs
 */
function displayTrace(trace: TraceStep[], _projectPath: string, indent: string): void {
  // Group by depth
  const byDepth = new Map<number, TraceStep[]>();
  for (const step of trace) {
    if (!byDepth.has(step.depth)) {
      byDepth.set(step.depth, []);
    }
    byDepth.get(step.depth)!.push(step);
  }

  for (const [_depth, steps] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    for (const step of steps) {
      const valueStr = step.node.value !== undefined ? ` = ${JSON.stringify(step.node.value)}` : '';
      console.log(`${indent}<- ${step.node.name || step.node.type} (${step.node.type})${valueStr}`);
      console.log(`${indent}   ${formatNodeInline(step.node)}`);
    }
  }
}

