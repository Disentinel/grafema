/**
 * BuiltinRegistry Types (REG-218)
 *
 * Type definitions for Node.js builtin function registry.
 * Used for lazy EXTERNAL_FUNCTION node creation.
 */

/**
 * Security category for builtin functions.
 * Used for security analysis and auditing.
 */
export type SecurityCategory = 'file-io' | 'exec' | 'net' | 'crypto';

/**
 * Definition of a single builtin function.
 */
export interface BuiltinFunctionDef {
  /** Function name (e.g., 'readFile') */
  name: string;
  /** Module name (e.g., 'fs', 'path', 'fs/promises') */
  module: string;
  /** Security category (for dangerous functions) */
  security?: SecurityCategory;
  /** Whether function is pure (no side effects) */
  pure?: boolean;
}

/**
 * Definition of a builtin module with its functions.
 */
export interface BuiltinModuleDef {
  /** Module name (e.g., 'fs', 'path') */
  name: string;
  /** List of functions in this module */
  functions: BuiltinFunctionDef[];
}
