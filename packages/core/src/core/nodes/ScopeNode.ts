/**
 * ScopeNode - contract for SCOPE node
 *
 * Supports two creation modes:
 * 1. createWithContext() - NEW: Uses ScopeContext + Location for semantic IDs
 * 2. create() - LEGACY: Uses line-based IDs for backward compatibility
 *
 * Semantic ID format: {file}->{scope_path}->SCOPE->{scopeType}#N
 * Example: src/app.js->handler->SCOPE->if#0
 */

import type { BaseNodeRecord } from '@grafema/types';
import { computeSemanticId, type ScopeContext, type Location } from '../SemanticId.js';

interface ScopeNodeRecord extends BaseNodeRecord {
  type: 'SCOPE';
  scopeType: string;
  conditional: boolean;
  parentScopeId?: string;
  parentFunctionId?: string;
  capturesFrom?: string[];
}

interface ScopeNodeOptions {
  name?: string;
  conditional?: boolean;
  parentScopeId?: string;
  parentFunctionId?: string;
  capturesFrom?: string[];
  counter?: number;
}

/**
 * Options for createWithContext
 */
interface ScopeContextOptions {
  discriminator: number;
  conditional?: boolean;
  parentScopeId?: string;
  parentFunctionId?: string;
  capturesFrom?: string[];
}

export class ScopeNode {
  static readonly TYPE = 'SCOPE' as const;

  static readonly REQUIRED = ['scopeType', 'file', 'line'] as const;
  static readonly OPTIONAL = ['name', 'conditional', 'parentScopeId', 'parentFunctionId', 'capturesFrom'] as const;

  /**
   * Create SCOPE node
   */
  static create(
    scopeType: string,
    file: string,
    line: number,
    options: ScopeNodeOptions = {}
  ): ScopeNodeRecord {
    if (!scopeType) throw new Error('ScopeNode.create: scopeType is required');
    if (!file) throw new Error('ScopeNode.create: file is required');
    if (line === undefined) throw new Error('ScopeNode.create: line is required');

    const name = options.name || scopeType;
    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:SCOPE:${name}:${line}${counter}`;

    return {
      id,
      type: this.TYPE,
      scopeType,
      name,
      file,
      line,
      conditional: options.conditional || false,
      parentScopeId: options.parentScopeId,
      parentFunctionId: options.parentFunctionId,
      capturesFrom: options.capturesFrom
    };
  }

  /**
   * Create SCOPE node with semantic ID (NEW API)
   *
   * Uses ScopeContext from ScopeTracker for stable identifiers.
   * Requires discriminator for multiple scopes of same type within parent scope.
   *
   * @param scopeType - Type of scope (if, else, try, catch, finally, for, while, switch)
   * @param context - Scope context from ScopeTracker.getContext()
   * @param location - Source location { line }
   * @param options - Options including required discriminator
   * @returns ScopeNodeRecord with semantic ID
   */
  static createWithContext(
    scopeType: string,
    context: ScopeContext,
    location: Partial<Location>,
    options: ScopeContextOptions
  ): ScopeNodeRecord {
    // Validate required fields
    if (!scopeType) throw new Error('ScopeNode.createWithContext: scopeType is required');
    if (!context.file) throw new Error('ScopeNode.createWithContext: file is required');
    if (location.line === undefined) throw new Error('ScopeNode.createWithContext: line is required');
    if (options.discriminator === undefined) throw new Error('ScopeNode.createWithContext: discriminator is required');

    // Compute semantic ID with discriminator
    const id = computeSemanticId('SCOPE', scopeType, context, {
      discriminator: options.discriminator
    });

    // Name includes the discriminator for display purposes
    const name = `${scopeType}#${options.discriminator}`;

    return {
      id,
      type: this.TYPE,
      scopeType,
      name,
      file: context.file,
      line: location.line,
      conditional: options.conditional || false,
      parentScopeId: options.parentScopeId,
      parentFunctionId: options.parentFunctionId,
      capturesFrom: options.capturesFrom
    };
  }

  static validate(node: ScopeNodeRecord): string[] {
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

export type { ScopeNodeRecord };
