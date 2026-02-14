/**
 * TypeParameterNode - contract for TYPE_PARAMETER node
 *
 * Represents a generic type parameter on a function, class, interface, or type alias.
 *
 * ID format: {parentId}:TYPE_PARAMETER:{name}
 * Example: /src/types.ts:INTERFACE:Container:5:TYPE_PARAMETER:T
 *
 * Type parameter names are unique within their declaration scope
 * (TypeScript does not allow `<T, T>`), so {parentId}:{name} is sufficient.
 */

import type { BaseNodeRecord } from '@grafema/types';

interface TypeParameterNodeRecord extends BaseNodeRecord {
  type: 'TYPE_PARAMETER';
  column: number;
  constraint?: string;
  defaultType?: string;
  variance?: 'in' | 'out' | 'in out';
}

interface TypeParameterNodeOptions {
  constraint?: string;
  defaultType?: string;
  variance?: 'in' | 'out' | 'in out';
}

export class TypeParameterNode {
  static readonly TYPE = 'TYPE_PARAMETER' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['constraint', 'defaultType', 'variance'] as const;

  /**
   * Create TYPE_PARAMETER node
   *
   * @param name - Type parameter name (e.g., "T", "K")
   * @param parentId - ID of the owning declaration (function, class, interface, type)
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Optional constraint, defaultType, variance
   * @returns TypeParameterNodeRecord
   */
  static create(
    name: string,
    parentId: string,
    file: string,
    line: number,
    column: number,
    options: TypeParameterNodeOptions = {}
  ): TypeParameterNodeRecord {
    if (!name) throw new Error('TypeParameterNode.create: name is required');
    if (!parentId) throw new Error('TypeParameterNode.create: parentId is required');
    if (!file) throw new Error('TypeParameterNode.create: file is required');
    if (!line) throw new Error('TypeParameterNode.create: line is required');
    if (column === undefined) throw new Error('TypeParameterNode.create: column is required');

    return {
      id: `${parentId}:TYPE_PARAMETER:${name}`,
      type: this.TYPE,
      name,
      file,
      line,
      column,
      ...(options.constraint !== undefined && { constraint: options.constraint }),
      ...(options.defaultType !== undefined && { defaultType: options.defaultType }),
      ...(options.variance !== undefined && { variance: options.variance }),
    };
  }

  static validate(node: TypeParameterNodeRecord): string[] {
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

export type { TypeParameterNodeRecord, TypeParameterNodeOptions };
