/**
 * ExportNode - contract for EXPORT node
 */

import type { BaseNodeRecord } from '@grafema/types';

type ExportKind = 'value' | 'type';

interface ExportNodeRecord extends BaseNodeRecord {
  type: 'EXPORT';
  column: number;
  exportKind: ExportKind;
  local: string;
  default: boolean;
}

interface ExportNodeOptions {
  exportKind?: ExportKind;
  local?: string;
  default?: boolean;
}

export class ExportNode {
  static readonly TYPE = 'EXPORT' as const;

  static readonly REQUIRED = ['name', 'file', 'line'] as const;
  static readonly OPTIONAL = ['column', 'exportKind', 'local', 'default'] as const;

  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    options: ExportNodeOptions = {}
  ): ExportNodeRecord {
    if (!name) throw new Error('ExportNode.create: name is required');
    if (!file) throw new Error('ExportNode.create: file is required');
    if (!line) throw new Error('ExportNode.create: line is required');

    return {
      id: `${file}:EXPORT:${name}:${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      column: column || 0,
      exportKind: options.exportKind || 'value',
      local: options.local || name,
      default: options.default || false
    };
  }

  static validate(node: ExportNodeRecord): string[] {
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

export type { ExportNodeRecord, ExportKind };
