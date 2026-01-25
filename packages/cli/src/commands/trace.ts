/**
 * Trace command - Data flow analysis
 *
 * Usage:
 *   grafema trace "userId from authenticate"
 *   grafema trace "config"
 *   grafema trace --to "addNode#0.type"  (sink-based trace)
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
  to?: string;
}

// =============================================================================
// SINK-BASED TRACE TYPES (REG-230)
// =============================================================================

/**
 * Parsed sink specification from "fn#0.property.path" format
 */
export interface SinkSpec {
  functionName: string;
  argIndex: number;
  propertyPath: string[];
  raw: string;
}

/**
 * Information about a call site
 */
export interface CallSiteInfo {
  id: string;
  calleeFunction: string;
  file: string;
  line: number;
}

/**
 * Source location for a value
 */
export interface ValueSource {
  id: string;
  file: string;
  line: number;
}

/**
 * Result of sink resolution
 */
export interface SinkResolutionResult {
  sink: SinkSpec;
  resolvedCallSites: CallSiteInfo[];
  possibleValues: Array<{
    value: unknown;
    sources: ValueSource[];
  }>;
  statistics: {
    callSites: number;
    totalSources: number;
    uniqueValues: number;
    unknownElements: boolean;
  };
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
  .description('Trace data flow for a variable or to a sink point')
  .argument('[pattern]', 'Pattern: "varName from functionName" or just "varName"')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-d, --depth <n>', 'Max trace depth', '10')
  .option('-t, --to <sink>', 'Sink point: "fn#argIndex.property" (e.g., "addNode#0.type")')
  .addHelpText('after', `
Examples:
  grafema trace "userId"                     Trace all variables named "userId"
  grafema trace "userId from authenticate"   Trace userId within authenticate function
  grafema trace "config" --depth 5           Limit trace depth to 5 levels
  grafema trace "apiKey" --json              Output trace as JSON
  grafema trace --to "addNode#0.type"        Trace values reaching sink point
`)
  .action(async (pattern: string | undefined, options: TraceOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    try {
      // Handle sink-based trace if --to option is provided
      if (options.to) {
        await handleSinkTrace(backend, options.to, projectPath, options.json);
        return;
      }

      // Regular trace requires pattern
      if (!pattern) {
        exitWithError('Pattern required', ['Provide a pattern or use --to for sink trace']);
      }

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
          edgeType: edge.type,
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
          edgeType: edge.type,
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

// =============================================================================
// SINK-BASED TRACE IMPLEMENTATION (REG-230)
// =============================================================================

/**
 * Parse sink specification string into structured format
 *
 * Format: "functionName#argIndex.property.path"
 * Examples:
 *   - "addNode#0.type" -> {functionName: "addNode", argIndex: 0, propertyPath: ["type"]}
 *   - "fn#0" -> {functionName: "fn", argIndex: 0, propertyPath: []}
 *   - "add_node_v2#1.config.options" -> {functionName: "add_node_v2", argIndex: 1, propertyPath: ["config", "options"]}
 *
 * @throws Error if spec is invalid
 */
export function parseSinkSpec(spec: string): SinkSpec {
  if (!spec || spec.trim() === '') {
    throw new Error('Invalid sink spec: empty string');
  }

  const trimmed = spec.trim();

  // Must contain # separator
  const hashIndex = trimmed.indexOf('#');
  if (hashIndex === -1) {
    throw new Error('Invalid sink spec: missing # separator');
  }

  // Extract function name (before #)
  const functionName = trimmed.substring(0, hashIndex);
  if (!functionName || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(functionName)) {
    throw new Error('Invalid sink spec: invalid function name');
  }

  // Extract argument index and optional property path (after #)
  const afterHash = trimmed.substring(hashIndex + 1);
  if (!afterHash) {
    throw new Error('Invalid sink spec: missing argument index');
  }

  // Split by first dot to separate argIndex from property path
  const dotIndex = afterHash.indexOf('.');
  const argIndexStr = dotIndex === -1 ? afterHash : afterHash.substring(0, dotIndex);
  const propertyPathStr = dotIndex === -1 ? '' : afterHash.substring(dotIndex + 1);

  // Parse argument index
  if (!/^\d+$/.test(argIndexStr)) {
    throw new Error('Invalid sink spec: argument index must be numeric');
  }

  const argIndex = parseInt(argIndexStr, 10);
  if (argIndex < 0) {
    throw new Error('Invalid sink spec: negative argument index');
  }

  // Parse property path (split by dots)
  const propertyPath = propertyPathStr ? propertyPathStr.split('.').filter(p => p) : [];

  return {
    functionName,
    argIndex,
    propertyPath,
    raw: trimmed,
  };
}

/**
 * Find all call sites for a function by name
 *
 * Handles both:
 * - Direct calls: fn() where name === targetFunctionName
 * - Method calls: obj.fn() where method attribute === targetFunctionName
 */
export async function findCallSites(
  backend: RFDBServerBackend,
  targetFunctionName: string
): Promise<CallSiteInfo[]> {
  const callSites: CallSiteInfo[] = [];

  for await (const node of backend.queryNodes({ nodeType: 'CALL' as any })) {
    const nodeName = node.name || '';
    const nodeMethod = (node as any).method || '';

    // Match direct calls (name === targetFunctionName)
    // Or method calls (method === targetFunctionName)
    if (nodeName === targetFunctionName || nodeMethod === targetFunctionName) {
      callSites.push({
        id: node.id,
        calleeFunction: targetFunctionName,
        file: node.file || '',
        line: (node as any).line || 0,
      });
    }
  }

  return callSites;
}

/**
 * Extract the argument node ID at a specific index from a call site
 *
 * Follows PASSES_ARGUMENT edges and matches by argIndex metadata
 *
 * @returns Node ID of the argument, or null if not found
 */
export async function extractArgument(
  backend: RFDBServerBackend,
  callSiteId: string,
  argIndex: number
): Promise<string | null> {
  const edges = await backend.getOutgoingEdges(callSiteId, ['PASSES_ARGUMENT' as any]);

  for (const edge of edges) {
    // argIndex is stored in edge metadata
    const edgeArgIndex = edge.metadata?.argIndex as number | undefined;
    if (edgeArgIndex === argIndex) {
      return edge.dst;
    }
  }

  return null;
}

/**
 * Extract a property from a node by following HAS_PROPERTY edges
 *
 * If node is a VARIABLE, first traces through ASSIGNED_FROM to find OBJECT_LITERAL
 *
 * @returns Node ID of the property value, or null if not found
 */
async function extractProperty(
  backend: RFDBServerBackend,
  nodeId: string,
  propertyName: string
): Promise<string | null> {
  const node = await backend.getNode(nodeId);
  if (!node) return null;

  const nodeType = node.type || (node as any).nodeType;

  // If it's an OBJECT_LITERAL, follow HAS_PROPERTY directly
  if (nodeType === 'OBJECT_LITERAL') {
    const edges = await backend.getOutgoingEdges(nodeId, ['HAS_PROPERTY' as any]);
    for (const edge of edges) {
      if (edge.metadata?.propertyName === propertyName) {
        return edge.dst;
      }
    }
    return null;
  }

  // If it's a VARIABLE, first trace to the object literal
  if (nodeType === 'VARIABLE' || nodeType === 'CONSTANT') {
    const assignedEdges = await backend.getOutgoingEdges(nodeId, ['ASSIGNED_FROM' as any]);
    for (const edge of assignedEdges) {
      const result = await extractProperty(backend, edge.dst, propertyName);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Trace a node to its literal values
 *
 * Follows ASSIGNED_FROM edges recursively until reaching LITERAL nodes
 * Returns array of {value, source} pairs
 *
 * Note: We don't use ValueDomainAnalyzer.getValueSet() here because:
 * 1. getValueSet() requires file + variableName parameters for lookup
 * 2. For sink tracing, we already have the node ID from extractArgument()
 * 3. This direct approach avoids re-searching for nodes we already found
 *
 * Tech debt: Consider extracting shared ValueTracer utility (see REG-244)
 */
async function traceToLiterals(
  backend: RFDBServerBackend,
  nodeId: string,
  visited: Set<string> = new Set(),
  maxDepth: number = 10
): Promise<{ value: unknown; source: ValueSource; isUnknown: boolean }[]> {
  if (visited.has(nodeId) || maxDepth <= 0) {
    return [];
  }
  visited.add(nodeId);

  const node = await backend.getNode(nodeId);
  if (!node) return [];

  const nodeType = node.type || (node as any).nodeType;
  const results: { value: unknown; source: ValueSource; isUnknown: boolean }[] = [];

  // If LITERAL, return its value
  if (nodeType === 'LITERAL') {
    results.push({
      value: (node as any).value,
      source: {
        id: node.id,
        file: node.file || '',
        line: (node as any).line || 0,
      },
      isUnknown: false,
    });
    return results;
  }

  // If PARAMETER, mark as unknown (runtime input)
  if (nodeType === 'PARAMETER') {
    results.push({
      value: undefined,
      source: {
        id: node.id,
        file: node.file || '',
        line: (node as any).line || 0,
      },
      isUnknown: true,
    });
    return results;
  }

  // Follow ASSIGNED_FROM edges
  const edges = await backend.getOutgoingEdges(nodeId, ['ASSIGNED_FROM' as any]);
  if (edges.length === 0 && nodeType !== 'OBJECT_LITERAL') {
    // No sources, unknown
    results.push({
      value: undefined,
      source: {
        id: node.id,
        file: node.file || '',
        line: (node as any).line || 0,
      },
      isUnknown: true,
    });
    return results;
  }

  for (const edge of edges) {
    const subResults = await traceToLiterals(backend, edge.dst, visited, maxDepth - 1);
    results.push(...subResults);
  }

  return results;
}

/**
 * Resolve a sink specification to all possible values
 *
 * This is the main entry point for sink-based trace.
 * It finds all call sites, extracts the specified argument,
 * optionally follows property path, and traces to literal values.
 */
export async function resolveSink(
  backend: RFDBServerBackend,
  sink: SinkSpec
): Promise<SinkResolutionResult> {
  // Find all call sites for the function
  const callSites = await findCallSites(backend, sink.functionName);

  const resolvedCallSites: CallSiteInfo[] = [];
  const valueMap = new Map<string, { value: unknown; sources: ValueSource[] }>();
  let hasUnknown = false;
  let totalSources = 0;

  for (const callSite of callSites) {
    resolvedCallSites.push(callSite);

    // Extract the argument at the specified index
    const argNodeId = await extractArgument(backend, callSite.id, sink.argIndex);
    if (!argNodeId) {
      // Argument doesn't exist at this call site
      continue;
    }

    // If property path specified, navigate to that property
    let targetNodeId = argNodeId;
    for (const propName of sink.propertyPath) {
      const propNodeId = await extractProperty(backend, targetNodeId, propName);
      if (!propNodeId) {
        // Property not found, mark as unknown
        hasUnknown = true;
        targetNodeId = '';
        break;
      }
      targetNodeId = propNodeId;
    }

    if (!targetNodeId) continue;

    // Trace to literal values
    const literals = await traceToLiterals(backend, targetNodeId);

    for (const lit of literals) {
      if (lit.isUnknown) {
        hasUnknown = true;
        continue;
      }

      totalSources++;
      const valueKey = JSON.stringify(lit.value);

      if (valueMap.has(valueKey)) {
        valueMap.get(valueKey)!.sources.push(lit.source);
      } else {
        valueMap.set(valueKey, {
          value: lit.value,
          sources: [lit.source],
        });
      }
    }
  }

  // Convert map to array
  const possibleValues = Array.from(valueMap.values());

  return {
    sink,
    resolvedCallSites,
    possibleValues,
    statistics: {
      callSites: callSites.length,
      totalSources,
      uniqueValues: possibleValues.length,
      unknownElements: hasUnknown,
    },
  };
}

/**
 * Handle sink trace command (--to option)
 */
async function handleSinkTrace(
  backend: RFDBServerBackend,
  sinkSpec: string,
  projectPath: string,
  jsonOutput?: boolean
): Promise<void> {
  // Parse the sink specification
  const sink = parseSinkSpec(sinkSpec);

  // Resolve the sink
  const result = await resolveSink(backend, sink);

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable output
  console.log(`Sink: ${sink.raw}`);
  console.log(`Resolved to ${result.statistics.callSites} call site(s)`);
  console.log('');

  if (result.possibleValues.length === 0) {
    if (result.statistics.unknownElements) {
      console.log('Possible values: <unknown> (runtime/parameter values)');
    } else {
      console.log('No values found');
    }
    return;
  }

  console.log('Possible values:');
  for (const pv of result.possibleValues) {
    const sourcesCount = pv.sources.length;
    console.log(`  - ${JSON.stringify(pv.value)} (${sourcesCount} source${sourcesCount === 1 ? '' : 's'})`);
    for (const src of pv.sources.slice(0, 3)) {
      const relativePath = src.file.startsWith(projectPath)
        ? src.file.substring(projectPath.length + 1)
        : src.file;
      console.log(`    <- ${relativePath}:${src.line}`);
    }
    if (pv.sources.length > 3) {
      console.log(`    ... and ${pv.sources.length - 3} more`);
    }
  }

  if (result.statistics.unknownElements) {
    console.log('');
    console.log('Note: Some values could not be determined (runtime/parameter inputs)');
  }
}

