/**
 * RustStructNode - contract for RUST_STRUCT node
 *
 * Represents a Rust struct extracted by RustAnalyzer.
 * Includes #[napi] attribute detection for FFI linking.
 *
 * ID format: RUST_STRUCT#<name>#<file>#<line>
 * Example: RUST_STRUCT#GraphEngine#src/engine.rs#15
 */

import type { BaseNodeRecord } from '@grafema/types';

interface RustStructNodeRecord extends BaseNodeRecord {
  type: 'RUST_STRUCT';
  pub: boolean;
  napi: boolean;
  fields: unknown[];
}

interface RustStructNodeOptions {
  pub?: boolean;
  napi?: boolean;
  fields?: unknown[];
}

export class RustStructNode {
  static readonly TYPE = 'RUST_STRUCT' as const;

  static readonly REQUIRED = ['name', 'file', 'line'] as const;
  static readonly OPTIONAL = ['pub', 'napi', 'fields'] as const;

  /**
   * Create RUST_STRUCT node
   *
   * @param name - Struct name
   * @param file - File path
   * @param line - Line number
   * @param options - Optional struct attributes
   */
  static create(
    name: string,
    file: string,
    line: number,
    options: RustStructNodeOptions = {}
  ): RustStructNodeRecord {
    if (!name) throw new Error('RustStructNode.create: name is required');
    if (!file) throw new Error('RustStructNode.create: file is required');
    if (line === undefined) throw new Error('RustStructNode.create: line is required');

    return {
      id: `RUST_STRUCT#${name}#${file}#${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      pub: options.pub || false,
      napi: options.napi || false,
      fields: options.fields || [],
    };
  }

  static validate(node: BaseNodeRecord): string[] {
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

export type { RustStructNodeRecord };
