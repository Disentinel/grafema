import type * as t from '@babel/types';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { ObjectLiteralNode } from '../../../../core/nodes/ObjectLiteralNode.js';
import type { VisitorModule } from '../visitors/index.js';
import type {
  LiteralInfo,
  ObjectLiteralInfo,
  ObjectPropertyInfo,
  CounterRef,
} from '../types.js';

export function extractObjectProperties(
  objectExpr: t.ObjectExpression,
  objectId: string,
  module: VisitorModule,
  objectProperties: ObjectPropertyInfo[],
  objectLiterals: ObjectLiteralInfo[],
  objectLiteralCounterRef: CounterRef,
  literals: LiteralInfo[],
  literalCounterRef: CounterRef
): void {
  for (const prop of objectExpr.properties) {
    const propLine = prop.loc?.start.line || 0;
    const propColumn = prop.loc?.start.column || 0;

    // Handle spread properties: { ...other }
    if (prop.type === 'SpreadElement') {
      const spreadArg = prop.argument;
      const propertyInfo: ObjectPropertyInfo = {
        objectId,
        propertyName: '<spread>',
        valueType: 'SPREAD',
        file: module.file,
        line: propLine,
        column: propColumn
      };

      if (spreadArg.type === 'Identifier') {
        propertyInfo.valueName = spreadArg.name;
        propertyInfo.valueType = 'VARIABLE';
      }

      objectProperties.push(propertyInfo);
      continue;
    }

    // Handle regular properties
    if (prop.type === 'ObjectProperty') {
      let propertyName: string;

      // Get property name
      if (prop.key.type === 'Identifier') {
        propertyName = prop.key.name;
      } else if (prop.key.type === 'StringLiteral') {
        propertyName = prop.key.value;
      } else if (prop.key.type === 'NumericLiteral') {
        propertyName = String(prop.key.value);
      } else {
        propertyName = '<computed>';
      }

      const propertyInfo: ObjectPropertyInfo = {
        objectId,
        propertyName,
        file: module.file,
        line: propLine,
        column: propColumn,
        valueType: 'EXPRESSION'
      };

      const value = prop.value;

      // Nested object literal - check BEFORE extractLiteralValue
      if (value.type === 'ObjectExpression') {
        const nestedObjectNode = ObjectLiteralNode.create(
          module.file,
          value.loc?.start.line || 0,
          value.loc?.start.column || 0,
          { counter: objectLiteralCounterRef.value++ }
        );
        objectLiterals.push(nestedObjectNode as unknown as ObjectLiteralInfo);
        const nestedObjectId = nestedObjectNode.id;

        // Recursively extract nested properties
        extractObjectProperties(
          value,
          nestedObjectId,
          module,
          objectProperties,
          objectLiterals,
          objectLiteralCounterRef,
          literals,
          literalCounterRef
        );

        propertyInfo.valueType = 'OBJECT_LITERAL';
        propertyInfo.nestedObjectId = nestedObjectId;
        propertyInfo.valueNodeId = nestedObjectId;
      }
      // Literal value (primitives only - objects/arrays handled above)
      else {
        const literalValue = ExpressionEvaluator.extractLiteralValue(value);
        // Handle both non-null literals AND explicit null literals (NullLiteral)
        if (literalValue !== null || value.type === 'NullLiteral') {
          const literalId = `LITERAL#${propertyName}#${module.file}#${propLine}:${propColumn}:${literalCounterRef.value++}`;
          literals.push({
            id: literalId,
            type: 'LITERAL',
            value: literalValue,
            valueType: typeof literalValue,
            file: module.file,
            line: propLine,
            column: propColumn,
            parentCallId: objectId,
            argIndex: 0
          });
          propertyInfo.valueType = 'LITERAL';
          propertyInfo.valueNodeId = literalId;
          propertyInfo.literalValue = literalValue;
        }
        // Variable reference
        else if (value.type === 'Identifier') {
          propertyInfo.valueType = 'VARIABLE';
          propertyInfo.valueName = value.name;
        }
        // Call expression
        else if (value.type === 'CallExpression') {
          propertyInfo.valueType = 'CALL';
          propertyInfo.callLine = value.loc?.start.line;
          propertyInfo.callColumn = value.loc?.start.column;
        }
        // Other expressions
        else {
          propertyInfo.valueType = 'EXPRESSION';
        }
      }

      objectProperties.push(propertyInfo);
    }
    // Handle object methods: { foo() {} }
    else if (prop.type === 'ObjectMethod') {
      const propertyName = prop.key.type === 'Identifier' ? prop.key.name : '<computed>';
      objectProperties.push({
        objectId,
        propertyName,
        valueType: 'EXPRESSION',
        file: module.file,
        line: propLine,
        column: propColumn
      });
    }
  }
}
