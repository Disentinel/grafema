/**
 * createParameterNodes - Shared utility for creating PARAMETER nodes
 *
 * Used by FunctionVisitor and ClassVisitor to create PARAMETER nodes
 * for function/method parameters with consistent behavior.
 */

import type {
  Node,
  Identifier,
  AssignmentPattern,
  RestElement
} from '@babel/types';
import type { ParameterInfo } from '../types.js';

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
 * @param line - Line number of the function (used for legacy ID generation)
 * @param parameters - Array to push ParameterInfo objects into
 */
export function createParameterNodes(
  params: Node[],
  functionId: string,
  file: string,
  line: number,
  parameters: ParameterInfo[]
): void {
  if (!parameters) return; // Guard for backward compatibility

  params.forEach((param, index) => {
    // Handle different parameter types
    if (param.type === 'Identifier') {
      const paramId = `PARAMETER#${(param as Identifier).name}#${file}#${line}:${index}`;
      parameters.push({
        id: paramId,
        type: 'PARAMETER',
        name: (param as Identifier).name,
        file: file,
        line: param.loc?.start.line || line,
        index: index,
        parentFunctionId: functionId
      });
    } else if (param.type === 'AssignmentPattern') {
      // Default parameter: function(a = 1)
      const assignmentParam = param as AssignmentPattern;
      if (assignmentParam.left.type === 'Identifier') {
        const paramId = `PARAMETER#${assignmentParam.left.name}#${file}#${line}:${index}`;
        parameters.push({
          id: paramId,
          type: 'PARAMETER',
          name: assignmentParam.left.name,
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
        const paramId = `PARAMETER#${restParam.argument.name}#${file}#${line}:${index}`;
        parameters.push({
          id: paramId,
          type: 'PARAMETER',
          name: restParam.argument.name,
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
