import type * as t from '@babel/types';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import { ObjectLiteralNode } from '../../../../core/nodes/ObjectLiteralNode.js';
import { ArrayLiteralNode } from '../../../../core/nodes/ArrayLiteralNode.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type { VisitorModule, VisitorCollections } from '../visitors/index.js';
import type {
  ArrayMutationInfo,
  ArrayMutationArgument,
  CounterRef,
  LiteralInfo,
  ObjectLiteralInfo,
  ArrayLiteralInfo,
} from '../types.js';

/**
 * Detect array mutation calls (push, unshift, splice) inside functions
 * and collect mutation info for FLOWS_INTO edge creation in GraphBuilder
 *
 * REG-117: Added isNested, baseObjectName, propertyName for nested mutations
 *
 * @param callNode - The call expression node
 * @param arrayName - Name of the array being mutated
 * @param method - The mutation method (push, unshift, splice)
 * @param module - Current module being analyzed
 * @param arrayMutations - Collection to push mutation info into
 * @param scopeTracker - Optional scope tracker for semantic IDs
 * @param isNested - REG-117: true if this is a nested mutation (obj.arr.push)
 * @param baseObjectName - REG-117: base object name for nested mutations
 * @param propertyName - REG-117: property name for nested mutations
 */
export function detectArrayMutationInFunction(
  callNode: t.CallExpression,
  arrayName: string,
  method: 'push' | 'unshift' | 'splice',
  module: VisitorModule,
  arrayMutations: ArrayMutationInfo[],
  scopeTracker?: ScopeTracker,
  isNested?: boolean,
  baseObjectName?: string,
  propertyName?: string
): void {
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

    let actualArg: t.Node = arg;
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
      insertedValues: mutationArgs,
      // REG-117: Nested mutation fields
      isNested,
      baseObjectName,
      propertyName
    });
  }
}

/**
 * Detect indexed array assignment: arr[i] = value
 * Creates ArrayMutationInfo for FLOWS_INTO edge generation in GraphBuilder.
 * For non-variable values (LITERAL, OBJECT_LITERAL, ARRAY_LITERAL), creates
 * value nodes and sets valueNodeId so GraphBuilder can create FLOWS_INTO edges.
 *
 * @param assignNode - The assignment expression node
 * @param module - Current module being analyzed
 * @param arrayMutations - Collection to push mutation info into
 * @param scopeTracker - Scope tracker for semantic ID generation
 * @param collections - Collections for creating value nodes (literals, objectLiterals, etc.)
 */
export function detectIndexedArrayAssignment(
  assignNode: t.AssignmentExpression,
  module: VisitorModule,
  arrayMutations: ArrayMutationInfo[],
  scopeTracker?: ScopeTracker,
  collections?: VisitorCollections
): void {
  // Check for indexed array assignment: arr[i] = value
  if (assignNode.left.type === 'MemberExpression' && assignNode.left.computed) {
    const memberExpr = assignNode.left;

    // Only process NumericLiteral keys - those are clearly array indexed assignments
    // e.g., arr[0] = value, arr[1] = value
    // Other computed keys (Identifier, expressions) are ambiguous (could be array or object)
    // and are handled by detectObjectPropertyAssignment as computed mutations
    if (memberExpr.property.type !== 'NumericLiteral') {
      return;
    }

    // Get array name (only simple identifiers for now)
    if (memberExpr.object.type === 'Identifier') {
      const arrayName = memberExpr.object.name;
      const value = assignNode.right;

      // Use defensive loc checks instead of ! assertions
      const line = assignNode.loc?.start.line ?? 0;
      const column = assignNode.loc?.start.column ?? 0;

      const argInfo: ArrayMutationArgument = {
        argIndex: 0,
        isSpread: false,
        valueType: 'EXPRESSION'
      };

      // Determine value type and create value nodes for non-variable types
      // IMPORTANT: Check ObjectExpression/ArrayExpression BEFORE extractLiteralValue
      // to match the order in detectArrayMutation and extractArguments (REG-396).
      // extractLiteralValue returns objects/arrays with all-literal properties as
      // literal values, but we want OBJECT_LITERAL/ARRAY_LITERAL nodes instead.
      if (value.type === 'ObjectExpression') {
        argInfo.valueType = 'OBJECT_LITERAL';
        const valueLine = value.loc?.start.line ?? line;
        const valueColumn = value.loc?.start.column ?? column;
        // Create OBJECT_LITERAL node if collections available
        if (collections?.objectLiteralCounterRef) {
          if (!collections.objectLiterals) collections.objectLiterals = [];
          const objectLiteralCounterRef = collections.objectLiteralCounterRef as CounterRef;
          const objectNode = ObjectLiteralNode.create(
            module.file, valueLine, valueColumn,
            { counter: objectLiteralCounterRef.value++ }
          );
          (collections.objectLiterals as ObjectLiteralInfo[]).push(objectNode as unknown as ObjectLiteralInfo);
          argInfo.valueNodeId = objectNode.id;
        }
      } else if (value.type === 'ArrayExpression') {
        argInfo.valueType = 'ARRAY_LITERAL';
        const valueLine = value.loc?.start.line ?? line;
        const valueColumn = value.loc?.start.column ?? column;
        // Create ARRAY_LITERAL node if collections available
        if (collections?.arrayLiteralCounterRef) {
          if (!collections.arrayLiterals) collections.arrayLiterals = [];
          const arrayLiteralCounterRef = collections.arrayLiteralCounterRef as CounterRef;
          const arrayNode = ArrayLiteralNode.create(
            module.file, valueLine, valueColumn,
            { counter: arrayLiteralCounterRef.value++ }
          );
          (collections.arrayLiterals as ArrayLiteralInfo[]).push(arrayNode as unknown as ArrayLiteralInfo);
          argInfo.valueNodeId = arrayNode.id;
        }
      } else if (value.type === 'Identifier') {
        argInfo.valueType = 'VARIABLE';
        argInfo.valueName = value.name;
      } else if (value.type === 'CallExpression') {
        argInfo.valueType = 'CALL';
        argInfo.callLine = value.loc?.start.line;
        argInfo.callColumn = value.loc?.start.column;
      } else {
        const literalValue = ExpressionEvaluator.extractLiteralValue(value);
        if (literalValue !== null) {
          argInfo.valueType = 'LITERAL';
          argInfo.literalValue = literalValue;
          const valueLine = value.loc?.start.line ?? line;
          const valueColumn = value.loc?.start.column ?? column;
          // Create LITERAL node if collections available
          if (collections?.literals && collections.literalCounterRef) {
            const literalCounterRef = collections.literalCounterRef as CounterRef;
            const literalId = `LITERAL#indexed#${module.file}#${valueLine}:${valueColumn}:${literalCounterRef.value++}`;
            (collections.literals as LiteralInfo[]).push({
              id: literalId,
              type: 'LITERAL',
              value: literalValue,
              valueType: typeof literalValue,
              file: module.file,
              line: valueLine,
              column: valueColumn,
              parentCallId: undefined,
              argIndex: 0
            } as LiteralInfo);
            argInfo.valueNodeId = literalId;
          }
        }
      }

      // Capture scope path for scope-aware lookup (REG-309)
      const scopePath = scopeTracker?.getContext().scopePath ?? [];

      arrayMutations.push({
        arrayName,
        mutationScopePath: scopePath,
        mutationMethod: 'indexed',
        file: module.file,
        line: line,
        column: column,
        insertedValues: [argInfo]
      });
    }
  }
}
