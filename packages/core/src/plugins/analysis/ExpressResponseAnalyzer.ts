/**
 * ExpressResponseAnalyzer - detects Express response patterns
 *
 * For each http:route node:
 * 1. Follow HANDLED_BY edge to get handler function
 * 2. Traverse handler AST for res.json(...), res.send(...) patterns
 * 3. Create RESPONDS_WITH edge from http:route to response argument node
 *
 * Patterns:
 * - res.json({ data })
 * - res.send(variable)
 * - res.status(200).json(data)
 */

import { readFileSync } from 'fs';
import type { ParserPlugin } from '@babel/parser';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { CallExpression, Identifier, MemberExpression, Node, ArrowFunctionExpression, FunctionExpression } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord, AnyBrandedNode } from '@grafema/types';
import { NodeFactory } from '../../core/NodeFactory.js';
import { getLine } from './ast/utils/location.js';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';

const traverse = (traverseModule as any).default || traverseModule;

const RESPONSE_METHODS = ['json', 'send'];

/**
 * Response call info
 */
interface ResponseCallInfo {
  method: string;          // 'json' or 'send'
  argLine: number;         // Line of the argument
  argColumn: number;       // Column of the argument
  argType: string;         // Type of the argument ('ObjectExpression', 'Identifier', etc.)
  line: number;
  identifierName?: string; // Actual variable name for Identifier arguments
}

export class ExpressResponseAnalyzer extends Plugin {
  private responseNodeCounter = 0;

  get metadata(): PluginMetadata {
    return {
      name: 'ExpressResponseAnalyzer',
      phase: 'ANALYSIS',
      covers: ['express'],
      creates: {
        nodes: [],
        edges: ['RESPONDS_WITH']
      },
      dependencies: ['ExpressRouteAnalyzer', 'JSASTAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);

    try {
      const { graph } = context;
      const projectPath = (context.manifest as { projectPath?: string })?.projectPath ?? '';

      // Get all http:route nodes
      const routes: NodeRecord[] = [];
      for await (const node of graph.queryNodes({ type: 'http:route' })) {
        routes.push(node);
      }

      logger.info('Processing routes', { count: routes.length });

      let edgesCreated = 0;
      let nodesCreated = 0;
      const allNodes: AnyBrandedNode[] = [];
      const allEdges: Array<{ type: string; src: string; dst: string; metadata?: unknown }> = [];

      for (const route of routes) {
        const result = await this.analyzeRouteResponses(route, graph, projectPath, allNodes, allEdges);
        edgesCreated += result.edges;
        nodesCreated += result.nodes;
      }

      // Flush all nodes and edges
      await graph.addNodes(allNodes);
      await graph.addEdges(allEdges);

      logger.info('Analysis complete', { nodesCreated, edgesCreated });

      return createSuccessResult(
        { nodes: nodesCreated, edges: edgesCreated },
        { routesAnalyzed: routes.length }
      );
    } catch (error) {
      logger.error('Analysis failed', { error });
      const err = error instanceof Error ? error : new Error(String(error));
      return createErrorResult(err);
    }
  }

  /**
   * Analyze a single http:route for response patterns
   */
  private async analyzeRouteResponses(
    route: NodeRecord,
    graph: PluginContext['graph'],
    projectPath: string,
    nodes: AnyBrandedNode[],
    edges: Array<{ type: string; src: string; dst: string; metadata?: unknown }>
  ): Promise<{ nodes: number; edges: number }> {
    let edgesCreated = 0;
    let nodesCreated = 0;

    try {
      // Get HANDLED_BY edges to find handler function
      const handledByEdges = await graph.getOutgoingEdges(route.id, ['HANDLED_BY']);

      if (handledByEdges.length === 0) {
        return { nodes: 0, edges: 0 };
      }

      // Get handler function node
      const handlerEdge = handledByEdges[0];
      const handlerNode = await graph.getNode(handlerEdge.dst);

      if (!handlerNode || !handlerNode.file) {
        return { nodes: 0, edges: 0 };
      }

      // Parse the file and find response calls in handler
      const code = readFileSync(resolveNodeFile(handlerNode.file, projectPath), 'utf-8');
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'] as ParserPlugin[]
      });

      // Find response calls within the handler's line range
      const responseCalls = this.findResponseCalls(
        ast,
        handlerNode.file,
        handlerNode.line as number
      );

      // Create RESPONDS_WITH edges
      for (const call of responseCalls) {
        // Try to resolve to existing variable, or create a unique response node
        const result = await this.resolveOrCreateResponseNode(
          graph,
          handlerNode.file,
          call,
          route.id,
          handlerNode.id, // Handler's semantic ID for scope resolution
          nodes
        );

        nodesCreated += result.nodesCreated;

        edges.push({
          type: 'RESPONDS_WITH',
          src: route.id,
          dst: result.nodeId,
          metadata: {
            responseMethod: call.method
          }
        });
        edgesCreated++;
      }
    } catch {
      // Silent - per-route errors shouldn't spam logs
    }

    return { nodes: nodesCreated, edges: edgesCreated };
  }

  /**
   * Find res.json/res.send calls within a function at given line
   */
  private findResponseCalls(
    ast: ReturnType<typeof parse>,
    file: string,
    handlerLine: number
  ): ResponseCallInfo[] {
    const calls: ResponseCallInfo[] = [];
    // Using object wrapper to satisfy TypeScript's control flow analysis
    const found: { path: NodePath | null } = { path: null };

    // First pass: find the handler function at the specified line
    traverse(ast, {
      'ArrowFunctionExpression|FunctionExpression|FunctionDeclaration': (path: NodePath) => {
        const node = path.node as Node;
        const line = getLine(node);

        if (line === handlerLine) {
          found.path = path;
          path.stop();
        }
      }
    });

    if (!found.path) {
      return calls;
    }

    const handlerPath = found.path;

    // Second pass: traverse only within the handler to find response calls
    const handlerNode = handlerPath.node as ArrowFunctionExpression | FunctionExpression;

    // Get parameter names to identify 'res'
    const resParamName = this.getResponseParamName(handlerNode);
    if (!resParamName) {
      return calls;
    }

    // Traverse the handler body for res.json/res.send calls
    handlerPath.traverse({
      CallExpression: (callPath: NodePath<CallExpression>) => {
        const callNode = callPath.node;
        const callee = callNode.callee;

        // Check for res.json() or res.send() or res.status().json() patterns
        const responseInfo = this.extractResponseInfo(callee, resParamName);
        if (!responseInfo) {
          return;
        }

        // Get the argument being sent
        if (callNode.arguments.length === 0) {
          return;
        }

        const arg = callNode.arguments[0] as Node;
        const argLine = getLine(arg);
        const argColumn = arg.loc?.start.column ?? 0;

        calls.push({
          method: responseInfo.method,
          argLine,
          argColumn,
          argType: arg.type,
          line: getLine(callNode),
          identifierName: arg.type === 'Identifier' ? (arg as Identifier).name : undefined
        });
      }
    });

    return calls;
  }

  /**
   * Get response parameter name from function params (typically 'res')
   */
  private getResponseParamName(
    func: ArrowFunctionExpression | FunctionExpression
  ): string | null {
    const params = func.params;
    // Express handlers: (req, res) or (req, res, next)
    if (params.length >= 2) {
      const resParam = params[1];
      if (resParam.type === 'Identifier') {
        return (resParam as Identifier).name;
      }
    }
    return null;
  }

  /**
   * Extract response method info from callee
   * Handles: res.json(), res.send(), res.status(200).json()
   */
  private extractResponseInfo(
    callee: Node,
    resParamName: string
  ): { method: string } | null {
    // Direct call: res.json() or res.send()
    if (callee.type === 'MemberExpression') {
      const memberExpr = callee as MemberExpression;
      const property = memberExpr.property;

      if (property.type !== 'Identifier') {
        return null;
      }

      const methodName = (property as Identifier).name;

      // Check for res.json() or res.send()
      if (
        memberExpr.object.type === 'Identifier' &&
        (memberExpr.object as Identifier).name === resParamName &&
        RESPONSE_METHODS.includes(methodName)
      ) {
        return { method: methodName };
      }

      // Check for res.status(200).json() chain
      if (
        memberExpr.object.type === 'CallExpression' &&
        RESPONSE_METHODS.includes(methodName)
      ) {
        const chainedCall = memberExpr.object as CallExpression;
        if (this.isResMethodCall(chainedCall.callee, resParamName, 'status')) {
          return { method: methodName };
        }
      }
    }

    return null;
  }

  /**
   * Check if callee is res.methodName()
   */
  private isResMethodCall(
    callee: Node,
    resParamName: string,
    methodName: string
  ): boolean {
    if (callee.type !== 'MemberExpression') {
      return false;
    }

    const memberExpr = callee as MemberExpression;
    return (
      memberExpr.object.type === 'Identifier' &&
      (memberExpr.object as Identifier).name === resParamName &&
      memberExpr.property.type === 'Identifier' &&
      (memberExpr.property as Identifier).name === methodName
    );
  }

  /**
   * Resolve response node: find existing variable or create stub.
   *
   * For Identifier arguments (e.g., res.json(statusData)):
   * 1. Try to find existing VARIABLE/PARAMETER/CONSTANT with same name in handler scope
   * 2. If found, return existing node ID (no stub needed)
   * 3. If not found, fall back to creating stub (external/global variables)
   *
   * For non-Identifier arguments (ObjectExpression, CallExpression, etc.):
   * - Always create stub node (existing behavior)
   *
   * @param graph - Graph backend
   * @param file - Handler file path
   * @param call - Response call info (includes identifierName)
   * @param routeId - Route ID (for metadata)
   * @param handlerSemanticId - Handler function's semantic ID (for scope matching)
   * @param nodes - Array to collect nodes for batch insertion
   * @returns Object with nodeId and nodesCreated count
   */
  private async resolveOrCreateResponseNode(
    graph: PluginContext['graph'],
    file: string,
    call: ResponseCallInfo,
    routeId: string,
    handlerSemanticId: string,
    nodes: AnyBrandedNode[]
  ): Promise<{ nodeId: string; nodesCreated: number }> {
    const { argLine, argColumn, argType, identifierName } = call;

    // For Identifier arguments, try to find existing variable/parameter
    if (argType === 'Identifier' && identifierName) {
      const existingNodeId = await this.findIdentifierInScope(
        graph,
        file,
        identifierName,
        handlerSemanticId,
        argLine
      );

      if (existingNodeId) {
        return { nodeId: existingNodeId, nodesCreated: 0 }; // Use existing node, no stub needed
      }
      // Fall through to create stub if not found (external/global variables)
    }

    // For non-Identifier or not-found, create stub node (existing logic)
    const nodeId = this.createResponseArgumentNode(
      file,
      argLine,
      argColumn,
      argType,
      routeId,
      nodes
    );
    return { nodeId, nodesCreated: 1 };
  }

  /**
   * Find existing VARIABLE/CONSTANT/PARAMETER node in handler scope.
   *
   * Strategy:
   * 1. Parse handler semantic ID to extract scope prefix
   * 2. Query VARIABLE/CONSTANT nodes: match by name, file, scope prefix, and line <= useLine
   * 3. Query PARAMETER nodes: match by name, file, parentFunctionId === handlerSemanticId
   *
   * Scope matching:
   * - Handler ID: "routes.js->anonymous[1]->FUNCTION->anonymous[1]"
   * - Scope prefix: "routes.js->anonymous[1]->"
   * - Variable ID: "routes.js->anonymous[1]->VARIABLE->statusData" (matches prefix)
   * - External ID: "utils.js->VARIABLE->config" (different file)
   *
   * @param graph - Graph backend
   * @param file - File path
   * @param name - Variable name to find
   * @param handlerSemanticId - Handler function's semantic ID
   * @param useLine - Line where identifier is used (variable must be declared before this)
   * @returns Node ID if found, null otherwise
   */
  private async findIdentifierInScope(
    graph: PluginContext['graph'],
    file: string,
    name: string,
    handlerSemanticId: string,
    useLine: number
  ): Promise<string | null> {
    // Extract scope prefix from handler semantic ID
    const handlerScopePrefix = this.extractScopePrefix(handlerSemanticId);

    // Query VARIABLE nodes
    for await (const node of graph.queryNodes({ type: 'VARIABLE' })) {
      if (node.name === name && node.file === file) {
        // Check if in handler scope and declared before usage
        if (node.id.startsWith(handlerScopePrefix) && (node.line as number) <= useLine) {
          return node.id;
        }
      }
    }

    // Query CONSTANT nodes
    for await (const node of graph.queryNodes({ type: 'CONSTANT' })) {
      if (node.name === name && node.file === file) {
        if (node.id.startsWith(handlerScopePrefix) && (node.line as number) <= useLine) {
          return node.id;
        }
      }
    }

    // Query PARAMETER nodes
    for await (const node of graph.queryNodes({ type: 'PARAMETER' })) {
      if (node.name === name && node.file === file) {
        // Parameters belong to the function directly
        const parentFunctionId = (node as NodeRecord & { parentFunctionId?: string }).parentFunctionId;
        if (parentFunctionId === handlerSemanticId) {
          return node.id;
        }
      }
    }

    // Also check module-level variables (scope prefix would be just "file.js->")
    // For module-level constants, they should be accessible from any function in the file
    const modulePrefix = this.extractModulePrefix(handlerSemanticId);
    if (modulePrefix) {
      // Check module-level VARIABLE
      for await (const node of graph.queryNodes({ type: 'VARIABLE' })) {
        if (node.name === name && node.file === file) {
          // Module-level variables have IDs like "file.js->VARIABLE->name" (3 parts)
          // Function-local variables have IDs like "file.js->funcName->VARIABLE->name" (4+ parts)
          // Only match true module-level variables by checking structure
          if (this.isModuleLevelId(node.id, modulePrefix) && (node.line as number) <= useLine) {
            return node.id;
          }
        }
      }

      // Check module-level CONSTANT
      for await (const node of graph.queryNodes({ type: 'CONSTANT' })) {
        if (node.name === name && node.file === file) {
          if (this.isModuleLevelId(node.id, modulePrefix) && (node.line as number) <= useLine) {
            return node.id;
          }
        }
      }
    }

    return null; // Not found - will create stub
  }

  /**
   * Extract scope prefix from handler function's semantic ID.
   *
   * Handler function semantic IDs follow the pattern:
   *   {file}->{scope_path}->{type}->{name}
   *
   * Variables declared INSIDE the handler have IDs where the handler's NAME
   * becomes part of THEIR scope path:
   *   {file}->{handler_name}->{type}->{var_name}
   *
   * Examples:
   * - Handler: "index.js->global->FUNCTION->anonymous[0]"
   *   -> Variables inside: "index.js->anonymous[0]->CONSTANT->statusData"
   *   -> Scope prefix: "index.js->anonymous[0]->"
   *
   * - Handler: "routes.js->anonymous[1]->FUNCTION->anonymous[1]"
   *   -> Variables inside: "routes.js->anonymous[1]->VARIABLE->data"
   *   -> Scope prefix: "routes.js->anonymous[1]->"
   *
   * - Handler: "app.js->global->FUNCTION->handleRequest"
   *   -> Variables inside: "app.js->handleRequest->VARIABLE->result"
   *   -> Scope prefix: "app.js->handleRequest->"
   *
   * Algorithm:
   * 1. Split by "->"
   * 2. Take file (first part) and handler name (last part)
   * 3. Join with "->" and add trailing "->"
   *
   * @param semanticId - Handler function's semantic ID
   * @returns Scope prefix for matching variables declared inside the handler
   */
  private extractScopePrefix(semanticId: string): string {
    const parts = semanticId.split('->');
    // Semantic ID format: file->scope->TYPE->name
    // We need file + function name (last part) to match variables inside the function
    if (parts.length >= 4) {
      const file = parts[0];
      const functionName = parts[parts.length - 1]; // Function name is the last part
      return `${file}->${functionName}->`;
    }
    // Fallback: use first two parts (shouldn't happen for well-formed IDs)
    if (parts.length >= 2) {
      return `${parts[0]}->${parts[1]}->`;
    }
    return semanticId;
  }

  /**
   * Extract module prefix from semantic ID (for module-level variable access).
   *
   * Examples:
   * - "routes.js->anonymous[1]->FUNCTION->anonymous[1]" -> "routes.js->"
   * - "app.js->startServer->FUNCTION->startServer" -> "app.js->"
   *
   * @param semanticId - Handler function's semantic ID
   * @returns Module prefix for matching module-level variables
   */
  private extractModulePrefix(semanticId: string): string | null {
    const parts = semanticId.split('->');
    if (parts.length >= 1 && parts[0]) {
      return `${parts[0]}->`;
    }
    return null;
  }

  /**
   * Check if a semantic ID represents a true module-level variable.
   *
   * Semantic IDs have format: file->scope->TYPE->name
   * - Module-level variables have "global" as the scope: "file.js->global->TYPE->name"
   * - Function-local variables have function name as scope: "file.js->funcName->TYPE->name"
   *
   * Examples:
   * - "index.js->global->CONSTANT->CONFIG" -> true (module-level)
   * - "index.js->global->VARIABLE->counter" -> true (module-level)
   * - "index.js->anonymous[0]->CONSTANT->data" -> false (function-local)
   * - "routes.js->handler->VARIABLE->result" -> false (function-local)
   *
   * @param nodeId - The node's semantic ID
   * @param modulePrefix - The module prefix (e.g., "index.js->")
   * @returns true if this is a module-level variable
   */
  private isModuleLevelId(nodeId: string, modulePrefix: string): boolean {
    if (!nodeId.startsWith(modulePrefix)) {
      return false;
    }

    // Check if the scope part (second component) is "global"
    const parts = nodeId.split('->');
    // Expected format: ["file.js", "global", "TYPE", "name"]
    // Check that second part is "global" (module scope)
    return parts.length >= 4 && parts[1] === 'global';
  }

  /**
   * Create a node for the response argument
   */
  private createResponseArgumentNode(
    file: string,
    line: number,
    column: number,
    astType: string,
    _routeId: string,
    nodes: AnyBrandedNode[]
  ): string {
    const counter = this.responseNodeCounter++;

    // Map AST type to node type and create appropriate node via NodeFactory
    switch (astType) {
      case 'ObjectExpression': {
        const node = NodeFactory.createObjectLiteral(file, line, column, {
          argIndex: counter
        });
        nodes.push(node);
        return node.id;
      }
      case 'Identifier': {
        const node = NodeFactory.createVariableDeclaration('<response>', file, line, column, {
          counter
        });
        nodes.push(node);
        return node.id;
      }
      case 'CallExpression': {
        const node = NodeFactory.createCallSite('<response>', file, line, column, {
          counter
        });
        nodes.push(node);
        return node.id;
      }
      case 'ArrayExpression': {
        const node = NodeFactory.createArrayLiteral(file, line, column, {
          argIndex: counter
        });
        nodes.push(node);
        return node.id;
      }
      default: {
        const node = NodeFactory.createExpression(astType, file, line, column);
        nodes.push(node);
        return node.id;
      }
    }
  }
}
