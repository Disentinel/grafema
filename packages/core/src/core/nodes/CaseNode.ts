/**
 * CaseNode - contract for CASE node
 *
 * Represents a case clause in a switch statement.
 *
 * ID format (legacy): {file}:CASE:{value}:{line}:{counter}
 * Semantic ID format: {file}->{scope_path}->CASE->{value}#N
 */

import type { BaseNodeRecord } from '@grafema/types';
import { computeSemanticId, type ScopeContext, type Location } from '../SemanticId.js';

interface CaseNodeRecord extends BaseNodeRecord {
  type: 'CASE';
  value: unknown;
  isDefault: boolean;
  fallsThrough: boolean;
  isEmpty: boolean;
  parentBranchId?: string;
}

interface CaseNodeOptions {
  parentBranchId?: string;
  counter?: number;
}

interface CaseContextOptions {
  discriminator: number;
  parentBranchId?: string;
}

export class CaseNode {
  static readonly TYPE = 'CASE' as const;
  static readonly REQUIRED = ['file', 'line'] as const;
  static readonly OPTIONAL = ['value', 'isDefault', 'fallsThrough', 'isEmpty', 'parentBranchId'] as const;

  /**
   * Create CASE node (legacy ID)
   */
  static create(
    value: unknown,
    isDefault: boolean,
    fallsThrough: boolean,
    isEmpty: boolean,
    file: string,
    line: number,
    options: CaseNodeOptions = {}
  ): CaseNodeRecord {
    if (!file) throw new Error('CaseNode.create: file is required');
    if (line === undefined) throw new Error('CaseNode.create: line is required');

    const valueName = isDefault ? 'default' : String(value);
    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:CASE:${valueName}:${line}${counter}`;

    return {
      id,
      type: this.TYPE,
      name: isDefault ? 'default' : `case ${String(value)}`,
      file,
      line,
      value,
      isDefault,
      fallsThrough,
      isEmpty,
      parentBranchId: options.parentBranchId
    };
  }

  /**
   * Create CASE node with semantic ID (NEW API)
   */
  static createWithContext(
    value: unknown,
    isDefault: boolean,
    fallsThrough: boolean,
    isEmpty: boolean,
    context: ScopeContext,
    location: Partial<Location>,
    options: CaseContextOptions
  ): CaseNodeRecord {
    if (!context.file) throw new Error('CaseNode.createWithContext: file is required');
    if (location.line === undefined) throw new Error('CaseNode.createWithContext: line is required');
    if (options.discriminator === undefined) throw new Error('CaseNode.createWithContext: discriminator is required');

    const valueName = isDefault ? 'default' : String(value);
    const id = computeSemanticId('CASE', valueName, context, {
      discriminator: options.discriminator
    });

    return {
      id,
      type: this.TYPE,
      name: isDefault ? 'default' : `case ${String(value)}`,
      file: context.file,
      line: location.line,
      value,
      isDefault,
      fallsThrough,
      isEmpty,
      parentBranchId: options.parentBranchId
    };
  }

  static validate(node: CaseNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }
    if (!node.file) {
      errors.push('Missing required field: file');
    }
    return errors;
  }
}

export type { CaseNodeRecord };
