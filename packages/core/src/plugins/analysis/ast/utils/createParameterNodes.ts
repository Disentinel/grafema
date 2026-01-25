/**
 * createParameterNodes - Shared utility for creating PARAMETER nodes
 *
 * Used by FunctionVisitor and ClassVisitor to create PARAMETER nodes
 * for function/method parameters with consistent behavior.
 *
 * Uses semantic IDs for stable, scope-based identification that doesn't
 * change when lines are added/removed above the function.
 */

import type {
  Node,
  Identifier,
  AssignmentPattern,
  RestElement
} from '@babel/types';
import type { ParameterInfo } from '../types.js';
import { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';

/**
 * Create PARAMETER nodes for function parameters
 *
 * Handles:
 * - Simple Identifier parameters: function(a, b)
 * - AssignmentPattern (default parameters): function(a = 1)
 * - RestElement (rest parameters): function(...args)
 *
 * Does NOT handle (can be added later):
 * - ObjectPattern (destructuring): function({ x, y })
 * - ArrayPattern (destructuring): function([a, b])
 *
 * @param params - AST nodes for function parameters
 * @param functionId - ID of the parent function (for parentFunctionId field)
 * @param file - File path
 * @param line - Line number of the function (for ParameterInfo.line fallback)
 * @param parameters - Array to push ParameterInfo objects into
 * @param scopeTracker - REQUIRED for semantic ID generation
 */
export function createParameterNodes(
  params: Node[],
  functionId: string,
  file: string,
  line: number,
  parameters: ParameterInfo[],
  scopeTracker: ScopeTracker
): void {
  if (!parameters) return; // Guard for backward compatibility

  params.forEach((param, index) => {
    // Handle different parameter types
    if (param.type === 'Identifier') {
      const name = (param as Identifier).name;
      const paramId = computeSemanticId('PARAMETER', name, scopeTracker.getContext(), { discriminator: index });
      parameters.push({
        id: paramId,
        semanticId: paramId,
        type: 'PARAMETER',
        name,
        file: file,
        line: param.loc?.start.line || line,
        index: index,
        parentFunctionId: functionId
      });
    } else if (param.type === 'AssignmentPattern') {
      // Default parameter: function(a = 1)
      const assignmentParam = param as AssignmentPattern;
      if (assignmentParam.left.type === 'Identifier') {
        const name = assignmentParam.left.name;
        const paramId = computeSemanticId('PARAMETER', name, scopeTracker.getContext(), { discriminator: index });
        parameters.push({
          id: paramId,
          semanticId: paramId,
          type: 'PARAMETER',
          name,
          file: file,
          line: assignmentParam.left.loc?.start.line || line,
          index: index,
          hasDefault: true,
          parentFunctionId: functionId
        });
      }
    } else if ((param as Node).type === 'RestElement') {
      // Rest parameter: function(...args)
      const restParam = param as unknown as RestElement;
      if (restParam.argument.type === 'Identifier') {
        const name = restParam.argument.name;
        const paramId = computeSemanticId('PARAMETER', name, scopeTracker.getContext(), { discriminator: index });
        parameters.push({
          id: paramId,
          semanticId: paramId,
          type: 'PARAMETER',
          name,
          file: file,
          line: restParam.argument.loc?.start.line || line,
          index: index,
          isRest: true,
          parentFunctionId: functionId
        });
      }
    }
    // ObjectPattern and ArrayPattern (destructuring parameters) can be added later
  });
}
