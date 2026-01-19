/**
 * MethodCallNode - contract for METHOD_CALL node
 */

import type { BaseNodeRecord } from '@grafema/types';

interface MethodCallNodeRecord extends BaseNodeRecord {
  type: 'METHOD_CALL';
  object?: string;
  method: string;
  column: number;
  parentScopeId?: string;
  args: unknown[];
}

interface MethodCallNodeOptions {
  parentScopeId?: string;
  args?: unknown[];
  counter?: number;
}

export class MethodCallNode {
  static readonly TYPE = 'METHOD_CALL' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'args'] as const;
  static readonly OPTIONAL = ['object', 'method', 'column', 'parentScopeId'] as const;

  /**
   * Create METHOD_CALL node
   */
  static create(
    objectName: string | undefined,
    methodName: string,
    file: string,
    line: number,
    column: number,
    options: MethodCallNodeOptions = {}
  ): MethodCallNodeRecord {
    if (!methodName) throw new Error('MethodCallNode.create: methodName is required');
    if (!file) throw new Error('MethodCallNode.create: file is required');
    if (line === undefined) throw new Error('MethodCallNode.create: line is required');

    const fullName = objectName ? `${objectName}.${methodName}` : methodName;
    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:METHOD_CALL:${fullName}:${line}:${column || 0}${counter}`;

    return {
      id,
      type: this.TYPE,
      name: fullName,
      object: objectName,
      method: methodName,
      file,
      line,
      column: column || 0,
      parentScopeId: options.parentScopeId,
      args: options.args || []
    };
  }

  static validate(node: MethodCallNodeRecord): string[] {
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

export type { MethodCallNodeRecord };
