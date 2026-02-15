/**
 * RustFunctionNode - contract for RUST_FUNCTION node
 *
 * Represents a top-level Rust function extracted by RustAnalyzer.
 * Includes #[napi] attribute detection for FFI linking.
 *
 * ID format: RUST_FUNCTION#<name>#<file>#<line>
 * Example: RUST_FUNCTION#parse_file#src/parser.rs#42
 */

import type { BaseNodeRecord } from '@grafema/types';

interface RustFunctionNodeRecord extends BaseNodeRecord {
  type: 'RUST_FUNCTION';
  column: number;
  pub: boolean;
  async: boolean;
  unsafe: boolean;
  const: boolean;
  napi: boolean;
  napiJsName: string | null;
  napiConstructor: boolean;
  napiGetter: string | null;
  napiSetter: string | null;
  params: string[];
  returnType: string | null;
  unsafeBlocks: number;
}

interface RustFunctionNodeOptions {
  pub?: boolean;
  async?: boolean;
  unsafe?: boolean;
  const?: boolean;
  napi?: boolean;
  napiJsName?: string | null;
  napiConstructor?: boolean;
  napiGetter?: string | null;
  napiSetter?: string | null;
  params?: string[];
  returnType?: string | null;
  unsafeBlocks?: number;
}

export class RustFunctionNode {
  static readonly TYPE = 'RUST_FUNCTION' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column'] as const;
  static readonly OPTIONAL = ['pub', 'async', 'unsafe', 'const', 'napi', 'napiJsName', 'napiConstructor', 'napiGetter', 'napiSetter', 'params', 'returnType', 'unsafeBlocks'] as const;

  /**
   * Create RUST_FUNCTION node
   *
   * @param name - Function name
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Optional function attributes
   */
  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    options: RustFunctionNodeOptions = {}
  ): RustFunctionNodeRecord {
    if (!name) throw new Error('RustFunctionNode.create: name is required');
    if (!file) throw new Error('RustFunctionNode.create: file is required');
    if (line === undefined) throw new Error('RustFunctionNode.create: line is required');
    if (column === undefined) throw new Error('RustFunctionNode.create: column is required');

    return {
      id: `RUST_FUNCTION#${name}#${file}#${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      column,
      pub: options.pub || false,
      async: options.async || false,
      unsafe: options.unsafe || false,
      const: options.const || false,
      napi: options.napi || false,
      napiJsName: options.napiJsName || null,
      napiConstructor: options.napiConstructor || false,
      napiGetter: options.napiGetter || null,
      napiSetter: options.napiSetter || null,
      params: options.params || [],
      returnType: options.returnType || null,
      unsafeBlocks: options.unsafeBlocks || 0,
    };
  }

  static validate(node: BaseNodeRecord): string[] {
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

export type { RustFunctionNodeRecord };
