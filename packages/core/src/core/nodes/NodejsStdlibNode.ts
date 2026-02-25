/**
 * NodejsStdlibNode - contract for NODEJS_STDLIB node
 *
 * Represents a Node.js-only global or built-in object. Not available
 * in browsers. Part of the Node.js runtime, not the ECMAScript or
 * WHATWG specification.
 *
 * Examples: process, Buffer, global, setImmediate, clearImmediate,
 *           fs, path, http, crypto
 *
 * ID format: NODEJS_STDLIB:{name}
 * Examples:
 *   NODEJS_STDLIB:process
 *   NODEJS_STDLIB:Buffer
 *   NODEJS_STDLIB:fs
 */

import type { BaseNodeRecord } from '@grafema/types';

interface NodejsStdlibNodeRecord extends BaseNodeRecord {
  type: 'NODEJS_STDLIB';
}

export class NodejsStdlibNode {
  static readonly TYPE = 'NODEJS_STDLIB' as const;

  static readonly REQUIRED = ['name'] as const;
  static readonly OPTIONAL = [] as const;

  /**
   * Create NODEJS_STDLIB node
   *
   * @param name - Stdlib name (e.g., 'process', 'Buffer', 'fs')
   * @returns NodejsStdlibNodeRecord
   */
  static create(name: string): NodejsStdlibNodeRecord {
    if (!name) throw new Error('NodejsStdlibNode.create: name is required');

    return {
      id: `NODEJS_STDLIB:${name}`,
      type: this.TYPE,
      name,
      file: '',
      line: 0
    };
  }

  static validate(node: NodejsStdlibNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }
    if (!node.name) {
      errors.push('Missing required field: name');
    }
    return errors;
  }
}

export type { NodejsStdlibNodeRecord };
