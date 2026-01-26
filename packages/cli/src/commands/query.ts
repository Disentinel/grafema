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
import { formatNodeDisplay, formatNodeInline, formatLocation } from '../utils/formatNode.js';
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
  method?: string;  // For http:route, http:request
  path?: string;    // For http:route
  url?: string;     // For http:request
  event?: string;   // For socketio:emit, socketio:on, socketio:event
  room?: string;    // For socketio:emit
  namespace?: string; // For socketio:emit
  broadcast?: boolean; // For socketio:emit
  objectName?: string; // For socketio:emit, socketio:on
  handlerName?: string; // For socketio:on
  [key: string]: unknown;
}

export const queryCommand = new Command('query')
  .description('Search the code graph')
  .argument('<pattern>', 'Search pattern: "function X", "class Y", or just "X"')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-l, --limit <n>', 'Limit results', '10')
  .option(
    '--raw',
    `Execute raw Datalog query

Predicates:
  type(Id, Type)        Find nodes by type or get type of node
  node(Id, Type)        Alias for type
  edge(Src, Dst, Type)  Find edges between nodes
  attr(Id, Name, Value) Access node attributes (name, file, line, etc.)
  path(Src, Dst)        Check reachability between nodes
  incoming(Dst, Src, T) Find incoming edges

Examples:
  grafema query --raw 'type(X, "FUNCTION")'
  grafema query --raw 'type(X, "FUNCTION"), attr(X, "name", "main")'
  grafema query --raw 'edge(X, Y, "CALLS")'`
  )
  .addHelpText('after', `
Examples:
  grafema query "auth"                 Search by name (partial match)
  grafema query "function login"       Search functions only
  grafema query "class UserService"    Search classes only
  grafema query "route /api/users"     Search HTTP routes by path
  grafema query "request /api"         Search HTTP requests (fetch/axios) by URL
  grafema query "POST /users"          Search routes by method + path
  grafema query -l 20 "fetch"          Return up to 20 results
  grafema query --json "config"        Output results as JSON
  grafema query --raw 'type(X, "FUNCTION")'   Raw Datalog query
`)
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
        await displayNode(node, projectPath, backend);

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
      // HTTP route aliases
      route: 'http:route',
      endpoint: 'http:route',
      // HTTP request aliases
      request: 'http:request',
      fetch: 'http:request',
      api: 'http:request',
      // Socket.IO aliases
      event: 'socketio:event',
      emit: 'socketio:emit',
      on: 'socketio:on',
      listener: 'socketio:on',
    };

    if (typeMap[typeWord]) {
      return { type: typeMap[typeWord], name };
    }
  }

  return { type: null, name: pattern.trim() };
}

/**
 * Check if a node matches the search pattern based on its type.
 *
 * Different node types have different searchable fields:
 * - http:route: search method and path fields
 * - http:request: search method and url fields
 * - socketio:event: search name field (standard)
 * - socketio:emit/on: search event field
 * - Default: search name field
 */
function matchesSearchPattern(
  node: {
    name?: string;
    method?: string;
    path?: string;
    url?: string;
    event?: string;
    [key: string]: unknown
  },
  nodeType: string,
  pattern: string
): boolean {
  const lowerPattern = pattern.toLowerCase();

  // HTTP routes: search method and path
  if (nodeType === 'http:route') {
    const method = (node.method || '').toLowerCase();
    const path = (node.path || '').toLowerCase();

    // Pattern could be: "POST", "/api/users", "POST /api", etc.
    const patternParts = pattern.trim().split(/\s+/);

    if (patternParts.length === 1) {
      // Single term: match method OR path
      const term = patternParts[0].toLowerCase();
      return method === term || path.includes(term);
    } else {
      // Multiple terms: first is method, rest is path pattern
      const methodPattern = patternParts[0].toLowerCase();
      const pathPattern = patternParts.slice(1).join(' ').toLowerCase();

      // Method must match exactly (GET, POST, etc.)
      const methodMatches = method === methodPattern;
      // Path must contain the pattern
      const pathMatches = path.includes(pathPattern);

      return methodMatches && pathMatches;
    }
  }

  // HTTP requests: search method and url
  if (nodeType === 'http:request') {
    const method = (node.method || '').toLowerCase();
    const url = (node.url || '').toLowerCase();

    // Pattern could be: "POST", "/api/users", "POST /api", etc.
    const patternParts = pattern.trim().split(/\s+/);

    if (patternParts.length === 1) {
      // Single term: match method OR url
      const term = patternParts[0].toLowerCase();
      return method === term || url.includes(term);
    } else {
      // Multiple terms: first is method, rest is url pattern
      const methodPattern = patternParts[0].toLowerCase();
      const urlPattern = patternParts.slice(1).join(' ').toLowerCase();

      // Method must match exactly (GET, POST, etc.)
      const methodMatches = method === methodPattern;
      // URL must contain the pattern
      const urlMatches = url.includes(urlPattern);

      return methodMatches && urlMatches;
    }
  }

  // Socket.IO event channels: search name field (standard)
  if (nodeType === 'socketio:event') {
    const nodeName = (node.name || '').toLowerCase();
    return nodeName.includes(lowerPattern);
  }

  // Socket.IO emit/on: search event field
  if (nodeType === 'socketio:emit' || nodeType === 'socketio:on') {
    const eventName = (node.event || '').toLowerCase();
    return eventName.includes(lowerPattern);
  }

  // Default: search name field
  const nodeName = (node.name || '').toLowerCase();
  return nodeName.includes(lowerPattern);
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
    : [
        'FUNCTION',
        'CLASS',
        'MODULE',
        'VARIABLE',
        'CONSTANT',
        'http:route',
        'http:request',
        'socketio:event',
        'socketio:emit',
        'socketio:on'
      ];

  for (const nodeType of searchTypes) {
    for await (const node of backend.queryNodes({ nodeType: nodeType as any })) {
      // Type-aware field matching
      const matches = matchesSearchPattern(node, nodeType, name);

      if (matches) {
        const nodeInfo: NodeInfo = {
          id: node.id,
          type: node.type || nodeType,
          name: node.name || '',
          file: node.file || '',
          line: node.line,
        };

        // Include method and path for http:route nodes
        if (nodeType === 'http:route') {
          nodeInfo.method = node.method as string | undefined;
          nodeInfo.path = node.path as string | undefined;
        }

        // Include method and url for http:request nodes
        if (nodeType === 'http:request') {
          nodeInfo.method = node.method as string | undefined;
          nodeInfo.url = node.url as string | undefined;
        }

        // Include event field for Socket.IO nodes
        if (nodeType === 'socketio:event' || nodeType === 'socketio:emit' || nodeType === 'socketio:on') {
          nodeInfo.event = node.event as string | undefined;
        }

        // Include emit-specific fields
        if (nodeType === 'socketio:emit') {
          nodeInfo.room = node.room as string | undefined;
          nodeInfo.namespace = node.namespace as string | undefined;
          nodeInfo.broadcast = node.broadcast as boolean | undefined;
          nodeInfo.objectName = node.objectName as string | undefined;
        }

        // Include listener-specific fields
        if (nodeType === 'socketio:on') {
          nodeInfo.objectName = node.objectName as string | undefined;
          nodeInfo.handlerName = node.handlerName as string | undefined;
        }

        results.push(nodeInfo);
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
  } catch (error) {
    if (process.env.DEBUG) {
      console.error('[query] Error in getCallers:', error);
    }
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
        // Only follow structural edges
        if (!['CONTAINS', 'HAS_SCOPE', 'DECLARES'].includes(edge.type)) continue;

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
    } catch (error) {
      if (process.env.DEBUG) {
        console.error('[query] Error in findContainingFunction:', error);
      }
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
  } catch (error) {
    if (process.env.DEBUG) {
      console.error('[query] Error in getCallees:', error);
    }
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
    } catch (error) {
      if (process.env.DEBUG) {
        console.error('[query] Error in findCallsInFunction:', error);
      }
    }
  }

  return calls;
}

/**
 * Display a node with semantic ID as primary identifier
 */
async function displayNode(node: NodeInfo, projectPath: string, backend: RFDBServerBackend): Promise<void> {
  // Special formatting for HTTP routes
  if (node.type === 'http:route' && node.method && node.path) {
    console.log(formatHttpRouteDisplay(node, projectPath));
    return;
  }

  // Special formatting for HTTP requests
  if (node.type === 'http:request') {
    console.log(formatHttpRequestDisplay(node, projectPath));
    return;
  }

  // Special formatting for Socket.IO event channels
  if (node.type === 'socketio:event') {
    console.log(await formatSocketEventDisplay(node, projectPath, backend));
    return;
  }

  // Special formatting for Socket.IO emit/on
  if (node.type === 'socketio:emit' || node.type === 'socketio:on') {
    console.log(formatSocketIONodeDisplay(node, projectPath));
    return;
  }

  console.log(formatNodeDisplay(node, { projectPath }));
}

/**
 * Format HTTP route for display
 *
 * Output:
 *   [http:route] POST /api/users
 *     Location: src/routes/users.js:15
 */
function formatHttpRouteDisplay(node: NodeInfo, projectPath: string): string {
  const lines: string[] = [];

  // Line 1: [type] METHOD PATH
  lines.push(`[${node.type}] ${node.method} ${node.path}`);

  // Line 2: Location
  if (node.file) {
    const relPath = relative(projectPath, node.file);
    const loc = node.line ? `${relPath}:${node.line}` : relPath;
    lines.push(`  Location: ${loc}`);
  }

  return lines.join('\n');
}

/**
 * Format HTTP request for display
 *
 * Output:
 *   [http:request] GET /api/users
 *     Location: src/pages/Users.tsx:42
 */
function formatHttpRequestDisplay(node: NodeInfo, projectPath: string): string {
  const lines: string[] = [];

  // Line 1: [type] METHOD URL
  const method = node.method || 'GET';
  const url = node.url || 'dynamic';
  lines.push(`[${node.type}] ${method} ${url}`);

  // Line 2: Location
  if (node.file) {
    const relPath = relative(projectPath, node.file);
    const loc = node.line ? `${relPath}:${node.line}` : relPath;
    lines.push(`  Location: ${loc}`);
  }

  return lines.join('\n');
}

/**
 * Format Socket.IO event channel for display
 *
 * Output:
 *   [socketio:event] slot:booked
 *     ID: socketio:event#slot:booked
 *     Emitted by: 3 locations
 *     Listened by: 5 locations
 */
async function formatSocketEventDisplay(
  node: NodeInfo,
  projectPath: string,
  backend: RFDBServerBackend
): Promise<string> {
  const lines: string[] = [];

  // Line 1: [type] event_name
  lines.push(`[${node.type}] ${node.name}`);

  // Line 2: ID
  lines.push(`  ID: ${node.id}`);

  // Query edges to get emitter and listener counts
  try {
    const incomingEdges = await backend.getIncomingEdges(node.id, ['EMITS_EVENT']);
    const outgoingEdges = await backend.getOutgoingEdges(node.id, ['LISTENED_BY']);

    if (incomingEdges.length > 0) {
      lines.push(`  Emitted by: ${incomingEdges.length} location${incomingEdges.length !== 1 ? 's' : ''}`);
    }

    if (outgoingEdges.length > 0) {
      lines.push(`  Listened by: ${outgoingEdges.length} location${outgoingEdges.length !== 1 ? 's' : ''}`);
    }
  } catch (error) {
    if (process.env.DEBUG) {
      console.error('[query] Error in formatSocketEventDisplay:', error);
    }
  }

  return lines.join('\n');
}

/**
 * Format Socket.IO emit/on for display
 *
 * Output for emit:
 *   [socketio:emit] slot:booked
 *     ID: socketio:emit#slot:booked#server.js#28
 *     Location: server.js:28
 *     Room: gig:123 (if applicable)
 *     Namespace: /admin (if applicable)
 *     Broadcast: true (if applicable)
 *
 * Output for on:
 *   [socketio:on] slot:booked
 *     ID: socketio:on#slot:booked#client.js#13
 *     Location: client.js:13
 *     Handler: anonymous:27
 */
function formatSocketIONodeDisplay(node: NodeInfo, projectPath: string): string {
  const lines: string[] = [];

  // Line 1: [type] event_name
  const eventName = node.event || node.name || 'unknown';
  lines.push(`[${node.type}] ${eventName}`);

  // Line 2: ID
  lines.push(`  ID: ${node.id}`);

  // Line 3: Location (if applicable)
  if (node.file) {
    const loc = formatLocation(node.file, node.line, projectPath);
    if (loc) {
      lines.push(`  Location: ${loc}`);
    }
  }

  // Emit-specific fields
  if (node.type === 'socketio:emit') {
    if (node.room) {
      lines.push(`  Room: ${node.room}`);
    }
    if (node.namespace) {
      lines.push(`  Namespace: ${node.namespace}`);
    }
    if (node.broadcast) {
      lines.push(`  Broadcast: true`);
    }
  }

  // Listener-specific fields
  if (node.type === 'socketio:on' && node.handlerName) {
    lines.push(`  Handler: ${node.handlerName}`);
  }

  return lines.join('\n');
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
