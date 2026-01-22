/**
 * CallSiteNode - contract for CALL_SITE node
 *
 * Supports two creation modes:
 * 1. createWithContext() - NEW: Uses ScopeContext + Location for semantic IDs
 * 2. create() - LEGACY: Uses line-based IDs for backward compatibility
 *
 * Semantic ID format: {file}->{scope_path}->CALL->{calleeName}#N
 * Example: src/app.js->handler->CALL->console.log#0
 */

import type { BaseNodeRecord } from '@grafema/types';
import { computeSemanticId, type ScopeContext, type Location } from '../SemanticId.js';

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

/**
 * Options for createWithContext
 */
interface CallSiteContextOptions {
  discriminator: number;
  parentScopeId?: string;
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

  /**
   * Create CALL_SITE node with semantic ID (NEW API)
   *
   * Uses ScopeContext from ScopeTracker for stable identifiers.
   * Requires discriminator for multiple calls to same function within scope.
   *
   * @param targetName - Name of called function (e.g., 'console.log', 'db.query')
   * @param context - Scope context from ScopeTracker.getContext()
   * @param location - Source location { line, column }
   * @param options - Options including required discriminator
   * @returns CallSiteNodeRecord with semantic ID
   */
  static createWithContext(
    targetName: string,
    context: ScopeContext,
    location: Partial<Location>,
    options: CallSiteContextOptions
  ): CallSiteNodeRecord {
    // Validate required fields
    if (!targetName) throw new Error('CallSiteNode.createWithContext: targetName is required');
    if (!context.file) throw new Error('CallSiteNode.createWithContext: file is required');
    if (location.line === undefined) throw new Error('CallSiteNode.createWithContext: line is required');
    if (options.discriminator === undefined) throw new Error('CallSiteNode.createWithContext: discriminator is required');

    // Compute semantic ID with discriminator
    // Use 'CALL' as the type for cleaner IDs (matches spec)
    const id = computeSemanticId('CALL', targetName, context, {
      discriminator: options.discriminator
    });

    return {
      id,
      type: this.TYPE,
      name: targetName,
      file: context.file,
      line: location.line,
      column: location.column ?? 0,
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
