/**
 * ExternalModuleNode - contract for EXTERNAL_MODULE node
 *
 * Represents external npm packages or Node.js built-in modules
 * that are imported but not analyzed.
 *
 * ID format: EXTERNAL_MODULE:{source}
 * Example: EXTERNAL_MODULE:lodash, EXTERNAL_MODULE:@tanstack/react-query
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ExternalModuleNodeRecord extends BaseNodeRecord {
  type: 'EXTERNAL_MODULE';
}

export class ExternalModuleNode {
  static readonly TYPE = 'EXTERNAL_MODULE' as const;

  static readonly REQUIRED = ['name'] as const;
  static readonly OPTIONAL = [] as const;

  /**
   * Create EXTERNAL_MODULE node
   *
   * Normalizes node: prefix for Node.js builtins:
   * - 'node:fs' -> 'fs'
   * - 'node:path' -> 'path'
   *
   * @param source - Module name (e.g., 'lodash', '@tanstack/react-query', 'node:fs')
   * @returns ExternalModuleNodeRecord
   */
  static create(source: string): ExternalModuleNodeRecord {
    if (!source) throw new Error('ExternalModuleNode.create: source is required');

    // Normalize node: prefix for Node.js builtins
    const normalizedSource = source.startsWith('node:')
      ? source.slice(5)
      : source;

    return {
      id: `EXTERNAL_MODULE:${normalizedSource}`,
      type: this.TYPE,
      name: normalizedSource,
      file: '',
      line: 0
    };
  }

  static validate(node: ExternalModuleNodeRecord): string[] {
    const errors: string[] = [];

    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }

    if (!node.name) {
      errors.push('Missing required field: name');
    }

    return errors;
  }
}

export type { ExternalModuleNodeRecord };
