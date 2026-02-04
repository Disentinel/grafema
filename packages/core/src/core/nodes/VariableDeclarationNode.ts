/**
 * VariableDeclarationNode - contract for VARIABLE_DECLARATION node
 *
 * Supports two creation modes:
 * 1. createWithContext() - NEW: Uses ScopeContext + Location for semantic IDs
 * 2. create() - LEGACY: Uses line-based IDs for backward compatibility
 *
 * Semantic ID format: {file}->{scope_path}->VARIABLE->{name}
 * Example: src/app.js->handler->VARIABLE->result
 */

import type { BaseNodeRecord } from '@grafema/types';
import { computeSemanticId, type ScopeContext, type Location } from '../SemanticId.js';

interface VariableDeclarationNodeRecord extends BaseNodeRecord {
  type: 'VARIABLE_DECLARATION';
  column: number;
  parentScopeId?: string;
}

interface VariableDeclarationNodeOptions {
  parentScopeId?: string;
  counter?: number;
}

/**
 * Options for createWithContext
 */
interface VariableContextOptions {
  parentScopeId?: string;
}

export class VariableDeclarationNode {
  static readonly TYPE = 'VARIABLE_DECLARATION' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['parentScopeId'] as const;

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
    if (column === undefined) throw new Error('VariableDeclarationNode.create: column is required');

    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:VARIABLE_DECLARATION:${name}:${line}:${column}${counter}`;

    return {
      id,
      type: this.TYPE,
      name,
      file,
      line,
      column,
      parentScopeId: options.parentScopeId
    };
  }

  /**
   * Create VARIABLE_DECLARATION node with semantic ID (NEW API)
   *
   * Uses ScopeContext from ScopeTracker for stable identifiers.
   * Variable names are unique within scope (handles shadowing naturally).
   *
   * @param name - Variable name
   * @param context - Scope context from ScopeTracker.getContext()
   * @param location - Source location { line, column }
   * @param options - Optional variable properties
   * @returns VariableDeclarationNodeRecord with semantic ID
   */
  static createWithContext(
    name: string,
    context: ScopeContext,
    location: Partial<Location>,
    options: VariableContextOptions = {}
  ): VariableDeclarationNodeRecord {
    // Validate required fields
    if (!name) throw new Error('VariableDeclarationNode.createWithContext: name is required');
    if (!context.file) throw new Error('VariableDeclarationNode.createWithContext: file is required');
    if (location.line === undefined) throw new Error('VariableDeclarationNode.createWithContext: line is required');
    if (location.column === undefined) throw new Error('VariableDeclarationNode.createWithContext: column is required');

    // Compute semantic ID using 'VARIABLE' type for cleaner IDs
    const id = computeSemanticId('VARIABLE', name, context);

    return {
      id,
      type: this.TYPE,
      name,
      file: context.file,
      line: location.line,
      column: location.column,
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
