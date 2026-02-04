/**
 * MethodCallNode - contract for METHOD_CALL node
 *
 * Supports two creation modes:
 * 1. createWithContext() - NEW: Uses ScopeContext + Location for semantic IDs
 * 2. create() - LEGACY: Uses line-based IDs for backward compatibility
 *
 * Semantic ID format: {file}->{scope_path}->CALL->{object.method}#N
 * Example: src/app.js->handler->CALL->db.query#0
 */

import type { BaseNodeRecord } from '@grafema/types';
import { computeSemanticId, type ScopeContext, type Location } from '../SemanticId.js';

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

/**
 * Options for createWithContext
 */
interface MethodCallContextOptions {
  discriminator: number;
  parentScopeId?: string;
  args?: unknown[];
}

export class MethodCallNode {
  static readonly TYPE = 'METHOD_CALL' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column', 'args'] as const;
  static readonly OPTIONAL = ['object', 'method', 'parentScopeId'] as const;

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
    if (column === undefined) throw new Error('MethodCallNode.create: column is required');

    const fullName = objectName ? `${objectName}.${methodName}` : methodName;
    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:METHOD_CALL:${fullName}:${line}:${column}${counter}`;

    return {
      id,
      type: this.TYPE,
      name: fullName,
      object: objectName,
      method: methodName,
      file,
      line,
      column,
      parentScopeId: options.parentScopeId,
      args: options.args || []
    };
  }

  /**
   * Create METHOD_CALL node with semantic ID (NEW API)
   *
   * Uses ScopeContext from ScopeTracker for stable identifiers.
   * Requires discriminator for multiple calls to same method within scope.
   *
   * @param objectName - Object name (can be undefined for bare function calls)
   * @param methodName - Method name
   * @param context - Scope context from ScopeTracker.getContext()
   * @param location - Source location { line, column }
   * @param options - Options including required discriminator
   * @returns MethodCallNodeRecord with semantic ID
   */
  static createWithContext(
    objectName: string | undefined,
    methodName: string,
    context: ScopeContext,
    location: Partial<Location>,
    options: MethodCallContextOptions
  ): MethodCallNodeRecord {
    // Validate required fields
    if (!methodName) throw new Error('MethodCallNode.createWithContext: methodName is required');
    if (!context.file) throw new Error('MethodCallNode.createWithContext: file is required');
    if (location.line === undefined) throw new Error('MethodCallNode.createWithContext: line is required');
    if (location.column === undefined) throw new Error('MethodCallNode.createWithContext: column is required');
    if (options.discriminator === undefined) throw new Error('MethodCallNode.createWithContext: discriminator is required');

    const fullName = objectName ? `${objectName}.${methodName}` : methodName;

    // Compute semantic ID with discriminator
    const id = computeSemanticId('CALL', fullName, context, {
      discriminator: options.discriminator
    });

    return {
      id,
      type: this.TYPE,
      name: fullName,
      object: objectName,
      method: methodName,
      file: context.file,
      line: location.line,
      column: location.column,
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
