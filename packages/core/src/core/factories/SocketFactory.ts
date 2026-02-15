/**
 * SocketFactory - factory methods for Socket.IO and net socket graph nodes
 *
 * Handles: socketio:emit, socketio:on, socketio:room, socketio:event,
 * os:unix-socket, net:tcp-connection, os:unix-server, net:tcp-server
 */

import {
  SocketIONode,
  SocketConnectionNode,
} from '../nodes/index.js';

import { brandNodeInternal } from '../brandNodeInternal.js';

export class SocketFactory {
  static createSocketIOEmit(
    event: string,
    objectName: string,
    file: string,
    line: number,
    column: number,
    options: { room?: string | null; namespace?: string | null; broadcast?: boolean } = {}
  ) {
    return brandNodeInternal(SocketIONode.createEmit(event, objectName, file, line, column, options));
  }

  static createSocketIOListener(
    event: string,
    objectName: string,
    handlerName: string,
    handlerLine: number,
    file: string,
    line: number,
    column: number
  ) {
    return brandNodeInternal(SocketIONode.createListener(event, objectName, handlerName, handlerLine, file, line, column));
  }

  static createSocketIORoom(
    roomName: string,
    objectName: string,
    file: string,
    line: number,
    column: number
  ) {
    return brandNodeInternal(SocketIONode.createRoom(roomName, objectName, file, line, column));
  }

  static createSocketIOEvent(eventName: string) {
    return brandNodeInternal(SocketIONode.createEvent(eventName));
  }

  static createUnixSocket(
    path: string,
    file: string,
    line: number,
    column: number,
    options: { library?: string } = {}
  ) {
    return brandNodeInternal(SocketConnectionNode.createUnixSocket(path, file, line, column, options));
  }

  static createTcpConnection(
    host: string,
    port: number,
    file: string,
    line: number,
    column: number,
    options: { library?: string } = {}
  ) {
    return brandNodeInternal(SocketConnectionNode.createTcpConnection(host, port, file, line, column, options));
  }

  static createUnixServer(
    path: string,
    file: string,
    line: number,
    column: number,
    options: { library?: string; backlog?: number } = {}
  ) {
    return brandNodeInternal(SocketConnectionNode.createUnixServer(path, file, line, column, options));
  }

  static createTcpServer(
    host: string,
    port: number,
    file: string,
    line: number,
    column: number,
    options: { library?: string; backlog?: number } = {}
  ) {
    return brandNodeInternal(SocketConnectionNode.createTcpServer(host, port, file, line, column, options));
  }
}
