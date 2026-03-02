/**
 * Extract a human-readable string representation of an AST expression value.
 *
 * Used to capture initial values, default values, and prop values
 * in a readable format for graph metadata.
 *
 * @module getExpressionValue
 */
import type { Node } from '@babel/types';

/**
 * @example
 * // StringLiteral "hello" => '"hello"'
 * // NumericLiteral 42 => "42"
 * // Identifier foo => "foo"
 * // ObjectExpression => "{...}"
 * // null/undefined => "undefined"
 *
 * @param expr - Babel AST expression node (may be undefined)
 * @returns Human-readable string representation
 */
export function getExpressionValue(expr: Node | undefined): string {
  if (!expr) return 'undefined';
  if (expr.type === 'StringLiteral') return `"${(expr as { value: string }).value}"`;
  if (expr.type === 'NumericLiteral') return String((expr as { value: number }).value);
  if (expr.type === 'BooleanLiteral') return String((expr as { value: boolean }).value);
  if (expr.type === 'NullLiteral') return 'null';
  if (expr.type === 'Identifier') return (expr as { name: string }).name;
  if (expr.type === 'ObjectExpression') return '{...}';
  if (expr.type === 'ArrayExpression') return '[...]';
  if (expr.type === 'ArrowFunctionExpression') return '() => {...}';
  if (expr.type === 'FunctionExpression') return 'function() {...}';
  return '<expression>';
}
