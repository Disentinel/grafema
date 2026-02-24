import * as t from '@babel/types';

export interface CallInfo {
  line: number;
  column: number;
  name: string;
  isMethodCall: boolean;
}

export function extractOperandName(node: t.Expression | t.PrivateName): string | undefined {
  if (t.isIdentifier(node)) return node.name;
  if (t.isMemberExpression(node) && t.isIdentifier(node.object)) return node.object.name;
  return undefined;
}

export function memberExpressionToString(expr: t.MemberExpression): string {
  const parts: string[] = [];

  let current: t.Expression = expr;
  while (t.isMemberExpression(current)) {
    if (t.isIdentifier(current.property)) {
      parts.unshift(current.property.name);
    } else {
      parts.unshift('<computed>');
    }
    current = current.object;
  }

  if (t.isIdentifier(current)) {
    parts.unshift(current.name);
  }

  return parts.join('.');
}

export function countLogicalOperators(node: t.Expression): number {
  let count = 0;

  const traverse = (expr: t.Expression | t.Node): void => {
    if (t.isLogicalExpression(expr)) {
      // Count && and || operators
      if (expr.operator === '&&' || expr.operator === '||') {
        count++;
      }
      traverse(expr.left);
      traverse(expr.right);
    } else if (t.isConditionalExpression(expr)) {
      // Handle ternary conditions: test ? consequent : alternate
      traverse(expr.test);
      traverse(expr.consequent);
      traverse(expr.alternate);
    } else if (t.isUnaryExpression(expr)) {
      traverse(expr.argument);
    } else if (t.isBinaryExpression(expr)) {
      traverse(expr.left);
      traverse(expr.right);
    } else if (t.isSequenceExpression(expr)) {
      for (const e of expr.expressions) {
        traverse(e);
      }
    } else if (t.isParenthesizedExpression(expr)) {
      traverse(expr.expression);
    }
  };

  traverse(node);
  return count;
}

export function extractCaseValue(test: t.Expression | null): unknown {
  if (!test) return null;

  if (t.isStringLiteral(test)) {
    return test.value;
  } else if (t.isNumericLiteral(test)) {
    return test.value;
  } else if (t.isBooleanLiteral(test)) {
    return test.value;
  } else if (t.isNullLiteral(test)) {
    return null;
  } else if (t.isIdentifier(test)) {
    // Constant reference: case CONSTANTS.ADD
    return test.name;
  } else if (t.isMemberExpression(test)) {
    // Member expression: case Action.ADD
    return memberExpressionToString(test);
  }

  return '<complex>';
}

export function caseTerminates(caseNode: t.SwitchCase): boolean {
  const statements = caseNode.consequent;
  if (statements.length === 0) return false;

  // Check last statement (or any statement for early returns)
  for (const stmt of statements) {
    if (t.isBreakStatement(stmt)) return true;
    if (t.isReturnStatement(stmt)) return true;
    if (t.isThrowStatement(stmt)) return true;
    if (t.isContinueStatement(stmt)) return true;  // In switch inside loop

    // Check for nested blocks (if last statement is block, check inside)
    if (t.isBlockStatement(stmt)) {
      const lastInBlock = stmt.body[stmt.body.length - 1];
      if (lastInBlock && (
        t.isBreakStatement(lastInBlock) ||
        t.isReturnStatement(lastInBlock) ||
        t.isThrowStatement(lastInBlock)
      )) {
        return true;
      }
    }

    // Check for if-else where both branches terminate
    if (t.isIfStatement(stmt) && stmt.alternate) {
      const ifTerminates = blockTerminates(stmt.consequent);
      const elseTerminates = blockTerminates(stmt.alternate);
      if (ifTerminates && elseTerminates) return true;
    }
  }

  return false;
}

export function blockTerminates(node: t.Statement): boolean {
  if (t.isBreakStatement(node)) return true;
  if (t.isReturnStatement(node)) return true;
  if (t.isThrowStatement(node)) return true;
  if (t.isBlockStatement(node)) {
    const last = node.body[node.body.length - 1];
    return last ? blockTerminates(last) : false;
  }
  return false;
}

export function unwrapAwaitExpression(node: t.Expression): t.Expression {
  if (node.type === 'AwaitExpression' && node.argument) {
    return unwrapAwaitExpression(node.argument);
  }
  return node;
}

export function extractCallInfo(node: t.Expression): CallInfo | null {
  if (node.type !== 'CallExpression') {
    return null;
  }

  const callee = node.callee;
  let name: string;
  let isMethodCall = false;

  // Direct call: fetchUser()
  if (t.isIdentifier(callee)) {
    name = callee.name;
  }
  // Method call: obj.fetchUser() or arr.map()
  else if (t.isMemberExpression(callee)) {
    isMethodCall = true;
    const objectName = t.isIdentifier(callee.object)
      ? callee.object.name
      : (t.isThisExpression(callee.object) ? 'this' : 'unknown');
    const methodName = t.isIdentifier(callee.property)
      ? callee.property.name
      : 'unknown';
    name = `${objectName}.${methodName}`;
  }
  else {
    return null;
  }

  return {
    line: node.loc?.start.line ?? 0,
    column: node.loc?.start.column ?? 0,
    name,
    isMethodCall
  };
}

export function isCallOrAwaitExpression(node: t.Expression): boolean {
  const unwrapped = unwrapAwaitExpression(node);
  return unwrapped.type === 'CallExpression';
}
