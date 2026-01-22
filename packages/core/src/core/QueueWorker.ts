/**
 * QueueWorker - Worker thread for queue-based analysis
 *
 * Runs in a worker_thread, receives file tasks, runs applicable plugins,
 * writes results directly to RFDB.
 *
 * Protocol:
 *   Main -> Worker: { type: 'process', taskId, file, moduleId, moduleName, plugins }
 *   Worker -> Main: { type: 'done', taskId, stats } | { type: 'error', taskId, error }
 */

import { parentPort, workerData } from 'worker_threads';
import { readFileSync } from 'fs';
import { parse, ParserPlugin } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';

import { RFDBClient } from '@grafema/rfdb-client';
import type { WireNode, WireEdge } from '@grafema/types';
import { ClassNode } from './nodes/ClassNode.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse = (traverseModule as any).default || traverseModule;

// === MESSAGE TYPES ===
interface ProcessMessage {
  type: 'process';
  taskId: string;
  file: string;
  moduleId: string;
  moduleName: string;
  plugins: string[];
}

interface ExitMessage {
  type: 'exit';
}

type IncomingMessage = ProcessMessage | ExitMessage;

interface ReadyMessage {
  type: 'ready';
  workerId: number;
}

interface DoneMessage {
  type: 'done';
  taskId: string;
  file: string;
  stats: PluginStats;
  workerId: number;
}

interface ErrorMessage {
  type: 'error';
  taskId?: string;
  file?: string;
  error: string;
  workerId?: number;
}

type OutgoingMessage = ReadyMessage | DoneMessage | ErrorMessage;

// === STATS TYPES ===
interface SinglePluginStats {
  nodes?: number;
  edges?: number;
  routes?: number;
  error?: string;
}

interface PluginStats {
  nodes: number;
  edges: number;
  plugins: Record<string, SinglePluginStats>;
}

// === INTERNAL NODE/EDGE TYPES ===
interface GraphNode {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
  [key: string]: unknown;
}

interface GraphEdge {
  src: string;
  dst: string;
  type: string;
}

// === PLUGIN ANALYZER TYPE ===
type PluginAnalyzer = (
  filePath: string,
  moduleId: string,
  moduleName: string,
  ast: t.File,
  client: RFDBClient
) => Promise<SinglePluginStats>;

// Worker state
let client: RFDBClient | null = null;
const workerId: number = (workerData as { workerId?: number })?.workerId || 0;
const socketPath: string = (workerData as { socketPath?: string })?.socketPath || '/tmp/rfdb.sock';
let connected = false;

// Plugin registry - maps plugin names to analyzer functions
const pluginAnalyzers = new Map<string, PluginAnalyzer>();

/**
 * Register built-in analysis plugins
 */
function registerBuiltinPlugins(): void {
  pluginAnalyzers.set('JSASTAnalyzer', analyzeJSAST);
  pluginAnalyzers.set('ExpressRouteAnalyzer', analyzeExpressRoutes);
  pluginAnalyzers.set('SocketIOAnalyzer', analyzeSocketIO);
  pluginAnalyzers.set('DatabaseAnalyzer', analyzeDatabase);
  pluginAnalyzers.set('FetchAnalyzer', analyzeFetch);
  pluginAnalyzers.set('ReactAnalyzer', analyzeReact);
}

/**
 * Connect to RFDB server
 */
async function connect(): Promise<void> {
  if (connected) return;

  client = new RFDBClient(socketPath);
  await client.connect();
  connected = true;

  registerBuiltinPlugins();
  parentPort?.postMessage({ type: 'ready', workerId } as ReadyMessage);
}

/**
 * Process a file with specified plugins
 */
async function processFile(
  taskId: string,
  filePath: string,
  moduleId: string,
  moduleName: string,
  pluginNames: string[]
): Promise<PluginStats> {
  const stats: PluginStats = {
    nodes: 0,
    edges: 0,
    plugins: {},
  };

  try {
    const code = readFileSync(filePath, 'utf-8');
    const ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'] as ParserPlugin[],
      errorRecovery: true,
    });

    for (const pluginName of pluginNames) {
      const analyzer = pluginAnalyzers.get(pluginName);
      if (!analyzer) {
        console.warn(`[Worker ${workerId}] Unknown plugin: ${pluginName}`);
        continue;
      }

      try {
        const pluginStats = await analyzer(filePath, moduleId, moduleName, ast, client!);
        stats.nodes += pluginStats.nodes || 0;
        stats.edges += pluginStats.edges || 0;
        stats.plugins[pluginName] = pluginStats;
      } catch (err) {
        console.error(`[Worker ${workerId}] Plugin ${pluginName} error on ${filePath}:`, (err as Error).message);
        stats.plugins[pluginName] = { error: (err as Error).message };
      }
    }

    return stats;
  } catch (err) {
    throw new Error(`Failed to process ${filePath}: ${(err as Error).message}`);
  }
}

// =============================================================================
// Plugin Implementations
// =============================================================================

/**
 * JSASTAnalyzer - Base AST analysis
 */
async function analyzeJSAST(
  filePath: string,
  moduleId: string,
  moduleName: string,
  ast: t.File,
  client: RFDBClient
): Promise<SinglePluginStats> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let callCounter = 0;

  nodes.push({
    id: moduleId,
    type: 'MODULE',
    name: moduleName,
    file: filePath,
  });

  // Extract imports
  traverse(ast, {
    ImportDeclaration(path: NodePath<t.ImportDeclaration>) {
      const node = path.node;
      const source = node.source.value;

      node.specifiers.forEach((spec) => {
        let importedName: string;
        let localName: string;

        if (spec.type === 'ImportDefaultSpecifier') {
          importedName = 'default';
          localName = spec.local.name;
        } else if (spec.type === 'ImportNamespaceSpecifier') {
          importedName = '*';
          localName = spec.local.name;
        } else {
          const imported = spec.imported;
          importedName = imported.type === 'Identifier' ? imported.name : imported.value;
          localName = spec.local.name;
        }

        const importId = `IMPORT#${localName}#${filePath}#${node.loc?.start.line || 0}`;
        nodes.push({
          id: importId,
          type: 'IMPORT',
          name: localName,
          file: filePath,
          line: node.loc?.start.line || 0,
          importedName,
          source,
        });

        edges.push({ src: moduleId, dst: importId, type: 'CONTAINS' });
      });
    },
  });

  // Extract functions
  traverse(ast, {
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      if (path.getFunctionParent()) return;

      const node = path.node;
      if (!node.id) return;

      const funcName = node.id.name;
      const line = node.loc?.start.line || 0;
      const functionId = `FUNCTION#${funcName}#${filePath}#${line}`;

      nodes.push({
        id: functionId,
        type: 'FUNCTION',
        name: funcName,
        file: filePath,
        line,
        async: node.async || false,
        generator: node.generator || false,
        exported: path.parent?.type?.includes('Export') || false,
      });

      edges.push({ src: moduleId, dst: functionId, type: 'CONTAINS' });

      // Extract parameters
      node.params.forEach((param, index) => {
        if (param.type === 'Identifier') {
          const paramId = `PARAMETER#${param.name}#${functionId}#${index}`;
          nodes.push({
            id: paramId,
            type: 'PARAMETER',
            name: param.name,
            file: filePath,
            index,
          });
          edges.push({ src: functionId, dst: paramId, type: 'HAS_PARAMETER' });
        }
      });
    },

    ArrowFunctionExpression(path: NodePath<t.ArrowFunctionExpression>) {
      if (path.getFunctionParent()) return;
      const parent = path.parent;
      if (parent.type !== 'VariableDeclarator') return;
      const varDecl = parent as t.VariableDeclarator;
      if (!varDecl.id || varDecl.id.type !== 'Identifier') return;

      const funcName = varDecl.id.name;
      const line = path.node.loc?.start.line || 0;
      const functionId = `FUNCTION#${funcName}#${filePath}#${line}`;

      nodes.push({
        id: functionId,
        type: 'FUNCTION',
        name: funcName,
        file: filePath,
        line,
        async: path.node.async || false,
        arrowFunction: true,
      });

      edges.push({ src: moduleId, dst: functionId, type: 'CONTAINS' });
    },
  });

  // Extract classes
  traverse(ast, {
    ClassDeclaration(path: NodePath<t.ClassDeclaration>) {
      if (path.getFunctionParent()) return;

      const node = path.node;
      if (!node.id) return;

      const className = node.id.name;
      const line = node.loc?.start.line || 0;
      const column = node.loc?.start.column || 0;

      // Extract superClass name
      const superClassName = node.superClass && node.superClass.type === 'Identifier'
        ? node.superClass.name
        : null;

      // Create CLASS node using ClassNode.create() (legacy format for workers)
      const classRecord = ClassNode.create(
        className,
        filePath,
        line,
        column,
        { superClass: superClassName || undefined }
      );

      nodes.push(classRecord as unknown as GraphNode);

      edges.push({ src: moduleId, dst: classRecord.id, type: 'CONTAINS' });

      // Extract methods
      node.body.body.forEach((member) => {
        if (member.type === 'ClassMethod' && member.key.type === 'Identifier') {
          const methodName = member.key.name;
          const methodLine = member.loc?.start.line || 0;
          const methodId = `METHOD#${className}.${methodName}#${filePath}#${methodLine}`;

          nodes.push({
            id: methodId,
            type: 'METHOD',
            name: methodName,
            file: filePath,
            line: methodLine,
            className,
            async: member.async || false,
            static: member.static || false,
            isConstructor: member.kind === 'constructor',
          });

          edges.push({ src: classRecord.id, dst: methodId, type: 'CONTAINS' });
        }
      });
    },
  });

  // Extract call expressions
  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      const node = path.node;

      if (node.callee.type === 'Identifier') {
        const line = node.loc?.start.line || 0;
        const callId = `CALL#${node.callee.name}#${filePath}#${line}:${callCounter++}`;

        nodes.push({
          id: callId,
          type: 'CALL',
          name: node.callee.name,
          file: filePath,
          line,
          argsCount: node.arguments.length,
        });

        const parentFunc = path.getFunctionParent();
        if (parentFunc) {
          const parentNode = parentFunc.node as t.FunctionDeclaration | t.ArrowFunctionExpression;
          const parentName = (parentNode as t.FunctionDeclaration).id?.name ||
                             ((parentFunc.parent as t.VariableDeclarator)?.id as t.Identifier)?.name ||
                             'anonymous';
          const parentLine = parentNode.loc?.start.line || 0;
          edges.push({
            src: `FUNCTION#${parentName}#${filePath}#${parentLine}`,
            dst: callId,
            type: 'CONTAINS'
          });
        } else {
          edges.push({ src: moduleId, dst: callId, type: 'CONTAINS' });
        }
      }
    },
  });

  if (nodes.length > 0) {
    await client.addNodes(nodes as Parameters<typeof client.addNodes>[0]);
  }
  if (edges.length > 0) {
    await client.addEdges(edges as Parameters<typeof client.addEdges>[0], true);
  }

  return { nodes: nodes.length, edges: edges.length };
}

/**
 * ExpressRouteAnalyzer - HTTP routes
 */
async function analyzeExpressRoutes(
  filePath: string,
  moduleId: string,
  _moduleName: string,
  ast: t.File,
  client: RFDBClient
): Promise<SinglePluginStats> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all'];

  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      const node = path.node;

      if (node.callee.type === 'MemberExpression' &&
          node.callee.property?.type === 'Identifier' &&
          HTTP_METHODS.includes(node.callee.property.name)) {

        const method = node.callee.property.name.toUpperCase();
        const pathArg = node.arguments[0];

        if (pathArg?.type === 'StringLiteral') {
          const routePath = pathArg.value;
          const line = node.loc?.start.line || 0;
          const routeId = `http:route#${method}#${routePath}#${filePath}#${line}`;

          nodes.push({
            id: routeId,
            type: 'http:route',
            name: `${method} ${routePath}`,
            method,
            path: routePath,
            file: filePath,
            line,
          });

          edges.push({ src: moduleId, dst: routeId, type: 'CONTAINS' });
        }
      }
    },
  });

  if (nodes.length > 0) {
    await client.addNodes(nodes as Parameters<typeof client.addNodes>[0]);
  }
  if (edges.length > 0) {
    await client.addEdges(edges as Parameters<typeof client.addEdges>[0], true);
  }

  return { nodes: nodes.length, edges: edges.length, routes: nodes.length };
}

/**
 * SocketIOAnalyzer - Socket.IO events
 */
async function analyzeSocketIO(
  filePath: string,
  moduleId: string,
  _moduleName: string,
  ast: t.File,
  client: RFDBClient
): Promise<SinglePluginStats> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      const node = path.node;

      if (node.callee.type === 'MemberExpression' &&
          node.callee.property?.type === 'Identifier') {

        const method = node.callee.property.name;
        const line = node.loc?.start.line || 0;

        if (method === 'on' && node.arguments[0]?.type === 'StringLiteral') {
          const eventName = node.arguments[0].value;
          const eventId = `socketio:on#${eventName}#${filePath}#${line}`;

          nodes.push({
            id: eventId,
            type: 'socketio:on',
            name: eventName,
            file: filePath,
            line,
          });

          edges.push({ src: moduleId, dst: eventId, type: 'CONTAINS' });
        }

        if (method === 'emit' && node.arguments[0]?.type === 'StringLiteral') {
          const eventName = node.arguments[0].value;
          const eventId = `socketio:emit#${eventName}#${filePath}#${line}`;

          nodes.push({
            id: eventId,
            type: 'socketio:emit',
            name: eventName,
            file: filePath,
            line,
          });

          edges.push({ src: moduleId, dst: eventId, type: 'CONTAINS' });
        }
      }
    },
  });

  if (nodes.length > 0) {
    await client.addNodes(nodes as Parameters<typeof client.addNodes>[0]);
  }
  if (edges.length > 0) {
    await client.addEdges(edges as Parameters<typeof client.addEdges>[0], true);
  }

  return { nodes: nodes.length, edges: edges.length };
}

/**
 * DatabaseAnalyzer - SQL queries
 */
async function analyzeDatabase(
  filePath: string,
  moduleId: string,
  _moduleName: string,
  ast: t.File,
  client: RFDBClient
): Promise<SinglePluginStats> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      const node = path.node;

      if (node.callee.type === 'MemberExpression' &&
          node.callee.property?.type === 'Identifier') {

        const method = node.callee.property.name;

        if (method === 'query' && node.arguments[0]?.type === 'StringLiteral') {
          const sql = node.arguments[0].value;
          const line = node.loc?.start.line || 0;
          const queryId = `db:query#${filePath}#${line}`;

          nodes.push({
            id: queryId,
            type: 'db:query',
            name: sql.slice(0, 50) + (sql.length > 50 ? '...' : ''),
            sql,
            file: filePath,
            line,
          });

          edges.push({ src: moduleId, dst: queryId, type: 'CONTAINS' });
        }
      }
    },
  });

  if (nodes.length > 0) {
    await client.addNodes(nodes as Parameters<typeof client.addNodes>[0]);
  }
  if (edges.length > 0) {
    await client.addEdges(edges as Parameters<typeof client.addEdges>[0], true);
  }

  return { nodes: nodes.length, edges: edges.length };
}

/**
 * FetchAnalyzer - HTTP requests
 */
async function analyzeFetch(
  filePath: string,
  moduleId: string,
  _moduleName: string,
  ast: t.File,
  client: RFDBClient
): Promise<SinglePluginStats> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      const node = path.node;
      const line = node.loc?.start.line || 0;

      if (node.callee.type === 'Identifier' && node.callee.name === 'fetch') {
        const urlArg = node.arguments[0];
        const url = urlArg?.type === 'StringLiteral' ? urlArg.value : '<dynamic>';

        const requestId = `http:request#${filePath}#${line}`;

        nodes.push({
          id: requestId,
          type: 'http:request',
          name: `fetch ${url.slice(0, 40)}`,
          url,
          file: filePath,
          line,
        });

        edges.push({ src: moduleId, dst: requestId, type: 'CONTAINS' });
      }

      if (node.callee.type === 'MemberExpression' &&
          node.callee.object?.type === 'Identifier' &&
          node.callee.object.name === 'axios') {
        const prop = node.callee.property;
        const method = (prop?.type === 'Identifier' ? prop.name : 'request').toUpperCase();
        const urlArg = node.arguments[0];
        const url = urlArg?.type === 'StringLiteral' ? urlArg.value : '<dynamic>';

        const requestId = `http:request#${filePath}#${line}`;

        nodes.push({
          id: requestId,
          type: 'http:request',
          name: `${method} ${url.slice(0, 40)}`,
          url,
          method,
          file: filePath,
          line,
        });

        edges.push({ src: moduleId, dst: requestId, type: 'CONTAINS' });
      }
    },
  });

  if (nodes.length > 0) {
    await client.addNodes(nodes as Parameters<typeof client.addNodes>[0]);
  }
  if (edges.length > 0) {
    await client.addEdges(edges as Parameters<typeof client.addEdges>[0], true);
  }

  return { nodes: nodes.length, edges: edges.length };
}

/**
 * ReactAnalyzer - React components
 */
async function analyzeReact(
  filePath: string,
  moduleId: string,
  _moduleName: string,
  ast: t.File,
  client: RFDBClient
): Promise<SinglePluginStats> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  traverse(ast, {
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      const node = path.node;
      if (!node.id) return;

      const name = node.id.name;
      if (name[0] === name[0].toUpperCase()) {
        let returnsJSX = false;
        path.traverse({
          ReturnStatement(retPath: NodePath<t.ReturnStatement>) {
            if (retPath.node.argument?.type === 'JSXElement' ||
                retPath.node.argument?.type === 'JSXFragment') {
              returnsJSX = true;
            }
          },
        });

        if (returnsJSX) {
          const line = node.loc?.start.line || 0;
          const componentId = `react:component#${name}#${filePath}#${line}`;
          nodes.push({
            id: componentId,
            type: 'react:component',
            name,
            file: filePath,
            line,
          });
          edges.push({ src: moduleId, dst: componentId, type: 'CONTAINS' });
        }
      }
    },

    CallExpression(path: NodePath<t.CallExpression>) {
      const node = path.node;
      if (node.callee.type === 'Identifier' && node.callee.name.startsWith('use')) {
        const hookName = node.callee.name;
        const line = node.loc?.start.line || 0;
        const hookId = `react:hook#${hookName}#${filePath}#${line}`;

        let hookType = 'react:hook';
        if (hookName === 'useState') hookType = 'react:state';
        if (hookName === 'useEffect' || hookName === 'useLayoutEffect') hookType = 'react:effect';
        if (hookName === 'useRef') hookType = 'react:ref';

        nodes.push({
          id: hookId,
          type: hookType,
          name: hookName,
          file: filePath,
          line,
        });

        edges.push({ src: moduleId, dst: hookId, type: 'CONTAINS' });
      }
    },
  });

  if (nodes.length > 0) {
    await client.addNodes(nodes as Parameters<typeof client.addNodes>[0]);
  }
  if (edges.length > 0) {
    await client.addEdges(edges as Parameters<typeof client.addEdges>[0], true);
  }

  return { nodes: nodes.length, edges: edges.length };
}

// =============================================================================
// Message Handler
// =============================================================================

parentPort?.on('message', async (msg: IncomingMessage) => {
  switch (msg.type) {
    case 'process':
      try {
        const stats = await processFile(
          msg.taskId,
          msg.file,
          msg.moduleId,
          msg.moduleName,
          msg.plugins
        );
        parentPort?.postMessage({
          type: 'done',
          taskId: msg.taskId,
          file: msg.file,
          stats,
          workerId,
        } as DoneMessage);
      } catch (err) {
        parentPort?.postMessage({
          type: 'error',
          taskId: msg.taskId,
          file: msg.file,
          error: (err as Error).message,
          workerId,
        } as ErrorMessage);
      }
      break;

    case 'exit':
      if (client) {
        await client.close();
      }
      process.exit(0);
      break;
  }
});

// Auto-connect on start
connect().catch((err: Error) => {
  parentPort?.postMessage({ type: 'error', error: err.message } as ErrorMessage);
});
