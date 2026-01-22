/**
 * InterfaceNode - contract for INTERFACE node
 *
 * Represents TypeScript interface declarations.
 *
 * ID format: {file}:INTERFACE:{name}:{line}
 * Example: /src/types.ts:INTERFACE:IUser:5
 */

import type { BaseNodeRecord } from '@grafema/types';

interface InterfacePropertyRecord {
  name: string;
  type?: string;
  optional?: boolean;
  readonly?: boolean;
}

interface InterfaceNodeRecord extends BaseNodeRecord {
  type: 'INTERFACE';
  column: number;
  extends: string[];
  properties: InterfacePropertyRecord[];
  isExternal?: boolean;
}

interface InterfaceNodeOptions {
  extends?: string[];
  properties?: InterfacePropertyRecord[];
  isExternal?: boolean;
}

export class InterfaceNode {
  static readonly TYPE = 'INTERFACE' as const;

  static readonly REQUIRED = ['name', 'file', 'line'] as const;
  static readonly OPTIONAL = ['column', 'extends', 'properties', 'isExternal'] as const;

  /**
   * Create INTERFACE node
   *
   * @param name - Interface name
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Optional interface properties
   * @returns InterfaceNodeRecord
   */
  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    options: InterfaceNodeOptions = {}
  ): InterfaceNodeRecord {
    if (!name) throw new Error('InterfaceNode.create: name is required');
    if (!file) throw new Error('InterfaceNode.create: file is required');
    if (!line) throw new Error('InterfaceNode.create: line is required');

    return {
      id: `${file}:INTERFACE:${name}:${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      column: column || 0,
      extends: options.extends || [],
      properties: options.properties || [],
      ...(options.isExternal !== undefined && { isExternal: options.isExternal })
    };
  }

  static validate(node: InterfaceNodeRecord): string[] {
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

export type { InterfaceNodeRecord, InterfacePropertyRecord };
