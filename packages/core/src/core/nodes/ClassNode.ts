/**
 * ClassNode - contract for CLASS node
 *
 * Supports two creation modes:
 * 1. createWithContext() - NEW: Uses ScopeContext + Location for semantic IDs
 * 2. create() - LEGACY: Uses line-based IDs for backward compatibility
 *
 * Semantic ID format: {file}->{scope_path}->CLASS->{name}
 * Example: src/models/User.js->global->CLASS->User
 */

import type { BaseNodeRecord } from '@grafema/types';
import { computeSemanticId, type ScopeContext, type Location } from '../SemanticId.js';

interface ClassNodeRecord extends BaseNodeRecord {
  type: 'CLASS';
  column: number;
  exported: boolean;
  superClass?: string;
  methods: string[];
  isInstantiationRef?: boolean;
}

interface ClassNodeOptions {
  exported?: boolean;
  superClass?: string;
  methods?: string[];
  isInstantiationRef?: boolean;
}

/**
 * Options for createWithContext
 */
interface ClassContextOptions {
  exported?: boolean;
  superClass?: string;
  methods?: string[];
  isInstantiationRef?: boolean;
}

export class ClassNode {
  static readonly TYPE = 'CLASS' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['exported', 'superClass', 'methods', 'isInstantiationRef'] as const;

  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    options: ClassNodeOptions = {}
  ): ClassNodeRecord {
    if (!name) throw new Error('ClassNode.create: name is required');
    if (!file) throw new Error('ClassNode.create: file is required');
    if (!line) throw new Error('ClassNode.create: line is required');
    if (column === undefined) throw new Error('ClassNode.create: column is required');

    return {
      id: `${file}:CLASS:${name}:${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      column,
      exported: options.exported || false,
      superClass: options.superClass,
      methods: options.methods || [],
      ...(options.isInstantiationRef !== undefined && { isInstantiationRef: options.isInstantiationRef })
    };
  }

  /**
   * Create CLASS node with semantic ID (NEW API)
   *
   * Uses ScopeContext from ScopeTracker for stable identifiers.
   * Class names are unique within scope, so no discriminator needed.
   *
   * @param name - Class name
   * @param context - Scope context from ScopeTracker.getContext()
   * @param location - Source location { line, column }
   * @param options - Optional class properties
   * @returns ClassNodeRecord with semantic ID
   */
  static createWithContext(
    name: string,
    context: ScopeContext,
    location: Partial<Location>,
    options: ClassContextOptions = {}
  ): ClassNodeRecord {
    // Validate required fields
    if (!name) throw new Error('ClassNode.createWithContext: name is required');
    if (!context.file) throw new Error('ClassNode.createWithContext: file is required');
    if (location.line === undefined) throw new Error('ClassNode.createWithContext: line is required');
    if (location.column === undefined) throw new Error('ClassNode.createWithContext: column is required');

    // Compute semantic ID
    const id = computeSemanticId(this.TYPE, name, context);

    return {
      id,
      type: this.TYPE,
      name,
      file: context.file,
      line: location.line,
      column: location.column,
      exported: options.exported || false,
      superClass: options.superClass,
      methods: options.methods || [],
      ...(options.isInstantiationRef !== undefined && { isInstantiationRef: options.isInstantiationRef })
    };
  }

  static validate(node: ClassNodeRecord): string[] {
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

export type { ClassNodeRecord };
