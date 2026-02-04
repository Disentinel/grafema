/**
 * DatabaseQueryNode - contract for DATABASE_QUERY node
 */

import type { BaseNodeRecord } from '@grafema/types';

interface DatabaseQueryNodeRecord extends BaseNodeRecord {
  type: 'DATABASE_QUERY';
  column: number;
  query?: string;
  operation: string;
  parentScopeId?: string;
}

interface DatabaseQueryNodeOptions {
  parentScopeId?: string;
}

export class DatabaseQueryNode {
  static readonly TYPE = 'DATABASE_QUERY' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['query', 'operation', 'parentScopeId'] as const;

  static create(
    query: string | undefined,
    operation: string | undefined,
    file: string,
    line: number,
    column: number,
    options: DatabaseQueryNodeOptions = {}
  ): DatabaseQueryNodeRecord {
    if (!file) throw new Error('DatabaseQueryNode.create: file is required');
    if (line === undefined) throw new Error('DatabaseQueryNode.create: line is required');
    if (column === undefined) throw new Error('DatabaseQueryNode.create: column is required');

    const name = query || `${operation || 'QUERY'}`;
    const id = `${file}:DATABASE_QUERY:${name}:${line}`;

    return {
      id,
      type: this.TYPE,
      name,
      query,
      operation: operation || 'UNKNOWN',
      file,
      line,
      column,
      parentScopeId: options.parentScopeId
    };
  }

  static validate(node: DatabaseQueryNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (nodeRecord[field] === undefined) errors.push(`Missing: ${field}`);
    }
    return errors;
  }
}

export type { DatabaseQueryNodeRecord };
