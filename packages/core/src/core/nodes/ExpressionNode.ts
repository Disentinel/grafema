/**
 * ExpressionNode - contract for EXPRESSION node
 *
 * Represents complex expressions for data flow tracking
 * (MemberExpression, BinaryExpression, LogicalExpression, etc.)
 *
 * ID format: {file}:EXPRESSION:{expressionType}:{line}:{column}
 * Example: /src/app.ts:EXPRESSION:MemberExpression:25:10
 */

import type { BaseNodeRecord } from '@grafema/types';

interface ExpressionNodeRecord extends BaseNodeRecord {
  type: 'EXPRESSION';
  column: number;
  expressionType: string;
  // MemberExpression fields
  object?: string;
  property?: string;
  computed?: boolean;
  computedPropertyVar?: string;
  // Binary/Logical expression fields
  operator?: string;
  // Tracking fields
  path?: string;
  baseName?: string;
  propertyPath?: string[];
  arrayIndex?: number;
}

interface ExpressionNodeOptions {
  // MemberExpression
  object?: string;
  property?: string;
  computed?: boolean;
  computedPropertyVar?: string;
  // Binary/Logical
  operator?: string;
  // Tracking
  path?: string;
  baseName?: string;
  propertyPath?: string[];
  arrayIndex?: number;
}

export class ExpressionNode {
  static readonly TYPE = 'EXPRESSION' as const;

  static readonly REQUIRED = ['expressionType', 'file', 'line'] as const;
  static readonly OPTIONAL = [
    'column', 'object', 'property', 'computed', 'computedPropertyVar',
    'operator', 'path', 'baseName', 'propertyPath', 'arrayIndex'
  ] as const;

  /**
   * Create EXPRESSION node
   *
   * @param expressionType - Type of expression (MemberExpression, BinaryExpression, etc.)
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Optional expression properties
   * @returns ExpressionNodeRecord
   */
  static create(
    expressionType: string,
    file: string,
    line: number,
    column: number,
    options: ExpressionNodeOptions = {}
  ): ExpressionNodeRecord {
    if (!expressionType) throw new Error('ExpressionNode.create: expressionType is required');
    if (!file) throw new Error('ExpressionNode.create: file is required');
    if (!line) throw new Error('ExpressionNode.create: line is required');

    const node: ExpressionNodeRecord = {
      id: `${file}:EXPRESSION:${expressionType}:${line}:${column}`,
      type: this.TYPE,
      name: this._computeName(expressionType, options),
      file,
      line,
      column: column || 0,
      expressionType
    };

    // Add optional fields if present
    if (options.object !== undefined) node.object = options.object;
    if (options.property !== undefined) node.property = options.property;
    if (options.computed !== undefined) node.computed = options.computed;
    if (options.computedPropertyVar !== undefined) node.computedPropertyVar = options.computedPropertyVar;
    if (options.operator !== undefined) node.operator = options.operator;
    if (options.path !== undefined) node.path = options.path;
    if (options.baseName !== undefined) node.baseName = options.baseName;
    if (options.propertyPath !== undefined) node.propertyPath = options.propertyPath;
    if (options.arrayIndex !== undefined) node.arrayIndex = options.arrayIndex;

    return node;
  }

  /**
   * Compute name from expression properties
   */
  private static _computeName(expressionType: string, options: ExpressionNodeOptions): string {
    if (options.path) {
      return options.path;
    }
    if (options.object && options.property) {
      return `${options.object}.${options.property}`;
    }
    return expressionType;
  }

  static validate(node: ExpressionNodeRecord): string[] {
    const errors: string[] = [];

    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }

    if (!node.expressionType) {
      errors.push('Missing required field: expressionType');
    }

    if (!node.file) {
      errors.push('Missing required field: file');
    }

    return errors;
  }
}

export type { ExpressionNodeRecord, ExpressionNodeOptions };
