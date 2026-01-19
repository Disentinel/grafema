/**
 * ModuleNode - contract for MODULE node
 */

import { createHash } from 'crypto';
import type { BaseNodeRecord } from '@grafema/types';

interface ModuleNodeRecord extends BaseNodeRecord {
  type: 'MODULE';
  contentHash: string;
  isTest: boolean;
}

interface ModuleNodeOptions {
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
