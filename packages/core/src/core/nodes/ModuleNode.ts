/**
 * ModuleNode - contract for MODULE node
 *
 * Supports two creation modes:
 * 1. createWithContext() - NEW: Uses ScopeContext for semantic IDs
 * 2. create() - LEGACY: Uses hash-based IDs for backward compatibility
 *
 * Semantic ID format: {file}->global->MODULE->module
 * Example: src/index.js->global->MODULE->module
 *
 * Each file has exactly one MODULE node. The name in the ID is always "module".
 */

import { createHash } from 'crypto';
import type { BaseNodeRecord } from '@grafema/types';
import { computeSemanticId, type ScopeContext } from '../SemanticId.js';

interface ModuleNodeRecord extends BaseNodeRecord {
  type: 'MODULE';
  contentHash: string;
  isTest: boolean;
}

interface ModuleNodeOptions {
  isTest?: boolean;
}

/**
 * Options for createWithContext
 */
interface ModuleContextOptions {
  contentHash?: string;
  isTest?: boolean;
}

export class ModuleNode {
  static readonly TYPE = 'MODULE' as const;

  static readonly REQUIRED = ['name', 'file', 'contentHash'] as const;
  static readonly OPTIONAL = ['isTest'] as const;

  /**
   * Create MODULE node
   * @param filePath - Full file path
   * @param relativePath - Relative path (module name)
   * @param contentHash - Content hash
   * @param options - Additional options (isTest, etc.)
   */
  static create(
    filePath: string,
    relativePath: string,
    contentHash: string,
    options: ModuleNodeOptions = {}
  ): ModuleNodeRecord {
    if (!filePath) throw new Error('ModuleNode.create: filePath is required');
    if (!relativePath) throw new Error('ModuleNode.create: relativePath is required');
    if (!contentHash) throw new Error('ModuleNode.create: contentHash is required');

    return {
      id: `MODULE:${contentHash}`,
      type: this.TYPE,
      name: relativePath,
      file: filePath,
      line: 0,
      contentHash,
      isTest: options.isTest || false
    };
  }

  /**
   * Create MODULE node with semantic ID (NEW API)
   *
   * Uses ScopeContext for stable identifiers that don't change
   * when file content changes (unlike hash-based IDs).
   *
   * Each file has exactly one MODULE node.
   * The name in the semantic ID is always "module".
   *
   * @param context - Scope context with file path (relative to project root)
   * @param options - Optional contentHash and isTest flag
   * @returns ModuleNodeRecord with semantic ID
   */
  static createWithContext(
    context: ScopeContext,
    options: ModuleContextOptions = {}
  ): ModuleNodeRecord {
    if (!context.file) throw new Error('ModuleNode.createWithContext: file is required in context');

    const id = computeSemanticId(this.TYPE, 'module', context);

    return {
      id,
      type: this.TYPE,
      name: context.file,
      file: context.file,
      line: 0,
      contentHash: options.contentHash || '',
      isTest: options.isTest || false
    };
  }

  static _hashPath(path: string): string {
    return createHash('md5').update(path).digest('hex').substring(0, 12);
  }

  static validate(node: ModuleNodeRecord): string[] {
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

export type { ModuleNodeRecord };
