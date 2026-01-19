/**
 * CallSiteNode - contract for CALL_SITE node
 */

import type { BaseNodeRecord } from '@grafema/types';

interface CallSiteNodeRecord extends BaseNodeRecord {
  type: 'CALL_SITE';
  column: number;
  parentScopeId?: string;
  targetFunctionName: string;
}

interface CallSiteNodeOptions {
  parentScopeId?: string;
  counter?: number;
}

export class CallSiteNode {
  static readonly TYPE = 'CALL_SITE' as const;

  static readonly REQUIRED = ['name', 'file', 'line'] as const;
  static readonly OPTIONAL = ['column', 'parentScopeId', 'targetFunctionName'] as const;

  /**
   * Create CALL_SITE node
   */
  static create(
    targetName: string,
    file: string,
    line: number,
    column: number,
    options: CallSiteNodeOptions = {}
  ): CallSiteNodeRecord {
    if (!targetName) throw new Error('CallSiteNode.create: targetName is required');
    if (!file) throw new Error('CallSiteNode.create: file is required');
    if (line === undefined) throw new Error('CallSiteNode.create: line is required');

    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:CALL_SITE:${targetName}:${line}:${column || 0}${counter}`;

    return {
      id,
      type: this.TYPE,
      name: targetName,
      file,
      line,
      column: column || 0,
      parentScopeId: options.parentScopeId,
      targetFunctionName: targetName
    };
  }

  static validate(node: CallSiteNodeRecord): string[] {
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

export type { CallSiteNodeRecord };
