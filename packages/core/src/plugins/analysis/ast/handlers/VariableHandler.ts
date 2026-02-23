/**
 * VariableHandler — handles VariableDeclaration and AssignmentExpression nodes.
 *
 * Mechanical extraction from analyzeFunctionBody() (REG-422).
 * Original source: JSASTAnalyzer.ts lines ~3765-3833.
 */
import type { Visitor, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type {
  ArrayMutationInfo,
  ObjectMutationInfo,
  PropertyAssignmentInfo,
  VariableReassignmentInfo,
  CounterRef,
} from '../types.js';
import { FunctionBodyHandler } from './FunctionBodyHandler.js';

export class VariableHandler extends FunctionBodyHandler {
  getHandlers(): Visitor {
    const ctx = this.ctx;
    const analyzer = this.analyzer;

    return {
      VariableDeclaration: (varPath: NodePath<t.VariableDeclaration>) => {
        analyzer.handleVariableDeclaration(
          varPath,
          ctx.getCurrentScopeId(),
          ctx.module,
          ctx.variableDeclarations,
          ctx.classInstantiations,
          ctx.literals,
          ctx.variableAssignments,
          ctx.varDeclCounterRef,
          ctx.literalCounterRef,
          ctx.scopeTracker,
          ctx.parentScopeVariables,
          ctx.objectLiterals,
          ctx.objectProperties,
          ctx.objectLiteralCounterRef,
          ctx.arrayLiterals,
          ctx.arrayLiteralCounterRef
        );

        // REG-416: Track parameter aliases for HOF detection
        // When `const f = fn` where fn is a parameter, map f -> param index.
        if (ctx.paramNameToIndex.size > 0) {
          for (const declarator of varPath.node.declarations) {
            if (t.isIdentifier(declarator.id) && t.isIdentifier(declarator.init)) {
              const initName = declarator.init.name;
              const paramIndex = ctx.paramNameToIndex.get(initName) ?? ctx.aliasToParamIndex.get(initName);
              if (paramIndex !== undefined) {
                ctx.aliasToParamIndex.set(declarator.id.name, paramIndex);
              }
            }
          }
        }
      },

      // Detect indexed array assignments: arr[i] = value
      AssignmentExpression: (assignPath: NodePath<t.AssignmentExpression>) => {
        const assignNode = assignPath.node;

        // === VARIABLE REASSIGNMENT (REG-290) ===
        // Check if LHS is simple identifier (not obj.prop, not arr[i])
        // Must be checked FIRST before array/object mutation handlers
        if (assignNode.left.type === 'Identifier') {
          // Initialize collection if not exists
          if (!ctx.collections.variableReassignments) {
            ctx.collections.variableReassignments = [];
          }
          const variableReassignments = ctx.collections.variableReassignments as VariableReassignmentInfo[];

          analyzer.detectVariableReassignment(assignNode, ctx.module, variableReassignments, ctx.scopeTracker);
        }
        // === END VARIABLE REASSIGNMENT ===

        // Initialize collection if not exists
        if (!ctx.collections.arrayMutations) {
          ctx.collections.arrayMutations = [];
        }
        const arrayMutations = ctx.collections.arrayMutations as ArrayMutationInfo[];

        // Check for indexed array assignment: arr[i] = value
        analyzer.detectIndexedArrayAssignment(assignNode, ctx.module, arrayMutations, ctx.scopeTracker, ctx.collections);

        // Initialize object mutations collection if not exists
        if (!ctx.collections.objectMutations) {
          ctx.collections.objectMutations = [];
        }
        const objectMutations = ctx.collections.objectMutations as ObjectMutationInfo[];

        // REG-554: Initialize property assignments collection
        if (!ctx.collections.propertyAssignments) {
          ctx.collections.propertyAssignments = [];
        }
        if (!ctx.collections.propertyAssignmentCounterRef) {
          ctx.collections.propertyAssignmentCounterRef = { value: 0 };
        }
        const propertyAssignments = ctx.collections.propertyAssignments as PropertyAssignmentInfo[];
        const propertyAssignmentCounterRef = ctx.collections.propertyAssignmentCounterRef as CounterRef;

        // Check for object property assignment: obj.prop = value
        analyzer.detectObjectPropertyAssignment(
          assignNode, ctx.module, objectMutations, ctx.scopeTracker,
          propertyAssignments, propertyAssignmentCounterRef
        );
      },
    };
  }
}
