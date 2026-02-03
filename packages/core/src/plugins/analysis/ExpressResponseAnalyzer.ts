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
import { parse, ParserPlugin } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { CallExpression, Identifier, MemberExpression, Node, ArrowFunctionExpression, FunctionExpression } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import { getLine } from './ast/utils/location.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
}

export class ExpressResponseAnalyzer extends Plugin {
  private responseNodeCounter = 0;

  get metadata(): PluginMetadata {
    return {
      name: 'ExpressResponseAnalyzer',
      phase: 'ANALYSIS',
      priority: 74, // After ExpressRouteAnalyzer (75)
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

      // Get all http:route nodes
      const routes: NodeRecord[] = [];
      for await (const node of graph.queryNodes({ type: 'http:route' })) {
        routes.push(node);
      }

      logger.info('Processing routes', { count: routes.length });

      let edgesCreated = 0;

      for (const route of routes) {
        const result = await this.analyzeRouteResponses(route, graph);
        edgesCreated += result;
      }

      logger.info('Analysis complete', { edgesCreated });

      return createSuccessResult(
        { nodes: 0, edges: edgesCreated },
        { routesAnalyzed: routes.length }
      );
    } catch (error) {
      logger.error('Analysis failed', { error });
      return createErrorResult(error as Error);
    }
  }

  /**
   * Analyze a single http:route for response patterns
   */
  private async analyzeRouteResponses(
    route: NodeRecord,
    graph: PluginContext['graph']
  ): Promise<number> {
    let edgesCreated = 0;

    try {
      // Get HANDLED_BY edges to find handler function
      const handledByEdges = await graph.getOutgoingEdges(route.id, ['HANDLED_BY']);

      if (handledByEdges.length === 0) {
        return 0;
      }

      // Get handler function node
      const handlerEdge = handledByEdges[0];
      const handlerNode = await graph.getNode(handlerEdge.dst);

      if (!handlerNode || !handlerNode.file) {
        return 0;
      }

      // Parse the file and find response calls in handler
      const code = readFileSync(handlerNode.file, 'utf-8');
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
        // Always create a unique response node for each route
        // JSASTAnalyzer doesn't create nodes inside functions, and each route
        // needs its own response node even if at the same source location
        const dstNodeId = await this.createResponseArgumentNode(
          graph,
          handlerNode.file,
          call.argLine,
          call.argColumn,
          call.argType,
          route.id
        );

        await graph.addEdge({
          type: 'RESPONDS_WITH',
          src: route.id,
          dst: dstNodeId,
          metadata: {
            responseMethod: call.method
          }
        });
        edgesCreated++;
      }
    } catch {
      // Silent - per-route errors shouldn't spam logs
    }

    return edgesCreated;
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
          line: getLine(callNode)
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
   * Create a node for the response argument
   */
  private async createResponseArgumentNode(
    graph: PluginContext['graph'],
    file: string,
    line: number,
    column: number,
    astType: string,
    routeId: string
  ): Promise<string> {
    // Map AST type to node type and create appropriate node
    switch (astType) {
      case 'ObjectExpression': {
        // Include counter to make the node unique even for same location
        const counter = this.responseNodeCounter++;
        const id = `OBJECT_LITERAL#response:${counter}#${file}#${line}:${column}`;
        await graph.addNode({
          id,
          type: 'OBJECT_LITERAL',
          name: '<response>',
          file,
          line,
          column,
          parentRouteId: routeId
        } as NodeRecord);
        return id;
      }
      case 'Identifier': {
        // For identifiers, we link to the variable that's being returned
        const counter = this.responseNodeCounter++;
        const id = `VARIABLE#response:${counter}#${file}#${line}:${column}`;
        await graph.addNode({
          id,
          type: 'VARIABLE',
          name: '<response>',
          file,
          line,
          column
        } as NodeRecord);
        return id;
      }
      case 'CallExpression': {
        const counter = this.responseNodeCounter++;
        const id = `CALL#response:${counter}#${file}#${line}:${column}`;
        await graph.addNode({
          id,
          type: 'CALL',
          name: '<response>',
          file,
          line,
          column
        } as NodeRecord);
        return id;
      }
      case 'ArrayExpression': {
        const counter = this.responseNodeCounter++;
        const id = `ARRAY_LITERAL#response:${counter}#${file}#${line}:${column}`;
        await graph.addNode({
          id,
          type: 'ARRAY_LITERAL',
          name: '<response>',
          file,
          line,
          column
        } as NodeRecord);
        return id;
      }
      default: {
        // Generic expression node
        const counter = this.responseNodeCounter++;
        const id = `EXPRESSION#response:${counter}#${file}#${line}:${column}`;
        await graph.addNode({
          id,
          type: 'EXPRESSION',
          name: '<response>',
          file,
          line,
          column
        } as NodeRecord);
        return id;
      }
    }
  }
}
