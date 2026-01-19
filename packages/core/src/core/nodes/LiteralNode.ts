/**
 * LiteralNode - contract for LITERAL node
 */

import type { BaseNodeRecord } from '@grafema/types';

interface LiteralNodeRecord extends BaseNodeRecord {
  type: 'LITERAL';
  value: unknown;
  valueType: string;
  column: number;
  parentCallId?: string;
  argIndex?: number;
}

interface LiteralNodeOptions {
  parentCallId?: string;
  argIndex?: number;
  counter?: number;
}

export class LiteralNode {
  static readonly TYPE = 'LITERAL' as const;

  static readonly REQUIRED = ['file', 'line'] as const;
  static readonly OPTIONAL = ['value', 'valueType', 'column', 'parentCallId', 'argIndex'] as const;

  static create(
    value: unknown,
    file: string,
    line: number,
    column: number,
    options: LiteralNodeOptions = {}
  ): LiteralNodeRecord {
    if (!file) throw new Error('LiteralNode.create: file is required');
    if (line === undefined) throw new Error('LiteralNode.create: line is required');

    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const argIndex = options.argIndex !== undefined ? `arg${options.argIndex}` : 'value';
    const id = `${file}:LITERAL:${argIndex}:${line}:${column || 0}${counter}`;

    return {
      id,
      type: this.TYPE,
      name: file,
      value,
      valueType: typeof value,
      file,
      line,
      column: column || 0,
      parentCallId: options.parentCallId,
      argIndex: options.argIndex
    };
  }

  static validate(node: LiteralNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (nodeRecord[field] === undefined) errors.push(`Missing: ${field}`);
    }
    return errors;
  }
}

export type { LiteralNodeRecord };
