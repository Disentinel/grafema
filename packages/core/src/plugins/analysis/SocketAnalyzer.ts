/**
 * SocketAnalyzer - detects socket connections (Unix/TCP) via Node.js net module
 *
 * Patterns:
 * - net.connect({ path: '/tmp/app.sock' }) -> os:unix-socket
 * - net.createConnection('/tmp/app.sock') -> os:unix-socket
 * - net.connect({ port: 3000, host: 'localhost' }) -> net:tcp-connection
 * - net.connect(port, host) -> net:tcp-connection
 * - net.createServer().listen('/tmp/app.sock') -> os:unix-server
 * - net.createServer().listen(port) -> net:tcp-server
 * - new net.Socket().connect(...) -> os:unix-socket or net:tcp-connection
 *
 * Node type selection:
 * - Unix domain socket: path string -> os:unix-socket or os:unix-server
 * - TCP socket: port number and host -> net:tcp-connection or net:tcp-server
 */

import { readFileSync } from 'fs';
import type { ParserPlugin } from '@babel/parser';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { CallExpression, Identifier, MemberExpression, NewExpression, Node } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import { getLine, getColumn } from './ast/utils/location.js';
import { getTraverseFunction } from './ast/utils/babelTraverse.js';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';

const traverse = getTraverseFunction(traverseModule);

/** Socket node created during analysis */
interface SocketNode {
  id: string;
  type: 'os:unix-socket' | 'os:unix-server' | 'net:tcp-connection' | 'net:tcp-server';
  name: string;
  protocol: 'unix' | 'tcp';
  path?: string;
  host?: string;
  port?: number;
  library: string;
  backlog?: number;
  file: string;
  line: number;
  column: number;
}

/** Analysis result per module */
interface AnalysisResult {
  sockets: number;
  edges: number;
}

/** Connection details extracted from AST arguments */
interface ConnectionArgs {
  path?: string;
  host?: string;
  port?: number;
  backlog?: number;
  dynamic?: boolean;
}

/** Client method names that create socket connections */
const CLIENT_METHODS = ['connect', 'createConnection'];

export class SocketAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'SocketAnalyzer',
      phase: 'ANALYSIS',
      creates: {
        nodes: ['os:unix-socket', 'os:unix-server', 'net:tcp-connection', 'net:tcp-server'],
        edges: ['CONTAINS', 'MAKES_REQUEST']
      },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);

    try {
      const { graph } = context;
      const projectPath = (context.manifest as { projectPath?: string })?.projectPath ?? '';

      const modules = await this.getModules(graph);
      logger.info('Processing modules for socket analysis', { count: modules.length });

      let socketsCount = 0;
      let edgesCount = 0;
      const startTime = Date.now();

      for (let i = 0; i < modules.length; i++) {
        const module = modules[i];
        const result = await this.analyzeModule(module, graph, projectPath);
        socketsCount += result.sockets;
        edgesCount += result.edges;

        if ((i + 1) % 20 === 0 || i === modules.length - 1) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const avgTime = ((Date.now() - startTime) / (i + 1)).toFixed(0);
          logger.debug('Progress', {
            current: i + 1,
            total: modules.length,
            elapsed: `${elapsed}s`,
            avgTime: `${avgTime}ms/module`
          });
        }
      }

      logger.info('Socket analysis complete', { socketsCount, edgesCount });

      return createSuccessResult(
        { nodes: socketsCount, edges: edgesCount },
        { socketsCount, edgesCount }
      );
    } catch (error) {
      logger.error('Socket analysis failed', { error });
      const err = error instanceof Error ? error : new Error(String(error));
      return createErrorResult(err);
    }
  }

  private async analyzeModule(
    module: NodeRecord,
    graph: PluginContext['graph'],
    projectPath: string
  ): Promise<AnalysisResult> {
    const nodes: NodeRecord[] = [];
    const edges: Array<{ type: string; src: string; dst: string }> = [];

    try {
      const code = readFileSync(resolveNodeFile(module.file!, projectPath), 'utf-8');

      const ast = parse(code, {
        sourceType: 'module',
        plugins: [
          'jsx',
          'typescript',
          'classProperties',
          'decorators-legacy',
          'asyncGenerators',
          'dynamicImport',
          'optionalChaining',
          'nullishCoalescingOperator'
        ] as ParserPlugin[]
      });

      const socketNodes: SocketNode[] = [];

      // Detect net module client/server patterns
      traverse(ast, {
        CallExpression: (astPath: NodePath<CallExpression>) => {
          const node = astPath.node;
          this.detectClientCall(node, module, socketNodes);
          this.detectServerListen(node, module, socketNodes);
        },
        NewExpression: (astPath: NodePath<NewExpression>) => {
          this.detectSocketConstructor(astPath, module, socketNodes);
        }
      });

      // Pre-fetch FUNCTION and CALL nodes for MAKES_REQUEST edges
      const fileFunctions: NodeRecord[] = [];
      for await (const fn of graph.queryNodes({ type: 'FUNCTION', file: module.file! })) {
        fileFunctions.push(fn);
      }
      const fileCalls: NodeRecord[] = [];
      for await (const cn of graph.queryNodes({ type: 'CALL', file: module.file! })) {
        fileCalls.push(cn);
      }

      // Create nodes and edges
      for (const socketNode of socketNodes) {
        nodes.push(socketNode as unknown as NodeRecord);

        // CONTAINS: MODULE -> socket node
        edges.push({ type: 'CONTAINS', src: module.id, dst: socketNode.id });

        // MAKES_REQUEST: FUNCTION -> socket node (closest enclosing function)
        this.linkToFunction(socketNode, fileFunctions, edges);

        // MAKES_REQUEST: CALL -> socket node (matching call on same line)
        this.linkToCall(socketNode, fileCalls, edges);
      }

      if (nodes.length > 0) {
        await graph.addNodes(nodes);
      }
      if (edges.length > 0) {
        await graph.addEdges(edges);
      }

      return { sockets: socketNodes.length, edges: edges.length };
    } catch {
      return { sockets: 0, edges: 0 };
    }
  }

  /**
   * Detect net.connect() and net.createConnection() calls.
   * Determines Unix vs TCP based on arguments.
   */
  private detectClientCall(
    node: CallExpression,
    module: NodeRecord,
    results: SocketNode[]
  ): void {
    const callee = node.callee;
    if (callee.type !== 'MemberExpression') return;

    const memberExpr = callee as MemberExpression;
    if (memberExpr.object.type !== 'Identifier') return;
    if ((memberExpr.object as Identifier).name !== 'net') return;
    if (memberExpr.property.type !== 'Identifier') return;

    const methodName = (memberExpr.property as Identifier).name;
    if (!CLIENT_METHODS.includes(methodName)) return;

    const connArgs = this.extractConnectionArgs(node.arguments as Node[]);
    if (!connArgs || connArgs.dynamic) return;

    const socketNode = this.createClientNode(connArgs, module, node);
    if (socketNode) {
      results.push(socketNode);
    }
  }

  /**
   * Detect net.createServer().listen() pattern.
   * Handles chained calls: net.createServer(handler).listen(args).
   */
  private detectServerListen(
    node: CallExpression,
    module: NodeRecord,
    results: SocketNode[]
  ): void {
    const callee = node.callee;
    if (callee.type !== 'MemberExpression') return;

    const memberExpr = callee as MemberExpression;
    if (memberExpr.property.type !== 'Identifier') return;
    if ((memberExpr.property as Identifier).name !== 'listen') return;

    // Check if the object is a net.createServer() call
    if (!this.isCreateServerCall(memberExpr.object)) return;

    const listenArgs = this.extractListenArgs(node.arguments as Node[]);
    if (!listenArgs || listenArgs.dynamic) return;

    const socketNode = this.createServerNode(listenArgs, module, node);
    if (socketNode) {
      results.push(socketNode);
    }
  }

  /**
   * Detect new net.Socket().connect() pattern.
   */
  private detectSocketConstructor(
    astPath: NodePath<NewExpression>,
    module: NodeRecord,
    results: SocketNode[]
  ): void {
    const newExpr = astPath.node;
    const callee = newExpr.callee;

    // Match: new net.Socket()
    if (callee.type !== 'MemberExpression') return;
    const memberExpr = callee as MemberExpression;
    if (memberExpr.object.type !== 'Identifier') return;
    if ((memberExpr.object as Identifier).name !== 'net') return;
    if (memberExpr.property.type !== 'Identifier') return;
    if ((memberExpr.property as Identifier).name !== 'Socket') return;

    // Look for chained .connect() call: new net.Socket().connect(args)
    const parent = astPath.parentPath;
    if (!parent || parent.node.type !== 'MemberExpression') return;

    const parentMember = parent.node as MemberExpression;
    if (parentMember.property.type !== 'Identifier') return;
    if ((parentMember.property as Identifier).name !== 'connect') return;

    const grandParent = parent.parentPath;
    if (!grandParent || grandParent.node.type !== 'CallExpression') return;

    const connectCall = grandParent.node as CallExpression;
    const connArgs = this.extractConnectionArgs(connectCall.arguments as Node[]);
    if (!connArgs || connArgs.dynamic) return;

    const socketNode = this.createClientNode(connArgs, module, connectCall);
    if (socketNode) {
      results.push(socketNode);
    }
  }

  /**
   * Check if a node is a net.createServer() call expression.
   * Handles direct calls and chained calls.
   */
  private isCreateServerCall(node: Node): boolean {
    if (node.type !== 'CallExpression') return false;
    const call = node as CallExpression;
    const callee = call.callee;

    if (callee.type !== 'MemberExpression') return false;
    const memberExpr = callee as MemberExpression;

    if (memberExpr.object.type !== 'Identifier') return false;
    if ((memberExpr.object as Identifier).name !== 'net') return false;
    if (memberExpr.property.type !== 'Identifier') return false;
    if ((memberExpr.property as Identifier).name !== 'createServer') return false;

    return true;
  }

  /**
   * Extract connection arguments from client call (connect/createConnection).
   * Handles both options object and positional arguments.
   */
  private extractConnectionArgs(args: Node[]): ConnectionArgs | null {
    if (args.length === 0) return null;

    const firstArg = args[0];

    // Pattern: net.connect({ path: '...' }) or net.connect({ port: N, host: '...' })
    if (firstArg.type === 'ObjectExpression') {
      return this.extractFromOptionsObject(firstArg);
    }

    // Pattern: net.createConnection('/path/to/socket') - string arg = Unix socket
    if (firstArg.type === 'StringLiteral') {
      return { path: (firstArg as { value: string }).value };
    }

    // Pattern: net.connect(port, host) - number arg = TCP
    if (firstArg.type === 'NumericLiteral') {
      const port = (firstArg as { value: number }).value;
      const host = args.length > 1 && args[1].type === 'StringLiteral'
        ? (args[1] as { value: string }).value
        : undefined;
      return { port, host };
    }

    // Template literal for path
    if (firstArg.type === 'TemplateLiteral') {
      return { dynamic: true };
    }

    return { dynamic: true };
  }

  /**
   * Extract connection parameters from an options object literal.
   */
  private extractFromOptionsObject(objExpr: Node): ConnectionArgs {
    const obj = objExpr as { properties: Array<{ type: string; key: Node; value: Node }> };
    const result: ConnectionArgs = {};

    for (const prop of obj.properties) {
      if (prop.type !== 'ObjectProperty') continue;

      const keyName = this.getPropertyKeyName(prop.key);
      if (!keyName) continue;

      if (keyName === 'path') {
        if (prop.value.type === 'StringLiteral') {
          result.path = (prop.value as { value: string }).value;
        } else {
          result.dynamic = true;
        }
      } else if (keyName === 'port') {
        if (prop.value.type === 'NumericLiteral') {
          result.port = (prop.value as { value: number }).value;
        } else {
          result.dynamic = true;
        }
      } else if (keyName === 'host') {
        if (prop.value.type === 'StringLiteral') {
          result.host = (prop.value as { value: string }).value;
        }
      } else if (keyName === 'backlog') {
        if (prop.value.type === 'NumericLiteral') {
          result.backlog = (prop.value as { value: number }).value;
        }
      }
    }

    return result;
  }

  /**
   * Extract listen() arguments for server detection.
   * Handles: .listen(port), .listen('path'), .listen({ port, host })
   */
  private extractListenArgs(args: Node[]): ConnectionArgs | null {
    if (args.length === 0) return null;

    const firstArg = args[0];

    // .listen('/path/to/socket')
    if (firstArg.type === 'StringLiteral') {
      return { path: (firstArg as { value: string }).value };
    }

    // .listen(3000)
    if (firstArg.type === 'NumericLiteral') {
      const port = (firstArg as { value: number }).value;
      const host = args.length > 1 && args[1].type === 'StringLiteral'
        ? (args[1] as { value: string }).value
        : undefined;
      return { port, host };
    }

    // .listen({ path: '...' }) or .listen({ port: N, host: '...' })
    if (firstArg.type === 'ObjectExpression') {
      return this.extractFromOptionsObject(firstArg);
    }

    // Template literal or variable
    if (firstArg.type === 'TemplateLiteral') {
      return { dynamic: true };
    }

    return { dynamic: true };
  }

  /**
   * Create a client socket node (os:unix-socket or net:tcp-connection).
   */
  private createClientNode(
    args: ConnectionArgs,
    module: NodeRecord,
    astNode: CallExpression | NewExpression
  ): SocketNode | null {
    const line = getLine(astNode as unknown as Node);
    const column = getColumn(astNode as unknown as Node);

    if (args.path) {
      return {
        id: `os:unix-socket#${args.path}#${module.file}#${line}`,
        type: 'os:unix-socket',
        name: `unix:${args.path}`,
        protocol: 'unix',
        path: args.path,
        library: 'net',
        file: module.file!,
        line,
        column
      };
    }

    if (args.port != null) {
      const host = args.host ?? 'localhost';
      return {
        id: `net:tcp-connection#${host}:${args.port}#${module.file}#${line}`,
        type: 'net:tcp-connection',
        name: `tcp:${host}:${args.port}`,
        protocol: 'tcp',
        host,
        port: args.port,
        library: 'net',
        file: module.file!,
        line,
        column
      };
    }

    return null;
  }

  /**
   * Create a server socket node (os:unix-server or net:tcp-server).
   */
  private createServerNode(
    args: ConnectionArgs,
    module: NodeRecord,
    astNode: CallExpression
  ): SocketNode | null {
    const line = getLine(astNode as unknown as Node);
    const column = getColumn(astNode as unknown as Node);

    if (args.path) {
      return {
        id: `os:unix-server#${args.path}#${module.file}#${line}`,
        type: 'os:unix-server',
        name: `unix-server:${args.path}`,
        protocol: 'unix',
        path: args.path,
        library: 'net',
        backlog: args.backlog,
        file: module.file!,
        line,
        column
      };
    }

    if (args.port != null) {
      const host = args.host ?? 'localhost';
      return {
        id: `net:tcp-server#${host}:${args.port}#${module.file}#${line}`,
        type: 'net:tcp-server',
        name: `tcp-server:${host}:${args.port}`,
        protocol: 'tcp',
        host,
        port: args.port,
        library: 'net',
        backlog: args.backlog,
        file: module.file!,
        line,
        column
      };
    }

    return null;
  }

  /**
   * Get the string key name from an object property key node.
   */
  private getPropertyKeyName(key: Node): string | null {
    if (key.type === 'Identifier') return (key as Identifier).name;
    if (key.type === 'StringLiteral') return (key as { value: string }).value;
    return null;
  }

  /**
   * Link a socket node to the closest enclosing FUNCTION via MAKES_REQUEST edge.
   */
  private linkToFunction(
    socketNode: SocketNode,
    fileFunctions: NodeRecord[],
    edges: Array<{ type: string; src: string; dst: string }>
  ): void {
    const candidates = fileFunctions.filter(fn =>
      fn.line != null &&
      fn.line <= socketNode.line &&
      fn.line + 50 >= socketNode.line
    );

    if (candidates.length === 0) return;

    const closest = candidates.reduce((best, fn) => {
      const currentDist = Math.abs(fn.line! - socketNode.line);
      const bestDist = Math.abs(best.line! - socketNode.line);
      return currentDist < bestDist ? fn : best;
    });

    edges.push({ type: 'MAKES_REQUEST', src: closest.id, dst: socketNode.id });
  }

  /**
   * Link a socket node to the matching CALL node on the same line.
   */
  private linkToCall(
    socketNode: SocketNode,
    fileCalls: NodeRecord[],
    edges: Array<{ type: string; src: string; dst: string }>
  ): void {
    const expectedNames = ['net.connect', 'net.createConnection', 'net.createServer'];

    const matchingCall = fileCalls.find(callNode =>
      callNode.line === socketNode.line &&
      expectedNames.includes(callNode.name as string)
    );

    if (matchingCall) {
      edges.push({ type: 'MAKES_REQUEST', src: matchingCall.id, dst: socketNode.id });
    }
  }
}
