/**
 * TypeNode - contract for TYPE node
 *
 * Represents TypeScript type alias declarations.
 *
 * ID format: {file}:TYPE:{name}:{line}
 * Example: /src/types.ts:TYPE:UserId:10
 */

import type { BaseNodeRecord } from '@grafema/types';

type MappedModifier = boolean | '+' | '-';

interface TypeNodeRecord extends BaseNodeRecord {
  type: 'TYPE';
  column: number;
  aliasOf?: string;
  mappedType?: boolean;
  keyName?: string;
  keyConstraint?: string;
  valueType?: string;
  mappedReadonly?: MappedModifier;
  mappedOptional?: MappedModifier;
  nameType?: string;
  conditionalType?: boolean;
  checkType?: string;
  extendsType?: string;
  trueType?: string;
  falseType?: string;
}

interface TypeNodeOptions {
  aliasOf?: string;
  mappedType?: boolean;
  keyName?: string;
  keyConstraint?: string;
  valueType?: string;
  mappedReadonly?: MappedModifier;
  mappedOptional?: MappedModifier;
  nameType?: string;
  conditionalType?: boolean;
  checkType?: string;
  extendsType?: string;
  trueType?: string;
  falseType?: string;
}

export class TypeNode {
  static readonly TYPE = 'TYPE' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['aliasOf', 'mappedType', 'keyName', 'keyConstraint', 'valueType', 'mappedReadonly', 'mappedOptional', 'nameType', 'conditionalType', 'checkType', 'extendsType', 'trueType', 'falseType'] as const;

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

    const record: TypeNodeRecord = {
      id: `${file}:TYPE:${name}:${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      column,
      aliasOf: options.aliasOf,
      conditionalType: options.conditionalType,
      checkType: options.checkType,
      extendsType: options.extendsType,
      trueType: options.trueType,
      falseType: options.falseType
    };

    if (options.mappedType) {
      record.mappedType = true;
      record.keyName = options.keyName;
      record.keyConstraint = options.keyConstraint;
      record.valueType = options.valueType;
      if (options.mappedReadonly !== undefined) record.mappedReadonly = options.mappedReadonly;
      if (options.mappedOptional !== undefined) record.mappedOptional = options.mappedOptional;
      if (options.nameType !== undefined) record.nameType = options.nameType;
    }

    return record;
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
