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
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import { extractNamesFromPattern } from './extractNamesFromPattern.js';

/**
 * Create PARAMETER nodes for function parameters
 *
 * Handles:
 * - Simple Identifier parameters: function(a, b)
 * - AssignmentPattern (default parameters): function(a = 1)
 * - RestElement (rest parameters): function(...args)
 * - ObjectPattern (destructuring): function({ x, y })               // REG-399
 * - ArrayPattern (destructuring): function([a, b])                  // REG-399
 * - Nested destructuring: function({ data: { user } })              // REG-399
 * - Defaults in destructuring: function({ x = 42 })                 // REG-399
 * - Pattern-level defaults: function({ x, y } = {})                 // REG-399
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
      // Default parameter: function(a = 1) OR destructured with defaults: function({ x = 1 })
      const assignmentParam = param as AssignmentPattern;

      if (assignmentParam.left.type === 'Identifier') {
        // Simple default: function(a = 1)
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
      } else if (assignmentParam.left.type === 'ObjectPattern' || assignmentParam.left.type === 'ArrayPattern') {
        // REG-399: Destructuring with default: function({ x } = {}) or function([x] = [])
        // The pattern-level default means "if argument is undefined, use this default object/array"
        // extractNamesFromPattern already handles nested AssignmentPattern (property-level defaults)
        const extractedParams = extractNamesFromPattern(assignmentParam.left);

        extractedParams.forEach((paramInfo, subIndex) => {
          // Discriminator ensures unique IDs for parameters at same position
          // Formula: index * 1000 + subIndex
          // Example: function({ a, b }, c) — a=0, b=1, c=1000
          const discriminator = index * 1000 + subIndex;

          const paramId = computeSemanticId(
            'PARAMETER',
            paramInfo.name,
            scopeTracker.getContext(),
            { discriminator }
          );

          const paramData: ParameterInfo = {
            id: paramId,
            semanticId: paramId,
            type: 'PARAMETER',
            name: paramInfo.name,
            file: file,
            line: paramInfo.loc.start.line,
            index: index,  // Original parameter position in function signature
            hasDefault: true,  // Pattern-level default (e.g., = {})
            parentFunctionId: functionId
          };

          // Add destructuring metadata
          if (paramInfo.propertyPath && paramInfo.propertyPath.length > 0) {
            paramData.propertyPath = paramInfo.propertyPath;
          }
          if (paramInfo.arrayIndex !== undefined) {
            paramData.arrayIndex = paramInfo.arrayIndex;
          }
          if (paramInfo.isRest) {
            paramData.isRest = true;
          }

          parameters.push(paramData);
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
    } else if (param.type === 'ObjectPattern' || param.type === 'ArrayPattern') {
      // REG-399: Handle destructured parameters
      // Extract all parameter names from destructuring pattern
      const extractedParams = extractNamesFromPattern(param);

      extractedParams.forEach((paramInfo, subIndex) => {
        // Discriminator ensures unique IDs for parameters at same position
        // Formula: index * 1000 + subIndex
        // Example: function({ a, b }, c) — a=0, b=1, c=1000
        const discriminator = index * 1000 + subIndex;

        const paramId = computeSemanticId(
          'PARAMETER',
          paramInfo.name,
          scopeTracker.getContext(),
          { discriminator }
        );

        const paramData: ParameterInfo = {
          id: paramId,
          semanticId: paramId,
          type: 'PARAMETER',
          name: paramInfo.name,
          file: file,
          line: paramInfo.loc.start.line,
          index: index,  // Original parameter position in function signature
          parentFunctionId: functionId
        };

        // Add destructuring metadata
        if (paramInfo.propertyPath && paramInfo.propertyPath.length > 0) {
          paramData.propertyPath = paramInfo.propertyPath;
        }
        if (paramInfo.arrayIndex !== undefined) {
          paramData.arrayIndex = paramInfo.arrayIndex;
        }
        if (paramInfo.isRest) {
          paramData.isRest = true;
        }
        // hasDefault already tracked by extractNamesFromPattern for property-level defaults
        if (paramInfo.hasDefault) {
          paramData.hasDefault = true;
        }

        parameters.push(paramData);
      });
    }
  });
}
