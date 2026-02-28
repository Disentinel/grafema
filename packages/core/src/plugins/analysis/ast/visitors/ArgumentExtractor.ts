/**
 * ArgumentExtractor — extracts argument info for PASSES_ARGUMENT edges.
 *
 * Handles object/array literals, primitive literals, variables, callbacks,
 * nested calls, member expressions, and binary/logical expressions.
 * Extracted from CallExpressionVisitor.ts (REG-424).
 */

import type { Node, CallExpression, Identifier, MemberExpression, ObjectExpression, ArrayExpression } from '@babel/types';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { NodeFactory } from '../../../../core/NodeFactory.js';
import { ObjectLiteralNode } from '../../../../core/nodes/ObjectLiteralNode.js';
import { ArrayLiteralNode } from '../../../../core/nodes/ArrayLiteralNode.js';
import type { VisitorModule, VisitorCollections, CounterRef } from './ASTVisitor.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { ObjectPropertyExtractor } from './ObjectPropertyExtractor.js';
import { ArrayElementExtractor } from './ArrayElementExtractor.js';
import type {
  ObjectLiteralInfo, ObjectPropertyInfo, ArrayLiteralInfo, ArrayElementInfo,
  ArgumentInfo, LiteralInfo,
} from './call-expression-types.js';

export class ArgumentExtractor {
  /**
   * Extract argument information for PASSES_ARGUMENT edges.
   */
  static extract(
    args: CallExpression['arguments'],
    callId: string,
    module: VisitorModule,
    callArguments: ArgumentInfo[],
    literals: LiteralInfo[],
    literalCounterRef: CounterRef,
    collections: VisitorCollections,
    scopeTracker?: ScopeTracker
  ): void {
    args.forEach((arg, index) => {
      const argInfo: ArgumentInfo = {
        callId,
        argIndex: index,
        file: module.file,
        line: arg.loc?.start.line || 0,
        column: arg.loc?.start.column || 0
      };

      // Check for spread: ...arg
      let actualArg: Node = arg;
      if (arg.type === 'SpreadElement') {
        argInfo.isSpread = true;
        actualArg = arg.argument;  // Get the actual argument
      }

      // Object literal - check BEFORE extractLiteralValue to handle object-typed args properly
      if (actualArg.type === 'ObjectExpression') {
        const objectExpr = actualArg as ObjectExpression;
        // Initialize collections if not exist (must assign back to collections!)
        if (!collections.objectLiteralCounterRef) {
          collections.objectLiteralCounterRef = { value: 0 };
        }
        if (!collections.objectLiterals) {
          collections.objectLiterals = [];
        }
        if (!collections.objectProperties) {
          collections.objectProperties = [];
        }
        const objectLiteralCounterRef = collections.objectLiteralCounterRef as CounterRef;

        // Use factory to create OBJECT_LITERAL node
        const objectNode = ObjectLiteralNode.create(
          module.file,
          argInfo.line,
          argInfo.column,
          {
            parentCallId: callId,
            argIndex: index,
            counter: objectLiteralCounterRef.value++
          }
        );
        // Factory guarantees line is set, cast to ObjectLiteralInfo
        (collections.objectLiterals as ObjectLiteralInfo[]).push(objectNode as unknown as ObjectLiteralInfo);
        const objectId = objectNode.id;

        // Extract properties
        ObjectPropertyExtractor.extract(
          objectExpr,
          objectId,
          module,
          collections.objectProperties as ObjectPropertyInfo[],
          collections.objectLiterals as ObjectLiteralInfo[],
          objectLiteralCounterRef,
          literals as LiteralInfo[],
          literalCounterRef,
          collections,
          scopeTracker
        );

        argInfo.targetType = 'OBJECT_LITERAL';
        argInfo.targetId = objectId;
      }
      // Array literal - check BEFORE extractLiteralValue to handle array-typed args properly
      else if (actualArg.type === 'ArrayExpression') {
        const arrayExpr = actualArg as ArrayExpression;
        // Initialize collections if not exist (must assign back to collections!)
        if (!collections.arrayLiteralCounterRef) {
          collections.arrayLiteralCounterRef = { value: 0 };
        }
        if (!collections.arrayLiterals) {
          collections.arrayLiterals = [];
        }
        if (!collections.arrayElements) {
          collections.arrayElements = [];
        }
        if (!collections.objectLiteralCounterRef) {
          collections.objectLiteralCounterRef = { value: 0 };
        }
        if (!collections.objectLiterals) {
          collections.objectLiterals = [];
        }
        if (!collections.objectProperties) {
          collections.objectProperties = [];
        }
        const arrayLiteralCounterRef = collections.arrayLiteralCounterRef as CounterRef;

        // Use factory to create ARRAY_LITERAL node
        const arrayNode = ArrayLiteralNode.create(
          module.file,
          argInfo.line,
          argInfo.column,
          {
            parentCallId: callId,
            argIndex: index,
            counter: arrayLiteralCounterRef.value++
          }
        );
        // Factory guarantees line is set, cast to ArrayLiteralInfo
        (collections.arrayLiterals as ArrayLiteralInfo[]).push(arrayNode as unknown as ArrayLiteralInfo);
        const arrayId = arrayNode.id;

        // Extract elements
        ArrayElementExtractor.extract(
          arrayExpr,
          arrayId,
          module,
          collections.arrayElements as ArrayElementInfo[],
          collections.arrayLiterals as ArrayLiteralInfo[],
          arrayLiteralCounterRef,
          collections.objectLiterals as ObjectLiteralInfo[],
          collections.objectLiteralCounterRef as CounterRef,
          collections.objectProperties as ObjectPropertyInfo[],
          literals as LiteralInfo[],
          literalCounterRef,
          collections,
          scopeTracker
        );

        argInfo.targetType = 'ARRAY_LITERAL';
        argInfo.targetId = arrayId;
      }
      // Literal value (primitives only - objects/arrays handled above)
      else {
        const literalValue = ExpressionEvaluator.extractLiteralValue(actualArg);
        if (literalValue !== null || actualArg.type === 'NullLiteral') {
          const literalId = `LITERAL#arg${index}#${module.file}#${argInfo.line}:${argInfo.column}:${literalCounterRef.value++}`;
          literals.push({
            id: literalId,
            type: 'LITERAL',
            value: literalValue,
            valueType: typeof literalValue,
            file: module.file,
            line: argInfo.line,
            column: argInfo.column,
            parentCallId: callId,
            argIndex: index
          });
          argInfo.targetType = 'LITERAL';
          argInfo.targetId = literalId;
          argInfo.literalValue = literalValue;
        }
        // Variable reference
        else if (actualArg.type === 'Identifier') {
        argInfo.targetType = 'VARIABLE';
        argInfo.targetName = (actualArg as Identifier).name;  // Will be resolved in GraphBuilder
      }
      // Function expression (callback)
      else if (actualArg.type === 'ArrowFunctionExpression' || actualArg.type === 'FunctionExpression') {
        argInfo.targetType = 'FUNCTION';
        argInfo.functionLine = actualArg.loc?.start.line;
        argInfo.functionColumn = actualArg.loc?.start.column;
      }
      // Call expression (nested call)
      else if (actualArg.type === 'CallExpression') {
        argInfo.targetType = 'CALL';
        // Nested calls will be processed separately, link by position
        argInfo.nestedCallLine = actualArg.loc?.start.line;
        argInfo.nestedCallColumn = actualArg.loc?.start.column;
      }
      // REG-556: NewExpression arguments (new Foo() passed as arg)
      else if (actualArg.type === 'NewExpression') {
        argInfo.targetType = 'CONSTRUCTOR_CALL';
        argInfo.nestedCallLine = actualArg.loc?.start.line;
        argInfo.nestedCallColumn = actualArg.loc?.start.column;
      }
      // Member expression: obj.prop or obj[x]
      else if (actualArg.type === 'MemberExpression') {
        const memberExpr = actualArg as MemberExpression;
        argInfo.targetType = 'EXPRESSION';
        argInfo.expressionType = 'MemberExpression';
        if (memberExpr.object.type === 'Identifier') {
          argInfo.objectName = memberExpr.object.name;
        }
        if (!memberExpr.computed && memberExpr.property.type === 'Identifier') {
          argInfo.propertyName = memberExpr.property.name;
        }
      }
      // Binary/Logical expression: a + b, a && b
      else if (actualArg.type === 'BinaryExpression' || actualArg.type === 'LogicalExpression') {
        const expr = actualArg as { operator?: string; type: string };
        const operator = expr.operator || '?';
        const counter = literalCounterRef.value++;

        // Create EXPRESSION node via NodeFactory
        const expressionNode = NodeFactory.createArgumentExpression(
          actualArg.type,
          module.file,
          argInfo.line,
          argInfo.column,
          {
            parentCallId: callId,
            argIndex: index,
            operator,
            counter
          }
        );

        literals.push(expressionNode as LiteralInfo);

        argInfo.targetType = 'EXPRESSION';
        argInfo.targetId = expressionNode.id;
        argInfo.expressionType = actualArg.type;

        // Track DERIVES_FROM edges for identifiers in expression
        const identifiers = ArgumentExtractor.extractIdentifiers(actualArg);
        const { variableAssignments } = collections;
        if (variableAssignments) {
          for (const identName of identifiers) {
            variableAssignments.push({
              variableId: expressionNode.id,
              sourceId: null,
              sourceName: identName,
              sourceType: 'DERIVES_FROM_VARIABLE',
              file: module.file
            });
          }
        }
      }
      // Other expression types (fallback for unhandled expression types)
      else {
        argInfo.targetType = 'EXPRESSION';
        argInfo.expressionType = actualArg.type;
      }
      }

      callArguments.push(argInfo);
    });
  }

  /**
   * Extract all Identifier names from an expression (recursively).
   * Used for BinaryExpression/LogicalExpression to track DERIVES_FROM edges.
   */
  static extractIdentifiers(node: Node | null | undefined, identifiers: Set<string> = new Set()): string[] {
    if (!node) return Array.from(identifiers);

    if (node.type === 'Identifier') {
      identifiers.add((node as Identifier).name);
    } else if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
      const expr = node as { left: Node; right: Node };
      ArgumentExtractor.extractIdentifiers(expr.left, identifiers);
      ArgumentExtractor.extractIdentifiers(expr.right, identifiers);
    } else if (node.type === 'UnaryExpression') {
      const expr = node as { argument: Node };
      ArgumentExtractor.extractIdentifiers(expr.argument, identifiers);
    } else if (node.type === 'ConditionalExpression') {
      const expr = node as { test: Node; consequent: Node; alternate: Node };
      ArgumentExtractor.extractIdentifiers(expr.test, identifiers);
      ArgumentExtractor.extractIdentifiers(expr.consequent, identifiers);
      ArgumentExtractor.extractIdentifiers(expr.alternate, identifiers);
    } else if (node.type === 'MemberExpression') {
      const memberExpr = node as MemberExpression;
      // For obj.prop - track obj (but not prop as it's a property name)
      if (memberExpr.object.type === 'Identifier') {
        identifiers.add(memberExpr.object.name);
      } else {
        ArgumentExtractor.extractIdentifiers(memberExpr.object, identifiers);
      }
    } else if (node.type === 'CallExpression') {
      const callExpr = node as CallExpression;
      // For func() - track func if identifier, and all arguments
      if (callExpr.callee.type === 'Identifier') {
        identifiers.add((callExpr.callee as Identifier).name);
      }
      for (const arg of callExpr.arguments) {
        if (arg.type !== 'SpreadElement') {
          ArgumentExtractor.extractIdentifiers(arg, identifiers);
        } else {
          ArgumentExtractor.extractIdentifiers(arg.argument, identifiers);
        }
      }
    }

    return Array.from(identifiers);
  }
}
