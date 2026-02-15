/**
 * SocketNode - contract for low-level socket nodes (net module)
 *
 * Types:
 * - os:unix-socket  — Unix domain socket client connection
 * - os:unix-server  — Unix domain socket server
 * - net:tcp-connection — TCP client connection
 * - net:tcp-server    — TCP server
 *
 * ID formats:
 * - os:unix-socket#<path>#<file>#<line>
 * - os:unix-server#<path>#<file>#<line>
 * - net:tcp-connection#<host>:<port>#<file>#<line>
 * - net:tcp-server#<host>:<port>#<file>#<line>
 */

import type { BaseNodeRecord } from '@grafema/types';

// --- Unix Socket ---

export interface UnixSocketNodeRecord extends BaseNodeRecord {
  type: 'os:unix-socket';
  protocol: 'unix';
  path: string;
  library: string;
  column: number;
}

// --- TCP Connection ---

export interface TcpConnectionNodeRecord extends BaseNodeRecord {
  type: 'net:tcp-connection';
  protocol: 'tcp';
  host: string;
  port: number;
  library: string;
  column: number;
}

// --- Unix Server ---

export interface UnixServerNodeRecord extends BaseNodeRecord {
  type: 'os:unix-server';
  protocol: 'unix';
  path: string;
  library: string;
  backlog?: number;
  column: number;
}

// --- TCP Server ---

export interface TcpServerNodeRecord extends BaseNodeRecord {
  type: 'net:tcp-server';
  protocol: 'tcp';
  host: string;
  port: number;
  library: string;
  backlog?: number;
  column: number;
}

export type AnySocketNodeRecord =
  | UnixSocketNodeRecord
  | TcpConnectionNodeRecord
  | UnixServerNodeRecord
  | TcpServerNodeRecord;

export class SocketNode {
  static readonly REQUIRED = ['id', 'type', 'name', 'protocol', 'library', 'file', 'line', 'column'] as const;

  /**
   * Create an os:unix-socket node.
   */
  static createUnixSocket(
    path: string,
    file: string,
    line: number,
    column: number,
    options: { library?: string } = {}
  ): UnixSocketNodeRecord {
    if (!path) throw new Error('SocketNode.createUnixSocket: path is required');
    if (!file) throw new Error('SocketNode.createUnixSocket: file is required');

    return {
      id: `os:unix-socket#${path}#${file}#${line}`,
      type: 'os:unix-socket',
      name: `unix:${path}`,
      protocol: 'unix',
      path,
      library: options.library ?? 'net',
      file,
      line,
      column
    };
  }

  /**
   * Create a net:tcp-connection node.
   */
  static createTcpConnection(
    host: string,
    port: number,
    file: string,
    line: number,
    column: number,
    options: { library?: string } = {}
  ): TcpConnectionNodeRecord {
    if (!file) throw new Error('SocketNode.createTcpConnection: file is required');

    return {
      id: `net:tcp-connection#${host}:${port}#${file}#${line}`,
      type: 'net:tcp-connection',
      name: `tcp:${host}:${port}`,
      protocol: 'tcp',
      host,
      port,
      library: options.library ?? 'net',
      file,
      line,
      column
    };
  }

  /**
   * Create an os:unix-server node.
   */
  static createUnixServer(
    path: string,
    file: string,
    line: number,
    column: number,
    options: { library?: string; backlog?: number } = {}
  ): UnixServerNodeRecord {
    if (!path) throw new Error('SocketNode.createUnixServer: path is required');
    if (!file) throw new Error('SocketNode.createUnixServer: file is required');

    return {
      id: `os:unix-server#${path}#${file}#${line}`,
      type: 'os:unix-server',
      name: `unix-server:${path}`,
      protocol: 'unix',
      path,
      library: options.library ?? 'net',
      backlog: options.backlog,
      file,
      line,
      column
    };
  }

  /**
   * Create a net:tcp-server node.
   */
  static createTcpServer(
    host: string,
    port: number,
    file: string,
    line: number,
    column: number,
    options: { library?: string; backlog?: number } = {}
  ): TcpServerNodeRecord {
    if (!file) throw new Error('SocketNode.createTcpServer: file is required');

    return {
      id: `net:tcp-server#${host}:${port}#${file}#${line}`,
      type: 'net:tcp-server',
      name: `tcp-server:${host}:${port}`,
      protocol: 'tcp',
      host,
      port,
      library: options.library ?? 'net',
      backlog: options.backlog,
      file,
      line,
      column
    };
  }

  /**
   * Validate a socket domain node.
   */
  static validate(node: BaseNodeRecord): string[] {
    const errors: string[] = [];

    if (!SocketNode.isSocketType(node.type)) {
      errors.push(`Expected socket type (os:unix-*, net:tcp-*), got ${node.type}`);
    }

    if (!node.id) errors.push('Missing required field: id');
    if (!node.name) errors.push('Missing required field: name');
    if (!node.file) errors.push('Missing required field: file');

    return errors;
  }

  /**
   * Check if a type is a low-level socket type.
   */
  static isSocketType(type: string): boolean {
    return type === 'os:unix-socket' ||
           type === 'os:unix-server' ||
           type === 'net:tcp-connection' ||
           type === 'net:tcp-server';
  }
}
