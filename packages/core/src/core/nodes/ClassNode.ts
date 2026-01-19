/**
 * ClassNode - contract for CLASS node
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ClassNodeRecord extends BaseNodeRecord {
  type: 'CLASS';
  column: number;
  exported: boolean;
  superClass?: string;
  methods: string[];
}

interface ClassNodeOptions {
  exported?: boolean;
  superClass?: string;
  methods?: string[];
}

export class ClassNode {
  static readonly TYPE = 'CLASS' as const;

  static readonly REQUIRED = ['name', 'file', 'line'] as const;
  static readonly OPTIONAL = ['column', 'exported', 'superClass', 'methods'] as const;

  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    options: ClassNodeOptions = {}
  ): ClassNodeRecord {
    if (!name) throw new Error('ClassNode.create: name is required');
    if (!file) throw new Error('ClassNode.create: file is required');
    if (!line) throw new Error('ClassNode.create: line is required');

    return {
      id: `${file}:CLASS:${name}:${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      column: column || 0,
      exported: options.exported || false,
      superClass: options.superClass,
      methods: options.methods || []
    };
  }

  static validate(node: ClassNodeRecord): string[] {
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

export type { ClassNodeRecord };
