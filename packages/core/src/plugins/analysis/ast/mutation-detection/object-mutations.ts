import type * as t from '@babel/types';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { computeSemanticId, computeSemanticIdV2 } from '../../../../core/SemanticId.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type { VisitorModule } from '../visitors/index.js';
import type {
  ObjectMutationInfo,
  ObjectMutationValue,
  PropertyAssignmentInfo,
  CounterRef,
} from '../types.js';

/**
 * Extract value information from an expression for mutation tracking
 */
export function extractMutationValue(value: t.Expression): ObjectMutationValue {
  const valueInfo: ObjectMutationValue = {
    valueType: 'EXPRESSION'  // Default
  };

  // REG-554: Unwrap TSNonNullExpression before evaluating the inner expression.
  // Handles: this.graph = options.graph! (TSNonNullExpression wrapping a MemberExpression)
  const effectiveValue: t.Expression =
    value.type === 'TSNonNullExpression' ? value.expression : value;

  const literalValue = ExpressionEvaluator.extractLiteralValue(effectiveValue);
  if (literalValue !== null) {
    valueInfo.valueType = 'LITERAL';
    valueInfo.literalValue = literalValue;
  } else if (effectiveValue.type === 'Identifier') {
    valueInfo.valueType = 'VARIABLE';
    valueInfo.valueName = effectiveValue.name;
  } else if (effectiveValue.type === 'ObjectExpression') {
    valueInfo.valueType = 'OBJECT_LITERAL';
  } else if (effectiveValue.type === 'ArrayExpression') {
    valueInfo.valueType = 'ARRAY_LITERAL';
  } else if (effectiveValue.type === 'CallExpression') {
    valueInfo.valueType = 'CALL';
    valueInfo.callLine = effectiveValue.loc?.start.line;
    valueInfo.callColumn = effectiveValue.loc?.start.column;
  } else if (
    effectiveValue.type === 'MemberExpression' &&
    effectiveValue.object.type === 'Identifier' &&
    !effectiveValue.computed &&
    effectiveValue.property.type === 'Identifier'
  ) {
    // REG-554: Simple member expression: options.graph, config.timeout, etc.
    // Use property location (not the full MemberExpression start) to match
    // the line/column stored by PropertyAccessVisitor.extractChain(), which
    // records current.property.loc.start for PROPERTY_ACCESS lookup.
    valueInfo.valueType = 'MEMBER_EXPRESSION';
    valueInfo.memberObject = effectiveValue.object.name;
    valueInfo.memberProperty = effectiveValue.property.name;
    valueInfo.memberLine = effectiveValue.property.loc?.start.line;
    valueInfo.memberColumn = effectiveValue.property.loc?.start.column;
  }

  return valueInfo;
}

/**
 * Detect object property assignment: obj.prop = value, obj['prop'] = value
 * Creates ObjectMutationInfo for FLOWS_INTO edge generation in GraphBuilder
 *
 * @param assignNode - The assignment expression node
 * @param module - Current module being analyzed
 * @param objectMutations - Collection to push mutation info into
 * @param scopeTracker - Optional scope tracker for semantic IDs
 */
export function detectObjectPropertyAssignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  objectMutations: ObjectMutationInfo[],
  scopeTracker?: ScopeTracker,
  propertyAssignments?: PropertyAssignmentInfo[],
  propertyAssignmentCounterRef?: CounterRef
): void {
  // Check for property assignment: obj.prop = value or obj['prop'] = value
  if (assignNode.left.type !== 'MemberExpression') return;

  const memberExpr = assignNode.left;

  // Skip NumericLiteral indexed assignment (handled by array mutation handler)
  // Array mutation handler processes: arr[0] (numeric literal index)
  // Object mutation handler processes: obj.prop, obj['prop'], obj[key], obj[expr]
  if (memberExpr.computed && memberExpr.property.type === 'NumericLiteral') {
    return; // Let array mutation handler deal with this
  }

  // Get object name and enclosing class context for 'this'
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
    // Complex expressions like obj.nested.prop = value
    // For now, skip these (documented limitation)
    return;
  }

  // REG-557: Capture enclosing function name to distinguish constructor from methods
  let enclosingFunctionName: string | undefined;
  if (objectName === 'this' && scopeTracker) {
    enclosingFunctionName = scopeTracker.getEnclosingScope('FUNCTION');
  }

  // Get property name
  let propertyName: string;
  let mutationType: 'property' | 'computed';
  let computedPropertyVar: string | undefined;

  if (!memberExpr.computed) {
    // obj.prop
    if (memberExpr.property.type === 'Identifier') {
      propertyName = memberExpr.property.name;
      mutationType = 'property';
    } else {
      return; // Unexpected property type
    }
  } else {
    // obj['prop'] or obj[key]
    if (memberExpr.property.type === 'StringLiteral') {
      propertyName = memberExpr.property.value;
      mutationType = 'property'; // String literal is effectively a property name
    } else {
      propertyName = '<computed>';
      mutationType = 'computed';
      // Capture variable name for later resolution in enrichment phase
      if (memberExpr.property.type === 'Identifier') {
        computedPropertyVar = memberExpr.property.name;
      }
    }
  }

  // Extract value info
  const value = assignNode.right;
  const valueInfo = extractMutationValue(value);

  // Use defensive loc checks
  const line = assignNode.loc?.start.line ?? 0;
  const column = assignNode.loc?.start.column ?? 0;

  // Capture scope path for scope-aware lookup (REG-309)
  const scopePath = scopeTracker?.getContext().scopePath ?? [];

  // Generate semantic ID if scopeTracker available
  let mutationId: string | undefined;
  if (scopeTracker) {
    const discriminator = scopeTracker.getItemCounter(`OBJECT_MUTATION:${objectName}.${propertyName}`);
    mutationId = computeSemanticId('OBJECT_MUTATION', `${objectName}.${propertyName}`, scopeTracker.getContext(), { discriminator });
  }

  objectMutations.push({
    id: mutationId,
    objectName,
    mutationScopePath: scopePath,
    enclosingClassName,  // REG-152: Class name for 'this' mutations
    enclosingFunctionName,  // REG-557: Function name for constructor detection
    propertyName,
    mutationType,
    computedPropertyVar,
    file: module.file,
    line,
    column,
    value: valueInfo
  });

  // REG-554: Also collect PROPERTY_ASSIGNMENT node info for 'this.prop = value'
  // Only when inside a class context (enclosingClassName must be set).
  // Non-'this' assignments are tracked by FLOWS_INTO edges only (MutationBuilder).
  if (propertyAssignments && objectName === 'this' && enclosingClassName) {
    let assignmentId: string;
    const fullName = `${objectName}.${propertyName}`;
    if (scopeTracker && propertyAssignmentCounterRef) {
      // Build a qualified parent that includes both the class name and the enclosing
      // method name so that:
      //   - Same property in different classes -> distinct IDs ("this.x[in:A.constructor]" vs "this.x[in:B.constructor]")
      //   - Same property in different methods of the same class -> distinct IDs ("this.x[in:Foo.constructor]" vs "this.x[in:Foo.reset]")
      //   - Same property assigned multiple times in the same method -> discriminator suffix ("this.x[in:Foo.constructor]#1")
      const qualifiedParent = enclosingFunctionName
        ? `${enclosingClassName}.${enclosingFunctionName}`
        : enclosingClassName;
      const discriminator = scopeTracker.getItemCounter(`PROPERTY_ASSIGNMENT:${qualifiedParent}.${fullName}`);
      assignmentId = computeSemanticIdV2(
        'PROPERTY_ASSIGNMENT',
        fullName,
        module.file,
        qualifiedParent,
        undefined,
        discriminator
      );
    } else {
      const cnt = propertyAssignmentCounterRef ? propertyAssignmentCounterRef.value++ : 0;
      assignmentId = `PROPERTY_ASSIGNMENT#${fullName}#${module.file}#${line}:${column}:${cnt}`;
    }

    propertyAssignments.push({
      id: assignmentId,
      semanticId: assignmentId,
      type: 'PROPERTY_ASSIGNMENT',
      objectName,
      propertyName,
      computed: mutationType === 'computed',
      file: module.file,
      line,
      column,
      scopePath,
      enclosingClassName,
      valueType: valueInfo.valueType as PropertyAssignmentInfo['valueType'],
      valueName: valueInfo.valueName,
      memberObject: valueInfo.memberObject,
      memberProperty: valueInfo.memberProperty,
      memberLine: valueInfo.memberLine,
      memberColumn: valueInfo.memberColumn,
    });
  }
}

/**
 * Detect Object.assign() calls inside functions
 * Creates ObjectMutationInfo for FLOWS_INTO edge generation in GraphBuilder
 */
export function detectObjectAssignInFunction(
  callNode: t.CallExpression,
  module: VisitorModule,
  objectMutations: ObjectMutationInfo[],
  scopeTracker?: ScopeTracker
): void {
  // Need at least 2 arguments: target and at least one source
  if (callNode.arguments.length < 2) return;

  // First argument is target
  const targetArg = callNode.arguments[0];
  let targetName: string;

  if (targetArg.type === 'Identifier') {
    targetName = targetArg.name;
  } else if (targetArg.type === 'ObjectExpression') {
    targetName = '<anonymous>';
  } else {
    return;
  }

  const line = callNode.loc?.start.line ?? 0;
  const column = callNode.loc?.start.column ?? 0;

  for (let i = 1; i < callNode.arguments.length; i++) {
    let arg = callNode.arguments[i];
    let isSpread = false;

    if (arg.type === 'SpreadElement') {
      isSpread = true;
      arg = arg.argument;
    }

    const valueInfo: ObjectMutationValue = {
      valueType: 'EXPRESSION',
      argIndex: i - 1,
      isSpread
    };

    const literalValue = ExpressionEvaluator.extractLiteralValue(arg);
    if (literalValue !== null) {
      valueInfo.valueType = 'LITERAL';
      valueInfo.literalValue = literalValue;
    } else if (arg.type === 'Identifier') {
      valueInfo.valueType = 'VARIABLE';
      valueInfo.valueName = arg.name;
    } else if (arg.type === 'ObjectExpression') {
      valueInfo.valueType = 'OBJECT_LITERAL';
    } else if (arg.type === 'ArrayExpression') {
      valueInfo.valueType = 'ARRAY_LITERAL';
    } else if (arg.type === 'CallExpression') {
      valueInfo.valueType = 'CALL';
      valueInfo.callLine = arg.loc?.start.line;
      valueInfo.callColumn = arg.loc?.start.column;
    }

    let mutationId: string | undefined;
    if (scopeTracker) {
      const discriminator = scopeTracker.getItemCounter(`OBJECT_MUTATION:Object.assign:${targetName}`);
      mutationId = computeSemanticId('OBJECT_MUTATION', `Object.assign:${targetName}`, scopeTracker.getContext(), { discriminator });
    }

    objectMutations.push({
      id: mutationId,
      objectName: targetName,
      propertyName: '<assign>',
      mutationType: 'assign',
      file: module.file,
      line,
      column,
      value: valueInfo
    });
  }
}
