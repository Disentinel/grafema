/**
 * CallExpressionVisitor - handles function calls and constructor invocations at module level
 *
 * Handles:
 * - Direct function calls: foo()
 * - Method calls: obj.method()
 * - Event handlers: obj.on('event', handler)
 * - Constructor calls: new Foo(), new Function()
 */

import type { Node, CallExpression, NewExpression, Identifier, MemberExpression, ObjectExpression, ArrayExpression, ObjectProperty, SpreadElement } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { ASTVisitor, type VisitorModule, type VisitorCollections, type VisitorHandlers, type CounterRef } from './ASTVisitor.js';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import type { ArrayMutationInfo, ArrayMutationArgument } from '../types.js';
import { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';

/**
 * Object literal info for OBJECT_LITERAL nodes
 */
interface ObjectLiteralInfo {
  id: string;
  type: 'OBJECT_LITERAL';
  file: string;
  line: number;
  column: number;
  parentCallId?: string;
  argIndex?: number;
  isSpread?: boolean;
}

/**
 * Object property info for HAS_PROPERTY edges
 */
interface ObjectPropertyInfo {
  objectId: string;
  propertyName: string;
  valueNodeId?: string;
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL' | 'SPREAD';
  valueName?: string;
  literalValue?: unknown;
  file: string;
  line: number;
  column: number;
  callLine?: number;
  callColumn?: number;
  nestedObjectId?: string;
  nestedArrayId?: string;
}

/**
 * Array literal info for ARRAY_LITERAL nodes
 */
interface ArrayLiteralInfo {
  id: string;
  type: 'ARRAY_LITERAL';
  file: string;
  line: number;
  column: number;
  parentCallId?: string;
  argIndex?: number;
}

/**
 * Array element info for HAS_ELEMENT edges
 */
interface ArrayElementInfo {
  arrayId: string;
  index: number;
  valueNodeId?: string;
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL' | 'SPREAD';
  valueName?: string;
  literalValue?: unknown;
  file: string;
  line: number;
  column: number;
  callLine?: number;
  callColumn?: number;
  nestedObjectId?: string;
  nestedArrayId?: string;
}

/**
 * Argument info for PASSES_ARGUMENT edges
 */
interface ArgumentInfo {
  callId: string;
  argIndex: number;
  file: string;
  line: number;
  column: number;
  isSpread?: boolean;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  literalValue?: unknown;
  functionLine?: number;
  functionColumn?: number;
  nestedCallLine?: number;
  nestedCallColumn?: number;
  objectName?: string;
  propertyName?: string;
  expressionType?: string;
}

/**
 * Call site info
 */
interface CallSiteInfo {
  id: string;
  type: 'CALL';
  name: string;
  file: string;
  line: number;
  column: number;
  parentScopeId: string;
  targetFunctionName: string;
  isNew?: boolean;
}

/**
 * Method call info
 */
interface MethodCallInfo {
  id: string;
  type: 'CALL';
  name: string;
  object: string;
  method: string;
  computed?: boolean;
  computedPropertyVar?: string | null;
  file: string;
  line: number;
  column: number;
  parentScopeId: string;
  isNew?: boolean;
}

/**
 * Event listener info
 */
interface EventListenerInfo {
  id: string;
  type: 'event:listener';
  name: string;
  object: string;
  file: string;
  line: number;
  parentScopeId: string;
  callbackArg: Node;
}

/**
 * Method callback info
 */
interface MethodCallbackInfo {
  methodCallId: string;
  callbackLine: number;
  callbackColumn: number;
  callbackType: string;
}

/**
 * Literal node info
 */
interface LiteralInfo {
  id: string;
  type: 'LITERAL' | 'EXPRESSION';
  value?: unknown;
  valueType?: string;
  expressionType?: string;
  operator?: string;
  name?: string;
  file: string;
  line: number;
  column: number;
  parentCallId: string;
  argIndex: number;
}

export class CallExpressionVisitor extends ASTVisitor {
  private scopeTracker?: ScopeTracker;

  /**
   * @param module - Current module being analyzed
   * @param collections - Must contain arrays and counter refs
   * @param scopeTracker - Optional ScopeTracker for semantic ID generation
   */
  constructor(module: VisitorModule, collections: VisitorCollections, scopeTracker?: ScopeTracker) {
    super(module, collections);
    this.scopeTracker = scopeTracker;
  }

  /**
   * Extract argument information for PASSES_ARGUMENT edges
   */
  extractArguments(
    args: CallExpression['arguments'],
    callId: string,
    module: VisitorModule,
    callArguments: ArgumentInfo[],
    literals: LiteralInfo[],
    literalCounterRef: CounterRef
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

      // Literal value
      const literalValue = ExpressionEvaluator.extractLiteralValue(actualArg);
      if (literalValue !== null) {
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
        const exprName = `<${actualArg.type}:${operator}>`;
        const expressionId = `EXPRESSION#${exprName}#${module.file}#${argInfo.line}:${argInfo.column}:${literalCounterRef.value++}`;

        // Create EXPRESSION node
        literals.push({
          id: expressionId,
          type: 'EXPRESSION',
          expressionType: actualArg.type,
          operator: operator,
          name: exprName,
          file: module.file,
          line: argInfo.line,
          column: argInfo.column,
          parentCallId: callId,
          argIndex: index
        });

        argInfo.targetType = 'EXPRESSION';
        argInfo.targetId = expressionId;
        argInfo.expressionType = actualArg.type;

        // Track DERIVES_FROM edges for identifiers in expression
        const identifiers = this.extractIdentifiers(actualArg);
        const { variableAssignments } = this.collections;
        if (variableAssignments) {
          for (const identName of identifiers) {
            variableAssignments.push({
              variableId: expressionId,
              sourceId: null,
              sourceName: identName,
              sourceType: 'DERIVES_FROM_VARIABLE',
              file: module.file
            });
          }
        }
      }
      // Object literal
      else if (actualArg.type === 'ObjectExpression') {
        const objectExpr = actualArg as ObjectExpression;
        // Initialize collections if not exist (must assign back to this.collections!)
        if (!this.collections.objectLiteralCounterRef) {
          this.collections.objectLiteralCounterRef = { value: 0 };
        }
        if (!this.collections.objectLiterals) {
          this.collections.objectLiterals = [];
        }
        if (!this.collections.objectProperties) {
          this.collections.objectProperties = [];
        }
        const objectLiteralCounterRef = this.collections.objectLiteralCounterRef as CounterRef;
        const objectId = `OBJECT_LITERAL#arg${index}#${module.file}#${argInfo.line}:${argInfo.column}:${objectLiteralCounterRef.value++}`;

        // Create OBJECT_LITERAL node
        (this.collections.objectLiterals as ObjectLiteralInfo[]).push({
          id: objectId,
          type: 'OBJECT_LITERAL',
          file: module.file,
          line: argInfo.line,
          column: argInfo.column,
          parentCallId: callId,
          argIndex: index
        });

        // Extract properties
        this.extractObjectProperties(
          objectExpr,
          objectId,
          module,
          this.collections.objectProperties as ObjectPropertyInfo[],
          this.collections.objectLiterals as ObjectLiteralInfo[],
          objectLiteralCounterRef,
          literals as LiteralInfo[],
          literalCounterRef
        );

        argInfo.targetType = 'OBJECT_LITERAL';
        argInfo.targetId = objectId;
      }
      // Array literal
      else if (actualArg.type === 'ArrayExpression') {
        const arrayExpr = actualArg as ArrayExpression;
        // Initialize collections if not exist (must assign back to this.collections!)
        if (!this.collections.arrayLiteralCounterRef) {
          this.collections.arrayLiteralCounterRef = { value: 0 };
        }
        if (!this.collections.arrayLiterals) {
          this.collections.arrayLiterals = [];
        }
        if (!this.collections.arrayElements) {
          this.collections.arrayElements = [];
        }
        if (!this.collections.objectLiteralCounterRef) {
          this.collections.objectLiteralCounterRef = { value: 0 };
        }
        if (!this.collections.objectLiterals) {
          this.collections.objectLiterals = [];
        }
        if (!this.collections.objectProperties) {
          this.collections.objectProperties = [];
        }
        const arrayLiteralCounterRef = this.collections.arrayLiteralCounterRef as CounterRef;
        const arrayId = `ARRAY_LITERAL#arg${index}#${module.file}#${argInfo.line}:${argInfo.column}:${arrayLiteralCounterRef.value++}`;

        // Create ARRAY_LITERAL node
        (this.collections.arrayLiterals as ArrayLiteralInfo[]).push({
          id: arrayId,
          type: 'ARRAY_LITERAL',
          file: module.file,
          line: argInfo.line,
          column: argInfo.column,
          parentCallId: callId,
          argIndex: index
        });

        // Extract elements
        this.extractArrayElements(
          arrayExpr,
          arrayId,
          module,
          this.collections.arrayElements as ArrayElementInfo[],
          this.collections.arrayLiterals as ArrayLiteralInfo[],
          arrayLiteralCounterRef,
          this.collections.objectLiterals as ObjectLiteralInfo[],
          this.collections.objectLiteralCounterRef as CounterRef,
          this.collections.objectProperties as ObjectPropertyInfo[],
          literals as LiteralInfo[],
          literalCounterRef
        );

        argInfo.targetType = 'ARRAY_LITERAL';
        argInfo.targetId = arrayId;
      }
      // Other expression types
      else {
        argInfo.targetType = 'EXPRESSION';
        argInfo.expressionType = actualArg.type;
      }

      callArguments.push(argInfo);
    });
  }

  /**
   * Extract all Identifier names from an expression (recursively)
   * Used for BinaryExpression/LogicalExpression to track DERIVES_FROM edges
   */
  extractIdentifiers(node: Node | null | undefined, identifiers: Set<string> = new Set()): string[] {
    if (!node) return Array.from(identifiers);

    if (node.type === 'Identifier') {
      identifiers.add((node as Identifier).name);
    } else if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
      const expr = node as { left: Node; right: Node };
      this.extractIdentifiers(expr.left, identifiers);
      this.extractIdentifiers(expr.right, identifiers);
    } else if (node.type === 'UnaryExpression') {
      const expr = node as { argument: Node };
      this.extractIdentifiers(expr.argument, identifiers);
    } else if (node.type === 'ConditionalExpression') {
      const expr = node as { test: Node; consequent: Node; alternate: Node };
      this.extractIdentifiers(expr.test, identifiers);
      this.extractIdentifiers(expr.consequent, identifiers);
      this.extractIdentifiers(expr.alternate, identifiers);
    } else if (node.type === 'MemberExpression') {
      const memberExpr = node as MemberExpression;
      // For obj.prop - track obj (but not prop as it's a property name)
      if (memberExpr.object.type === 'Identifier') {
        identifiers.add(memberExpr.object.name);
      } else {
        this.extractIdentifiers(memberExpr.object, identifiers);
      }
    } else if (node.type === 'CallExpression') {
      const callExpr = node as CallExpression;
      // For func() - track func if identifier, and all arguments
      if (callExpr.callee.type === 'Identifier') {
        identifiers.add((callExpr.callee as Identifier).name);
      }
      for (const arg of callExpr.arguments) {
        if (arg.type !== 'SpreadElement') {
          this.extractIdentifiers(arg, identifiers);
        } else {
          this.extractIdentifiers(arg.argument, identifiers);
        }
      }
    }

    return Array.from(identifiers);
  }

  /**
   * Extract object properties and create ObjectPropertyInfo records
   */
  extractObjectProperties(
    objectExpr: ObjectExpression,
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

        // Literal value
        const literalValue = ExpressionEvaluator.extractLiteralValue(value);
        if (literalValue !== null) {
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
        // Nested object literal
        else if (value.type === 'ObjectExpression') {
          const nestedObjectId = `OBJECT_LITERAL#${propertyName}#${module.file}#${value.loc?.start.line}:${value.loc?.start.column}:${objectLiteralCounterRef.value++}`;
          objectLiterals.push({
            id: nestedObjectId,
            type: 'OBJECT_LITERAL',
            file: module.file,
            line: value.loc?.start.line || 0,
            column: value.loc?.start.column || 0
          });

          // Recursively extract nested properties
          this.extractObjectProperties(
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
        // Nested array literal
        else if (value.type === 'ArrayExpression') {
          const arrayLiteralCounterRef = (this.collections.arrayLiteralCounterRef ?? { value: 0 }) as CounterRef;
          const arrayLiterals = this.collections.arrayLiterals ?? [];
          const arrayElements = this.collections.arrayElements ?? [];

          const nestedArrayId = `ARRAY_LITERAL#${propertyName}#${module.file}#${value.loc?.start.line}:${value.loc?.start.column}:${arrayLiteralCounterRef.value++}`;
          (arrayLiterals as ArrayLiteralInfo[]).push({
            id: nestedArrayId,
            type: 'ARRAY_LITERAL',
            file: module.file,
            line: value.loc?.start.line || 0,
            column: value.loc?.start.column || 0
          });

          // Recursively extract array elements
          this.extractArrayElements(
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
            literalCounterRef
          );

          propertyInfo.valueType = 'ARRAY_LITERAL';
          propertyInfo.nestedArrayId = nestedArrayId;
          propertyInfo.valueNodeId = nestedArrayId;
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

  /**
   * Extract array elements and create ArrayElementInfo records
   */
  extractArrayElements(
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
    literalCounterRef: CounterRef
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

      // Literal value
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
      // Nested object literal
      else if (element.type === 'ObjectExpression') {
        const nestedObjectId = `OBJECT_LITERAL#elem${index}#${module.file}#${elemLine}:${elemColumn}:${objectLiteralCounterRef.value++}`;
        objectLiterals.push({
          id: nestedObjectId,
          type: 'OBJECT_LITERAL',
          file: module.file,
          line: elemLine,
          column: elemColumn
        });

        // Recursively extract properties
        this.extractObjectProperties(
          element,
          nestedObjectId,
          module,
          objectProperties,
          objectLiterals,
          objectLiteralCounterRef,
          literals,
          literalCounterRef
        );

        elementInfo.valueType = 'OBJECT_LITERAL';
        elementInfo.nestedObjectId = nestedObjectId;
        elementInfo.valueNodeId = nestedObjectId;
      }
      // Nested array literal
      else if (element.type === 'ArrayExpression') {
        const nestedArrayId = `ARRAY_LITERAL#elem${index}#${module.file}#${elemLine}:${elemColumn}:${arrayLiteralCounterRef.value++}`;
        arrayLiterals.push({
          id: nestedArrayId,
          type: 'ARRAY_LITERAL',
          file: module.file,
          line: elemLine,
          column: elemColumn
        });

        // Recursively extract elements
        this.extractArrayElements(
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
          literalCounterRef
        );

        elementInfo.valueType = 'ARRAY_LITERAL';
        elementInfo.nestedArrayId = nestedArrayId;
        elementInfo.valueNodeId = nestedArrayId;
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

      arrayElements.push(elementInfo);
    });
  }

  /**
   * Detect array mutation calls (push, unshift, splice) and collect mutation info
   * for later FLOWS_INTO edge creation in GraphBuilder
   */
  private detectArrayMutation(
    callNode: CallExpression,
    arrayName: string,
    method: 'push' | 'unshift' | 'splice',
    module: VisitorModule
  ): void {
    // Initialize collection if not exists
    if (!this.collections.arrayMutations) {
      this.collections.arrayMutations = [];
    }
    const arrayMutations = this.collections.arrayMutations as ArrayMutationInfo[];

    const mutationArgs: ArrayMutationArgument[] = [];

    // For splice, only arguments from index 2 onwards are insertions
    // splice(start, deleteCount, item1, item2, ...)
    callNode.arguments.forEach((arg, index) => {
      // Skip start and deleteCount for splice
      if (method === 'splice' && index < 2) return;

      const argInfo: ArrayMutationArgument = {
        argIndex: method === 'splice' ? index - 2 : index,
        isSpread: arg.type === 'SpreadElement',
        valueType: 'EXPRESSION'  // Default
      };

      let actualArg = arg;
      if (arg.type === 'SpreadElement') {
        actualArg = arg.argument;
      }

      // Determine value type
      const literalValue = ExpressionEvaluator.extractLiteralValue(actualArg);
      if (literalValue !== null) {
        argInfo.valueType = 'LITERAL';
        argInfo.literalValue = literalValue;
      } else if (actualArg.type === 'Identifier') {
        argInfo.valueType = 'VARIABLE';
        argInfo.valueName = actualArg.name;
      } else if (actualArg.type === 'ObjectExpression') {
        argInfo.valueType = 'OBJECT_LITERAL';
      } else if (actualArg.type === 'ArrayExpression') {
        argInfo.valueType = 'ARRAY_LITERAL';
      } else if (actualArg.type === 'CallExpression') {
        argInfo.valueType = 'CALL';
        argInfo.callLine = actualArg.loc?.start.line;
        argInfo.callColumn = actualArg.loc?.start.column;
      }

      mutationArgs.push(argInfo);
    });

    // Only record if there are actual insertions
    if (mutationArgs.length > 0) {
      const line = callNode.loc?.start.line ?? 0;
      const column = callNode.loc?.start.column ?? 0;

      // Generate semantic ID for array mutation if scopeTracker available
      const scopeTracker = this.scopeTracker;
      let mutationId: string | undefined;
      if (scopeTracker) {
        const discriminator = scopeTracker.getItemCounter(`ARRAY_MUTATION:${arrayName}.${method}`);
        mutationId = computeSemanticId('ARRAY_MUTATION', `${arrayName}.${method}`, scopeTracker.getContext(), { discriminator });
      }

      arrayMutations.push({
        id: mutationId,
        arrayName,
        mutationMethod: method,
        file: module.file,
        line,
        column,
        insertedValues: mutationArgs
      });
    }
  }

  /**
   * Get a stable scope ID for a function parent
   * Format must match what FunctionVisitor creates:
   * - FunctionDeclaration: FUNCTION#name#file#line
   * - ArrowFunctionExpression: FUNCTION#name#file#line:col:counter
   *
   * NOTE: We don't have access to the counter here, so for arrow functions
   * we try to match by name+file+line:col. This may not always work for
   * multiple arrow functions on the same line.
   */
  getFunctionScopeId(functionParent: NodePath, module: VisitorModule): string {
    const funcNode = functionParent.node as Node & {
      id?: { name: string } | null;
      loc?: { start: { line: number; column: number } };
      type: string;
    };
    const line = funcNode.loc?.start.line || 0;
    const col = funcNode.loc?.start.column || 0;

    // FunctionDeclaration with name
    if (funcNode.type === 'FunctionDeclaration' && funcNode.id?.name) {
      return `FUNCTION#${funcNode.id.name}#${module.file}#${line}`;
    }

    // For arrow functions and other cases, we can't perfectly match the ID
    // because FunctionVisitor uses a counter. For now, use module.id as fallback
    // to avoid creating invalid edges. The CALL node will be connected to MODULE
    // instead of the specific function.
    return module.id;
  }

  getHandlers(): VisitorHandlers {
    const { module } = this;
    const callSites = this.collections.callSites ?? [];
    const methodCalls = this.collections.methodCalls ?? [];
    const eventListeners = this.collections.eventListeners ?? [];
    const methodCallbacks = this.collections.methodCallbacks ?? [];
    const literals = this.collections.literals ?? [];
    const callArguments = this.collections.callArguments ?? [];
    const callSiteCounterRef = (this.collections.callSiteCounterRef ?? { value: 0 }) as CounterRef;
    const literalCounterRef = (this.collections.literalCounterRef ?? { value: 0 }) as CounterRef;
    const processedNodes = this.collections.processedNodes ?? { callSites: new Set(), methodCalls: new Set(), eventListeners: new Set() };
    const scopeTracker = this.scopeTracker;

    return {
      CallExpression: (path: NodePath) => {
        const callNode = path.node as CallExpression;
        const functionParent = path.getFunctionParent();

        // Determine parent scope - if inside a function, use function's scope, otherwise module
        const parentScopeId = functionParent ? this.getFunctionScopeId(functionParent, module) : module.id;

        // Identifier calls (direct function calls)
        // Skip if inside function - they will be processed by analyzeFunctionBody with proper scope tracking
          if (callNode.callee.type === 'Identifier') {
            if (functionParent) {
              return;
            }
            const callee = callNode.callee as Identifier;

            // Generate semantic ID with discriminator for same-named calls
            const legacyId = `CALL#${callee.name}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`;

            let callId = legacyId;
            if (scopeTracker) {
              const discriminator = scopeTracker.getItemCounter(`CALL:${callee.name}`);
              callId = computeSemanticId('CALL', callee.name, scopeTracker.getContext(), { discriminator });
            }

            (callSites as CallSiteInfo[]).push({
              id: callId,
              type: 'CALL',
              name: callee.name,
              file: module.file,
              line: callNode.loc!.start.line,
              column: callNode.loc!.start.column,
              parentScopeId,
              targetFunctionName: callee.name
            });

            // Extract arguments for PASSES_ARGUMENT edges
            if (callNode.arguments.length > 0) {
              this.extractArguments(
                callNode.arguments,
                callId,
                module,
                callArguments as ArgumentInfo[],
                literals as LiteralInfo[],
                literalCounterRef
              );
            }
          }
          // MemberExpression calls (method calls)
          // Skip if inside function - they will be processed by analyzeFunctionBody with proper scope tracking
          else if (callNode.callee.type === 'MemberExpression') {
            if (functionParent) {
              return;
            }
            const memberCallee = callNode.callee as MemberExpression;
            const object = memberCallee.object;
            const property = memberCallee.property;
            const isComputed = memberCallee.computed;

            if ((object.type === 'Identifier' || object.type === 'ThisExpression') && property.type === 'Identifier') {
              const objectName = object.type === 'Identifier' ? (object as Identifier).name : 'this';
              // For computed access obj[x](), methodName is '<computed>' but we save the variable name
              const methodName = isComputed ? '<computed>' : (property as Identifier).name;
              const computedPropertyVar = isComputed ? (property as Identifier).name : null;

              // Special handling for .on() event handlers
              if (methodName === 'on' && callNode.arguments.length >= 2) {
                const firstArg = callNode.arguments[0];
                const secondArg = callNode.arguments[1];

                if (firstArg.type === 'StringLiteral') {
                  const eventName = firstArg.value;

                  // Dedup check
                  const nodeKey = `${callNode.start}:${callNode.end}`;
                  if (processedNodes.eventListeners.has(nodeKey)) {
                    return;
                  }
                  processedNodes.eventListeners.add(nodeKey);

                  (eventListeners as EventListenerInfo[]).push({
                    id: `event:listener#${eventName}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`,
                    type: 'event:listener',
                    name: eventName,
                    object: objectName,
                    file: module.file,
                    line: callNode.loc!.start.line,
                    parentScopeId,
                    callbackArg: secondArg
                  });
                }
              } else {
                // Regular method call
                const nodeKey = `${callNode.start}:${callNode.end}`;
                if (processedNodes.methodCalls.has(nodeKey)) {
                  return;
                }
                processedNodes.methodCalls.add(nodeKey);

                const fullName = `${objectName}.${methodName}`;

                // Generate semantic ID with discriminator for same-named calls
                const legacyId = `CALL#${fullName}#${module.file}#${callNode.loc!.start.line}:${callNode.loc!.start.column}:${callSiteCounterRef.value++}`;

                let methodCallId = legacyId;
                if (scopeTracker) {
                  const discriminator = scopeTracker.getItemCounter(`CALL:${fullName}`);
                  methodCallId = computeSemanticId('CALL', fullName, scopeTracker.getContext(), { discriminator });
                }

                (methodCalls as MethodCallInfo[]).push({
                  id: methodCallId,
                  type: 'CALL',
                  name: fullName,
                  object: objectName,
                  method: methodName,
                  computed: isComputed,
                  computedPropertyVar,  // Variable name used in obj[x]() calls
                  file: module.file,
                  line: callNode.loc!.start.line,
                  column: callNode.loc!.start.column,
                  parentScopeId
                });

                // Check for array mutation methods (push, unshift, splice)
                const ARRAY_MUTATION_METHODS = ['push', 'unshift', 'splice'];
                if (ARRAY_MUTATION_METHODS.includes(methodName)) {
                  this.detectArrayMutation(
                    callNode,
                    objectName,
                    methodName as 'push' | 'unshift' | 'splice',
                    module
                  );
                }

                // Extract arguments for PASSES_ARGUMENT edges
                if (callNode.arguments.length > 0) {
                  this.extractArguments(
                    callNode.arguments,
                    methodCallId,
                    module,
                    callArguments as ArgumentInfo[],
                    literals as LiteralInfo[],
                    literalCounterRef
                  );

                  // Also track callbacks for HAS_CALLBACK edges
                  callNode.arguments.forEach((arg) => {
                    if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') {
                      (methodCallbacks as MethodCallbackInfo[]).push({
                        methodCallId,
                        callbackLine: arg.loc!.start.line,
                        callbackColumn: arg.loc!.start.column,
                        callbackType: arg.type
                      });
                    }
                  });
                }
              }
            }
          }
      },

      // NewExpression: new Foo(), new Function(), new Map(), etc.
      // Skip if inside function - they will be processed by analyzeFunctionBody with proper scope tracking
      NewExpression: (path: NodePath) => {
        const newNode = path.node as NewExpression;
        const functionParent = path.getFunctionParent();

        // Skip if inside function - handled by analyzeFunctionBody
        if (functionParent) {
          return;
        }

        const parentScopeId = module.id;

        // Dedup check
        const nodeKey = `new:${newNode.start}:${newNode.end}`;
        if (processedNodes.methodCalls.has(nodeKey)) {
          return;
        }
        processedNodes.methodCalls.add(nodeKey);

        // new Foo() - Identifier callee
        if (newNode.callee.type === 'Identifier') {
          const callee = newNode.callee as Identifier;
          const constructorName = callee.name;

          // Generate semantic ID for constructor call
          const legacyId = `CALL#new:${constructorName}#${module.file}#${newNode.loc!.start.line}:${newNode.loc!.start.column}:${callSiteCounterRef.value++}`;

          let newCallId = legacyId;
          if (scopeTracker) {
            const discriminator = scopeTracker.getItemCounter(`CALL:new:${constructorName}`);
            newCallId = computeSemanticId('CALL', `new:${constructorName}`, scopeTracker.getContext(), { discriminator });
          }

          (callSites as CallSiteInfo[]).push({
            id: newCallId,
            type: 'CALL',
            name: constructorName,
            file: module.file,
            line: newNode.loc!.start.line,
            column: newNode.loc!.start.column,
            parentScopeId,
            targetFunctionName: constructorName,
            isNew: true  // Mark as constructor call
          });
        }
        // new obj.Constructor() - MemberExpression callee
        else if (newNode.callee.type === 'MemberExpression') {
          const memberCallee = newNode.callee as MemberExpression;
          const object = memberCallee.object;
          const property = memberCallee.property;

          if (object.type === 'Identifier' && property.type === 'Identifier') {
            const objectName = (object as Identifier).name;
            const constructorName = (property as Identifier).name;
            const fullName = `${objectName}.${constructorName}`;

            // Generate semantic ID for method-style constructor call
            const legacyId = `CALL#new:${fullName}#${module.file}#${newNode.loc!.start.line}:${newNode.loc!.start.column}:${callSiteCounterRef.value++}`;

            let newMethodCallId = legacyId;
            if (scopeTracker) {
              const discriminator = scopeTracker.getItemCounter(`CALL:new:${fullName}`);
              newMethodCallId = computeSemanticId('CALL', `new:${fullName}`, scopeTracker.getContext(), { discriminator });
            }

            (methodCalls as MethodCallInfo[]).push({
              id: newMethodCallId,
              type: 'CALL',
              name: fullName,
              object: objectName,
              method: constructorName,
              file: module.file,
              line: newNode.loc!.start.line,
              column: newNode.loc!.start.column,
              parentScopeId,
              isNew: true  // Mark as constructor call
            });
          }
        }
      }
    };
  }
}
