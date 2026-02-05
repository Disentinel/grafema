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
import { resolve, join, relative, basename } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend, parseSemanticId, findCallsInFunction as findCallsInFunctionCore, findContainingFunction as findContainingFunctionCore } from '@grafema/core';
import { formatNodeDisplay, formatNodeInline, formatLocation } from '../utils/formatNode.js';
import { exitWithError } from '../utils/errorFormatter.js';
import { Spinner } from '../utils/spinner.js';

interface QueryOptions {
  project: string;
  json?: boolean;
  limit: string;
  raw?: boolean;
  type?: string;  // Explicit node type (bypasses type aliases)
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
  /** Human-readable scope context */
  scopeContext?: string | null;
  [key: string]: unknown;
}

/**
 * Parsed query with optional scope constraints.
 *
 * Supports patterns like:
 *   "response" -> { name: "response" }
 *   "variable response" -> { type: "VARIABLE", name: "response" }
 *   "response in fetchData" -> { name: "response", scopes: ["fetchData"] }
 *   "response in src/app.ts" -> { name: "response", file: "src/app.ts" }
 *   "response in catch in fetchData" -> { name: "response", scopes: ["fetchData", "catch"] }
 */
export interface ParsedQuery {
  /** Node type (e.g., "FUNCTION", "VARIABLE") or null for any */
  type: string | null;
  /** Node name to search (partial match) */
  name: string;
  /** File scope - filter to nodes in this file */
  file: string | null;
  /** Scope chain - filter to nodes inside these scopes (function/class/block names) */
  scopes: string[];
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
  .option(
    '-t, --type <nodeType>',
    `Filter by exact node type (bypasses type aliases)

Use this when:
- Searching custom node types (jsx:component, redis:cache)
- You need exact type match without alias resolution
- Discovering nodes from plugins or custom analyzers

Examples:
  grafema query --type http:request "/api"
  grafema query --type FUNCTION "auth"
  grafema query -t socketio:event "connect"`
  )
  .addHelpText('after', `
Examples:
  grafema query "auth"                         Search by name (partial match)
  grafema query "function login"               Search functions only
  grafema query "class UserService"            Search classes only
  grafema query "route /api/users"             Search HTTP routes by path
  grafema query "response in fetchData"        Search in specific function scope
  grafema query "error in catch in fetchData"  Search in nested scopes
  grafema query "token in src/auth.ts"         Search in specific file
  grafema query "variable x in foo in app.ts"  Combine type, name, and scopes
  grafema query -l 20 "fetch"                  Return up to 20 results
  grafema query --json "config"                Output results as JSON
  grafema query --type FUNCTION "auth"         Explicit type (no alias resolution)
  grafema query -t http:request "/api"         Search custom node types
  grafema query --raw 'type(X, "FUNCTION")'    Raw Datalog query
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

    const spinner = new Spinner('Querying graph...');
    spinner.start();

    try {
      // Raw Datalog mode
      if (options.raw) {
        spinner.stop();
        await executeRawQuery(backend, pattern, options);
        return;
      }

      const limit = parseInt(options.limit, 10);

      // Parse query with scope support
      let query: ParsedQuery;

      if (options.type) {
        // Explicit --type bypasses pattern parsing for type
        // But we still parse for scope support
        const scopeParsed = parseQuery(pattern);
        query = {
          type: options.type,
          name: scopeParsed.name,
          file: scopeParsed.file,
          scopes: scopeParsed.scopes,
        };
      } else {
        query = parseQuery(pattern);
      }

      // Find matching nodes
      const nodes = await findNodes(backend, query, limit);

      spinner.stop();

      // Check if query has scope constraints for suggestion
      const hasScope = query.file !== null || query.scopes.length > 0;

      if (nodes.length === 0) {
        console.log(`No results for "${pattern}"`);
        if (hasScope) {
          console.log(`  Try: grafema query "${query.name}" (search all scopes)`);
        } else if (query.type) {
          console.log(`  Try: grafema query "${query.name}" (search all types)`);
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
      spinner.stop();
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
 * Parse search pattern with scope support.
 *
 * Grammar:
 *   query := [type] name [" in " scope]*
 *   type  := "function" | "class" | "variable" | etc.
 *   scope := <filename> | <functionName>
 *
 * File scope detection: contains "/" or ends with .ts/.js/.tsx/.jsx
 * Function scope detection: anything else
 *
 * IMPORTANT: Only split on " in " (space-padded) to avoid matching names like "signin"
 *
 * Examples:
 *   "response" -> { type: null, name: "response", file: null, scopes: [] }
 *   "variable response in fetchData" -> { type: "VARIABLE", name: "response", file: null, scopes: ["fetchData"] }
 *   "response in src/app.ts" -> { type: null, name: "response", file: "src/app.ts", scopes: [] }
 *   "error in catch in fetchData in src/app.ts" -> { type: null, name: "error", file: "src/app.ts", scopes: ["fetchData", "catch"] }
 */
export function parseQuery(pattern: string): ParsedQuery {
  // Split on " in " (space-padded) to get clauses
  const clauses = pattern.split(/ in /);

  // First clause is [type] name - use existing parsePattern logic
  const firstClause = clauses[0];
  const { type, name } = parsePattern(firstClause);

  // Remaining clauses are scopes
  let file: string | null = null;
  const scopes: string[] = [];

  for (let i = 1; i < clauses.length; i++) {
    const scope = clauses[i].trim();
    if (scope === '') continue; // Skip empty clauses from trailing whitespace
    if (isFileScope(scope)) {
      file = scope;
    } else {
      scopes.push(scope);
    }
  }

  return { type, name, file, scopes };
}

/**
 * Detect if a scope string looks like a file path.
 *
 * Heuristics:
 * - Contains "/" -> file path
 * - Ends with .ts, .js, .tsx, .jsx, .mjs, .cjs -> file path
 *
 * Examples:
 *   "src/app.ts" -> true
 *   "app.js" -> true
 *   "fetchData" -> false
 *   "UserService" -> false
 *   "catch" -> false
 */
export function isFileScope(scope: string): boolean {
  // Contains path separator
  if (scope.includes('/')) return true;

  // Ends with common JS/TS extensions
  const fileExtensions = /\.(ts|js|tsx|jsx|mjs|cjs)$/i;
  if (fileExtensions.test(scope)) return true;

  return false;
}

/**
 * Check if a semantic ID matches the given scope constraints.
 *
 * Uses parseSemanticId from @grafema/core for robust ID parsing.
 *
 * Scope matching rules:
 * - File scope: semantic ID must match the file path (full or basename)
 * - Function/class scope: semantic ID must contain the scope in its scopePath
 * - Multiple scopes: ALL must match (AND logic)
 * - Scope order: independent - all scopes just need to be present
 *
 * Examples:
 *   ID: "src/app.ts->fetchData->try#0->VARIABLE->response"
 *   Matches: scopes=["fetchData"] -> true
 *   Matches: scopes=["try"] -> true (matches "try#0")
 *   Matches: scopes=["fetchData", "try"] -> true (both present)
 *   Matches: scopes=["processData"] -> false (not in ID)
 *
 * @param semanticId - The full semantic ID to check
 * @param file - File scope (null for any file)
 * @param scopes - Array of scope names to match
 * @returns true if ID matches all constraints
 */
export function matchesScope(semanticId: string, file: string | null, scopes: string[]): boolean {
  const parsed = parseSemanticId(semanticId);
  if (!parsed) return false;

  // File scope check
  if (file !== null) {
    // Full path match
    if (parsed.file === file) {
      // Exact match - OK
    }
    // Basename match: "app.ts" matches "src/app.ts"
    else if (parsed.file.endsWith('/' + file)) {
      // Partial path match - OK
    }
    // Also try if parsed.file ends with the file name (e.g., file is basename)
    else if (basename(parsed.file) === file) {
      // Basename exact match - OK
    }
    else {
      return false;
    }
  }

  // Function/class/block scope check
  for (const scope of scopes) {
    // Check if scope appears in the scopePath
    // Handle numbered scopes: "try" matches "try#0"
    const matches = parsed.scopePath.some(s =>
      s === scope || s.startsWith(scope + '#')
    );
    if (!matches) return false;
  }

  return true;
}

/**
 * Extract human-readable scope context from a semantic ID.
 *
 * Parses the ID and returns a description of the scope chain.
 *
 * Examples:
 *   "src/app.ts->fetchData->try#0->VARIABLE->response"
 *   -> "inside fetchData, inside try block"
 *
 *   "src/app.ts->UserService->login->VARIABLE->token"
 *   -> "inside UserService, inside login"
 *
 *   "src/app.ts->global->FUNCTION->main"
 *   -> null (no interesting scope)
 *
 * @param semanticId - The semantic ID to parse
 * @returns Human-readable scope context or null
 */
export function extractScopeContext(semanticId: string): string | null {
  const parsed = parseSemanticId(semanticId);
  if (!parsed) return null;

  // Filter out "global" and format remaining scopes
  const meaningfulScopes = parsed.scopePath.filter(s => s !== 'global');
  if (meaningfulScopes.length === 0) return null;

  // Format each scope with context
  const formatted = meaningfulScopes.map(scope => {
    // Handle numbered scopes: "try#0" -> "try block"
    if (scope.match(/^try#\d+$/)) return 'try block';
    if (scope.match(/^catch#\d+$/)) return 'catch block';
    if (scope.match(/^if#\d+$/)) return 'conditional';
    if (scope.match(/^else#\d+$/)) return 'else block';
    if (scope.match(/^for#\d+$/)) return 'loop';
    if (scope.match(/^while#\d+$/)) return 'loop';
    if (scope.match(/^switch#\d+$/)) return 'switch';

    // Regular scope: function or class name
    return scope;
  });

  // Build "inside X, inside Y" string
  return 'inside ' + formatted.join(', inside ');
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
 * Find nodes by query (type, name, file scope, function scopes)
 */
async function findNodes(
  backend: RFDBServerBackend,
  query: ParsedQuery,
  limit: number
): Promise<NodeInfo[]> {
  const results: NodeInfo[] = [];
  const searchTypes = query.type
    ? [query.type]
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
      // Type-aware field matching (name)
      const nameMatches = matchesSearchPattern(node, nodeType, query.name);
      if (!nameMatches) continue;

      // Scope matching (file and function scopes)
      const scopeMatches = matchesScope(node.id, query.file, query.scopes);
      if (!scopeMatches) continue;

      const nodeInfo: NodeInfo = {
        id: node.id,
        type: node.type || nodeType,
        name: node.name || '',
        file: node.file || '',
        line: node.line,
      };

      // Add scope context for display
      nodeInfo.scopeContext = extractScopeContext(node.id);

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

      // Find the FUNCTION that contains this CALL (use shared utility from @grafema/core)
      const containingFunc = await findContainingFunctionCore(backend, callNode.id);

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
 * Get functions that this node calls
 *
 * Uses shared utility from @grafema/core which:
 * - Follows HAS_SCOPE -> SCOPE -> CONTAINS pattern correctly
 * - Finds both CALL and METHOD_CALL nodes
 * - Only returns resolved calls (those with CALLS edges to targets)
 */
async function getCallees(
  backend: RFDBServerBackend,
  nodeId: string,
  limit: number
): Promise<NodeInfo[]> {
  const callees: NodeInfo[] = [];
  const seen = new Set<string>();

  try {
    // Use shared utility (now includes METHOD_CALL and correct graph traversal)
    const calls = await findCallsInFunctionCore(backend, nodeId);

    for (const call of calls) {
      if (callees.length >= limit) break;

      // Only include resolved calls with targets
      if (call.resolved && call.target && !seen.has(call.target.id)) {
        seen.add(call.target.id);
        callees.push({
          id: call.target.id,
          type: 'FUNCTION',
          name: call.target.name || '<anonymous>',
          file: call.target.file || '',
          line: call.target.line,
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

  // Add scope context if present
  if (node.scopeContext) {
    console.log(`  Scope: ${node.scopeContext}`);
  }
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
