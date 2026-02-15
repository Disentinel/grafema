/**
 * SocketIONode - contract for Socket.IO domain-specific nodes
 *
 * Types: socketio:emit, socketio:on, socketio:room, socketio:event
 *
 * ID formats:
 * - socketio:emit#<event>#<file>#<line>
 * - socketio:on#<event>#<file>#<line>
 * - socketio:room#<roomName>#<file>#<line>
 * - socketio:event#<eventName> (singleton per event name)
 */

import type { BaseNodeRecord } from '@grafema/types';
import { getNamespace } from './NodeKind.js';

// --- Emit ---

export interface SocketIOEmitNodeRecord extends BaseNodeRecord {
  type: 'socketio:emit';
  event: string;
  room: string | null;
  namespace: string | null;
  broadcast: boolean;
  objectName: string;
  column: number;
}

// --- Listener ---

export interface SocketIOListenerNodeRecord extends BaseNodeRecord {
  type: 'socketio:on';
  event: string;
  objectName: string;
  handlerName: string;
  handlerLine: number;
  column: number;
}

// --- Room ---

export interface SocketIORoomNodeRecord extends BaseNodeRecord {
  type: 'socketio:room';
  room: string;
  objectName: string;
  column: number;
}

// --- Event Channel ---

export interface SocketIOEventNodeRecord extends BaseNodeRecord {
  type: 'socketio:event';
  event: string;
}

export class SocketIONode {
  static readonly REQUIRED = ['id', 'type'] as const;

  /**
   * Create a socketio:emit node.
   */
  static createEmit(
    event: string,
    objectName: string,
    file: string,
    line: number,
    column: number,
    options: { room?: string | null; namespace?: string | null; broadcast?: boolean } = {}
  ): SocketIOEmitNodeRecord {
    if (!event) throw new Error('SocketIONode.createEmit: event is required');
    if (!file) throw new Error('SocketIONode.createEmit: file is required');

    return {
      id: `socketio:emit#${event}#${file}#${line}`,
      type: 'socketio:emit',
      name: event,
      event,
      room: options.room ?? null,
      namespace: options.namespace ?? null,
      broadcast: options.broadcast ?? false,
      objectName,
      file,
      line,
      column
    };
  }

  /**
   * Create a socketio:on listener node.
   */
  static createListener(
    event: string,
    objectName: string,
    handlerName: string,
    handlerLine: number,
    file: string,
    line: number,
    column: number
  ): SocketIOListenerNodeRecord {
    if (!event) throw new Error('SocketIONode.createListener: event is required');
    if (!file) throw new Error('SocketIONode.createListener: file is required');

    return {
      id: `socketio:on#${event}#${file}#${line}`,
      type: 'socketio:on',
      name: event,
      event,
      objectName,
      handlerName,
      handlerLine,
      file,
      line,
      column
    };
  }

  /**
   * Create a socketio:room node.
   */
  static createRoom(
    roomName: string,
    objectName: string,
    file: string,
    line: number,
    column: number
  ): SocketIORoomNodeRecord {
    if (!roomName) throw new Error('SocketIONode.createRoom: roomName is required');
    if (!file) throw new Error('SocketIONode.createRoom: file is required');

    return {
      id: `socketio:room#${roomName}#${file}#${line}`,
      type: 'socketio:room',
      name: roomName,
      room: roomName,
      objectName,
      file,
      line,
      column
    };
  }

  /**
   * Create a socketio:event channel node (singleton per event name).
   */
  static createEvent(eventName: string): SocketIOEventNodeRecord {
    if (!eventName) throw new Error('SocketIONode.createEvent: eventName is required');

    return {
      id: `socketio:event#${eventName}`,
      type: 'socketio:event',
      name: eventName,
      event: eventName
    };
  }

  /**
   * Validate a Socket.IO domain node.
   */
  static validate(node: BaseNodeRecord): string[] {
    const errors: string[] = [];

    if (!SocketIONode.isSocketIOType(node.type)) {
      errors.push(`Expected socketio:* type, got ${node.type}`);
    }

    if (!node.id) errors.push('Missing required field: id');

    return errors;
  }

  /**
   * Check if a type belongs to the Socket.IO domain.
   */
  static isSocketIOType(type: string): boolean {
    if (!type) return false;
    return getNamespace(type) === 'socketio';
  }
}
