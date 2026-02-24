import * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { NodeFactory } from '../../../../core/NodeFactory.js';
import type { ReturnStatementInfo, LiteralInfo, CounterRef } from '../types.js';

export function extractReturnExpressionInfo(
  expr: t.Expression,
  module: { file: string },
  literals: LiteralInfo[],
  literalCounterRef: CounterRef,
  baseLine: number,
  baseColumn: number,
  literalIdSuffix: 'return' | 'implicit_return' | 'yield' = 'return'
): Partial<ReturnStatementInfo> {
  const exprLine = getLine(expr);
  const exprColumn = getColumn(expr);

  // Identifier (variable reference)
  if (t.isIdentifier(expr)) {
    return {
      returnValueType: 'VARIABLE',
      returnValueName: expr.name,
    };
  }

  // TemplateLiteral must come BEFORE isLiteral (TemplateLiteral extends Literal)
  if (t.isTemplateLiteral(expr)) {
    const sourceNames: string[] = [];
    for (const embedded of expr.expressions) {
      if (t.isIdentifier(embedded)) {
        sourceNames.push(embedded.name);
      }
    }
    return {
      returnValueType: 'EXPRESSION',
      expressionType: 'TemplateLiteral',
      returnValueLine: exprLine,
      returnValueColumn: exprColumn,
      returnValueId: NodeFactory.generateExpressionId(
        'TemplateLiteral', module.file, exprLine, exprColumn
      ),
      ...(sourceNames.length > 0 ? { expressionSourceNames: sourceNames } : {}),
    };
  }

  // Literal values (after TemplateLiteral check)
  if (t.isLiteral(expr)) {
    const literalId = `LITERAL#${literalIdSuffix}#${module.file}#${baseLine}:${baseColumn}:${literalCounterRef.value++}`;
    literals.push({
      id: literalId,
      type: 'LITERAL',
      value: ExpressionEvaluator.extractLiteralValue(expr),
      valueType: typeof ExpressionEvaluator.extractLiteralValue(expr),
      file: module.file,
      line: exprLine,
      column: exprColumn,
    });
    return {
      returnValueType: 'LITERAL',
      returnValueId: literalId,
    };
  }

  // Direct function call: return foo()
  if (t.isCallExpression(expr) && t.isIdentifier(expr.callee)) {
    return {
      returnValueType: 'CALL_SITE',
      returnValueLine: exprLine,
      returnValueColumn: exprColumn,
      returnValueCallName: expr.callee.name,
    };
  }

  // Method call: return obj.method()
  if (t.isCallExpression(expr) && t.isMemberExpression(expr.callee)) {
    return {
      returnValueType: 'METHOD_CALL',
      returnValueLine: exprLine,
      returnValueColumn: exprColumn,
      returnValueCallName: t.isIdentifier(expr.callee.property)
        ? expr.callee.property.name
        : undefined,
    };
  }

  // BinaryExpression: return a + b
  if (t.isBinaryExpression(expr)) {
    return {
      returnValueType: 'EXPRESSION',
      expressionType: 'BinaryExpression',
      returnValueLine: exprLine,
      returnValueColumn: exprColumn,
      operator: expr.operator,
      returnValueId: NodeFactory.generateExpressionId(
        'BinaryExpression', module.file, exprLine, exprColumn
      ),
      leftSourceName: t.isIdentifier(expr.left) ? expr.left.name : undefined,
      rightSourceName: t.isIdentifier(expr.right) ? expr.right.name : undefined,
    };
  }

  // LogicalExpression: return a && b, return a || b
  if (t.isLogicalExpression(expr)) {
    return {
      returnValueType: 'EXPRESSION',
      expressionType: 'LogicalExpression',
      returnValueLine: exprLine,
      returnValueColumn: exprColumn,
      operator: expr.operator,
      returnValueId: NodeFactory.generateExpressionId(
        'LogicalExpression', module.file, exprLine, exprColumn
      ),
      leftSourceName: t.isIdentifier(expr.left) ? expr.left.name : undefined,
      rightSourceName: t.isIdentifier(expr.right) ? expr.right.name : undefined,
    };
  }

  // ConditionalExpression: return condition ? a : b
  if (t.isConditionalExpression(expr)) {
    return {
      returnValueType: 'EXPRESSION',
      expressionType: 'ConditionalExpression',
      returnValueLine: exprLine,
      returnValueColumn: exprColumn,
      returnValueId: NodeFactory.generateExpressionId(
        'ConditionalExpression', module.file, exprLine, exprColumn
      ),
      consequentSourceName: t.isIdentifier(expr.consequent) ? expr.consequent.name : undefined,
      alternateSourceName: t.isIdentifier(expr.alternate) ? expr.alternate.name : undefined,
    };
  }

  // UnaryExpression: return !x, return -x
  if (t.isUnaryExpression(expr)) {
    return {
      returnValueType: 'EXPRESSION',
      expressionType: 'UnaryExpression',
      returnValueLine: exprLine,
      returnValueColumn: exprColumn,
      operator: expr.operator,
      returnValueId: NodeFactory.generateExpressionId(
        'UnaryExpression', module.file, exprLine, exprColumn
      ),
      unaryArgSourceName: t.isIdentifier(expr.argument) ? expr.argument.name : undefined,
    };
  }

  // MemberExpression (property access): return obj.prop
  if (t.isMemberExpression(expr)) {
    return {
      returnValueType: 'EXPRESSION',
      expressionType: 'MemberExpression',
      returnValueLine: exprLine,
      returnValueColumn: exprColumn,
      returnValueId: NodeFactory.generateExpressionId(
        'MemberExpression', module.file, exprLine, exprColumn
      ),
      object: t.isIdentifier(expr.object) ? expr.object.name : undefined,
      objectSourceName: t.isIdentifier(expr.object) ? expr.object.name : undefined,
      property: t.isIdentifier(expr.property) ? expr.property.name : undefined,
      computed: expr.computed,
    };
  }

  // NewExpression: return new Foo()
  if (t.isNewExpression(expr)) {
    return {
      returnValueType: 'EXPRESSION',
      expressionType: 'NewExpression',
      returnValueLine: exprLine,
      returnValueColumn: exprColumn,
      returnValueId: NodeFactory.generateExpressionId(
        'NewExpression', module.file, exprLine, exprColumn
      ),
    };
  }

  // Fallback for other expression types
  return {
    returnValueType: 'EXPRESSION',
    expressionType: expr.type,
    returnValueLine: exprLine,
    returnValueColumn: exprColumn,
    returnValueId: NodeFactory.generateExpressionId(
      expr.type, module.file, exprLine, exprColumn
    ),
  };
}
