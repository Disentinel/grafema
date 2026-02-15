/**
 * Helper functions for CallExpressionVisitor — grafema-ignore annotation detection.
 *
 * Extracted from CallExpressionVisitor.ts (REG-424) to reduce file size.
 */

import type { Node, Comment } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import type { GrafemaIgnoreAnnotation } from '../types.js';

/**
 * Pattern for grafema-ignore comments (REG-332)
 * Matches:
 *   // grafema-ignore STRICT_UNRESOLVED_METHOD
 *   // grafema-ignore STRICT_UNRESOLVED_METHOD - known library call
 *   block comments with same pattern
 */
const GRAFEMA_IGNORE_PATTERN = /grafema-ignore(?:-next-line)?\s+([\w_]+)(?:\s+-\s+(.+))?/;

/**
 * Check node's leadingComments for grafema-ignore annotation.
 */
function checkNodeComments(node: Node): GrafemaIgnoreAnnotation | null {
  const comments = (node as { leadingComments?: Comment[] }).leadingComments;
  if (!comments || comments.length === 0) return null;

  // Check comments from last to first (closest to node wins)
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    const text = comment.value.trim();
    const match = text.match(GRAFEMA_IGNORE_PATTERN);
    if (match) {
      return {
        code: match[1],
        reason: match[2]?.trim(),
      };
    }
  }

  return null;
}

/**
 * Check if a call has a grafema-ignore comment for suppressing strict mode errors.
 * Babel attaches leading comments to statements (VariableDeclaration, ExpressionStatement),
 * not to nested CallExpression nodes. So we check:
 * 1. The call node itself (rare, but possible for standalone calls)
 * 2. The parent statement (VariableDeclaration, ExpressionStatement, etc.)
 *
 * @param path - Babel NodePath for the CallExpression
 * @returns GrafemaIgnoreAnnotation if found, null otherwise
 */
export function getGrafemaIgnore(path: NodePath): GrafemaIgnoreAnnotation | null {
  // First check the call node itself
  const callResult = checkNodeComments(path.node);
  if (callResult) return callResult;

  // Then check parent statement (where Babel typically attaches comments)
  const statementPath = path.getStatementParent();
  if (statementPath) {
    return checkNodeComments(statementPath.node);
  }

  return null;
}
