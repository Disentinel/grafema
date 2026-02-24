import type * as t from '@babel/types';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { getLine, getColumn } from '../utils/location.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type { VisitorModule } from '../visitors/index.js';
import type {
  VariableReassignmentInfo,
  UpdateExpressionInfo,
} from '../types.js';

/**
 * Collect update expression info for graph building (i++, obj.prop++, arr[i]++).
 *
 * REG-288: Simple identifiers (i++, --count)
 * REG-312: Member expressions (obj.prop++, arr[i]++, this.count++)
 *
 * Creates UpdateExpressionInfo entries that GraphBuilder uses to create:
 * - UPDATE_EXPRESSION nodes
 * - MODIFIES edges to target variables/objects
 * - READS_FROM self-loops
 * - CONTAINS edges for scope hierarchy
 */
export function collectUpdateExpression(
  updateNode: t.UpdateExpression,
  module: VisitorModule,
  updateExpressions: UpdateExpressionInfo[],
  parentScopeId: string | undefined,
  scopeTracker?: ScopeTracker
): void {
  const operator = updateNode.operator as '++' | '--';
  const prefix = updateNode.prefix;
  const line = getLine(updateNode);
  const column = getColumn(updateNode);

  // CASE 1: Simple identifier (i++, --count) - REG-288 behavior
  if (updateNode.argument.type === 'Identifier') {
    const variableName = updateNode.argument.name;

    updateExpressions.push({
      targetType: 'IDENTIFIER',
      variableName,
      variableLine: getLine(updateNode.argument),
      operator,
      prefix,
      file: module.file,
      line,
      column,
      parentScopeId
    });
    return;
  }

  // CASE 2: Member expression (obj.prop++, arr[i]++) - REG-312 new
  if (updateNode.argument.type === 'MemberExpression') {
    const memberExpr = updateNode.argument;

    // Extract object name (reuses detectObjectPropertyAssignment pattern)
    let objectName: string;
    let enclosingClassName: string | undefined;

    if (memberExpr.object.type === 'Identifier') {
      objectName = memberExpr.object.name;
    } else if (memberExpr.object.type === 'ThisExpression') {
      objectName = 'this';
      // REG-152: Extract enclosing class name from scope context
      if (scopeTracker) {
        enclosingClassName = scopeTracker.getEnclosingScope('CLASS');
      }
    } else {
      // Complex expressions: obj.nested.prop++, (obj || fallback).count++
      // Skip for now (documented limitation, same as detectObjectPropertyAssignment)
      return;
    }

    // REG-557: Capture enclosing function name to distinguish constructor from methods
    let enclosingFunctionName: string | undefined;
    if (objectName === 'this' && scopeTracker) {
      enclosingFunctionName = scopeTracker.getEnclosingScope('FUNCTION');
    }

    // Extract property name (reuses detectObjectPropertyAssignment pattern)
    let propertyName: string;
    let mutationType: 'property' | 'computed';
    let computedPropertyVar: string | undefined;

    if (!memberExpr.computed) {
      // obj.prop++
      if (memberExpr.property.type === 'Identifier') {
        propertyName = memberExpr.property.name;
        mutationType = 'property';
      } else {
        return; // Unexpected property type
      }
    } else {
      // obj['prop']++ or obj[key]++
      if (memberExpr.property.type === 'StringLiteral') {
        // obj['prop']++ - static string
        propertyName = memberExpr.property.value;
        mutationType = 'property';
      } else {
        // obj[key]++, arr[i]++ - computed property
        propertyName = '<computed>';
        mutationType = 'computed';
        if (memberExpr.property.type === 'Identifier') {
          computedPropertyVar = memberExpr.property.name;
        }
      }
    }

    updateExpressions.push({
      targetType: 'MEMBER_EXPRESSION',
      objectName,
      objectLine: getLine(memberExpr.object),
      enclosingClassName,
      enclosingFunctionName,  // REG-557: Function name for constructor detection
      propertyName,
      mutationType,
      computedPropertyVar,
      operator,
      prefix,
      file: module.file,
      line,
      column,
      parentScopeId
    });
  }
}

/**
 * Detect variable reassignment for FLOWS_INTO edge creation.
 * Handles all assignment operators: =, +=, -=, *=, /=, etc.
 *
 * Captures COMPLETE metadata for:
 * - LITERAL values (literalValue field)
 * - EXPRESSION nodes (expressionType, expressionMetadata fields)
 * - VARIABLE, CALL_SITE, METHOD_CALL references
 *
 * REG-290: No deferred functionality - all value types captured.
 */
export function detectVariableReassignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  variableReassignments: VariableReassignmentInfo[],
  scopeTracker?: ScopeTracker
): void {
  // LHS must be simple identifier (checked by caller)
  const leftId = assignNode.left as t.Identifier;
  const variableName = leftId.name;
  const operator = assignNode.operator;  // '=', '+=', '-=', etc.

  // Get RHS value info
  const rightExpr = assignNode.right;
  const line = getLine(assignNode);
  const column = getColumn(assignNode);

  // Extract value source (similar to VariableVisitor pattern)
  let valueType: 'VARIABLE' | 'CALL_SITE' | 'METHOD_CALL' | 'LITERAL' | 'EXPRESSION';
  let valueName: string | undefined;
  let valueId: string | null = null;
  let callLine: number | undefined;
  let callColumn: number | undefined;

  // Complete metadata for node creation
  let literalValue: unknown;
  let expressionType: string | undefined;
  let expressionMetadata: VariableReassignmentInfo['expressionMetadata'];

  // 1. Literal value
  const extractedLiteralValue = ExpressionEvaluator.extractLiteralValue(rightExpr);
  if (extractedLiteralValue !== null) {
    valueType = 'LITERAL';
    valueId = `LITERAL#${line}:${rightExpr.start}#${module.file}`;
    literalValue = extractedLiteralValue;  // Store for GraphBuilder
  }
  // 2. Simple identifier (variable reference)
  else if (rightExpr.type === 'Identifier') {
    valueType = 'VARIABLE';
    valueName = rightExpr.name;
  }
  // 3. CallExpression (function call)
  else if (rightExpr.type === 'CallExpression' && rightExpr.callee.type === 'Identifier') {
    valueType = 'CALL_SITE';
    valueName = rightExpr.callee.name;
    callLine = getLine(rightExpr);
    callColumn = getColumn(rightExpr);
  }
  // 4. MemberExpression (method call: obj.method())
  else if (rightExpr.type === 'CallExpression' && rightExpr.callee.type === 'MemberExpression') {
    valueType = 'METHOD_CALL';
    callLine = getLine(rightExpr);
    callColumn = getColumn(rightExpr);
  }
  // 5. Everything else is EXPRESSION
  else {
    valueType = 'EXPRESSION';
    expressionType = rightExpr.type;  // Store AST node type
    // Use correct EXPRESSION ID format: {file}:EXPRESSION:{type}:{line}:{column}
    valueId = `${module.file}:EXPRESSION:${expressionType}:${line}:${column}`;

    // Extract type-specific metadata (matches VariableAssignmentInfo pattern)
    expressionMetadata = {};

    // MemberExpression: obj.prop or obj[key]
    if (rightExpr.type === 'MemberExpression') {
      const objName = rightExpr.object.type === 'Identifier' ? rightExpr.object.name : undefined;
      const propName = rightExpr.property.type === 'Identifier' ? rightExpr.property.name : undefined;
      const computed = rightExpr.computed;

      expressionMetadata.object = objName;
      expressionMetadata.property = propName;
      expressionMetadata.computed = computed;

      // Computed property variable: obj[varName]
      if (computed && rightExpr.property.type === 'Identifier') {
        expressionMetadata.computedPropertyVar = rightExpr.property.name;
      }
    }
    // BinaryExpression: a + b, a - b, etc.
    else if (rightExpr.type === 'BinaryExpression' || rightExpr.type === 'LogicalExpression') {
      expressionMetadata.operator = rightExpr.operator;
      expressionMetadata.leftSourceName = rightExpr.left.type === 'Identifier' ? rightExpr.left.name : undefined;
      expressionMetadata.rightSourceName = rightExpr.right.type === 'Identifier' ? rightExpr.right.name : undefined;
    }
    // ConditionalExpression: condition ? a : b
    else if (rightExpr.type === 'ConditionalExpression') {
      expressionMetadata.consequentSourceName = rightExpr.consequent.type === 'Identifier' ? rightExpr.consequent.name : undefined;
      expressionMetadata.alternateSourceName = rightExpr.alternate.type === 'Identifier' ? rightExpr.alternate.name : undefined;
    }
    // Add more expression types as needed
  }

  // Capture scope path for scope-aware lookup (REG-309)
  const scopePath = scopeTracker?.getContext().scopePath ?? [];

  // Push reassignment info to collection
  variableReassignments.push({
    variableName,
    variableLine: getLine(leftId),
    mutationScopePath: scopePath,
    valueType,
    valueName,
    valueId,
    callLine,
    callColumn,
    operator,
    // Complete metadata
    literalValue,
    expressionType,
    expressionMetadata,
    file: module.file,
    line,
    column
  });
}
