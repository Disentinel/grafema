/**
 * RustImplNode - contract for RUST_IMPL node
 *
 * Represents a Rust impl block extracted by RustAnalyzer.
 * Handles both inherent impls and trait impls.
 *
 * ID format: RUST_IMPL#<targetType>[:<traitName>]#<file>#<line>
 * Example: RUST_IMPL#GraphEngine#src/engine.rs#42
 * Example: RUST_IMPL#GraphEngine:Display#src/engine.rs#100
 */

import type { BaseNodeRecord } from '@grafema/types';

interface RustImplNodeRecord extends BaseNodeRecord {
  type: 'RUST_IMPL';
  traitName: string | null;
}

interface RustImplNodeOptions {
  traitName?: string | null;
}

export class RustImplNode {
  static readonly TYPE = 'RUST_IMPL' as const;

  static readonly REQUIRED = ['name', 'file', 'line'] as const;
  static readonly OPTIONAL = ['traitName'] as const;

  /**
   * Create RUST_IMPL node
   *
   * @param targetType - The type being implemented (used as node name)
   * @param file - File path
   * @param line - Line number
   * @param options - Optional traitName for trait implementations
   */
  static create(
    targetType: string,
    file: string,
    line: number,
    options: RustImplNodeOptions = {}
  ): RustImplNodeRecord {
    if (!targetType) throw new Error('RustImplNode.create: targetType is required');
    if (!file) throw new Error('RustImplNode.create: file is required');
    if (line === undefined) throw new Error('RustImplNode.create: line is required');

    const traitName = options.traitName || null;
    const traitSuffix = traitName ? ':' + traitName : '';

    return {
      id: `RUST_IMPL#${targetType}${traitSuffix}#${file}#${line}`,
      type: this.TYPE,
      name: targetType,
      file,
      line,
      traitName,
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

export type { RustImplNodeRecord };
