/**
 * ArrayLiteralNode - contract for ARRAY_LITERAL node
 *
 * Represents an array literal expression: [elem1, elem2, ...]
 * Used for tracking data flow through array construction.
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ArrayLiteralNodeRecord extends BaseNodeRecord {
  type: 'ARRAY_LITERAL';
  column: number;
  parentCallId?: string;
  argIndex?: number;
}

interface ArrayLiteralNodeOptions {
  parentCallId?: string;
  argIndex?: number;
  counter?: number;
}

export class ArrayLiteralNode {
  static readonly TYPE = 'ARRAY_LITERAL' as const;

  static readonly REQUIRED = ['file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['parentCallId', 'argIndex'] as const;

  static create(
    file: string,
    line: number,
    column: number,
    options: ArrayLiteralNodeOptions = {}
  ): ArrayLiteralNodeRecord {
    if (!file) throw new Error('ArrayLiteralNode.create: file is required');
    if (line === undefined) throw new Error('ArrayLiteralNode.create: line is required');

    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const argSuffix = options.argIndex !== undefined ? `arg${options.argIndex}` : 'arr';
    const id = `ARRAY_LITERAL#${argSuffix}#${file}#${line}:${column || 0}${counter}`;

    return {
      id,
      type: this.TYPE,
      name: `<array>`,
      file,
      line,
      column: column || 0,
      parentCallId: options.parentCallId,
      argIndex: options.argIndex
    };
  }

  static validate(node: ArrayLiteralNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (nodeRecord[field] === undefined) errors.push(`Missing: ${field}`);
    }
    return errors;
  }
}

export type { ArrayLiteralNodeRecord, ArrayLiteralNodeOptions };
