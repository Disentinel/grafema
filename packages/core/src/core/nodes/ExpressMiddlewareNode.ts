/**
 * ExpressMiddlewareNode - contract for express:middleware nodes
 *
 * Represents an Express.js middleware in a route chain or global mount.
 * Created by ExpressRouteAnalyzer.
 *
 * ID format: express:middleware#${name}#${file}#${line}
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ExpressMiddlewareNodeRecord extends BaseNodeRecord {
  type: 'express:middleware';
  name: string;
  file: string;
  line: number;
  column: number;
}

interface ExpressMiddlewareNodeOptions {
  /** Associated endpoint ID (for route-specific middleware) */
  endpointId?: string;
  /** Order in middleware chain */
  order?: number;
  /** Mount path (for app.use() middleware) */
  mountPath?: string;
  /** Whether this is a global middleware (mounted on '/') */
  isGlobal?: boolean;
}

export class ExpressMiddlewareNode {
  static readonly TYPE = 'express:middleware' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['endpointId', 'order', 'mountPath', 'isGlobal'] as const;

  /**
   * Create express:middleware node
   *
   * @param name - Middleware name (e.g., "cors", "authMiddleware", "inline:42")
   * @param file - File path where middleware is used
   * @param line - Line number
   * @param column - Column number
   * @param options - Optional fields
   */
  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    options: ExpressMiddlewareNodeOptions = {}
  ): ExpressMiddlewareNodeRecord {
    const id = `express:middleware#${name}#${file}#${line}`;

    const node: ExpressMiddlewareNodeRecord = {
      id,
      type: this.TYPE,
      name,
      file,
      line,
      column,
    };

    if (options.endpointId !== undefined) {
      (node as Record<string, unknown>).endpointId = options.endpointId;
    }
    if (options.order !== undefined) {
      (node as Record<string, unknown>).order = options.order;
    }
    if (options.mountPath !== undefined) {
      (node as Record<string, unknown>).mountPath = options.mountPath;
    }
    if (options.isGlobal !== undefined) {
      (node as Record<string, unknown>).isGlobal = options.isGlobal;
    }

    return node;
  }

  /**
   * Validate express:middleware node structure
   */
  static validate(node: ExpressMiddlewareNodeRecord): string[] {
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

export type { ExpressMiddlewareNodeRecord, ExpressMiddlewareNodeOptions };
