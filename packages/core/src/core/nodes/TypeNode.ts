/**
 * TypeNode - contract for TYPE node
 *
 * Represents TypeScript type alias declarations.
 *
 * ID format: {file}:TYPE:{name}:{line}
 * Example: /src/types.ts:TYPE:UserId:10
 */

import type { BaseNodeRecord } from '@grafema/types';

interface TypeNodeRecord extends BaseNodeRecord {
  type: 'TYPE';
  column: number;
  aliasOf?: string;
}

interface TypeNodeOptions {
  aliasOf?: string;
}

export class TypeNode {
  static readonly TYPE = 'TYPE' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['aliasOf'] as const;

  /**
   * Create TYPE node
   *
   * @param name - Type alias name
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Optional type properties
   * @returns TypeNodeRecord
   */
  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    options: TypeNodeOptions = {}
  ): TypeNodeRecord {
    if (!name) throw new Error('TypeNode.create: name is required');
    if (!file) throw new Error('TypeNode.create: file is required');
    if (!line) throw new Error('TypeNode.create: line is required');
    if (column === undefined) throw new Error('TypeNode.create: column is required');

    return {
      id: `${file}:TYPE:${name}:${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      column,
      aliasOf: options.aliasOf
    };
  }

  static validate(node: TypeNodeRecord): string[] {
    const errors: string[] = [];

    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }

    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (nodeRecord[field] === undefined || nodeRecord[field] === null) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    return errors;
  }
}

export type { TypeNodeRecord };
