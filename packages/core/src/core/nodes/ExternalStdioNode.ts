/**
 * ExternalStdioNode - contract for net:stdio node (singleton)
 *
 * Represents standard I/O streams (console.log, console.error, etc.)
 * Singleton node - only one instance per graph.
 *
 * Uses namespaced type 'net:stdio' for semantic grouping - AI agents
 * can query all I/O-related nodes via 'net:*' pattern.
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ExternalStdioNodeRecord extends BaseNodeRecord {
  type: 'net:stdio';
  description?: string;
}

export class ExternalStdioNode {
  static readonly TYPE = 'net:stdio' as const;
  static readonly SINGLETON_ID = 'net:stdio#__stdio__';

  static readonly REQUIRED = ['name'] as const;
  static readonly OPTIONAL = ['description'] as const;

  static create(): ExternalStdioNodeRecord {
    return {
      id: this.SINGLETON_ID,
      type: this.TYPE,
      name: '__stdio__',
      file: '__builtin__',
      line: 0,
      description: 'Standard input/output stream'
    };
  }

  static validate(node: ExternalStdioNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    if (node.id !== this.SINGLETON_ID) errors.push(`Invalid singleton ID: ${node.id}, expected ${this.SINGLETON_ID}`);
    return errors;
  }
}

export type { ExternalStdioNodeRecord };
