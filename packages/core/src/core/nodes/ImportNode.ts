/**
 * ImportNode - contract for IMPORT node
 */

import type { BaseNodeRecord } from '@grafema/types';

type ImportKind = 'value' | 'type' | 'typeof';

interface ImportNodeRecord extends BaseNodeRecord {
  type: 'IMPORT';
  column: number;
  source: string;
  importKind: ImportKind;
  imported: string;
  local: string;
}

interface ImportNodeOptions {
  importKind?: ImportKind;
  imported?: string;
  local?: string;
}

export class ImportNode {
  static readonly TYPE = 'IMPORT' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'source'] as const;
  static readonly OPTIONAL = ['column', 'importKind', 'imported', 'local'] as const;

  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    source: string,
    options: ImportNodeOptions = {}
  ): ImportNodeRecord {
    if (!name) throw new Error('ImportNode.create: name is required');
    if (!file) throw new Error('ImportNode.create: file is required');
    if (!line) throw new Error('ImportNode.create: line is required');
    if (!source) throw new Error('ImportNode.create: source is required');

    return {
      id: `${file}:IMPORT:${name}:${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      column: column || 0,
      source,
      importKind: options.importKind || 'value',
      imported: options.imported || name,
      local: options.local || name
    };
  }

  static validate(node: ImportNodeRecord): string[] {
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

export type { ImportNodeRecord, ImportKind };
