/**
 * ExternalStdioNode - contract for EXTERNAL_STDIO node (singleton)
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ExternalStdioNodeRecord extends BaseNodeRecord {
  type: 'EXTERNAL_STDIO';
}

export class ExternalStdioNode {
  static readonly TYPE = 'EXTERNAL_STDIO' as const;
  static readonly SINGLETON_ID = 'EXTERNAL_STDIO:__stdio__';

  static readonly REQUIRED = ['name', 'file'] as const;
  static readonly OPTIONAL = [] as const;

  static create(): ExternalStdioNodeRecord {
    return {
      id: this.SINGLETON_ID,
      type: this.TYPE,
      name: '__stdio__',
      file: '__builtin__',
      line: 0
    };
  }

  static validate(node: ExternalStdioNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    if (node.id !== this.SINGLETON_ID) errors.push(`Invalid singleton ID`);
    return errors;
  }
}

export type { ExternalStdioNodeRecord };
