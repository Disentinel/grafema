/**
 * SocketIOAnalyzer - детектит Socket.IO operations
 *
 * Паттерны Server:
 * - io.emit(event, data)
 * - io.to(room).emit(event, data)
 * - io.of(namespace).emit(event, data)
 * - socket.on(event, handler)
 * - socket.join(room)
 * - socket.broadcast.emit(event, data)
 *
 * Паттерны Client:
 * - socket.emit(event, data)
 * - socket.on(event, handler)
 * - socket.off(event, handler)
 */

import { readFileSync } from 'fs';
import type { ParserPlugin } from '@babel/parser';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { CallExpression, Identifier, MemberExpression, Node } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord, AnyBrandedNode } from '@grafema/types';
import { NodeFactory } from '../../core/NodeFactory.js';
import { getLine, getColumn } from './ast/utils/location.js';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';

 
const traverse = (traverseModule as any).default || traverseModule;

/**
 * Socket emit node
 */
interface SocketEmitNode {
  id: string;
  type: 'socketio:emit';
  event: string;
  room: string | null;
  namespace: string | null;
  broadcast: boolean;
  objectName: string;
  file: string;
  line: number;
  column: number;
}

/**
 * Socket listener node
 */
interface SocketListenerNode {
  id: string;
  type: 'socketio:on';
  event: string;
  objectName: string;
  handlerName: string;
  handlerLine: number;
  file: string;
  line: number;
  column: number;
}

/**
 * Socket room node
 */
interface SocketRoomNode {
  id: string;
  type: 'socketio:room';
  room: string;
  objectName: string;
  file: string;
  line: number;
  column: number;
}

/**
 * Analysis result
 */
interface AnalysisResult {
  emits: number;
  listeners: number;
  rooms: number;
}

export class SocketIOAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'SocketIOAnalyzer',
      phase: 'ANALYSIS',
      covers: ['socket.io', 'socket.io-client'],
      creates: {
        nodes: ['socketio:emit', 'socketio:on', 'socketio:room', 'socketio:event'],
        edges: ['CONTAINS', 'EMITS_EVENT', 'LISTENS_TO', 'JOINS_ROOM', 'LISTENED_BY']
      },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);

    try {
      const { graph, onProgress } = context;
      const factory = this.getFactory(context);
      const projectPath = (context.manifest as { projectPath?: string })?.projectPath ?? '';

      // Получаем все модули
      const modules = await this.getModules(graph);
      logger.info('Processing modules', { count: modules.length });

      let emitsCount = 0;
      let listenersCount = 0;
      let roomsCount = 0;
      const startTime = Date.now();

      // PHASE 1: Analyze modules and create emit/listener/room nodes
      for (let i = 0; i < modules.length; i++) {
        const module = modules[i];
        const result = await this.analyzeModule(module, graph, projectPath, factory);
        emitsCount += result.emits;
        listenersCount += result.listeners;
        roomsCount += result.rooms;

        // Progress every 20 modules
        if ((i + 1) % 20 === 0 || i === modules.length - 1) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const avgTime = ((Date.now() - startTime) / (i + 1)).toFixed(0);
          logger.debug('Progress', {
            current: i + 1,
            total: modules.length,
            elapsed: `${elapsed}s`,
            avgTime: `${avgTime}ms/module`
          });
          onProgress?.({
            phase: 'analysis',
            currentPlugin: 'SocketIOAnalyzer',
            message: `Processing modules ${i + 1}/${modules.length}`,
            totalFiles: modules.length,
            processedFiles: i + 1,
          });
        }
      }

      // PHASE 2: Create event channel nodes and edges
      const eventCount = await this.createEventChannels(graph, logger, factory);

      logger.info('Analysis complete', {
        emitsCount,
        listenersCount,
        roomsCount,
        eventCount
      });

      return createSuccessResult(
        {
          nodes: emitsCount + listenersCount + roomsCount + eventCount,
          edges: 0
        },
        { emitsCount, listenersCount, roomsCount, eventCount }
      );
    } catch (error) {
      logger.error('Analysis failed', { error });
      const err = error instanceof Error ? error : new Error(String(error));
      return createErrorResult(err);
    }
  }

  /**
   * Create event channel nodes and connect them to emits/listeners
   *
   * This runs AFTER all modules are analyzed, so all emit/listener nodes exist.
   * Creates one socketio:event node per unique event name, then connects:
   * - socketio:emit → EMITS_EVENT → socketio:event
   * - socketio:event → LISTENED_BY → socketio:on
   */
  private async createEventChannels(
    graph: PluginContext['graph'],
    logger: ReturnType<typeof this.log>,
    factory: PluginContext['factory'],
  ): Promise<number> {
    try {
      // Step 1: Get all emit and listener nodes
      const allEmits: NodeRecord[] = [];
      for await (const node of graph.queryNodes({ nodeType: 'socketio:emit' })) {
        allEmits.push(node);
      }
      const allListeners: NodeRecord[] = [];
      for await (const node of graph.queryNodes({ nodeType: 'socketio:on' })) {
        allListeners.push(node);
      }

      logger.debug('Creating event channels', {
        emits: allEmits.length,
        listeners: allListeners.length
      });

      // Step 2: Extract unique event names
      const eventNames = new Set<string>();

      for (const emit of allEmits) {
        if (emit.event && typeof emit.event === 'string') {
          eventNames.add(emit.event);
        }
      }

      for (const listener of allListeners) {
        if (listener.event && typeof listener.event === 'string') {
          eventNames.add(listener.event);
        }
      }

      logger.debug('Unique events found', { count: eventNames.size });

      // Step 3: Create event channel node for each unique event
      const nodes: AnyBrandedNode[] = [];
      const edges: Array<{ type: string; src: string; dst: string }> = [];
      let createdCount = 0;

      for (const eventName of eventNames) {
        const eventNodeId = `socketio:event#${eventName}`;

        // Create event channel node via factory
        const brandedNode = NodeFactory.createSocketIOEvent(eventName);
        nodes.push(brandedNode);
        createdCount++;

        // Step 4: Connect all emits of this event to the channel
        const matchingEmits = allEmits.filter(e => e.event === eventName);
        for (const emit of matchingEmits) {
          edges.push({
            type: 'EMITS_EVENT',
            src: emit.id,
            dst: eventNodeId
          });
        }

        // Step 5: Connect event channel to all listeners of this event
        const matchingListeners = allListeners.filter(l => l.event === eventName);
        for (const listener of matchingListeners) {
          edges.push({
            type: 'LISTENED_BY',
            src: eventNodeId,
            dst: listener.id
          });
        }

        logger.debug('Created event channel', {
          event: eventName,
          emits: matchingEmits.length,
          listeners: matchingListeners.length
        });
      }

      // Flush all nodes and edges
      await factory!.storeMany(nodes);
      await factory!.linkMany(edges);

      return createdCount;
    } catch (error) {
      logger.error('Failed to create event channels', { error });
      return 0;
    }
  }

  private async analyzeModule(
    module: NodeRecord,
    graph: PluginContext['graph'],
    projectPath: string,
    factory: PluginContext['factory'],
  ): Promise<AnalysisResult> {
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

      const emits: SocketEmitNode[] = [];
      const listeners: SocketListenerNode[] = [];
      const rooms: SocketRoomNode[] = [];

      // Детект Socket.IO паттернов
      traverse(ast, {
        CallExpression: (path: NodePath<CallExpression>) => {
          const node = path.node;
          const callee = node.callee;

          // Pattern: socket.emit(event, data) или io.emit(event, data)
          if (
            callee.type === 'MemberExpression' &&
            (callee.property as Identifier).type === 'Identifier' &&
            (callee.property as Identifier).name === 'emit'
          ) {
            const objectName = this.getObjectName(callee.object);
            const event = this.extractStringArg(node.arguments[0]);
            const line = getLine(node);
            const column = getColumn(node);

            // io.to('room').emit() - room-based emit
            let room: string | null = null;
            if (
              callee.object.type === 'CallExpression' &&
              (callee.object.callee as MemberExpression).type === 'MemberExpression' &&
              ((callee.object.callee as MemberExpression).property as Identifier).name === 'to'
            ) {
              room = this.extractStringArg(callee.object.arguments[0]);
            }

            // io.of('/namespace').emit() - namespace emit
            let namespace: string | null = null;
            if (
              callee.object.type === 'CallExpression' &&
              (callee.object.callee as MemberExpression).type === 'MemberExpression' &&
              ((callee.object.callee as MemberExpression).property as Identifier).name === 'of'
            ) {
              namespace = this.extractStringArg(callee.object.arguments[0]);
            }

            // socket.broadcast.emit() - broadcast to all except sender
            let broadcast = false;
            if (
              callee.object.type === 'MemberExpression' &&
              ((callee.object as MemberExpression).property as Identifier).name === 'broadcast'
            ) {
              broadcast = true;
            }

            emits.push({
              id: `socketio:emit#${event}#${module.file}#${line}`,
              type: 'socketio:emit',
              event: event,
              room: room,
              namespace: namespace,
              broadcast: broadcast,
              objectName: objectName,
              file: module.file!,
              line: line,
              column: column
            });
          }

          // Pattern: socket.on(event, handler) или io.on(event, handler)
          if (
            callee.type === 'MemberExpression' &&
            (callee.property as Identifier).type === 'Identifier' &&
            (callee.property as Identifier).name === 'on'
          ) {
            const objectName = this.getObjectName(callee.object);
            const event = this.extractStringArg(node.arguments[0]);
            const line = getLine(node);
            const handler = node.arguments[1];

            // Извлекаем имя handler функции
            let handlerName = 'anonymous';
            let handlerLine = line;
            if (handler) {
              if (
                handler.type === 'FunctionExpression' ||
                handler.type === 'ArrowFunctionExpression'
              ) {
                handlerName = `anonymous:${getLine(handler)}`;
                handlerLine = getLine(handler);
              } else if (handler.type === 'Identifier') {
                handlerName = (handler as Identifier).name;
              }
            }

            listeners.push({
              id: `socketio:on#${event}#${module.file}#${line}`,
              type: 'socketio:on',
              event: event,
              objectName: objectName,
              handlerName: handlerName,
              handlerLine: handlerLine,
              file: module.file!,
              line: line,
              column: getColumn(node)
            });
          }

          // Pattern: socket.join(room)
          if (
            callee.type === 'MemberExpression' &&
            (callee.property as Identifier).type === 'Identifier' &&
            (callee.property as Identifier).name === 'join'
          ) {
            const objectName = this.getObjectName(callee.object);
            const roomName = this.extractStringArg(node.arguments[0]);
            const line = getLine(node);

            if (objectName === 'socket') {
              rooms.push({
                id: `socketio:room#${roomName}#${module.file}#${line}`,
                type: 'socketio:room',
                room: roomName,
                objectName: objectName,
                file: module.file!,
                line: line,
                column: getColumn(node)
              });
            }
          }
        }
      });

      // Create branded nodes via factory
      const nodes: AnyBrandedNode[] = [];
      const edges: Array<{ type: string; src: string; dst: string }> = [];

      for (const emit of emits) {
        nodes.push(NodeFactory.createSocketIOEmit(
          emit.event, emit.objectName, emit.file, emit.line, emit.column,
          { room: emit.room, namespace: emit.namespace, broadcast: emit.broadcast }
        ));

        edges.push({
          type: 'CONTAINS',
          src: module.id,
          dst: emit.id
        });
      }

      for (const listener of listeners) {
        nodes.push(NodeFactory.createSocketIOListener(
          listener.event, listener.objectName, listener.handlerName,
          listener.handlerLine, listener.file, listener.line, listener.column
        ));

        edges.push({
          type: 'CONTAINS',
          src: module.id,
          dst: listener.id
        });

        // Find FUNCTION node for handler by name and file (supports both legacy and semantic IDs)
        const handlerFunctions: NodeRecord[] = [];
        for await (const node of graph.queryNodes({
          nodeType: 'FUNCTION',
          name: listener.handlerName,
          file: listener.file
        })) {
          handlerFunctions.push(node);
        }

        // Find the handler at the matching line
        const handlerFunction = handlerFunctions.find(fn =>
          fn.line === listener.handlerLine
        );

        if (handlerFunction) {
          edges.push({
            type: 'LISTENS_TO',
            src: listener.id,
            dst: handlerFunction.id
          });
        }
      }

      for (const room of rooms) {
        nodes.push(NodeFactory.createSocketIORoom(
          room.room, room.objectName, room.file, room.line, room.column
        ));

        edges.push({
          type: 'CONTAINS',
          src: module.id,
          dst: room.id
        });
      }

      // Flush all nodes and edges
      await factory!.storeMany(nodes);
      await factory!.linkMany(edges);

      return {
        emits: emits.length,
        listeners: listeners.length,
        rooms: rooms.length
      };
    } catch {
      // Silent - per-module errors shouldn't spam logs
      return { emits: 0, listeners: 0, rooms: 0 };
    }
  }

  /**
   * Извлекает имя объекта из MemberExpression
   * Например: socket.emit → 'socket', io.to('room').emit → 'io'
   */
  private getObjectName(node: Node): string {
    if (node.type === 'Identifier') {
      return (node as Identifier).name;
    } else if (node.type === 'MemberExpression') {
      return this.getObjectName((node as MemberExpression).object);
    } else if (node.type === 'CallExpression') {
      return this.getObjectName((node as CallExpression).callee);
    }
    return 'unknown';
  }

  /**
   * Извлекает строковое значение из аргумента
   */
  private extractStringArg(arg: Node | undefined): string {
    if (!arg) return 'unknown';

    if (arg.type === 'StringLiteral') {
      return (arg as { value: string }).value;
    } else if (arg.type === 'TemplateLiteral') {
      const tl = arg as { quasis: Array<{ value: { raw: string } }>; expressions: unknown[] };
      if (tl.quasis.length === 1) {
        // Простой template literal без интерполяции
        return tl.quasis[0].value.raw;
      } else {
        // Template literal с переменными - возвращаем паттерн
        const parts = tl.quasis.map(q => q.value.raw);
        const expressions = tl.expressions.map(() => '${...}');

        let result = '';
        for (let i = 0; i < parts.length; i++) {
          result += parts[i];
          if (i < expressions.length) {
            result += expressions[i];
          }
        }
        return result;
      }
    }

    return 'dynamic';
  }
}
