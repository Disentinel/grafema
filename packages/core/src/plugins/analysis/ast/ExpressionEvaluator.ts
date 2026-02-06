/**
 * ExpressionEvaluator - utilities for evaluating AST expressions
 */
import type {
  Node,
  StringLiteral,
  NumericLiteral,
  BooleanLiteral,
  TemplateLiteral,
  ArrayExpression,
  ObjectExpression,
  ObjectProperty
} from '@babel/types';

export type LiteralValue = string | number | boolean | null | undefined | LiteralValue[] | { [key: string]: LiteralValue };

export class ExpressionEvaluator {
  /**
   * Extract literal value from AST node
   * Returns null if not a literal
   */
  static extractLiteralValue(node: Node | null | undefined): LiteralValue | null {
    if (!node) return null;

    switch (node.type) {
      case 'StringLiteral':
        return (node as StringLiteral).value;

      case 'NumericLiteral':
        return (node as NumericLiteral).value;

      case 'BooleanLiteral':
        return (node as BooleanLiteral).value;

      case 'NullLiteral':
        return null;

      case 'TemplateLiteral': {
        const templateNode = node as TemplateLiteral;
        // Only if template literal has no expressions (simple string)
        if (templateNode.expressions.length === 0) {
          return templateNode.quasis[0].value.cooked ?? null;
        }
        return null;
      }

      case 'ArrayExpression': {
        // Handle arrays with literal values
        // Only if ALL elements are literals
        const arrayNode = node as ArrayExpression;
        const elements: LiteralValue[] = [];
        for (const element of arrayNode.elements) {
          if (!element) {
            // Sparse array: [1, , 3]
            elements.push(undefined);
            continue;
          }
          if (element.type === 'SpreadElement') {
            // Can't handle spread
            return null;
          }
          const value = this.extractLiteralValue(element);
          if (value === null && element.type !== 'NullLiteral') {
            // Not a literal - can't handle entire array
            return null;
          }
          elements.push(value);
        }
        return elements;
      }

      case 'ObjectExpression': {
        // Handle objects with literal values
        // Only if ALL properties are literals
        const objNode = node as ObjectExpression;
        const obj: { [key: string]: LiteralValue } = {};
        for (const prop of objNode.properties) {
          if (prop.type === 'SpreadElement') {
            // Can't handle spread
            return null;
          }

          const property = prop as ObjectProperty;

          // Get key
          let key: string;
          if (property.key.type === 'Identifier') {
            key = property.key.name;
          } else if (property.key.type === 'StringLiteral') {
            key = property.key.value;
          } else {
            // Computed property or other - can't handle
            return null;
          }

          // Get value
          // prop.value can be undefined in edge cases
          if (!property.value) {
            return null;
          }
          const value = this.extractLiteralValue(property.value);
          if (value === null && property.value.type !== 'NullLiteral') {
            // Not a literal - can't handle entire object
            return null;
          }
          obj[key] = value;
        }
        return obj;
      }

      default:
        return null;
    }
  }
}
