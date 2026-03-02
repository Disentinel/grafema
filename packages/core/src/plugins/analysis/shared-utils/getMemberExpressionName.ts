/**
 * Extract full dotted name from a MemberExpression AST node.
 *
 * Recursively walks the member expression to build
 * a dotted string like "localStorage.setItem" or "window.history.pushState".
 *
 * Returns the Identifier name for non-MemberExpression nodes,
 * or '<unknown>' / '<computed>' for unresolvable parts.
 *
 * @module getMemberExpressionName
 */
import type { Node } from '@babel/types';

/**
 * @example
 * // For AST node representing `localStorage.setItem`:
 * getMemberExpressionName(node) // => "localStorage.setItem"
 *
 * // For a plain Identifier node:
 * getMemberExpressionName(identNode) // => "someVar"
 *
 * @param node - Babel AST node (MemberExpression or Identifier)
 * @returns Dotted name string
 */
export function getMemberExpressionName(node: Node): string {
  if (node.type !== 'MemberExpression') {
    return (node as { name?: string }).name || '<unknown>';
  }
  const memExpr = node as { object: Node; property: { name?: string; value?: string } };
  const object = getMemberExpressionName(memExpr.object);
  const property = memExpr.property.name || memExpr.property.value || '<computed>';
  return `${object}.${property}`;
}
