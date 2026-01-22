/**
 * ExportNode - contract for EXPORT node
 *
 * Supports two creation modes:
 * 1. createWithContext() - NEW: Uses ScopeContext + Location for semantic IDs
 * 2. create() - LEGACY: Uses line-based IDs for backward compatibility
 *
 * Semantic ID format: {file}->global->EXPORT->{exportedName}
 * Example: src/utils.js->global->EXPORT->formatDate
 */

import type { BaseNodeRecord } from '@grafema/types';
import { computeSemanticId, type ScopeContext, type Location } from '../SemanticId.js';

type ExportKind = 'value' | 'type';

type ExportType = 'default' | 'named' | 'all';

interface ExportNodeRecord extends BaseNodeRecord {
  type: 'EXPORT';
  column: number;
  exportKind: ExportKind;
  local: string;
  default: boolean;
  source?: string;
  exportType?: ExportType;
}

interface ExportNodeOptions {
  exportKind?: ExportKind;
  local?: string;
  default?: boolean;
  source?: string;
  exportType?: ExportType;
}

/**
 * Options for createWithContext
 */
interface ExportContextOptions {
  exportKind?: ExportKind;
  local?: string;
  default?: boolean;
  source?: string;
  exportType?: ExportType;
}

export class ExportNode {
  static readonly TYPE = 'EXPORT' as const;

  static readonly REQUIRED = ['name', 'file', 'line'] as const;
  static readonly OPTIONAL = ['column', 'exportKind', 'local', 'default', 'source', 'exportType'] as const;

  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    options: ExportNodeOptions = {}
  ): ExportNodeRecord {
    if (!name) throw new Error('ExportNode.create: name is required');
    if (!file) throw new Error('ExportNode.create: file is required');
    if (!line) throw new Error('ExportNode.create: line is required');

    return {
      id: `${file}:EXPORT:${name}:${line}`,
      type: this.TYPE,
      name,
      file,
      line,
      column: column || 0,
      exportKind: options.exportKind || 'value',
      local: options.local || name,
      default: options.default || false,
      ...(options.source !== undefined && { source: options.source }),
      ...(options.exportType !== undefined && { exportType: options.exportType })
    };
  }

  /**
   * Create EXPORT node with semantic ID (NEW API)
   *
   * Uses ScopeContext from ScopeTracker for stable identifiers.
   * Export names are unique within module, so no discriminator needed.
   *
   * @param name - Exported name (as visible to importers)
   * @param context - Scope context from ScopeTracker.getContext()
   * @param location - Source location { line, column }
   * @param options - Optional export properties
   * @returns ExportNodeRecord with semantic ID
   */
  static createWithContext(
    name: string,
    context: ScopeContext,
    location: Partial<Location>,
    options: ExportContextOptions = {}
  ): ExportNodeRecord {
    // Validate required fields
    if (!name) throw new Error('ExportNode.createWithContext: name is required');
    if (!context.file) throw new Error('ExportNode.createWithContext: file is required');
    if (location.line === undefined) throw new Error('ExportNode.createWithContext: line is required');

    // Compute semantic ID
    const id = computeSemanticId(this.TYPE, name, context);

    return {
      id,
      type: this.TYPE,
      name,
      file: context.file,
      line: location.line,
      column: location.column ?? 0,
      exportKind: options.exportKind || 'value',
      local: options.local || name,
      default: options.default || false,
      ...(options.source !== undefined && { source: options.source }),
      ...(options.exportType !== undefined && { exportType: options.exportType })
    };
  }

  static validate(node: ExportNodeRecord): string[] {
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

export type { ExportNodeRecord, ExportKind };
