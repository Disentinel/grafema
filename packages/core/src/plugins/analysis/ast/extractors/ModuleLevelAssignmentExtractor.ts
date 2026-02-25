import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type { VisitorModule, VisitorCollections } from '../visitors/index.js';
import type {
  FunctionInfo,
  ScopeInfo,
  ArrayMutationInfo,
  ObjectMutationInfo,
  VariableReassignmentInfo,
  PropertyAssignmentInfo,
  CounterRef,
} from '../types.js';
import {
  detectIndexedArrayAssignment,
  detectObjectPropertyAssignment,
  detectVariableReassignment,
} from '../mutation-detection/index.js';

interface ModuleLevelAssignmentContext {
  module: VisitorModule;
  scopeTracker: ScopeTracker;
  functions: FunctionInfo[];
  scopes: ScopeInfo[];
  allCollections: VisitorCollections;
  arrayMutations: ArrayMutationInfo[];
  objectMutations: ObjectMutationInfo[];
  analyzeFunctionBody: (
    funcPath: NodePath<t.Function | t.StaticBlock>,
    parentScopeId: string,
    module: VisitorModule,
    collections: VisitorCollections,
  ) => void;
}

export function createModuleLevelAssignmentVisitor(
  ctx: ModuleLevelAssignmentContext
): { AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => void } {
  return {
    AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
      const assignNode = assignPath.node;
      const functionParent = assignPath.getFunctionParent();
      if (functionParent) return;

      // FunctionExpression is handled by FunctionVisitor (which also calls analyzeFunctionBody).
      // Only handle ArrowFunctionExpression in assignments here — FunctionVisitor's
      // ArrowFunctionExpression handler doesn't derive name from AssignmentExpression parent.
      if (assignNode.right &&
           assignNode.right.type === 'ArrowFunctionExpression') {

        let functionName = 'anonymous';
        if (assignNode.left.type === 'MemberExpression') {
          const prop = assignNode.left.property;
          if (t.isIdentifier(prop)) {
            functionName = prop.name;
          }
        } else if (assignNode.left.type === 'Identifier') {
          functionName = assignNode.left.name;
        }

        const funcNode = assignNode.right;
        // Use semantic ID as primary ID (matching FunctionVisitor pattern)
        const functionId = computeSemanticId('FUNCTION', functionName, ctx.scopeTracker.getContext());

        ctx.functions.push({
          id: functionId,
          type: 'FUNCTION',
          name: functionName,
          file: ctx.module.file,
          line: getLine(funcNode),
          column: getColumn(funcNode),
          async: funcNode.async || false,
          generator: false,
          isAssignment: true
        });

        const funcBodyScopeId = `SCOPE#${functionName}:body#${ctx.module.file}#${getLine(assignNode)}`;
        ctx.scopes.push({
          id: funcBodyScopeId,
          type: 'SCOPE',
          scopeType: 'function_body',
          name: `${functionName}:body`,
          semanticId: `${functionName}:function_body[0]`,
          conditional: false,
          file: ctx.module.file,
          line: getLine(assignNode),
          parentFunctionId: functionId
        });

        const funcPath = assignPath.get('right') as NodePath<t.FunctionExpression | t.ArrowFunctionExpression>;
        // Enter function scope for semantic ID generation and analyze
        ctx.scopeTracker.enterScope(functionName, 'function');
        ctx.analyzeFunctionBody(funcPath, funcBodyScopeId, ctx.module, ctx.allCollections);
        ctx.scopeTracker.exitScope();
      }

      // === VARIABLE REASSIGNMENT (REG-290) ===
      // Check if LHS is simple identifier (not obj.prop, not arr[i])
      // Must be checked at module level too
      if (assignNode.left.type === 'Identifier') {
        // Initialize collection if not exists
        if (!ctx.allCollections.variableReassignments) {
          ctx.allCollections.variableReassignments = [];
        }
        const variableReassignments = ctx.allCollections.variableReassignments as VariableReassignmentInfo[];

        detectVariableReassignment(assignNode, ctx.module, variableReassignments, ctx.scopeTracker);
      }
      // === END VARIABLE REASSIGNMENT ===

      // Check for indexed array assignment at module level: arr[i] = value
      detectIndexedArrayAssignment(assignNode, ctx.module, ctx.arrayMutations, ctx.scopeTracker, ctx.allCollections);

      // Check for object property assignment at module level: obj.prop = value
      if (!ctx.allCollections.propertyAssignments) {
        ctx.allCollections.propertyAssignments = [];
      }
      if (!ctx.allCollections.propertyAssignmentCounterRef) {
        ctx.allCollections.propertyAssignmentCounterRef = { value: 0 };
      }
      detectObjectPropertyAssignment(
        assignNode, ctx.module, ctx.objectMutations, ctx.scopeTracker,
        ctx.allCollections.propertyAssignments as PropertyAssignmentInfo[],
        ctx.allCollections.propertyAssignmentCounterRef as CounterRef
      );
    }
  };
}
