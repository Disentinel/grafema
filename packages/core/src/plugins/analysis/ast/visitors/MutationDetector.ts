/**
 * MutationDetector — detects array mutations (push/unshift/splice) and Object.assign calls.
 *
 * Creates ArrayMutationInfo and ObjectMutationInfo records for FLOWS_INTO edge
 * generation in GraphBuilder.
 * Extracted from CallExpressionVisitor.ts (REG-424).
 */

import type { CallExpression } from '@babel/types';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import type { ArrayMutationInfo, ArrayMutationArgument, ObjectMutationInfo, ObjectMutationValue } from '../types.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import type { VisitorModule, VisitorCollections } from './ASTVisitor.js';

export class MutationDetector {
  /**
   * Detect array mutation calls (push, unshift, splice) and collect mutation info
   * for later FLOWS_INTO edge creation in GraphBuilder.
   *
   * REG-117: Added isNested, baseObjectName, propertyName for nested mutations.
   */
  static detectArrayMutation(
    callNode: CallExpression,
    arrayName: string,
    method: 'push' | 'unshift' | 'splice',
    module: VisitorModule,
    collections: VisitorCollections,
    scopeTracker?: ScopeTracker,
    isNested?: boolean,
    baseObjectName?: string,
    propertyName?: string
  ): void {
    // Initialize collection if not exists
    if (!collections.arrayMutations) {
      collections.arrayMutations = [];
    }
    const arrayMutations = collections.arrayMutations as ArrayMutationInfo[];

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

      // Determine value type and store coordinates for node lookup in GraphBuilder.
      // IMPORTANT: Check ObjectExpression/ArrayExpression BEFORE extractLiteralValue
      // to match the order in extractArguments (which creates the actual nodes).
      // extractLiteralValue returns objects/arrays with all-literal properties as
      // literal values, but extractArguments creates OBJECT_LITERAL/ARRAY_LITERAL nodes.
      if (actualArg.type === 'ObjectExpression') {
        argInfo.valueType = 'OBJECT_LITERAL';
        argInfo.valueLine = actualArg.loc?.start.line;
        argInfo.valueColumn = actualArg.loc?.start.column;
      } else if (actualArg.type === 'ArrayExpression') {
        argInfo.valueType = 'ARRAY_LITERAL';
        argInfo.valueLine = actualArg.loc?.start.line;
        argInfo.valueColumn = actualArg.loc?.start.column;
      } else if (actualArg.type === 'Identifier') {
        argInfo.valueType = 'VARIABLE';
        argInfo.valueName = actualArg.name;
      } else if (actualArg.type === 'CallExpression') {
        argInfo.valueType = 'CALL';
        argInfo.callLine = actualArg.loc?.start.line;
        argInfo.callColumn = actualArg.loc?.start.column;
      } else {
        const literalValue = ExpressionEvaluator.extractLiteralValue(actualArg);
        if (literalValue !== null) {
          argInfo.valueType = 'LITERAL';
          argInfo.literalValue = literalValue;
          argInfo.valueLine = actualArg.loc?.start.line;
          argInfo.valueColumn = actualArg.loc?.start.column;
        }
      }

      mutationArgs.push(argInfo);
    });

    // Only record if there are actual insertions
    if (mutationArgs.length > 0) {
      const line = callNode.loc?.start.line ?? 0;
      const column = callNode.loc?.start.column ?? 0;

      let mutationId: string | undefined;
      // Capture scope path for scope-aware lookup (REG-309)
      const scopePath = scopeTracker?.getContext().scopePath ?? [];

      if (scopeTracker) {
        const discriminator = scopeTracker.getItemCounter(`ARRAY_MUTATION:${arrayName}.${method}`);
        mutationId = computeSemanticId('ARRAY_MUTATION', `${arrayName}.${method}`, scopeTracker.getContext(), { discriminator });
      }

      arrayMutations.push({
        id: mutationId,
        arrayName,
        mutationScopePath: scopePath,
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
   * Detect Object.assign(target, source1, source2, ...) calls.
   * Creates ObjectMutationInfo for FLOWS_INTO edge generation in GraphBuilder.
   */
  static detectObjectAssign(
    callNode: CallExpression,
    module: VisitorModule,
    collections: VisitorCollections,
    scopeTracker?: ScopeTracker
  ): void {
    // Need at least 2 arguments: target and at least one source
    if (callNode.arguments.length < 2) return;

    // Initialize object mutations collection if not exists
    if (!collections.objectMutations) {
      collections.objectMutations = [];
    }
    const objectMutations = collections.objectMutations as ObjectMutationInfo[];

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

      // Capture scope path for scope-aware lookup (REG-309)
      const scopePath = scopeTracker?.getContext().scopePath ?? [];

      let mutationId: string | undefined;
      if (scopeTracker) {
        const discriminator = scopeTracker.getItemCounter(`OBJECT_MUTATION:Object.assign:${targetName}`);
        mutationId = computeSemanticId('OBJECT_MUTATION', `Object.assign:${targetName}`, scopeTracker.getContext(), { discriminator });
      }

      objectMutations.push({
        id: mutationId,
        objectName: targetName,
        mutationScopePath: scopePath,
        propertyName: '<assign>',
        mutationType: 'assign',
        file: module.file,
        line,
        column,
        value: valueInfo
      });
    }
  }
}
