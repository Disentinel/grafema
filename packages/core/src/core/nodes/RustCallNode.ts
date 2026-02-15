/**
 * RustCallNode - contract for RUST_CALL node
 *
 * Represents a function/method/macro call inside a Rust function or method,
 * extracted by RustAnalyzer. Tracks side effects (fs:write, panic, io:print, etc.).
 *
 * ID format: RUST_CALL#<parentName>#<line>#<column>#<file>
 * Example: RUST_CALL#parse_file#42#8#src/parser.rs
 */

import type { BaseNodeRecord } from '@grafema/types';

type RustCallType = 'function' | 'method' | 'macro';

interface RustCallNodeRecord extends BaseNodeRecord {
  type: 'RUST_CALL';
  column: number;
  callType: RustCallType;
  argsCount: number;
  receiver: string | null;
  method: string | null;
  sideEffect: string | null;
}

interface RustCallNodeOptions {
  name?: string | null;
  receiver?: string | null;
  method?: string | null;
  sideEffect?: string | null;
}

export class RustCallNode {
  static readonly TYPE = 'RUST_CALL' as const;

  static readonly REQUIRED = ['file', 'line', 'column', 'callType', 'argsCount'] as const;
  static readonly OPTIONAL = ['name', 'receiver', 'method', 'sideEffect'] as const;

  /**
   * Create RUST_CALL node
   *
   * @param parentName - Name of the containing function/method (used in ID)
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param callType - "function" | "method" | "macro"
   * @param argsCount - Number of arguments
   * @param options - Optional call attributes (name, receiver, method, sideEffect)
   */
  static create(
    parentName: string,
    file: string,
    line: number,
    column: number,
    callType: RustCallType,
    argsCount: number,
    options: RustCallNodeOptions = {}
  ): RustCallNodeRecord {
    if (!file) throw new Error('RustCallNode.create: file is required');
    if (line === undefined) throw new Error('RustCallNode.create: line is required');
    if (column === undefined) throw new Error('RustCallNode.create: column is required');
    if (!callType) throw new Error('RustCallNode.create: callType is required');

    return {
      id: `RUST_CALL#${parentName}#${line}#${column}#${file}`,
      type: this.TYPE,
      name: options.name || undefined,
      file,
      line,
      column,
      callType,
      argsCount,
      receiver: options.receiver || null,
      method: options.method || null,
      sideEffect: options.sideEffect || null,
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

export type { RustCallNodeRecord, RustCallType };
