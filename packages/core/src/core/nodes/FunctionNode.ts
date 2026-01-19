/**
 * FunctionNode - contract for FUNCTION node
 */

import type { FunctionNodeRecord } from '@grafema/types';

interface FunctionNodeOptions {
  async?: boolean;
  generator?: boolean;
  exported?: boolean;
  arrowFunction?: boolean;
  parentScopeId?: string;
  isClassMethod?: boolean;
  className?: string;
  params?: string[];
  counter?: number;
}

export class FunctionNode {
  static readonly TYPE = 'FUNCTION' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['async', 'generator', 'exported', 'arrowFunction', 'parentScopeId', 'isClassMethod', 'className', 'params'] as const;

  /**
   * Create FUNCTION node
   */
  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    options: FunctionNodeOptions = {}
  ): FunctionNodeRecord {
    if (!name) throw new Error('FunctionNode.create: name is required');
    if (!file) throw new Error('FunctionNode.create: file is required');
    if (line === undefined) throw new Error('FunctionNode.create: line is required');
    if (column === undefined) throw new Error('FunctionNode.create: column is required');

    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:FUNCTION:${name}:${line}:${column}${counter}`;

    return {
      id,
      stableId: id,
      type: this.TYPE,
      name,
      file,
      line,
      column,
      async: options.async || false,
      generator: options.generator || false,
      exported: options.exported || false,
      arrowFunction: options.arrowFunction || false,
      parentScopeId: options.parentScopeId,
      isClassMethod: options.isClassMethod || false,
      className: options.className,
      params: options.params || []
    };
  }

  static validate(node: FunctionNodeRecord): string[] {
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
