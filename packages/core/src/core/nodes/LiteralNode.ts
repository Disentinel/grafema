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

  static readonly REQUIRED = ['file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['value', 'valueType', 'parentCallId', 'argIndex'] as const;

  private static readonly MAX_NAME_LENGTH = 64;

  private static formatName(value: unknown): string {
    let formatted: string;

    if (value === null) {
      formatted = 'null';
    } else if (typeof value === 'string') {
      const escaped = value.replace(/'/g, "\\'");
      const MAX_CONTENT = this.MAX_NAME_LENGTH - 2; // room for surrounding quotes
      if (escaped.length > MAX_CONTENT) {
        formatted = `'${escaped.slice(0, MAX_CONTENT - 1)}\u2026'`;
      } else {
        formatted = `'${escaped}'`;
      }
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      formatted = String(value);
    } else {
      formatted = String(value);
    }

    if (formatted.length > this.MAX_NAME_LENGTH) {
      return formatted.slice(0, this.MAX_NAME_LENGTH - 1) + '\u2026';
    }

    return formatted;
  }

  static create(
    value: unknown,
    file: string,
    line: number,
    column: number,
    options: LiteralNodeOptions = {}
  ): LiteralNodeRecord {
    if (!file) throw new Error('LiteralNode.create: file is required');
    if (line === undefined) throw new Error('LiteralNode.create: line is required');
    if (column === undefined) throw new Error('LiteralNode.create: column is required');

    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const argIndex = options.argIndex !== undefined ? `arg${options.argIndex}` : 'value';
    const id = `${file}:LITERAL:${argIndex}:${line}:${column}${counter}`;

    return {
      id,
      type: this.TYPE,
      name: LiteralNode.formatName(value),
      value,
      valueType: typeof value,
      file,
      line,
      column,
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
