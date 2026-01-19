/**
 * MethodNode - contract for METHOD node (class method)
 */

import type { BaseNodeRecord } from '@grafema/types';

type MethodKind = 'method' | 'get' | 'set' | 'constructor';

interface MethodNodeRecord extends BaseNodeRecord {
  type: 'METHOD';
  column: number;
  className: string;
  async: boolean;
  generator: boolean;
  static: boolean;
  kind: MethodKind;
}

interface MethodNodeOptions {
  async?: boolean;
  generator?: boolean;
  static?: boolean;
  kind?: MethodKind;
}

export class MethodNode {
  static readonly TYPE = 'METHOD' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'className'] as const;
  static readonly OPTIONAL = ['column', 'async', 'generator', 'static', 'kind'] as const;

  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    className: string,
    options: MethodNodeOptions = {}
  ): MethodNodeRecord {
    if (!name) throw new Error('MethodNode.create: name is required');
    if (!file) throw new Error('MethodNode.create: file is required');
    if (!line) throw new Error('MethodNode.create: line is required');
    if (!className) throw new Error('MethodNode.create: className is required');

    return {
      id: `${file}:METHOD:${className}.${name}:${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      column: column || 0,
      className,
      async: options.async || false,
      generator: options.generator || false,
      static: options.static || false,
      kind: options.kind || 'method'
    };
  }

  static validate(node: MethodNodeRecord): string[] {
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

export type { MethodNodeRecord, MethodKind };
