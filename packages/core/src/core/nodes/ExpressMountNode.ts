/**
 * ExpressMountNode - contract for express:mount nodes
 *
 * Represents an Express.js mount point (app.use('/prefix', router)).
 * Created by ExpressAnalyzer.
 *
 * ID format: express:mount#${prefix}#${file}#${line}
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ExpressMountNodeRecord extends BaseNodeRecord {
  type: 'express:mount';
  file: string;
  line: number;
  column: number;
}

interface ExpressMountNodeOptions {
  /** Target function name (e.g., "createRouter") */
  targetFunction?: string | null;
  /** Target variable name (e.g., "router") */
  targetVariable?: string | null;
  /** App/router variable name this is mounted on */
  mountedOn?: string;
}

export class ExpressMountNode {
  static readonly TYPE = 'express:mount' as const;

  static readonly REQUIRED = ['prefix', 'file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['targetFunction', 'targetVariable', 'mountedOn'] as const;

  /**
   * Create express:mount node
   *
   * @param prefix - Mount path prefix (e.g., "/api", "/users")
   * @param file - File path where mount is defined
   * @param line - Line number
   * @param column - Column number
   * @param options - Optional fields
   */
  static create(
    prefix: string,
    file: string,
    line: number,
    column: number,
    options: ExpressMountNodeOptions = {}
  ): ExpressMountNodeRecord {
    const id = `express:mount#${prefix}#${file}#${line}`;

    const node: ExpressMountNodeRecord = {
      id,
      type: this.TYPE,
      name: `mount:${prefix}`,
      file,
      line,
      column,
    };

    (node as Record<string, unknown>).prefix = prefix;

    if (options.targetFunction !== undefined) {
      (node as Record<string, unknown>).targetFunction = options.targetFunction;
    }
    if (options.targetVariable !== undefined) {
      (node as Record<string, unknown>).targetVariable = options.targetVariable;
    }
    if (options.mountedOn !== undefined) {
      (node as Record<string, unknown>).mountedOn = options.mountedOn;
    }

    return node;
  }

  /**
   * Validate express:mount node structure
   */
  static validate(node: ExpressMountNodeRecord): string[] {
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

export type { ExpressMountNodeRecord, ExpressMountNodeOptions };
