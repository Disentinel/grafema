/**
 * RustTraitNode - contract for RUST_TRAIT node
 *
 * Represents a Rust trait extracted by RustAnalyzer.
 *
 * ID format: RUST_TRAIT#<name>#<file>#<line>
 * Example: RUST_TRAIT#QueryEngine#src/traits.rs#10
 */

import type { BaseNodeRecord } from '@grafema/types';

interface RustTraitMethodRecord {
  name: string;
  params: string[];
  returnType: string;
}

interface RustTraitNodeRecord extends BaseNodeRecord {
  type: 'RUST_TRAIT';
  pub: boolean;
  methods: RustTraitMethodRecord[];
}

interface RustTraitNodeOptions {
  pub?: boolean;
  methods?: RustTraitMethodRecord[];
}

export class RustTraitNode {
  static readonly TYPE = 'RUST_TRAIT' as const;

  static readonly REQUIRED = ['name', 'file', 'line'] as const;
  static readonly OPTIONAL = ['pub', 'methods'] as const;

  /**
   * Create RUST_TRAIT node
   *
   * @param name - Trait name
   * @param file - File path
   * @param line - Line number
   * @param options - Optional trait attributes
   */
  static create(
    name: string,
    file: string,
    line: number,
    options: RustTraitNodeOptions = {}
  ): RustTraitNodeRecord {
    if (!name) throw new Error('RustTraitNode.create: name is required');
    if (!file) throw new Error('RustTraitNode.create: file is required');
    if (line === undefined) throw new Error('RustTraitNode.create: line is required');

    return {
      id: `RUST_TRAIT#${name}#${file}#${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      pub: options.pub || false,
      methods: options.methods || [],
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

export type { RustTraitNodeRecord, RustTraitMethodRecord };
