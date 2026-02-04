/**
 * ConstructorCallNode - contract for CONSTRUCTOR_CALL node
 *
 * Represents a `new ClassName()` expression in code.
 * Used for data flow: VARIABLE --ASSIGNED_FROM--> CONSTRUCTOR_CALL
 *
 * ID format: {file}:CONSTRUCTOR_CALL:{className}:{line}:{column}
 * Example: src/app.js:CONSTRUCTOR_CALL:Date:42:10
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ConstructorCallNodeRecord extends BaseNodeRecord {
  type: 'CONSTRUCTOR_CALL';
  className: string;
  isBuiltin: boolean;
  column: number;
}

interface ConstructorCallNodeOptions {
  counter?: number;
}

/**
 * List of built-in JavaScript constructors
 * These are globally available and don't require imports
 */
const BUILTIN_CONSTRUCTORS = new Set([
  // Fundamental objects
  'Object',
  'Function',
  'Boolean',
  'Symbol',

  // Error types
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'AggregateError',

  // Numbers and dates
  'Number',
  'BigInt',
  'Math',
  'Date',

  // Text processing
  'String',
  'RegExp',

  // Indexed collections
  'Array',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',

  // Keyed collections
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'WeakRef',

  // Structured data
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Atomics',
  'JSON',

  // Control abstraction
  'Promise',
  'Generator',
  'GeneratorFunction',
  'AsyncFunction',
  'AsyncGenerator',
  'AsyncGeneratorFunction',

  // Reflection
  'Reflect',
  'Proxy',

  // Internationalization
  'Intl',

  // Web APIs (commonly used)
  'URL',
  'URLSearchParams',
  'Headers',
  'Request',
  'Response',
  'FormData',
  'Blob',
  'File',
  'FileReader',
  'AbortController',
  'TextEncoder',
  'TextDecoder',
  'Event',
  'CustomEvent',
  'EventTarget',
  'WebSocket',
  'Worker',
  'MessageChannel',
  'MessagePort',
  'BroadcastChannel',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'CompressionStream',
  'DecompressionStream',
]);

export class ConstructorCallNode {
  static readonly TYPE = 'CONSTRUCTOR_CALL' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column', 'className', 'isBuiltin'] as const;
  static readonly OPTIONAL = [] as const;

  /**
   * Check if a class name is a built-in JavaScript constructor
   */
  static isBuiltinConstructor(className: string): boolean {
    return BUILTIN_CONSTRUCTORS.has(className);
  }

  /**
   * Generate ID for CONSTRUCTOR_CALL node
   *
   * @param className - Name of the constructor
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Optional counter for disambiguation
   */
  static generateId(
    className: string,
    file: string,
    line: number,
    column: number,
    options: ConstructorCallNodeOptions = {}
  ): string {
    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    return `${file}:CONSTRUCTOR_CALL:${className}:${line}:${column}${counter}`;
  }

  /**
   * Create CONSTRUCTOR_CALL node
   *
   * @param className - Name of the constructor (e.g., 'Date', 'MyClass')
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Optional counter for disambiguation
   */
  static create(
    className: string,
    file: string,
    line: number,
    column: number,
    options: ConstructorCallNodeOptions = {}
  ): ConstructorCallNodeRecord {
    if (!className) throw new Error('ConstructorCallNode.create: className is required');
    if (!file) throw new Error('ConstructorCallNode.create: file is required');
    if (line === undefined) throw new Error('ConstructorCallNode.create: line is required');
    if (column === undefined) throw new Error('ConstructorCallNode.create: column is required');

    const id = this.generateId(className, file, line, column, options);
    const isBuiltin = this.isBuiltinConstructor(className);

    return {
      id,
      type: this.TYPE,
      name: `new ${className}()`,
      className,
      isBuiltin,
      file,
      line,
      column
    };
  }

  static validate(node: ConstructorCallNodeRecord): string[] {
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

    if (typeof node.isBuiltin !== 'boolean') {
      errors.push('isBuiltin must be a boolean');
    }

    return errors;
  }
}

export type { ConstructorCallNodeRecord };
