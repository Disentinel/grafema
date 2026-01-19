/**
 * ConstantNode - contract for CONSTANT node
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ConstantNodeRecord extends BaseNodeRecord {
  type: 'CONSTANT';
  column: number;
  value?: unknown;
  parentScopeId?: string;
}

interface ConstantNodeOptions {
  value?: unknown;
  parentScopeId?: string;
  counter?: number;
}

export class ConstantNode {
  static readonly TYPE = 'CONSTANT' as const;

  static readonly REQUIRED = ['name', 'file', 'line'] as const;
  static readonly OPTIONAL = ['column', 'value', 'parentScopeId'] as const;

  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    options: ConstantNodeOptions = {}
  ): ConstantNodeRecord {
    if (!name) throw new Error('ConstantNode.create: name is required');
    if (!file) throw new Error('ConstantNode.create: file is required');
    if (line === undefined) throw new Error('ConstantNode.create: line is required');

    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:CONSTANT:${name}:${line}:${column || 0}${counter}`;

    return {
      id,
      type: this.TYPE,
      name,
      file,
      line,
      column: column || 0,
      value: options.value,
      parentScopeId: options.parentScopeId
    };
  }

  static validate(node: ConstantNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (nodeRecord[field] === undefined) errors.push(`Missing: ${field}`);
    }
    return errors;
  }
}

export type { ConstantNodeRecord };
