/**
 * MethodNode - contract for METHOD node (class method)
 *
 * Supports two creation modes:
 * 1. createWithContext() - NEW: Uses ScopeContext + Location for semantic IDs
 * 2. create() - LEGACY: Uses line-based IDs for backward compatibility
 *
 * Semantic ID format: {file}->{className}->METHOD->{name}
 * Example: src/services/UserService.js->UserService->METHOD->login
 */

import type { BaseNodeRecord } from '@grafema/types';
import { computeSemanticId, type ScopeContext, type Location } from '../SemanticId.js';

type MethodKind = 'method' | 'get' | 'set' | 'constructor';

interface MethodNodeRecord extends BaseNodeRecord {
  type: 'METHOD';
  column: number;
  className: string;
  async: boolean;
  generator: boolean;
  static: boolean;
  kind: MethodKind;
}

interface MethodNodeOptions {
  async?: boolean;
  generator?: boolean;
  static?: boolean;
  kind?: MethodKind;
}

/**
 * Options for createWithContext
 */
interface MethodContextOptions {
  async?: boolean;
  generator?: boolean;
  static?: boolean;
  kind?: MethodKind;
}

export class MethodNode {
  static readonly TYPE = 'METHOD' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column', 'className'] as const;
  static readonly OPTIONAL = ['async', 'generator', 'static', 'kind'] as const;

  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    className: string,
    options: MethodNodeOptions = {}
  ): MethodNodeRecord {
    if (!name) throw new Error('MethodNode.create: name is required');
    if (!file) throw new Error('MethodNode.create: file is required');
    if (!line) throw new Error('MethodNode.create: line is required');
    if (column === undefined) throw new Error('MethodNode.create: column is required');
    if (!className) throw new Error('MethodNode.create: className is required');

    return {
      id: `${file}:METHOD:${className}.${name}:${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      column,
      className,
      async: options.async || false,
      generator: options.generator || false,
      static: options.static || false,
      kind: options.kind || 'method'
    };
  }

  /**
   * Create METHOD node with semantic ID (NEW API)
   *
   * Uses ScopeContext from ScopeTracker for stable identifiers.
   * Method names are unique within class, so no discriminator needed.
   * Context should include the class in scopePath.
   *
   * @param name - Method name
   * @param className - Name of the class containing this method
   * @param context - Scope context from ScopeTracker.getContext() (should be inside class)
   * @param location - Source location { line, column }
   * @param options - Optional method properties
   * @returns MethodNodeRecord with semantic ID
   */
  static createWithContext(
    name: string,
    className: string,
    context: ScopeContext,
    location: Partial<Location>,
    options: MethodContextOptions = {}
  ): MethodNodeRecord {
    // Validate required fields
    if (!name) throw new Error('MethodNode.createWithContext: name is required');
    if (!className) throw new Error('MethodNode.createWithContext: className is required');
    if (!context.file) throw new Error('MethodNode.createWithContext: file is required');
    if (location.line === undefined) throw new Error('MethodNode.createWithContext: line is required');
    if (location.column === undefined) throw new Error('MethodNode.createWithContext: column is required');

    // Compute semantic ID
    const id = computeSemanticId(this.TYPE, name, context);

    return {
      id,
      type: this.TYPE,
      name,
      file: context.file,
      line: location.line,
      column: location.column,
      className,
      async: options.async || false,
      generator: options.generator || false,
      static: options.static || false,
      kind: options.kind || 'method'
    };
  }

  static validate(node: MethodNodeRecord): string[] {
    const errors: string[] = [];

    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }

    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (!nodeRecord[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    return errors;
  }
}

export type { MethodNodeRecord, MethodKind };
