/**
 * RustModuleNode - contract for RUST_MODULE node
 *
 * Represents a Rust source file (.rs) indexed from packages/rfdb-server/src/.
 * Created by RustModuleIndexer during the INDEXING phase.
 *
 * ID format: RUST_MODULE#<moduleName>#<relativePath>
 * Example: RUST_MODULE#ffi::napi_bindings#ffi/napi_bindings.rs
 */

import type { BaseNodeRecord } from '@grafema/types';

interface RustModuleNodeRecord extends BaseNodeRecord {
  type: 'RUST_MODULE';
  contentHash: string;
  isLib: boolean;
  isMod: boolean;
  isTest: boolean;
}

interface RustModuleNodeOptions {
  isLib?: boolean;
  isMod?: boolean;
  isTest?: boolean;
}

export class RustModuleNode {
  static readonly TYPE = 'RUST_MODULE' as const;

  static readonly REQUIRED = ['name', 'file', 'contentHash'] as const;
  static readonly OPTIONAL = ['isLib', 'isMod', 'isTest'] as const;

  /**
   * Create RUST_MODULE node
   *
   * @param moduleName - Rust module name (e.g., "crate", "ffi::napi_bindings")
   * @param file - Absolute file path
   * @param contentHash - SHA-256 hash of file content
   * @param prefixedPath - Relative path, possibly prefixed for multi-root workspaces
   * @param options - Optional flags (isLib, isMod, isTest)
   */
  static create(
    moduleName: string,
    file: string,
    contentHash: string,
    prefixedPath: string,
    options: RustModuleNodeOptions = {}
  ): RustModuleNodeRecord {
    if (!moduleName) throw new Error('RustModuleNode.create: moduleName is required');
    if (!file) throw new Error('RustModuleNode.create: file is required');
    if (!contentHash) throw new Error('RustModuleNode.create: contentHash is required');
    if (!prefixedPath) throw new Error('RustModuleNode.create: prefixedPath is required');

    return {
      id: `RUST_MODULE#${moduleName}#${prefixedPath}`,
      type: this.TYPE,
      name: moduleName,
      file,
      contentHash,
      isLib: options.isLib || false,
      isMod: options.isMod || false,
      isTest: options.isTest || false,
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

export type { RustModuleNodeRecord };
