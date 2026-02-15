/**
 * HttpRouteNode - contract for http:route nodes
 *
 * Represents an HTTP route endpoint detected from framework patterns.
 * Used by ExpressAnalyzer, ExpressRouteAnalyzer, and NestJSRouteAnalyzer.
 *
 * Each analyzer may add different optional fields, but all share
 * the same core: method, path, file, line.
 *
 * ID format: http:route#${method}:${path}#${file}#${line}
 */

import type { BaseNodeRecord } from '@grafema/types';

interface HttpRouteNodeRecord extends BaseNodeRecord {
  type: 'http:route';
  method: string;
  path: string;
  file: string;
  line: number;
  column?: number;
}

interface HttpRouteNodeOptions {
  /** Human-readable name (e.g., "GET /api/users") */
  name?: string;
  column?: number;

  // Express-specific
  /** Local path before mounting */
  localPath?: string;
  /** Router/app variable name this route is mounted on */
  mountedOn?: string;
  /** Router variable name (alternative to mountedOn) */
  routerName?: string;

  // NestJS-specific
  /** Framework that defined this route */
  framework?: string;
  /** Handler function name (e.g., "UserController.findAll") */
  handlerName?: string;

  /** Arbitrary metadata (handler location, etc.) */
  metadata?: Record<string, unknown>;
}

export class HttpRouteNode {
  static readonly TYPE = 'http:route' as const;

  static readonly REQUIRED = ['method', 'path', 'file', 'line'] as const;
  static readonly OPTIONAL = [
    'name', 'column', 'localPath', 'mountedOn', 'routerName',
    'framework', 'handlerName', 'metadata'
  ] as const;

  /**
   * Create http:route node
   *
   * @param method - HTTP method (GET, POST, PUT, DELETE, etc.)
   * @param path - Route path (e.g., "/api/users", "/users/:id")
   * @param file - File path where route is defined
   * @param line - Line number of route definition
   * @param options - Optional fields for framework-specific metadata
   */
  static create(
    method: string,
    path: string,
    file: string,
    line: number,
    options: HttpRouteNodeOptions = {}
  ): HttpRouteNodeRecord {
    const id = `http:route#${method}:${path}#${file}#${line}`;

    const node: HttpRouteNodeRecord = {
      id,
      type: this.TYPE,
      name: options.name || `${method} ${path}`,
      method,
      path,
      file,
      line,
    };

    if (options.column !== undefined) node.column = options.column;
    if (options.localPath !== undefined) (node as Record<string, unknown>).localPath = options.localPath;
    if (options.mountedOn !== undefined) (node as Record<string, unknown>).mountedOn = options.mountedOn;
    if (options.routerName !== undefined) (node as Record<string, unknown>).routerName = options.routerName;
    if (options.framework !== undefined) (node as Record<string, unknown>).framework = options.framework;
    if (options.handlerName !== undefined) (node as Record<string, unknown>).handlerName = options.handlerName;
    if (options.metadata !== undefined) node.metadata = options.metadata;

    return node;
  }

  /**
   * Validate http:route node structure
   */
  static validate(node: HttpRouteNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }
    const record = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (record[field] === undefined) {
        errors.push(`Missing required field: ${field}`);
      }
    }
    return errors;
  }
}

export type { HttpRouteNodeRecord, HttpRouteNodeOptions };
