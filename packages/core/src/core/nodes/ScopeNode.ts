/**
 * ScopeNode - contract for SCOPE node
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ScopeNodeRecord extends BaseNodeRecord {
  type: 'SCOPE';
  scopeType: string;
  conditional: boolean;
  parentScopeId?: string;
  parentFunctionId?: string;
  capturesFrom?: string[];
}

interface ScopeNodeOptions {
  name?: string;
  conditional?: boolean;
  parentScopeId?: string;
  parentFunctionId?: string;
  capturesFrom?: string[];
  counter?: number;
}

export class ScopeNode {
  static readonly TYPE = 'SCOPE' as const;

  static readonly REQUIRED = ['scopeType', 'file', 'line'] as const;
  static readonly OPTIONAL = ['name', 'conditional', 'parentScopeId', 'parentFunctionId', 'capturesFrom'] as const;

  /**
   * Create SCOPE node
   */
  static create(
    scopeType: string,
    file: string,
    line: number,
    options: ScopeNodeOptions = {}
  ): ScopeNodeRecord {
    if (!scopeType) throw new Error('ScopeNode.create: scopeType is required');
    if (!file) throw new Error('ScopeNode.create: file is required');
    if (line === undefined) throw new Error('ScopeNode.create: line is required');

    const name = options.name || scopeType;
    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:SCOPE:${name}:${line}${counter}`;

    return {
      id,
      type: this.TYPE,
      scopeType,
      name,
      file,
      line,
      conditional: options.conditional || false,
      parentScopeId: options.parentScopeId,
      parentFunctionId: options.parentFunctionId,
      capturesFrom: options.capturesFrom
    };
  }

  static validate(node: ScopeNodeRecord): string[] {
    const errors: string[] = [];

    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }

    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (nodeRecord[field] === undefined || nodeRecord[field] === null) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    return errors;
  }
}

export type { ScopeNodeRecord };
