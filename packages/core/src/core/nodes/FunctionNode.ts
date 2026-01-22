/**
 * FunctionNode - contract for FUNCTION node
 *
 * Supports two creation modes:
 * 1. createWithContext() - NEW: Uses ScopeContext + Location for semantic IDs
 * 2. create() - LEGACY: Uses line-based IDs for backward compatibility
 *
 * Semantic ID format: {file}->{scope_path}->FUNCTION->{name}
 * Example: src/app.js->global->FUNCTION->processData
 */

import type { FunctionNodeRecord } from '@grafema/types';
import { computeSemanticId, type ScopeContext, type Location } from '../SemanticId.js';

/**
 * Options for function node creation
 */
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

/**
 * Options specific to createWithContext
 */
interface FunctionNodeContextOptions {
  async?: boolean;
  generator?: boolean;
  exported?: boolean;
  arrowFunction?: boolean;
  isClassMethod?: boolean;
  className?: string;
  params?: string[];
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

  /**
   * Create FUNCTION node with semantic ID (NEW API)
   *
   * Uses ScopeContext from ScopeTracker for stable identifiers that
   * don't change when unrelated code is added/removed.
   *
   * @param name - Function name (or 'anonymous[N]' for anonymous functions)
   * @param context - Scope context from ScopeTracker.getContext()
   * @param location - Source location { line, column }
   * @param options - Optional function properties
   * @returns FunctionNodeRecord with semantic ID
   */
  static createWithContext(
    name: string,
    context: ScopeContext,
    location: Partial<Location>,
    options: FunctionNodeContextOptions = {}
  ): FunctionNodeRecord {
    // Validate required fields
    if (!name) throw new Error('FunctionNode.createWithContext: name is required');
    if (!context.file) throw new Error('FunctionNode.createWithContext: file is required');
    if (location.line === undefined) throw new Error('FunctionNode.createWithContext: line is required');
    if (location.column === undefined) throw new Error('FunctionNode.createWithContext: column is required');

    // Compute semantic ID
    const id = computeSemanticId(this.TYPE, name, context);

    // Compute parentScopeId from context
    // If we have a scope path, the parent is the last scope in the path
    let parentScopeId: string | undefined;
    if (context.scopePath.length > 0) {
      // Find the most recent function/method scope to use as parent
      // For now, we construct the parent's semantic ID from the scope path
      const parentContext = {
        file: context.file,
        scopePath: context.scopePath.slice(0, -1) // Remove last scope
      };
      const parentScopeName = context.scopePath[context.scopePath.length - 1];

      // Check if parent is a function/method scope (not a control flow scope)
      if (!parentScopeName.includes('#')) {
        // Named scope - likely a function or class
        parentScopeId = computeSemanticId('FUNCTION', parentScopeName, parentContext);
      } else {
        // Control flow scope - find the nearest function ancestor
        // For simplicity, take the first non-control-flow scope from the path
        const nonControlFlowScopes = context.scopePath.filter(s => !s.includes('#'));
        if (nonControlFlowScopes.length > 0) {
          const parentName = nonControlFlowScopes[nonControlFlowScopes.length - 1];
          const idx = context.scopePath.indexOf(parentName);
          const ancestorContext = {
            file: context.file,
            scopePath: context.scopePath.slice(0, idx)
          };
          parentScopeId = computeSemanticId('FUNCTION', parentName, ancestorContext);
        }
      }
    }

    return {
      id,
      stableId: id,
      type: this.TYPE,
      name,
      file: context.file,
      line: location.line,
      column: location.column,
      async: options.async || false,
      generator: options.generator || false,
      exported: options.exported || false,
      arrowFunction: options.arrowFunction || false,
      parentScopeId,
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
