/**
 * ExternalFunctionNode - contract for EXTERNAL_FUNCTION node
 *
 * Represents an external function from a Node.js built-in module
 * (e.g., fs.readFile, path.join, crypto.createHash).
 *
 * Created lazily by NodejsBuiltinsResolver when a call to a builtin function is detected.
 *
 * ID format: EXTERNAL_FUNCTION:{module}.{function}
 * Example: EXTERNAL_FUNCTION:fs.readFile, EXTERNAL_FUNCTION:path.join
 */

import type { BaseNodeRecord } from '@grafema/types';
import type { SecurityCategory } from '../../data/builtins/types.js';

interface ExternalFunctionNodeRecord extends BaseNodeRecord {
  type: 'EXTERNAL_FUNCTION';
  isBuiltin: boolean;
  security?: SecurityCategory;
  pure?: boolean;
}

interface ExternalFunctionOptions {
  security?: SecurityCategory;
  pure?: boolean;
}

export class ExternalFunctionNode {
  static readonly TYPE = 'EXTERNAL_FUNCTION' as const;

  static readonly REQUIRED = ['name', 'isBuiltin'] as const;
  static readonly OPTIONAL = ['security', 'pure'] as const;

  /**
   * Create EXTERNAL_FUNCTION node
   *
   * @param moduleName - Normalized module name (e.g., 'fs', 'path', 'crypto')
   * @param functionName - Function name (e.g., 'readFile', 'join')
   * @param options - Optional security and pure fields
   * @returns ExternalFunctionNodeRecord
   */
  static create(moduleName: string, functionName: string, options: ExternalFunctionOptions = {}): ExternalFunctionNodeRecord {
    if (!moduleName) throw new Error('ExternalFunctionNode.create: moduleName is required');
    if (!functionName) throw new Error('ExternalFunctionNode.create: functionName is required');

    return {
      id: `EXTERNAL_FUNCTION:${moduleName}.${functionName}`,
      type: this.TYPE,
      name: `${moduleName}.${functionName}`,
      file: '',
      line: 0,
      isBuiltin: true,
      ...(options.security && { security: options.security }),
      ...(options.pure !== undefined && { pure: options.pure }),
    };
  }

  static validate(node: ExternalFunctionNodeRecord): string[] {
    const errors: string[] = [];

    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }

    if (!node.name) {
      errors.push('Missing required field: name');
    }

    if (node.isBuiltin === undefined) {
      errors.push('Missing required field: isBuiltin');
    }

    return errors;
  }
}

export type { ExternalFunctionNodeRecord, ExternalFunctionOptions };
