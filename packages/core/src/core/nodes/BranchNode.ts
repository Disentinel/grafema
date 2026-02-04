/**
 * BranchNode - contract for BRANCH node
 *
 * Represents control flow branching (switch statements).
 * Future: if statements, ternary expressions.
 *
 * ID format (legacy): {file}:BRANCH:{branchType}:{line}:{counter}
 * Semantic ID format: {file}->{scope_path}->BRANCH->switch#N
 */

import type { BaseNodeRecord } from '@grafema/types';
import { computeSemanticId, type ScopeContext, type Location } from '../SemanticId.js';

interface BranchNodeRecord extends BaseNodeRecord {
  type: 'BRANCH';
  column: number;
  branchType: 'switch' | 'if' | 'ternary';
  parentScopeId?: string;
}

interface BranchNodeOptions {
  parentScopeId?: string;
  counter?: number;
}

interface BranchContextOptions {
  discriminator: number;
  parentScopeId?: string;
}

export class BranchNode {
  static readonly TYPE = 'BRANCH' as const;
  static readonly REQUIRED = ['branchType', 'file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['parentScopeId'] as const;

  /**
   * Create BRANCH node (legacy ID)
   */
  static create(
    branchType: 'switch' | 'if' | 'ternary',
    file: string,
    line: number,
    column: number,
    options: BranchNodeOptions = {}
  ): BranchNodeRecord {
    // Validation
    if (!branchType) throw new Error('BranchNode.create: branchType is required');
    if (!file) throw new Error('BranchNode.create: file is required');
    if (line === undefined) throw new Error('BranchNode.create: line is required');
    if (column === undefined) throw new Error('BranchNode.create: column is required');

    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:BRANCH:${branchType}:${line}${counter}`;

    return {
      id,
      type: this.TYPE,
      name: branchType,
      file,
      line,
      column,
      branchType,
      parentScopeId: options.parentScopeId
    };
  }

  /**
   * Create BRANCH node with semantic ID (NEW API)
   */
  static createWithContext(
    branchType: 'switch' | 'if' | 'ternary',
    context: ScopeContext,
    location: Partial<Location>,
    options: BranchContextOptions
  ): BranchNodeRecord {
    if (!branchType) throw new Error('BranchNode.createWithContext: branchType is required');
    if (!context.file) throw new Error('BranchNode.createWithContext: file is required');
    if (location.line === undefined) throw new Error('BranchNode.createWithContext: line is required');
    if (location.column === undefined) throw new Error('BranchNode.createWithContext: column is required');
    if (options.discriminator === undefined) throw new Error('BranchNode.createWithContext: discriminator is required');

    const id = computeSemanticId('BRANCH', branchType, context, {
      discriminator: options.discriminator
    });

    return {
      id,
      type: this.TYPE,
      name: `${branchType}#${options.discriminator}`,
      file: context.file,
      line: location.line,
      column: location.column,
      branchType,
      parentScopeId: options.parentScopeId
    };
  }

  static validate(node: BranchNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }
    if (!node.branchType) {
      errors.push('Missing required field: branchType');
    }
    if (!node.file) {
      errors.push('Missing required field: file');
    }
    return errors;
  }
}

export type { BranchNodeRecord };
