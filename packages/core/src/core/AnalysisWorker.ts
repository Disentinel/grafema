/**
 * AnalysisWorker - worker thread for parallel AST analysis
 *
 * Each worker:
 * 1. Connects to RFDB server
 * 2. Receives file paths to analyze
 * 3. Parses AST and writes nodes/edges directly to RFDB
 *
 * Communication:
 *   Main -> Worker: { type: 'analyze', file, moduleId, moduleName }
 *   Worker -> Main: { type: 'done', file, stats } | { type: 'error', file, error }
 */

import { parentPort, workerData } from 'worker_threads';
import { readFileSync } from 'fs';
import { parse, ParserPlugin } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { ImportDeclaration, FunctionDeclaration, ArrowFunctionExpression, ClassDeclaration, CallExpression, Identifier } from '@babel/types';
import type { NodePath } from '@babel/traverse';

import { RFDBClient } from '@grafema/rfdb-client';
import { ClassNode } from './nodes/ClassNode.js';
import { ImportNode } from './nodes/ImportNode.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse = (traverseModule as any).default || traverseModule;

/**
 * Worker data from main thread
 */
interface WorkerDataInput {
  workerId?: number;
  socketPath?: string;
  autoConnect?: boolean;
}

/**
 * Message types from main thread
 */
interface ConnectMessage {
  type: 'connect';
  socketPath?: string;
}

interface AnalyzeMessage {
  type: 'analyze';
  file: string;
  moduleId: string;
  moduleName: string;
}

interface DisconnectMessage {
  type: 'disconnect';
}

interface ExitMessage {
  type: 'exit';
}

type WorkerMessage = ConnectMessage | AnalyzeMessage | DisconnectMessage | ExitMessage;

/**
 * Analysis stats
 */
interface AnalysisStats {
  nodes: number;
  edges: number;
  functions: number;
  calls: number;
}

/**
 * Wire node for RFDB
 */
interface WireNode {
  id: string;
  type: string;
  name: string;
  file: string;
  metadata?: string;
}

/**
 * Wire edge for RFDB
 */
interface WireEdge {
  src: string;
  dst: string;
  type: string;
}

// Worker state
let client: RFDBClient | null = null;
const workerId = (workerData as WorkerDataInput)?.workerId || 0;
let socketPath = (workerData as WorkerDataInput)?.socketPath || '/tmp/rfdb.sock';
let connected = false;

/**
 * Connect to RFDB server
 */
async function connect(): Promise<void> {
  if (connected) return;

  client = new RFDBClient(socketPath);
  await client.connect();
  connected = true;

  parentPort?.postMessage({ type: 'ready', workerId });
}

/**
 * Parse a file and write results directly to RFDB
 */
async function analyzeFile(filePath: string, moduleId: string, moduleName: string): Promise<AnalysisStats> {
  const stats: AnalysisStats = { nodes: 0, edges: 0, functions: 0, calls: 0 };

  try {
    const code = readFileSync(filePath, 'utf-8');

    const ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'] as ParserPlugin[],
      errorRecovery: true
    });

    // Collections to batch write
    const nodes: WireNode[] = [];
    const edges: WireEdge[] = [];

    // Counters for unique IDs
    let callCounter = 0;

    // Add module node
    nodes.push({
      id: moduleId,
      type: 'MODULE',
      name: moduleName,
      file: filePath
    });

    // Extract imports
    traverse(ast, {
      ImportDeclaration(path: NodePath<ImportDeclaration>) {
        const node = path.node;
        const source = node.source.value;

        node.specifiers.forEach(spec => {
          let importedName: string;
          let localName: string;

          if (spec.type === 'ImportDefaultSpecifier') {
            importedName = 'default';
            localName = spec.local.name;
          } else if (spec.type === 'ImportNamespaceSpecifier') {
            importedName = '*';
            localName = spec.local.name;
          } else {
            importedName = (spec.imported as Identifier)?.name || spec.local.name;
            localName = spec.local.name;
          }

          const importNode = ImportNode.create(
            localName,      // name
            filePath,       // file
            node.loc!.start.line,  // line
            0,              // column (not available in this worker)
            source,         // source
            { imported: importedName, local: localName }
          );
          nodes.push({
            id: importNode.id,
            type: importNode.type,
            name: importNode.name,
            file: importNode.file,
            metadata: JSON.stringify({
              importedName: importNode.imported,
              source: importNode.source,
              line: importNode.line,
              importType: importNode.importType,
              importBinding: importNode.importBinding
            })
          });

          edges.push({ src: moduleId, dst: importNode.id, type: 'CONTAINS' });
        });
      }
    });

    // Extract functions
    traverse(ast, {
      FunctionDeclaration(path: NodePath<FunctionDeclaration>) {
        if (path.getFunctionParent()) return;

        const node = path.node;
        if (!node.id) return;

        const funcName = node.id.name;
        const functionId = `FUNCTION#${funcName}#${filePath}#${node.loc!.start.line}`;

        nodes.push({
          id: functionId,
          type: 'FUNCTION',
          name: funcName,
          file: filePath,
          metadata: JSON.stringify({
            line: node.loc!.start.line,
            async: node.async || false,
            generator: node.generator || false,
            exported: path.parent?.type?.includes('Export') || false
          })
        });

        edges.push({ src: moduleId, dst: functionId, type: 'CONTAINS' });
        stats.functions++;

        // Extract parameters
        node.params.forEach((param, index) => {
          if (param.type === 'Identifier') {
            const paramId = `PARAMETER#${param.name}#${functionId}#${index}`;
            nodes.push({
              id: paramId,
              type: 'PARAMETER',
              name: param.name,
              file: filePath,
              metadata: JSON.stringify({ index, functionId })
            });
            edges.push({ src: functionId, dst: paramId, type: 'CONTAINS' });
          }
        });
      },

      ArrowFunctionExpression(path: NodePath<ArrowFunctionExpression>) {
        // Only process top-level arrow functions assigned to variables
        if (path.getFunctionParent()) return;

        const parent = path.parent;
        if (parent.type !== 'VariableDeclarator') return;
        if (!('id' in parent) || !parent.id || parent.id.type !== 'Identifier') return;

        const funcName = parent.id.name;
        const functionId = `FUNCTION#${funcName}#${filePath}#${path.node.loc!.start.line}`;

        nodes.push({
          id: functionId,
          type: 'FUNCTION',
          name: funcName,
          file: filePath,
          metadata: JSON.stringify({
            line: path.node.loc!.start.line,
            async: path.node.async || false,
            arrowFunction: true
          })
        });

        edges.push({ src: moduleId, dst: functionId, type: 'CONTAINS' });
        stats.functions++;
      }
    });

    // Extract classes
    traverse(ast, {
      ClassDeclaration(path: NodePath<ClassDeclaration>) {
        if (path.getFunctionParent()) return;

        const node = path.node;
        if (!node.id) return;

        const className = node.id.name;
        const superClassName = (node.superClass as Identifier)?.name || null;

        // Use ClassNode.create() for consistent ID format
        const classRecord = ClassNode.create(
          className,
          filePath,
          node.loc!.start.line,
          node.loc!.start.column || 0,
          { superClass: superClassName || undefined }
        );

        nodes.push({
          id: classRecord.id,
          type: 'CLASS',
          name: className,
          file: filePath,
          metadata: JSON.stringify({
            line: node.loc!.start.line,
            superClass: superClassName
          })
        });

        edges.push({ src: moduleId, dst: classRecord.id, type: 'CONTAINS' });

        // Extract methods
        node.body.body.forEach(member => {
          if (member.type === 'ClassMethod' && member.key.type === 'Identifier') {
            const methodName = member.key.name;
            const methodId = `METHOD#${className}.${methodName}#${filePath}#${member.loc!.start.line}`;

            nodes.push({
              id: methodId,
              type: 'METHOD',
              name: methodName,
              file: filePath,
              metadata: JSON.stringify({
                className,
                line: member.loc!.start.line,
                async: member.async || false,
                static: member.static || false,
                isConstructor: member.kind === 'constructor'
              })
            });

            edges.push({ src: classRecord.id, dst: methodId, type: 'CONTAINS' });
            stats.functions++;
          }
        });
      }
    });

    // Extract call expressions (simplified)
    traverse(ast, {
      CallExpression(path: NodePath<CallExpression>) {
        const node = path.node;

        if (node.callee.type === 'Identifier') {
          const callId = `CALL#${node.callee.name}#${filePath}#${node.loc!.start.line}:${callCounter++}`;

          nodes.push({
            id: callId,
            type: 'CALL',
            name: node.callee.name,
            file: filePath,
            metadata: JSON.stringify({
              line: node.loc!.start.line,
              argsCount: node.arguments.length
            })
          });

          // Find parent function to connect
          const parentFunc = path.getFunctionParent();
          if (parentFunc) {
            const parentName =
              (parentFunc.node as { id?: Identifier }).id?.name ||
              ((parentFunc.parent as { id?: Identifier })?.id?.name) ||
              'anonymous';
            edges.push({
              src: `FUNCTION#${parentName}#${filePath}#${parentFunc.node.loc!.start.line}`,
              dst: callId,
              type: 'CONTAINS'
            });
          } else {
            edges.push({ src: moduleId, dst: callId, type: 'CONTAINS' });
          }

          stats.calls++;
        }
      }
    });

    // Batch write to RFDB
    if (nodes.length > 0 && client) {
      await client.addNodes(nodes);
      stats.nodes = nodes.length;
    }

    if (edges.length > 0 && client) {
      await client.addEdges(edges, true); // skipValidation for speed
      stats.edges = edges.length;
    }

    return stats;
  } catch (err) {
    throw new Error(`Failed to analyze ${filePath}: ${(err as Error).message}`);
  }
}

/**
 * Handle messages from main thread
 */
if (parentPort) {
  parentPort.on('message', async (msg: WorkerMessage) => {
    switch (msg.type) {
      case 'connect':
        try {
          socketPath = msg.socketPath || socketPath;
          await connect();
        } catch (err) {
          parentPort!.postMessage({ type: 'error', error: (err as Error).message });
        }
        break;

      case 'analyze':
        try {
          const stats = await analyzeFile(msg.file, msg.moduleId, msg.moduleName);
          parentPort!.postMessage({
            type: 'done',
            file: msg.file,
            stats,
            workerId
          });
        } catch (err) {
          parentPort!.postMessage({
            type: 'error',
            file: msg.file,
            error: (err as Error).message,
            workerId
          });
        }
        break;

      case 'disconnect':
        if (client) {
          await client.close();
          connected = false;
        }
        parentPort!.postMessage({ type: 'disconnected', workerId });
        break;

      case 'exit':
        if (client) {
          await client.close();
        }
        process.exit(0);
        break;
    }
  });

  // Auto-connect on start if socketPath provided
  if ((workerData as WorkerDataInput)?.autoConnect) {
    connect().catch(err => {
      parentPort!.postMessage({ type: 'error', error: (err as Error).message });
    });
  }
}
