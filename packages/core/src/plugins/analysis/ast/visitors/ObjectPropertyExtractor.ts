/**
 * ObjectPropertyExtractor — extracts object properties for HAS_PROPERTY edges.
 *
 * Handles nested objects, arrays, literals, variables, calls, and spread properties.
 * Extracted from CallExpressionVisitor.ts (REG-424).
 */

import type { ObjectExpression, ObjectProperty } from '@babel/types';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { ObjectLiteralNode } from '../../../../core/nodes/ObjectLiteralNode.js';
import { ArrayLiteralNode } from '../../../../core/nodes/ArrayLiteralNode.js';
import type { VisitorModule, VisitorCollections, CounterRef } from './ASTVisitor.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type { ObjectLiteralInfo, ObjectPropertyInfo, ArrayLiteralInfo, ArrayElementInfo, LiteralInfo } from './call-expression-types.js';
import { ArrayElementExtractor } from './ArrayElementExtractor.js';

export class ObjectPropertyExtractor {
  /**
   * Extract object properties and create ObjectPropertyInfo records.
   *
   * Handles nested objects (recursive), nested arrays (delegates to ArrayElementExtractor),
   * literal values, variable references, call expressions, and spread properties.
   */
  static extract(
    objectExpr: ObjectExpression,
    objectId: string,
    module: VisitorModule,
    objectProperties: ObjectPropertyInfo[],
    objectLiterals: ObjectLiteralInfo[],
    objectLiteralCounterRef: CounterRef,
    literals: LiteralInfo[],
    literalCounterRef: CounterRef,
    collections: VisitorCollections,
    scopeTracker?: ScopeTracker
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
          // REG-329: Capture scope path for spread variable resolution
          propertyInfo.valueScopePath = scopeTracker?.getContext().scopePath ?? [];
        }

        objectProperties.push(propertyInfo);
        continue;
      }

      // Handle regular properties
      if (prop.type === 'ObjectProperty') {
        const objProp = prop as ObjectProperty;
        let propertyName: string;

        // Get property name
        if (objProp.key.type === 'Identifier') {
          propertyName = objProp.key.name;
        } else if (objProp.key.type === 'StringLiteral') {
          propertyName = objProp.key.value;
        } else if (objProp.key.type === 'NumericLiteral') {
          propertyName = String(objProp.key.value);
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

        const value = objProp.value;

        // Nested object literal - check BEFORE extractLiteralValue
        if (value.type === 'ObjectExpression') {
          // Use factory - do NOT pass argIndex for nested literals (uses 'obj' suffix)
          const nestedObjectNode = ObjectLiteralNode.create(
            module.file,
            value.loc?.start.line || 0,
            value.loc?.start.column || 0,
            {
              counter: objectLiteralCounterRef.value++
            }
          );
          objectLiterals.push(nestedObjectNode as unknown as ObjectLiteralInfo);
          const nestedObjectId = nestedObjectNode.id;

          // Recursively extract nested properties
          ObjectPropertyExtractor.extract(
            value,
            nestedObjectId,
            module,
            objectProperties,
            objectLiterals,
            objectLiteralCounterRef,
            literals,
            literalCounterRef,
            collections,
            scopeTracker
          );

          propertyInfo.valueType = 'OBJECT_LITERAL';
          propertyInfo.nestedObjectId = nestedObjectId;
          propertyInfo.valueNodeId = nestedObjectId;
        }
        // Nested array literal - check BEFORE extractLiteralValue
        else if (value.type === 'ArrayExpression') {
          const arrayLiteralCounterRef = (collections.arrayLiteralCounterRef ?? { value: 0 }) as CounterRef;
          const arrayLiterals = collections.arrayLiterals ?? [];
          const arrayElements = collections.arrayElements ?? [];

          // Use factory - do NOT pass argIndex for nested literals (uses 'arr' suffix)
          const nestedArrayNode = ArrayLiteralNode.create(
            module.file,
            value.loc?.start.line || 0,
            value.loc?.start.column || 0,
            {
              counter: arrayLiteralCounterRef.value++
            }
          );
          (arrayLiterals as ArrayLiteralInfo[]).push(nestedArrayNode as unknown as ArrayLiteralInfo);
          const nestedArrayId = nestedArrayNode.id;

          // Recursively extract array elements
          ArrayElementExtractor.extract(
            value,
            nestedArrayId,
            module,
            arrayElements as ArrayElementInfo[],
            arrayLiterals as ArrayLiteralInfo[],
            arrayLiteralCounterRef,
            objectLiterals,
            objectLiteralCounterRef,
            objectProperties,
            literals,
            literalCounterRef,
            collections,
            scopeTracker
          );

          propertyInfo.valueType = 'ARRAY_LITERAL';
          propertyInfo.nestedArrayId = nestedArrayId;
          propertyInfo.valueNodeId = nestedArrayId;
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
            // REG-329: Capture scope path for scope-aware variable resolution
            propertyInfo.valueScopePath = scopeTracker?.getContext().scopePath ?? [];
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
}
