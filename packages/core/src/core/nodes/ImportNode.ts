/**
 * ImportNode - contract for IMPORT node
 */

import type { BaseNodeRecord } from '@grafema/types';

type ImportBinding = 'value' | 'type' | 'typeof';
type ImportType = 'default' | 'named' | 'namespace';

interface ImportNodeRecord extends BaseNodeRecord {
  type: 'IMPORT';
  column: number;
  source: string;
  importType: ImportType;      // NEW: HOW it's imported (syntax)
  importBinding: ImportBinding; // RENAMED: WHAT is imported (semantics)
  imported: string;
  local: string;
  isDynamic?: boolean;         // true for dynamic import() expressions
  isResolvable?: boolean;      // true if path is a string literal (statically analyzable)
  dynamicPath?: string;        // original expression for template/variable paths
  sideEffect?: boolean;        // REG-273: true for side-effect-only imports
}

interface ImportNodeOptions {
  importType?: ImportType;      // Optional - will be auto-detected if not provided
  importBinding?: ImportBinding;
  imported?: string;            // Used for auto-detection if importType not provided
  local?: string;
  isDynamic?: boolean;          // true for dynamic import() expressions
  isResolvable?: boolean;       // true if path is a string literal (statically analyzable)
  dynamicPath?: string;         // original expression for template/variable paths
  sideEffect?: boolean;         // REG-273: true for side-effect-only imports
}

export class ImportNode {
  static readonly TYPE = 'IMPORT' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'source'] as const;
  static readonly OPTIONAL = ['column', 'importType', 'importBinding', 'imported', 'local', 'isDynamic', 'isResolvable', 'dynamicPath', 'sideEffect'] as const;

  /**
   * Create IMPORT node
   *
   * @param name - The local binding name (what the import is called in this module)
   * @param file - Absolute file path
   * @param line - Line number (for debugging only, not part of ID)
   * @param column - Column position (pass 0 if unavailable - JSASTAnalyzer limitation)
   * @param source - Module source (e.g., 'react', './utils')
   * @param options - Optional fields
   * @returns ImportNodeRecord
   */
  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    source: string,
    options: ImportNodeOptions = {}
  ): ImportNodeRecord {
    if (!name) throw new Error('ImportNode.create: name is required');
    if (!file) throw new Error('ImportNode.create: file is required');
    if (line === undefined) throw new Error('ImportNode.create: line is required');
    if (!source) throw new Error('ImportNode.create: source is required');

    // Auto-detect importType from imported field if not explicitly provided
    let importType = options.importType;
    if (!importType && options.imported) {
      importType = options.imported === 'default' ? 'default' :
                   options.imported === '*' ? 'namespace' : 'named';
    }

    const record: ImportNodeRecord = {
      id: `${file}:IMPORT:${source}:${name}`,  // SEMANTIC ID: no line number
      type: this.TYPE,
      name,
      file,
      line,      // Stored as field, not in ID
      column: column || 0,
      source,
      importType: importType || 'named',           // NEW field with auto-detection
      importBinding: options.importBinding || 'value',  // RENAMED field
      imported: options.imported || name,
      local: options.local || name
    };

    // Add dynamic import fields if provided
    if (options.isDynamic !== undefined) {
      record.isDynamic = options.isDynamic;
    }
    if (options.isResolvable !== undefined) {
      record.isResolvable = options.isResolvable;
    }
    if (options.dynamicPath !== undefined) {
      record.dynamicPath = options.dynamicPath;
    }

    // REG-273: Add sideEffect field if provided
    if (options.sideEffect !== undefined) {
      record.sideEffect = options.sideEffect;
    }

    return record;
  }

  static validate(node: ImportNodeRecord): string[] {
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

export type { ImportNodeRecord, ImportBinding, ImportType };
