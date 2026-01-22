/**
 * ArgumentExpressionNode - EXPRESSION node with call argument context
 *
 * Extends ExpressionNode with fields tracking which call and argument position
 * this expression appears in. Used for argument data flow tracking.
 *
 * ID format: {file}:EXPRESSION:{expressionType}:{line}:{column}
 * With counter: {file}:EXPRESSION:{expressionType}:{line}:{column}:{counter}
 *
 * Example: /src/app.ts:EXPRESSION:BinaryExpression:25:10
 *
 * Note: Uses counter suffix since same expression at same position can appear
 * multiple times in different argument contexts.
 */

import { ExpressionNode, type ExpressionNodeRecord, type ExpressionNodeOptions } from './ExpressionNode.js';

interface ArgumentExpressionNodeRecord extends ExpressionNodeRecord {
  parentCallId: string;
  argIndex: number;
}

interface ArgumentExpressionNodeOptions extends ExpressionNodeOptions {
  parentCallId: string;
  argIndex: number;
  counter?: number;
}

export class ArgumentExpressionNode {
  // Inherit TYPE from ExpressionNode
  static readonly TYPE = ExpressionNode.TYPE;
  static readonly REQUIRED: readonly string[] = [...ExpressionNode.REQUIRED, 'parentCallId', 'argIndex'];
  static readonly OPTIONAL: readonly string[] = [...ExpressionNode.OPTIONAL, 'counter'];

  /**
   * Create EXPRESSION node with argument context
   *
   * @param expressionType - Type of expression (BinaryExpression, LogicalExpression, etc.)
   * @param file - File path
   * @param line - Line number
   * @param column - Column position
   * @param options - Required: parentCallId, argIndex; Optional: expression properties, counter
   * @returns ArgumentExpressionNodeRecord
   */
  static create(
    expressionType: string,
    file: string,
    line: number,
    column: number,
    options: ArgumentExpressionNodeOptions
  ): ArgumentExpressionNodeRecord {
    if (!options.parentCallId) {
      throw new Error('ArgumentExpressionNode.create: parentCallId is required');
    }
    if (options.argIndex === undefined) {
      throw new Error('ArgumentExpressionNode.create: argIndex is required');
    }

    // Create base EXPRESSION node using parent class
    const baseNode = ExpressionNode.create(expressionType, file, line, column, options);

    // Override ID with counter suffix (since same location can have multiple expressions)
    const counter = options.counter !== undefined ? `:${options.counter}` : '';
    const id = `${file}:EXPRESSION:${expressionType}:${line}:${column}${counter}`;

    return {
      ...baseNode,
      id,
      parentCallId: options.parentCallId,
      argIndex: options.argIndex
    };
  }

  static validate(node: ArgumentExpressionNodeRecord): string[] {
    const errors = ExpressionNode.validate(node);

    if (!node.parentCallId) {
      errors.push('Missing required field: parentCallId');
    }

    if (node.argIndex === undefined) {
      errors.push('Missing required field: argIndex');
    }

    return errors;
  }
}

export type { ArgumentExpressionNodeRecord, ArgumentExpressionNodeOptions };
