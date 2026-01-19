/**
 * ParameterNode - contract for PARAMETER node
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ParameterNodeRecord extends BaseNodeRecord {
  type: 'PARAMETER';
  column: number;
  functionId: string;
  index: number;
  defaultValue?: unknown;
  rest: boolean;
}

interface ParameterNodeOptions {
  index?: number;
  defaultValue?: unknown;
  rest?: boolean;
}

export class ParameterNode {
  static readonly TYPE = 'PARAMETER' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'functionId'] as const;
  static readonly OPTIONAL = ['column', 'index', 'defaultValue', 'rest'] as const;

  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    functionId: string,
    options: ParameterNodeOptions = {}
  ): ParameterNodeRecord {
    if (!name) throw new Error('ParameterNode.create: name is required');
    if (!file) throw new Error('ParameterNode.create: file is required');
    if (!line) throw new Error('ParameterNode.create: line is required');
    if (!functionId) throw new Error('ParameterNode.create: functionId is required');

    return {
      id: `${file}:PARAMETER:${name}:${line}:${options.index || 0}`,
      type: this.TYPE,
      name,
      file,
      line,
      column: column || 0,
      functionId,
      index: options.index || 0,
      defaultValue: options.defaultValue,
      rest: options.rest || false
    };
  }

  static validate(node: ParameterNodeRecord): string[] {
    const errors: string[] = [];

    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }

    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (!nodeRecord[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    return errors;
  }
}

export type { ParameterNodeRecord };
