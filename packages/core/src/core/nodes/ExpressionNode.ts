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
   *
   * Naming conventions:
   * - MemberExpression: "object.property"
   * - BinaryExpression: "<BinaryExpression>"
   * - LogicalExpression: "<LogicalExpression>"
   * - ConditionalExpression: "<ternary>"
   * - TemplateLiteral: "<template>"
   * - Other: expressionType
   */
  private static _computeName(expressionType: string, options: ExpressionNodeOptions): string {
    if (options.path) {
      return options.path;
    }
    if (options.object && options.property) {
      return `${options.object}.${options.property}`;
    }
    // Special naming for non-MemberExpression types
    switch (expressionType) {
      case 'BinaryExpression':
      case 'LogicalExpression':
        return `<${expressionType}>`;
      case 'ConditionalExpression':
        return '<ternary>';
      case 'TemplateLiteral':
        return '<template>';
      default:
        return expressionType;
    }
  }

  /**
   * Generate EXPRESSION node ID without creating the full node
   *
   * Used by JSASTAnalyzer when creating assignment metadata.
   * The full node is created later by GraphBuilder.
   *
   * ID format: {file}:EXPRESSION:{expressionType}:{line}:{column}
   *
   * @param expressionType - Type of expression (MemberExpression, BinaryExpression, etc.)
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @returns Generated ID string in colon format
   */
  static generateId(
    expressionType: string,
    file: string,
    line: number,
    column: number
  ): string {
    return `${file}:EXPRESSION:${expressionType}:${line}:${column}`;
  }

  /**
   * Create EXPRESSION node from assignment metadata
   *
   * Used by GraphBuilder when processing variableAssignments.
   * The ID is provided from upstream (generated by JSASTAnalyzer).
   *
   * @param expressionType - Type of expression
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Must include id; optional: expression properties
   * @returns ExpressionNodeRecord
   */
  static createFromMetadata(
    expressionType: string,
    file: string,
    line: number,
    column: number,
    options: ExpressionNodeOptions & { id: string }
  ): ExpressionNodeRecord {
    if (!options.id) {
      throw new Error('ExpressionNode.createFromMetadata: id is required');
    }

    // Validate ID format - must use colon format
    if (!options.id.includes(':EXPRESSION:')) {
      throw new Error(
        `ExpressionNode.createFromMetadata: Invalid ID format "${options.id}". ` +
        `Expected format: {file}:EXPRESSION:{type}:{line}:{column}`
      );
    }

    // Create base node structure
    const node: ExpressionNodeRecord = {
      id: options.id,  // Use provided ID (from upstream)
      type: this.TYPE,
      name: this._computeName(expressionType, options),
      file,
      line,
      column: column || 0,
      expressionType
    };

    // Add optional fields if present (same logic as create())
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
