/**
 * ExpressMountNode - contract for express:mount nodes
 *
 * Represents Express.js app.use() mount points.
 * These connect routers/middleware to the app at specific path prefixes.
 *
 * ID format: express:mount:{prefix}:{file}:{line}
 * Note: line is included because same prefix could theoretically be mounted multiple times
 */

import type { ExpressMountNodeRecord } from '@grafema/types';

interface ExpressMountNodeOptions {
  targetFunction?: string | null;   // If mounted via function call: require('./routes')()
  targetVariable?: string | null;   // If mounted via variable: router
}

export class ExpressMountNode {
  static readonly TYPE = 'express:mount' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column', 'prefix', 'mountedOn'] as const;
  static readonly OPTIONAL = ['targetFunction', 'targetVariable'] as const;

  /**
   * Create express:mount node
   *
   * @param prefix - Mount path prefix (e.g., '/api', '/users')
   * @param mountedOn - Variable name of mount target (e.g., 'app', 'router')
   * @param file - Absolute file path
   * @param line - Line number
   * @param column - Column position
   * @param options - Optional target function/variable
   */
  static create(
    prefix: string,
    mountedOn: string,
    file: string,
    line: number,
    column: number,
    options: ExpressMountNodeOptions = {}
  ): ExpressMountNodeRecord {
    if (!prefix) throw new Error('ExpressMountNode.create: prefix is required');
    if (!mountedOn) throw new Error('ExpressMountNode.create: mountedOn is required');
    if (!file) throw new Error('ExpressMountNode.create: file is required');
    if (line === undefined) throw new Error('ExpressMountNode.create: line is required');
    if (column === undefined) throw new Error('ExpressMountNode.create: column is required');

    const id = `express:mount#${prefix}#${file}#${line}`;

    return {
      id,
      type: this.TYPE,
      name: `mount ${prefix}`,
      prefix,
      mountedOn,
      targetFunction: options.targetFunction ?? null,
      targetVariable: options.targetVariable ?? null,
      file,
      line,
      column,
    };
  }

  static validate(node: ExpressMountNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (nodeRecord[field] === undefined) errors.push(`Missing: ${field}`);
    }
    return errors;
  }
}

export type { ExpressMountNodeRecord };
