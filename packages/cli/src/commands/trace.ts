/**
 * Trace command - Data flow analysis
 *
 * Usage:
 *   grafema trace "userId from authenticate"
 *   grafema trace "config"
 *   grafema trace --to "addNode#0.type"  (sink-based trace)
 */

import { Command } from 'commander';
import { isAbsolute, resolve, join } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend, parseSemanticId, parseSemanticIdV2, traceValues, type ValueSource } from '@grafema/core';
import { formatNodeDisplay, formatNodeInline } from '../utils/formatNode.js';
import { exitWithError } from '../utils/errorFormatter.js';

interface TraceOptions {
  project: string;
  json?: boolean;
  depth: string;
  to?: string;
  fromRoute?: string;
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
  .option('-r, --from-route <pattern>', 'Trace from route response (e.g., "GET /status" or "/status")')
  .addHelpText('after', `
Examples:
  grafema trace "userId"                     Trace all variables named "userId"
  grafema trace "userId from authenticate"   Trace userId within authenticate function
  grafema trace "config" --depth 5           Limit trace depth to 5 levels
  grafema trace "apiKey" --json              Output trace as JSON
  grafema trace --to "addNode#0.type"        Trace values reaching sink point
  grafema trace --from-route "GET /status"   Trace values from route response
  grafema trace -r "/status"                 Trace by path only
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

      // Handle route-based trace if --from-route option is provided
      if (options.fromRoute) {
        const maxDepth = parseInt(options.depth, 10);
        await handleRouteTrace(backend, options.fromRoute, projectPath, options.json, maxDepth);
        return;
      }

      // Regular trace requires pattern
      if (!pattern) {
        exitWithError('Pattern required', ['Provide a pattern, use --to for sink trace, or --from-route for route trace']);
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
          // Try v2 parsing first
          const parsedV2 = parseSemanticIdV2(node.id);
          if (parsedV2) {
            if (!parsedV2.namedParent || parsedV2.namedParent.toLowerCase() !== lowerScopeName) {
              continue;
            }
          } else {
            // Fallback to v1 parsing
            const parsed = parseSemanticId(node.id);
            if (!parsed) continue; // Skip nodes with invalid IDs

            // Check if scopeName appears anywhere in the scope chain
            if (!parsed.scopePath.some(s => s.toLowerCase() === lowerScopeName)) {
              continue;
            }
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
 * Trace a node to its literal values.
 * Uses shared traceValues utility from @grafema/core (REG-244).
 *
 * @param backend - RFDBServerBackend for graph queries
 * @param nodeId - Starting node ID
 * @param _visited - Kept for API compatibility (internal cycle detection in shared utility)
 * @param maxDepth - Maximum traversal depth
 * @returns Array of traced values with sources
 */
async function traceToLiterals(
  backend: RFDBServerBackend,
  nodeId: string,
  _visited: Set<string> = new Set(),
  maxDepth: number = 10
): Promise<{ value: unknown; source: ValueSource; isUnknown: boolean }[]> {
  // RFDBServerBackend implements TraceValuesGraphBackend interface
  const traced = await traceValues(backend, nodeId, {
    maxDepth,
    followDerivesFrom: true,
    detectNondeterministic: true,
  });

  // Map to expected format (strip reason field)
  return traced.map(t => ({
    value: t.value,
    source: t.source,
    isUnknown: t.isUnknown,
  }));
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
      const relativePath = isAbsolute(src.file)
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

// =============================================================================
// ROUTE-BASED TRACE IMPLEMENTATION (REG-326)
// =============================================================================

/**
 * Find route by pattern.
 *
 * Supports:
 * - "METHOD /path" format (e.g., "GET /status")
 * - "/path" format (e.g., "/status")
 *
 * Matching strategy:
 * 1. Try exact "METHOD PATH" match
 * 2. Try "/PATH" only match (any method)
 *
 * @param backend - Graph backend
 * @param pattern - Route pattern (with or without method)
 * @returns Route node or null if not found
 */
async function findRouteByPattern(
  backend: RFDBServerBackend,
  pattern: string
): Promise<NodeInfo | null> {
  const trimmed = pattern.trim();

  for await (const node of backend.queryNodes({ type: 'http:route' })) {
    const method = (node as NodeInfo & { method?: string }).method || '';
    const path = (node as NodeInfo & { path?: string }).path || '';

    // Match "METHOD /path"
    if (`${method} ${path}` === trimmed) {
      return {
        id: node.id,
        type: node.type || 'http:route',
        name: `${method} ${path}`,
        file: node.file || '',
        line: node.line
      };
    }

    // Match "/path" only (ignore method)
    if (path === trimmed) {
      return {
        id: node.id,
        type: node.type || 'http:route',
        name: `${method} ${path}`,
        file: node.file || '',
        line: node.line
      };
    }
  }

  return null;
}

/**
 * Handle route-based trace (--from-route option).
 *
 * Flow:
 * 1. Find route by pattern
 * 2. Get RESPONDS_WITH edges from route
 * 3. For each response node: call traceValues()
 * 4. Format and display results grouped by response call
 *
 * @param backend - Graph backend
 * @param pattern - Route pattern (e.g., "GET /status" or "/status")
 * @param projectPath - Project root path
 * @param jsonOutput - Whether to output as JSON
 * @param maxDepth - Maximum trace depth (default 10)
 */
async function handleRouteTrace(
  backend: RFDBServerBackend,
  pattern: string,
  projectPath: string,
  jsonOutput?: boolean,
  maxDepth: number = 10
): Promise<void> {
  // Find route
  const route = await findRouteByPattern(backend, pattern);

  if (!route) {
    console.log(`Route not found: ${pattern}`);
    console.log('');
    console.log('Hint: Use "grafema query" to list available routes');
    return;
  }

  // Get RESPONDS_WITH edges
  const respondsWithEdges = await backend.getOutgoingEdges(route.id, ['RESPONDS_WITH']);

  if (respondsWithEdges.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({
        route: {
          name: route.name,
          file: route.file,
          line: route.line
        },
        responses: [],
        message: 'No response data found'
      }, null, 2));
    } else {
      console.log(`Route: ${route.name} (${route.file}:${route.line || '?'})`);
      console.log('');
      console.log('No response data found for this route.');
      console.log('');
      console.log('Hint: Make sure ExpressResponseAnalyzer is in your config.');
    }
    return;
  }

  // Build response data
  const responses: Array<{
    index: number;
    method: string;
    line: number;
    sources: Array<{
      type: string;
      value?: unknown;
      reason?: string;
      file: string;
      line: number;
      id: string;
      name?: string;
    }>;
  }> = [];

  // Trace each response
  for (let i = 0; i < respondsWithEdges.length; i++) {
    const edge = respondsWithEdges[i];
    const responseNode = await backend.getNode(edge.dst);

    if (!responseNode) continue;

    const responseMethod = (edge.metadata?.responseMethod as string) || 'unknown';

    // Trace values from this response node
    const traced = await traceValues(backend, responseNode.id, {
      maxDepth,
      followDerivesFrom: true,
      detectNondeterministic: true
    });

    // Format traced values
    const sources = await Promise.all(
      traced.map(async (t) => {
        const relativePath = isAbsolute(t.source.file)
          ? t.source.file.substring(projectPath.length + 1)
          : t.source.file;

        if (t.isUnknown) {
          return {
            type: 'UNKNOWN',
            reason: t.reason || 'runtime input',
            file: relativePath,
            line: t.source.line,
            id: t.source.id
          };
        } else if (t.value !== undefined) {
          return {
            type: 'LITERAL',
            value: t.value,
            file: relativePath,
            line: t.source.line,
            id: t.source.id
          };
        } else {
          // Look up node to get type and name
          const sourceNode = await backend.getNode(t.source.id);
          return {
            type: sourceNode?.type || 'VALUE',
            name: sourceNode?.name || '<unnamed>',
            file: relativePath,
            line: t.source.line,
            id: t.source.id
          };
        }
      })
    );

    responses.push({
      index: i + 1,
      method: responseMethod,
      line: responseNode.line || 0,
      sources: sources.length > 0 ? sources : []
    });

    if (!jsonOutput) {
      // Display human-readable output
      console.log(`Response ${i + 1} (res.${responseMethod} at line ${responseNode.line || '?'}):`);
      if (sources.length === 0) {
        console.log('  No data sources found (response may be external or complex)');
      } else {
        console.log('  Data sources:');
        for (const src of sources) {
          if (src.type === 'UNKNOWN') {
            console.log(`    [UNKNOWN] ${src.reason} at ${src.file}:${src.line}`);
          } else if (src.type === 'LITERAL') {
            console.log(`    [LITERAL] ${JSON.stringify(src.value)} at ${src.file}:${src.line}`);
          } else {
            console.log(`    [${src.type}] ${src.name} at ${src.file}:${src.line}`);
          }
        }
      }
      console.log('');
    }
  }

  // Output results
  if (jsonOutput) {
    console.log(JSON.stringify({
      route: {
        name: route.name,
        file: route.file,
        line: route.line
      },
      responses
    }, null, 2));
  } else {
    // Human-readable output header
    if (responses.length > 0 && !jsonOutput) {
      // Already printed above, just for clarity
    }
  }
}

