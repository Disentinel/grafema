/**
 * RustMethodNode - contract for RUST_METHOD node
 *
 * Represents a method inside a Rust impl block, extracted by RustAnalyzer.
 * Includes #[napi] attribute detection for FFI linking.
 *
 * ID format: RUST_METHOD#<name>#<file>#<line>
 * Example: RUST_METHOD#add_node#src/engine.rs#55
 */

import type { BaseNodeRecord } from '@grafema/types';

interface RustMethodNodeRecord extends BaseNodeRecord {
  type: 'RUST_METHOD';
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
  selfType: string | null;
  implId: string;
  implType: string;
  unsafeBlocks: number;
}

interface RustMethodNodeOptions {
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
  selfType?: string | null;
  unsafeBlocks?: number;
}

export class RustMethodNode {
  static readonly TYPE = 'RUST_METHOD' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column', 'implId', 'implType'] as const;
  static readonly OPTIONAL = ['pub', 'async', 'unsafe', 'const', 'napi', 'napiJsName', 'napiConstructor', 'napiGetter', 'napiSetter', 'params', 'returnType', 'selfType', 'unsafeBlocks'] as const;

  /**
   * Create RUST_METHOD node
   *
   * @param name - Method name
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param implId - ID of the parent RUST_IMPL node
   * @param implType - Target type of the parent impl block
   * @param options - Optional method attributes
   */
  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    implId: string,
    implType: string,
    options: RustMethodNodeOptions = {}
  ): RustMethodNodeRecord {
    if (!name) throw new Error('RustMethodNode.create: name is required');
    if (!file) throw new Error('RustMethodNode.create: file is required');
    if (line === undefined) throw new Error('RustMethodNode.create: line is required');
    if (column === undefined) throw new Error('RustMethodNode.create: column is required');
    if (!implId) throw new Error('RustMethodNode.create: implId is required');
    if (!implType) throw new Error('RustMethodNode.create: implType is required');

    return {
      id: `RUST_METHOD#${name}#${file}#${line}`,
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
      selfType: options.selfType || null,
      implId,
      implType,
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

export type { RustMethodNodeRecord };
