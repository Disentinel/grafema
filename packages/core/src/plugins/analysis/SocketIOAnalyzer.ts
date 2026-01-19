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
import { parse, ParserPlugin } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { CallExpression, Identifier, MemberExpression, Node } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      priority: 75, // После JSASTAnalyzer (80)
      creates: {
        nodes: ['socketio:emit', 'socketio:on', 'socketio:room'],
        edges: ['CONTAINS', 'EMITS_EVENT', 'LISTENS_TO', 'JOINS_ROOM']
      },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    try {
      const { graph } = context;

      // Получаем все модули
      const modules = await this.getModules(graph);
      console.log(`[SocketIOAnalyzer] Processing ${modules.length} modules...`);

      let emitsCount = 0;
      let listenersCount = 0;
      let roomsCount = 0;
      const startTime = Date.now();

      for (let i = 0; i < modules.length; i++) {
        const module = modules[i];
        const result = await this.analyzeModule(module, graph);
        emitsCount += result.emits;
        listenersCount += result.listeners;
        roomsCount += result.rooms;

        // Progress every 20 modules
        if ((i + 1) % 20 === 0 || i === modules.length - 1) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const avgTime = ((Date.now() - startTime) / (i + 1)).toFixed(0);
          console.log(
            `[SocketIOAnalyzer] Progress: ${i + 1}/${modules.length} (${elapsed}s, avg ${avgTime}ms/module)`
          );
        }
      }

      console.log(
        `[SocketIOAnalyzer] Found ${emitsCount} emits, ${listenersCount} listeners, ${roomsCount} rooms`
      );

      return createSuccessResult(
        {
          nodes: emitsCount + listenersCount + roomsCount,
          edges: 0
        },
        { emitsCount, listenersCount, roomsCount }
      );
    } catch (error) {
      console.error('[SocketIOAnalyzer] Error:', error);
      return createErrorResult(error as Error);
    }
  }

  private async analyzeModule(
    module: NodeRecord,
    graph: PluginContext['graph']
  ): Promise<AnalysisResult> {
    try {
      const code = readFileSync(module.file!, 'utf-8');

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
            const line = node.loc!.start.line;
            const column = node.loc!.start.column;

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
            const line = node.loc!.start.line;
            const handler = node.arguments[1];

            // Извлекаем имя handler функции
            let handlerName = 'anonymous';
            let handlerLine = line;
            if (handler) {
              if (
                handler.type === 'FunctionExpression' ||
                handler.type === 'ArrowFunctionExpression'
              ) {
                handlerName = `anonymous:${handler.loc!.start.line}`;
                handlerLine = handler.loc!.start.line;
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
              line: line
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
            const line = node.loc!.start.line;

            if (objectName === 'socket') {
              rooms.push({
                id: `socketio:room#${roomName}#${module.file}#${line}`,
                type: 'socketio:room',
                room: roomName,
                objectName: objectName,
                file: module.file!,
                line: line
              });
            }
          }
        }
      });

      // Создаём ноды в графе
      for (const emit of emits) {
        await graph.addNode(emit as unknown as NodeRecord);

        // Создаём ребро от модуля к event
        await graph.addEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: emit.id
        });
      }

      for (const listener of listeners) {
        await graph.addNode(listener as unknown as NodeRecord);

        // Создаём ребро от модуля к listener
        await graph.addEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: listener.id
        });

        // Ищем FUNCTION node для handler и создаём ребро LISTENS_TO
        const handlerFunctionId = `FUNCTION#${listener.handlerName}#${listener.file}#${listener.handlerLine}`;
        const handlerFunction = await graph.getNode(handlerFunctionId);

        if (handlerFunction) {
          await graph.addEdge({
            type: 'LISTENS_TO',
            src: listener.id,
            dst: handlerFunctionId
          });
        }
      }

      for (const room of rooms) {
        await graph.addNode(room as unknown as NodeRecord);

        // Создаём ребро от модуля к room
        await graph.addEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: room.id
        });
      }

      return {
        emits: emits.length,
        listeners: listeners.length,
        rooms: rooms.length
      };
    } catch (error) {
      console.error(
        `[SocketIOAnalyzer] Error analyzing ${module.file}:`,
        (error as Error).message
      );
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
