/**
 * EcmascriptBuiltinNode - contract for ECMASCRIPT_BUILTIN node
 *
 * Represents an ECMAScript specification built-in object or function.
 * These exist in all JavaScript environments (browser, Node.js, Deno, etc.)
 * and are defined by the ECMAScript specification, not by any runtime.
 *
 * Examples: Math, JSON, Object, Array, Promise, parseInt, prototype methods
 *
 * ID format: ECMASCRIPT_BUILTIN:{name}
 * Examples:
 *   ECMASCRIPT_BUILTIN:Math
 *   ECMASCRIPT_BUILTIN:prototype
 *   ECMASCRIPT_BUILTIN:parseInt
 */

import type { BaseNodeRecord } from '@grafema/types';

interface EcmascriptBuiltinNodeRecord extends BaseNodeRecord {
  type: 'ECMASCRIPT_BUILTIN';
}

export class EcmascriptBuiltinNode {
  static readonly TYPE = 'ECMASCRIPT_BUILTIN' as const;

  static readonly REQUIRED = ['name'] as const;
  static readonly OPTIONAL = [] as const;

  /**
   * Create ECMASCRIPT_BUILTIN node
   *
   * @param name - Builtin name (e.g., 'Math', 'prototype', 'parseInt')
   * @returns EcmascriptBuiltinNodeRecord
   */
  static create(name: string): EcmascriptBuiltinNodeRecord {
    if (!name) throw new Error('EcmascriptBuiltinNode.create: name is required');

    return {
      id: `ECMASCRIPT_BUILTIN:${name}`,
      type: this.TYPE,
      name,
      file: '',
      line: 0
    };
  }

  static validate(node: EcmascriptBuiltinNodeRecord): string[] {
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

export type { EcmascriptBuiltinNodeRecord };
