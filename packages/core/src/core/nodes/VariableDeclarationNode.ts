/**
 * VariableDeclarationNode - contract for VARIABLE_DECLARATION node
 */

import type { BaseNodeRecord } from '@grafema/types';

interface VariableDeclarationNodeRecord extends BaseNodeRecord {
  type: 'VARIABLE_DECLARATION';
  column: number;
  parentScopeId?: string;
}

interface VariableDeclarationNodeOptions {
  parentScopeId?: string;
  counter?: number;
}

export class VariableDeclarationNode {
  static readonly TYPE = 'VARIABLE_DECLARATION' as const;

  static readonly REQUIRED = ['name', 'file', 'line'] as const;
  static readonly OPTIONAL = ['column', 'parentScopeId'] as const;

  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    options: VariableDeclarationNodeOptions = {}
  ): VariableDeclarationNodeRecord {
    if (!name) throw new Error('VariableDeclarationNode.create: name is required');
    if (!file) throw new Error('VariableDeclarationNode.create: file is required');
    if (line === undefined) throw new Error('VariableDeclarationNode.create: line is required');

    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:VARIABLE_DECLARATION:${name}:${line}:${column || 0}${counter}`;

    return {
      id,
      type: this.TYPE,
      name,
      file,
      line,
      column: column || 0,
      parentScopeId: options.parentScopeId
    };
  }

  static validate(node: VariableDeclarationNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (nodeRecord[field] === undefined) errors.push(`Missing: ${field}`);
    }
    return errors;
  }
}

export type { VariableDeclarationNodeRecord };
