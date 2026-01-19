/**
 * ConditionParser - парсит условия if/switch и извлекает constraints
 *
 * Поддерживаемые паттерны:
 * - x === "value"        → { variable: "x", operator: "===", value: "value" }
 * - x !== "value"        → { variable: "x", operator: "!==", value: "value", excludes: true }
 * - x === "a" || x === "b" → { variable: "x", operator: "in", values: ["a", "b"] }
 * - x === "a" && y === "b" → [{ variable: "x", ... }, { variable: "y", ... }]
 */

import type * as t from '@babel/types';

/**
 * Constraint operator types
 */
type ConstraintOperator = '===' | '!==' | 'in' | 'not_in' | 'truthy' | 'falsy';

/**
 * Simple constraint
 */
export interface SimpleConstraint {
  variable: string;
  operator: ConstraintOperator;
  value?: unknown;
  values?: unknown[];
  excludes?: boolean;
  negated?: boolean;
}

/**
 * Compound constraint (OR/AND groups)
 */
export interface CompoundConstraint {
  type: 'or' | 'and';
  constraints: Constraint[];
}

/**
 * Combined constraint type
 */
export type Constraint = SimpleConstraint | CompoundConstraint;

/**
 * Type guard for compound constraints
 */
function isCompoundConstraint(c: Constraint): c is CompoundConstraint {
  return 'type' in c && (c.type === 'or' || c.type === 'and');
}

export class ConditionParser {
  /**
   * Парсит AST условия и возвращает массив constraints
   * @param testNode - AST нода условия (ifNode.test)
   * @returns constraints
   */
  static parse(testNode: t.Node | null | undefined): Constraint[] {
    if (!testNode) return [];

    const constraints: Constraint[] = [];
    this._parseNode(testNode, constraints, false);
    return constraints;
  }

  /**
   * Рекурсивно парсит ноду условия
   * @param node - AST нода
   * @param constraints - массив для накопления constraints
   * @param negated - инвертировано ли условие (для else)
   */
  private static _parseNode(node: t.Node | null | undefined, constraints: Constraint[], negated: boolean): void {
    if (!node) return;

    switch (node.type) {
      case 'BinaryExpression':
        this._parseBinaryExpression(node as t.BinaryExpression, constraints, negated);
        break;

      case 'LogicalExpression':
        this._parseLogicalExpression(node as t.LogicalExpression, constraints, negated);
        break;

      case 'UnaryExpression': {
        const unaryNode = node as t.UnaryExpression;
        if (unaryNode.operator === '!') {
          // !condition → инвертируем
          this._parseNode(unaryNode.argument, constraints, !negated);
        }
        break;
      }

      case 'Identifier': {
        const identNode = node as t.Identifier;
        // if (x) → x is truthy
        constraints.push({
          variable: identNode.name,
          operator: 'truthy',
          negated
        });
        break;
      }

      case 'MemberExpression': {
        // if (obj.prop) → obj.prop is truthy
        const memberName = this._getMemberExpressionName(node as t.MemberExpression);
        if (memberName) {
          constraints.push({
            variable: memberName,
            operator: 'truthy',
            negated
          });
        }
        break;
      }
    }
  }

  /**
   * Парсит BinaryExpression (===, !==, ==, !=)
   */
  private static _parseBinaryExpression(node: t.BinaryExpression, constraints: Constraint[], negated: boolean): void {
    const { operator, left, right } = node;

    // Поддерживаемые операторы
    if (!['===', '!==', '==', '!='].includes(operator)) {
      return;
    }

    // Определяем переменную и значение
    let variable: string | null = null;
    let value: unknown = null;

    // x === "value" или "value" === x
    if (left.type === 'Identifier' && this._isLiteralValue(right)) {
      variable = (left as t.Identifier).name;
      value = this._getLiteralValue(right);
    } else if (right.type === 'Identifier' && this._isLiteralValue(left)) {
      variable = (right as t.Identifier).name;
      value = this._getLiteralValue(left);
    }
    // obj.prop === "value"
    else if (left.type === 'MemberExpression' && this._isLiteralValue(right)) {
      variable = this._getMemberExpressionName(left as t.MemberExpression);
      value = this._getLiteralValue(right);
    } else if (right.type === 'MemberExpression' && this._isLiteralValue(left)) {
      variable = this._getMemberExpressionName(right as t.MemberExpression);
      value = this._getLiteralValue(left);
    }

    if (variable === null || value === null) {
      return;
    }

    // Определяем тип constraint
    const isNegation = operator === '!==' || operator === '!=';
    const effectiveNegated = negated ? !isNegation : isNegation;

    constraints.push({
      variable,
      operator: effectiveNegated ? '!==' : '===',
      value,
      excludes: effectiveNegated
    });
  }

  /**
   * Парсит LogicalExpression (&&, ||)
   */
  private static _parseLogicalExpression(node: t.LogicalExpression, constraints: Constraint[], negated: boolean): void {
    const { operator, left, right } = node;

    if (operator === '||') {
      // OR: проверяем можно ли объединить в одну constraint
      // x === "a" || x === "b" → { variable: x, values: ["a", "b"] }
      const leftConstraints: Constraint[] = [];
      const rightConstraints: Constraint[] = [];

      this._parseNode(left, leftConstraints, negated);
      this._parseNode(right, rightConstraints, negated);

      // Пытаемся объединить constraints для одной переменной
      const merged = this._tryMergeOrConstraints(leftConstraints, rightConstraints);
      if (merged) {
        constraints.push(merged);
      } else {
        // Не удалось объединить - добавляем как OR группу
        constraints.push({
          type: 'or',
          constraints: [...leftConstraints, ...rightConstraints]
        });
      }
    } else if (operator === '&&') {
      // AND: обе части должны быть true
      this._parseNode(left, constraints, negated);
      this._parseNode(right, constraints, negated);
    }
  }

  /**
   * Пытается объединить OR constraints для одной переменной
   * x === "a" || x === "b" → { variable: x, operator: "in", values: ["a", "b"] }
   */
  private static _tryMergeOrConstraints(left: Constraint[], right: Constraint[]): SimpleConstraint | null {
    // Проверяем что обе части - простые equality constraints для одной переменной
    if (left.length !== 1 || right.length !== 1) return null;

    const l = left[0];
    const r = right[0];

    // Type guards for simple constraints
    if (isCompoundConstraint(l) || isCompoundConstraint(r)) return null;

    if (l.variable !== r.variable) return null;
    if (l.operator !== '===' || r.operator !== '===') return null;

    return {
      variable: l.variable,
      operator: 'in',
      values: [l.value, r.value]
    };
  }

  /**
   * Проверяет является ли нода литеральным значением
   */
  private static _isLiteralValue(node: t.Node | null | undefined): boolean {
    if (!node) return false;

    return (
      node.type === 'StringLiteral' ||
      node.type === 'NumericLiteral' ||
      node.type === 'BooleanLiteral' ||
      node.type === 'NullLiteral' ||
      (node.type as string) === 'Literal' // для некоторых парсеров (ESTree)
    );
  }

  /**
   * Извлекает значение из литеральной ноды
   */
  private static _getLiteralValue(node: t.Node | null | undefined): unknown {
    if (!node) return null;

    switch (node.type) {
      case 'StringLiteral':
        return (node as t.StringLiteral).value;
      case 'NumericLiteral':
        return (node as t.NumericLiteral).value;
      case 'BooleanLiteral':
        return (node as t.BooleanLiteral).value;
      case 'NullLiteral':
        return null;
      default:
        // Handle ESTree 'Literal' type
        if ((node.type as string) === 'Literal') {
          return (node as unknown as { value: unknown }).value;
        }
        return null;
    }
  }

  /**
   * Получает имя MemberExpression как строку
   * obj.prop → "obj.prop"
   */
  private static _getMemberExpressionName(node: t.MemberExpression): string | null {
    if (node.type !== 'MemberExpression') return null;

    const parts: string[] = [];
    let current: t.Node = node;

    while (current.type === 'MemberExpression') {
      const memberNode = current as t.MemberExpression;
      if (memberNode.computed) {
        // obj[x] - не можем статически определить
        return null;
      }
      if (memberNode.property.type === 'Identifier') {
        parts.unshift((memberNode.property as t.Identifier).name);
      } else {
        return null;
      }
      current = memberNode.object;
    }

    if (current.type === 'Identifier') {
      parts.unshift((current as t.Identifier).name);
      return parts.join('.');
    }

    return null;
  }

  /**
   * Создаёт negated версию constraints для else-блока
   * @param constraints - оригинальные constraints
   * @returns negated constraints
   */
  static negate(constraints: Constraint[]): Constraint[] {
    return constraints.map(c => {
      if (isCompoundConstraint(c)) {
        if (c.type === 'or') {
          // De Morgan: !(A || B) = !A && !B
          return {
            type: 'and' as const,
            constraints: this.negate(c.constraints)
          };
        } else {
          // De Morgan: !(A && B) = !A || !B
          return {
            type: 'or' as const,
            constraints: this.negate(c.constraints)
          };
        }
      }

      // Инвертируем operator
      const negatedOp: ConstraintOperator = c.operator === '===' ? '!==' :
                        c.operator === '!==' ? '===' :
                        c.operator === 'in' ? 'not_in' :
                        c.operator === 'truthy' ? 'falsy' :
                        c.operator;

      return {
        ...c,
        operator: negatedOp,
        excludes: !c.excludes,
        negated: !c.negated
      };
    });
  }
}

export default ConditionParser;
