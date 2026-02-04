/**
 * EnumNode - contract for ENUM node
 *
 * Represents TypeScript enum declarations.
 *
 * ID format: {file}:ENUM:{name}:{line}
 * Example: /src/types.ts:ENUM:Status:20
 */

import type { BaseNodeRecord } from '@grafema/types';

interface EnumMemberRecord {
  name: string;
  value?: string | number;
}

interface EnumNodeRecord extends BaseNodeRecord {
  type: 'ENUM';
  column: number;
  isConst: boolean;
  members: EnumMemberRecord[];
}

interface EnumNodeOptions {
  isConst?: boolean;
  members?: EnumMemberRecord[];
}

export class EnumNode {
  static readonly TYPE = 'ENUM' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['isConst', 'members'] as const;

  /**
   * Create ENUM node
   *
   * @param name - Enum name
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Optional enum properties
   * @returns EnumNodeRecord
   */
  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    options: EnumNodeOptions = {}
  ): EnumNodeRecord {
    if (!name) throw new Error('EnumNode.create: name is required');
    if (!file) throw new Error('EnumNode.create: file is required');
    if (!line) throw new Error('EnumNode.create: line is required');
    if (column === undefined) throw new Error('EnumNode.create: column is required');

    return {
      id: `${file}:ENUM:${name}:${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      column,
      isConst: options.isConst || false,
      members: options.members || []
    };
  }

  static validate(node: EnumNodeRecord): string[] {
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

export type { EnumNodeRecord, EnumMemberRecord };
