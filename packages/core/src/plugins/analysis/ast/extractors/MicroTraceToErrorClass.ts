import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { VariableDeclarationInfo } from '../types.js';

export function microTraceToErrorClass(
  variableName: string,
  funcPath: NodePath<t.Function>,
  _variableDeclarations: VariableDeclarationInfo[]
): { errorClassName: string | null; tracePath: string[] } {
  const tracePath: string[] = [variableName];
  const visited = new Set<string>(); // Cycle detection
  let currentName = variableName;

  const funcBody = funcPath.node.body;
  if (!t.isBlockStatement(funcBody)) {
    return { errorClassName: null, tracePath };
  }

  // Iterate until we find a NewExpression or can't trace further
  while (!visited.has(currentName)) {
    visited.add(currentName);
    let found = false;
    let foundNewExpression: string | null = null;
    let nextName: string | null = null;

    // Walk AST to find assignments: currentName = newValue
    funcPath.traverse({
      VariableDeclarator: (declPath: NodePath<t.VariableDeclarator>) => {
        if (found || foundNewExpression) return;
        if (t.isIdentifier(declPath.node.id) && declPath.node.id.name === currentName) {
          const init = declPath.node.init;
          if (init) {
            // Case 1: const err = new Error()
            if (t.isNewExpression(init) && t.isIdentifier(init.callee)) {
              tracePath.push(`new ${init.callee.name}()`);
              foundNewExpression = init.callee.name;
              found = true;
              return;
            }
            // Case 2: const err = otherVar (chain)
            if (t.isIdentifier(init)) {
              tracePath.push(init.name);
              nextName = init.name;
              found = true;
              return;
            }
          }
        }
      },
      AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
        if (found || foundNewExpression) return;
        const left = assignPath.node.left;
        const right = assignPath.node.right;

        if (t.isIdentifier(left) && left.name === currentName) {
          if (t.isNewExpression(right) && t.isIdentifier(right.callee)) {
            tracePath.push(`new ${right.callee.name}()`);
            foundNewExpression = right.callee.name;
            found = true;
            return;
          }
          if (t.isIdentifier(right)) {
            tracePath.push(right.name);
            nextName = right.name;
            found = true;
            return;
          }
        }
      }
    });

    // If we found a NewExpression, return the class name
    if (foundNewExpression) {
      return { errorClassName: foundNewExpression, tracePath };
    }

    // If we found another variable to follow, continue
    if (nextName) {
      currentName = nextName;
      continue;
    }

    // Couldn't trace further
    break;
  }

  return { errorClassName: null, tracePath };
}
