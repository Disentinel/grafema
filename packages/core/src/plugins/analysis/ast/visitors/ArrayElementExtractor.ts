/**
 * ArrayElementExtractor — extracts array elements for HAS_ELEMENT edges.
 *
 * Handles nested objects, arrays, literals, variables, calls, and spread elements.
 * Extracted from CallExpressionVisitor.ts (REG-424).
 */

import type { ArrayExpression } from '@babel/types';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { ObjectLiteralNode } from '../../../../core/nodes/ObjectLiteralNode.js';
import { ArrayLiteralNode } from '../../../../core/nodes/ArrayLiteralNode.js';
import type { VisitorModule, VisitorCollections, CounterRef } from './ASTVisitor.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type { ObjectLiteralInfo, ObjectPropertyInfo, ArrayLiteralInfo, ArrayElementInfo, LiteralInfo } from './call-expression-types.js';
import { ObjectPropertyExtractor } from './ObjectPropertyExtractor.js';

export class ArrayElementExtractor {
  /**
   * Extract array elements and create ArrayElementInfo records.
   *
   * Handles nested objects (delegates to ObjectPropertyExtractor), nested arrays (recursive),
   * literal values, variable references, call expressions, and spread elements.
   */
  static extract(
    arrayExpr: ArrayExpression,
    arrayId: string,
    module: VisitorModule,
    arrayElements: ArrayElementInfo[],
    arrayLiterals: ArrayLiteralInfo[],
    arrayLiteralCounterRef: CounterRef,
    objectLiterals: ObjectLiteralInfo[],
    objectLiteralCounterRef: CounterRef,
    objectProperties: ObjectPropertyInfo[],
    literals: LiteralInfo[],
    literalCounterRef: CounterRef,
    collections: VisitorCollections,
    scopeTracker?: ScopeTracker
  ): void {
    arrayExpr.elements.forEach((element, index) => {
      if (!element) return;  // Skip holes in arrays

      const elemLine = element.loc?.start.line || 0;
      const elemColumn = element.loc?.start.column || 0;

      const elementInfo: ArrayElementInfo = {
        arrayId,
        index,
        file: module.file,
        line: elemLine,
        column: elemColumn,
        valueType: 'EXPRESSION'
      };

      // Handle spread elements: [...arr]
      if (element.type === 'SpreadElement') {
        const spreadArg = element.argument;
        elementInfo.valueType = 'SPREAD';
        if (spreadArg.type === 'Identifier') {
          elementInfo.valueName = spreadArg.name;
        }
        arrayElements.push(elementInfo);
        return;
      }

      // Nested object literal - check BEFORE extractLiteralValue
      if (element.type === 'ObjectExpression') {
        // Use factory - do NOT pass argIndex for nested literals (uses 'obj' suffix)
        const nestedObjectNode = ObjectLiteralNode.create(
          module.file,
          elemLine,
          elemColumn,
          {
            counter: objectLiteralCounterRef.value++
          }
        );
        objectLiterals.push(nestedObjectNode as unknown as ObjectLiteralInfo);
        const nestedObjectId = nestedObjectNode.id;

        // Recursively extract properties
        ObjectPropertyExtractor.extract(
          element,
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

        elementInfo.valueType = 'OBJECT_LITERAL';
        elementInfo.nestedObjectId = nestedObjectId;
        elementInfo.valueNodeId = nestedObjectId;
      }
      // Nested array literal - check BEFORE extractLiteralValue
      else if (element.type === 'ArrayExpression') {
        // Use factory - do NOT pass argIndex for nested literals (uses 'arr' suffix)
        const nestedArrayNode = ArrayLiteralNode.create(
          module.file,
          elemLine,
          elemColumn,
          {
            counter: arrayLiteralCounterRef.value++
          }
        );
        arrayLiterals.push(nestedArrayNode as unknown as ArrayLiteralInfo);
        const nestedArrayId = nestedArrayNode.id;

        // Recursively extract elements
        ArrayElementExtractor.extract(
          element,
          nestedArrayId,
          module,
          arrayElements,
          arrayLiterals,
          arrayLiteralCounterRef,
          objectLiterals,
          objectLiteralCounterRef,
          objectProperties,
          literals,
          literalCounterRef,
          collections,
          scopeTracker
        );

        elementInfo.valueType = 'ARRAY_LITERAL';
        elementInfo.nestedArrayId = nestedArrayId;
        elementInfo.valueNodeId = nestedArrayId;
      }
      // Literal value (primitives only - objects/arrays handled above)
      else {
        const literalValue = ExpressionEvaluator.extractLiteralValue(element);
        if (literalValue !== null) {
          const literalId = `LITERAL#elem${index}#${module.file}#${elemLine}:${elemColumn}:${literalCounterRef.value++}`;
          literals.push({
            id: literalId,
            type: 'LITERAL',
            value: literalValue,
            valueType: typeof literalValue,
            file: module.file,
            line: elemLine,
            column: elemColumn,
            parentCallId: arrayId,
            argIndex: index
          });
          elementInfo.valueType = 'LITERAL';
          elementInfo.valueNodeId = literalId;
          elementInfo.literalValue = literalValue;
        }
        // Variable reference
        else if (element.type === 'Identifier') {
          elementInfo.valueType = 'VARIABLE';
          elementInfo.valueName = element.name;
        }
        // Call expression
        else if (element.type === 'CallExpression') {
          elementInfo.valueType = 'CALL';
          elementInfo.callLine = element.loc?.start.line;
          elementInfo.callColumn = element.loc?.start.column;
        }
        // Other expressions
        else {
          elementInfo.valueType = 'EXPRESSION';
        }
      }

      arrayElements.push(elementInfo);
    });
  }
}
