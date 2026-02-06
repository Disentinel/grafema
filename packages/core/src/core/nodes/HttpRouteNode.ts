/**
 * HttpRouteNode - contract for http:route nodes
 *
 * Represents HTTP route definitions (Express app.get(), router.post(), etc.)
 * ID format: http:route:{method}:{path}:{file}
 *
 * Note: ID does NOT include line number to make it stable across edits.
 * Same route (method + path + file) = same ID = UPSERT on re-analysis.
 */

import type { HttpRouteNodeRecord } from '@grafema/types';

interface HttpRouteNodeOptions {
  localPath?: string;    // Original path before mounting
  mountedOn?: string;    // Variable name of mount target
  handler?: string;      // Handler function name
}

export class HttpRouteNode {
  static readonly TYPE = 'http:route' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column', 'method', 'path'] as const;
  static readonly OPTIONAL = ['localPath', 'mountedOn', 'handler'] as const;

  /**
   * Create http:route node
   *
   * @param method - HTTP method (GET, POST, etc.)
   * @param path - Route path (e.g., '/users', '/api/items/:id')
   * @param file - Absolute file path
   * @param line - Line number (for display, not part of ID)
   * @param column - Column position
   * @param options - Optional fields
   */
  static create(
    method: string,
    path: string,
    file: string,
    line: number,
    column: number,
    options: HttpRouteNodeOptions = {}
  ): HttpRouteNodeRecord {
    if (!method) throw new Error('HttpRouteNode.create: method is required');
    if (!path) throw new Error('HttpRouteNode.create: path is required');
    if (!file) throw new Error('HttpRouteNode.create: file is required');
    if (line === undefined) throw new Error('HttpRouteNode.create: line is required');
    if (column === undefined) throw new Error('HttpRouteNode.create: column is required');

    const upperMethod = method.toUpperCase();
    // ID without line number - stable across edits
    const id = `http:route:${upperMethod}:${path}:${file}`;

    return {
      id,
      type: this.TYPE,
      name: `${upperMethod} ${path}`,
      method: upperMethod,
      path,
      localPath: options.localPath ?? path,
      mountedOn: options.mountedOn,
      handler: options.handler,
      file,
      line,
      column,
    };
  }

  static validate(node: HttpRouteNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (nodeRecord[field] === undefined) errors.push(`Missing: ${field}`);
    }
    return errors;
  }
}

export type { HttpRouteNodeRecord };
