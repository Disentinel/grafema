/**
 * ExternalNode - contract for EXTERNAL nodes
 *
 * Represents external APIs/services that the codebase interacts with.
 * Singleton per domain - same domain always produces same ID.
 *
 * ID format: EXTERNAL#{domain}
 */

import type { ExternalNodeRecord } from '@grafema/types';

export class ExternalNode {
  static readonly TYPE = 'EXTERNAL' as const;

  static readonly REQUIRED = ['name'] as const;
  static readonly OPTIONAL = ['domain'] as const;

  /**
   * Create EXTERNAL node
   *
   * @param domain - External service domain (e.g., 'api.github.com')
   */
  static create(domain: string): ExternalNodeRecord {
    if (!domain) throw new Error('ExternalNode.create: domain is required');

    const id = `EXTERNAL#${domain}`;

    return {
      id,
      type: this.TYPE,
      name: domain,
      domain,
      file: '__external__',  // External nodes don't have a source file
    };
  }

  static validate(node: ExternalNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (nodeRecord[field] === undefined) errors.push(`Missing: ${field}`);
    }
    return errors;
  }
}

export type { ExternalNodeRecord };
