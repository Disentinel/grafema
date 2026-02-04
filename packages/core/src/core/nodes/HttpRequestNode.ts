/**
 * HttpRequestNode - contract for HTTP_REQUEST node
 */

import type { BaseNodeRecord } from '@grafema/types';

interface HttpRequestNodeRecord extends BaseNodeRecord {
  type: 'HTTP_REQUEST';
  column: number;
  url?: string;
  method: string;
  parentScopeId?: string;
}

interface HttpRequestNodeOptions {
  parentScopeId?: string;
  counter?: number;
}

export class HttpRequestNode {
  static readonly TYPE = 'HTTP_REQUEST' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['url', 'method', 'parentScopeId'] as const;

  static create(
    url: string | undefined,
    method: string | undefined,
    file: string,
    line: number,
    column: number,
    options: HttpRequestNodeOptions = {}
  ): HttpRequestNodeRecord {
    if (!file) throw new Error('HttpRequestNode.create: file is required');
    if (line === undefined) throw new Error('HttpRequestNode.create: line is required');
    if (column === undefined) throw new Error('HttpRequestNode.create: column is required');

    const httpMethod = method || 'GET';
    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:HTTP_REQUEST:${httpMethod}:${line}:${column}${counter}`;

    return {
      id,
      type: this.TYPE,
      name: `${httpMethod} ${url || 'dynamic'}`,
      url,
      method: httpMethod,
      file,
      line,
      column,
      parentScopeId: options.parentScopeId
    };
  }

  static validate(node: HttpRequestNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (nodeRecord[field] === undefined) errors.push(`Missing: ${field}`);
    }
    return errors;
  }
}

export type { HttpRequestNodeRecord };
