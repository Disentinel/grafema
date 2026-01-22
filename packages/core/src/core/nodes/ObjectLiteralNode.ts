/**
 * ObjectLiteralNode - contract for OBJECT_LITERAL node
 *
 * Represents an object literal expression: { key: value, ... }
 * Used for tracking data flow through object construction.
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ObjectLiteralNodeRecord extends BaseNodeRecord {
  type: 'OBJECT_LITERAL';
  column: number;
  parentCallId?: string;
  argIndex?: number;
}

interface ObjectLiteralNodeOptions {
  parentCallId?: string;
  argIndex?: number;
  counter?: number;
}

export class ObjectLiteralNode {
  static readonly TYPE = 'OBJECT_LITERAL' as const;

  static readonly REQUIRED = ['file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['parentCallId', 'argIndex'] as const;

  static create(
    file: string,
    line: number,
    column: number,
    options: ObjectLiteralNodeOptions = {}
  ): ObjectLiteralNodeRecord {
    if (!file) throw new Error('ObjectLiteralNode.create: file is required');
    if (line === undefined) throw new Error('ObjectLiteralNode.create: line is required');

    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const argSuffix = options.argIndex !== undefined ? `arg${options.argIndex}` : 'obj';
    const id = `OBJECT_LITERAL#${argSuffix}#${file}#${line}:${column || 0}${counter}`;

    return {
      id,
      type: this.TYPE,
      name: `<object>`,
      file,
      line,
      column: column || 0,
      parentCallId: options.parentCallId,
      argIndex: options.argIndex
    };
  }

  static validate(node: ObjectLiteralNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (nodeRecord[field] === undefined) errors.push(`Missing: ${field}`);
    }
    return errors;
  }
}

export type { ObjectLiteralNodeRecord, ObjectLiteralNodeOptions };
