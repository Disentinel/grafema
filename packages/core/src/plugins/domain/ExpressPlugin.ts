/**
 * ExpressPlugin — domain plugin for Express.js route detection.
 *
 * Detects:
 *   app.get('/path', handler)        -> http:route node
 *   app.post('/path', handler)       -> http:route node
 *   app.put('/path', handler)        -> http:route node
 *   app.delete('/path', handler)     -> http:route node
 *   app.patch('/path', handler)      -> http:route node
 *   app.options('/path', handler)    -> http:route node
 *   app.head('/path', handler)       -> http:route node
 *   app.all('/path', handler)        -> http:route node (method: 'ALL')
 *   router.get('/path', handler)     -> http:route node (same as app.*)
 *   app.use('/prefix', router)       -> express:mount node
 *   app.use(middleware)              -> express:mount node (prefix: '/')
 *
 * Does NOT detect:
 *   app.route('/path').get(handler)  -> needs AST escape hatch (out of scope)
 *
 * Prerequisites: uses data flow analysis to find variables assigned from
 * express() or express.Router(). No heuristic name-based matching.
 */

import type { DomainPlugin, DomainPluginResult, FileResult, GraphNode, GraphEdge } from '@grafema/core-v2';
import type { File } from '@babel/types';

// HTTP methods recognized as route registration methods.
// 'all' maps to method 'ALL' in node metadata.
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all']);

export class ExpressPlugin implements DomainPlugin {
  readonly name = 'express';

  analyzeFile(fileResult: Readonly<FileResult>, _ast: File): DomainPluginResult {
    // Guard: only process files where variables are assigned from express() or express.Router().
    // With the dataflow approach, if no variables are assigned from express(), expressVarNames
    // will be empty and we return early.
    const expressVarNames = this._findExpressVarNames(fileResult);
    if (expressVarNames.size === 0) {
      return { nodes: [], edges: [] };
    }

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // Find the MODULE node for EXPOSES/MOUNTS edges.
    const moduleNode = fileResult.nodes.find(n => n.type === 'MODULE');

    for (const node of fileResult.nodes) {
      if (node.type !== 'CALL') continue;

      const meta = node.metadata;
      if (!meta) continue;

      const obj = meta.object as string | undefined;
      const method = meta.method as string | undefined;
      const argValues = meta.argValues as (string | null)[] | undefined;

      if (!obj || !method) continue;

      // Data-flow check: only process calls on variables we know hold Express instances.
      if (!expressVarNames.has(obj)) continue;

      if (HTTP_METHODS.has(method)) {
        // Route registration: app.get('/path', handler)
        // Require at least one argument AND argValues[0] is a string.
        if (!argValues || argValues.length < 1 || argValues[0] === null) continue;

        const path = argValues[0];
        const httpMethod = method === 'all' ? 'ALL' : method.toUpperCase();
        const routeNode = this._createHttpRouteNode(node, httpMethod, path);
        nodes.push(routeNode);

        if (moduleNode) {
          edges.push({
            src: moduleNode.id,
            dst: routeNode.id,
            type: 'EXPOSES',
          });
        }
      } else if (method === 'use') {
        // Router mounting: app.use('/prefix', router) or app.use(middleware)
        this._processMountPoint(node, argValues ?? [], moduleNode ?? null, nodes, edges);
      }
    }

    return { nodes, edges };
  }

  /**
   * Scan FileResult to find all variable names that hold Express app or router instances.
   *
   * Algorithm:
   *   For each VARIABLE node in the file:
   *     Follow all ASSIGNED_FROM edges from that VARIABLE.
   *     If the edge destination is a CALL node with:
   *       name === 'express'            -> variable holds an Express app
   *       name === 'express.Router'     -> variable holds an Express router
   *     Then add the VARIABLE's name to the result set.
   *
   *   For alias chains (const server = app):
   *     If ASSIGNED_FROM destination is a VARIABLE that is already in the result set,
   *     add the current VARIABLE's name to the result set.
   *     Repeat until no new names are added (BFS convergence).
   *
   * NOTE: Only VariableDeclarator init assignments are detected (const/let x = express()).
   * Separate assignment expressions (let x; x = express()) are NOT detected because
   * AssignmentExpression creates an EXPRESSION node, not a VARIABLE->ASSIGNED_FROM->CALL edge.
   * This is an accepted limitation of the ASSIGNED_FROM traversal. The pattern `const app = express()`
   * covers 95%+ of real Express code and is the recommended style.
   *
   * @returns Map from variable name to 'app' | 'router'
   */
  private _findExpressVarNames(fileResult: Readonly<FileResult>): Map<string, 'app' | 'router'> {
    const { nodes, edges } = fileResult;

    // Build lookup maps for O(1) access
    const nodeById = new Map<string, GraphNode>(nodes.map(n => [n.id, n]));

    // Index edges by src for fast forward traversal
    const edgesBySrc = new Map<string, GraphEdge[]>();
    for (const e of edges) {
      const list = edgesBySrc.get(e.src) ?? [];
      list.push(e);
      edgesBySrc.set(e.src, list);
    }

    // Phase 1: single-hop detection — VARIABLE --ASSIGNED_FROM--> CALL('express' | 'express.Router')
    const result = new Map<string, 'app' | 'router'>();

    for (const node of nodes) {
      if (node.type !== 'VARIABLE') continue;

      const assignedFromEdges = (edgesBySrc.get(node.id) ?? [])
        .filter(e => e.type === 'ASSIGNED_FROM');

      for (const assignEdge of assignedFromEdges) {
        const srcNode = nodeById.get(assignEdge.dst);
        if (!srcNode || srcNode.type !== 'CALL') continue;

        if (srcNode.name === 'express') {
          result.set(node.name, 'app');
          break;
        }

        if (
          srcNode.name === 'express.Router'
          || (srcNode.metadata?.object === 'express' && srcNode.metadata?.method === 'Router')
        ) {
          result.set(node.name, 'router');
          break;
        }
      }
    }

    // Phase 2: alias chain resolution — VARIABLE --ASSIGNED_FROM--> VARIABLE (already known)
    // Runs until convergence (no new additions). Handles: const server = app; server.get(...)
    // Uses node IDs for classification to avoid false positives from variable shadowing.
    const resultById = new Map<string, 'app' | 'router'>();

    // Seed resultById from Phase 1 results using nodeById for O(1) lookup
    for (const node of nodes) {
      if (node.type !== 'VARIABLE') continue;
      const kind = result.get(node.name);
      if (kind !== undefined) resultById.set(node.id, kind);
    }

    // BFS: follow ASSIGNED_FROM -> VARIABLE chains
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        if (node.type !== 'VARIABLE') continue;
        if (resultById.has(node.id)) continue; // already classified

        const assignedFromEdges = (edgesBySrc.get(node.id) ?? [])
          .filter(e => e.type === 'ASSIGNED_FROM');

        for (const assignEdge of assignedFromEdges) {
          const srcNode = nodeById.get(assignEdge.dst);
          if (!srcNode || srcNode.type !== 'VARIABLE') continue;

          const srcKind = resultById.get(srcNode.id);
          if (srcKind !== undefined) {
            resultById.set(node.id, srcKind);
            changed = true;
            break;
          }
        }
      }
    }

    // Final: convert back to name-keyed map for compatibility with analyzeFile
    const finalResult = new Map<string, 'app' | 'router'>();
    for (const [nodeId, kind] of resultById.entries()) {
      const node = nodeById.get(nodeId);
      if (node) finalResult.set(node.name, kind);
    }

    return finalResult;
  }

  /**
   * Create an http:route GraphNode.
   * Node ID format: "{file}->http:route->{METHOD}:{path}#{line}:{column}"
   */
  private _createHttpRouteNode(
    callNode: GraphNode,
    method: string,
    path: string,
  ): GraphNode {
    return {
      id: `${callNode.file}->http:route->${method}:${path}#${callNode.line}:${callNode.column}`,
      type: 'http:route',
      name: `${method} ${path}`,
      file: callNode.file,
      line: callNode.line,
      column: callNode.column,
      metadata: {
        method,
        path,
        mountedOn: callNode.metadata?.object as string,
      },
    };
  }

  /**
   * Process app.use() call. Creates express:mount node.
   * Handles:
   *   app.use('/prefix', router)  -> express:mount with prefix
   *   app.use(middleware)         -> express:mount with prefix '/'
   */
  private _processMountPoint(
    callNode: GraphNode,
    argValues: (string | null)[],
    moduleNode: GraphNode | null,
    nodes: GraphNode[],
    edges: GraphEdge[],
  ): void {
    let prefix: string;

    if (argValues.length === 0) {
      // app.use() with no arguments — malformed, skip
      return;
    }

    if (argValues.length === 1) {
      // app.use(middleware) — no prefix, mounts at root
      prefix = '/';
    } else {
      // app.use('/prefix', ...) — extract prefix from first arg
      const firstArg = argValues[0];
      if (firstArg === null) {
        // Dynamic prefix (variable, expression) — use placeholder
        prefix = '${dynamic}';
      } else {
        prefix = firstArg;
      }
    }

    const mountNode = this._createExpressMountNode(callNode, prefix);
    nodes.push(mountNode);

    if (moduleNode) {
      edges.push({
        src: moduleNode.id,
        dst: mountNode.id,
        type: 'MOUNTS',
      });
    }
  }

  /**
   * Create an express:mount GraphNode.
   * Node ID format: "{file}->express:mount->{prefix}#{line}:{column}"
   */
  private _createExpressMountNode(
    callNode: GraphNode,
    prefix: string,
  ): GraphNode {
    return {
      id: `${callNode.file}->express:mount->${prefix}#${callNode.line}:${callNode.column}`,
      type: 'express:mount',
      name: prefix,
      file: callNode.file,
      line: callNode.line,
      column: callNode.column,
      metadata: {
        prefix,
        mountedOn: callNode.metadata?.object as string,
      },
    };
  }
}
