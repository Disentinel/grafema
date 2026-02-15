/**
 * PropertyAccessHandler — handles MemberExpression, OptionalMemberExpression,
 * MetaProperty, and UpdateExpression nodes.
 *
 * Mechanical extraction from analyzeFunctionBody() (REG-422).
 * Original source: JSASTAnalyzer.ts lines ~4287-4877.
 */
import type { Visitor, NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { getLine } from '../utils/location.js';
import { PropertyAccessVisitor } from '../visitors/index.js';
import type { PropertyAccessInfo, CounterRef } from '../types.js';
import { FunctionBodyHandler } from './FunctionBodyHandler.js';

export class PropertyAccessHandler extends FunctionBodyHandler {
  getHandlers(): Visitor {
    const ctx = this.ctx;
    const analyzer = this.analyzer;

    return {
      UpdateExpression: (updatePath: NodePath<t.UpdateExpression>) => {
        const updateNode = updatePath.node;

        // REG-288/REG-312: Collect update expression info for graph building
        analyzer.collectUpdateExpression(updateNode, ctx.module, ctx.updateExpressions, ctx.getCurrentScopeId(), ctx.scopeTracker);

        // Legacy behavior: update scope.modifies for IDENTIFIER targets
        if (updateNode.argument.type === 'Identifier') {
          const varName = updateNode.argument.name;

          // Find variable by name - could be from parent scope or declarations
          const fromParentScope = Array.from(ctx.parentScopeVariables).find(v => v.name === varName);
          const fromDeclarations = ctx.variableDeclarations.find(v => v.name === varName);
          const variable = fromParentScope ?? fromDeclarations;

          if (variable) {
            const scope = ctx.scopes.find(s => s.id === ctx.parentScopeId);
            if (scope) {
              if (!scope.modifies) scope.modifies = [];
              scope.modifies.push({
                variableId: variable.id,
                variableName: varName,
                line: getLine(updateNode)
              });
            }
          }
        }
      },

      // Property access expressions (REG-395)
      // Shared handler for both MemberExpression and OptionalMemberExpression
      MemberExpression: (memberPath: NodePath<t.MemberExpression>) => {
        // Initialize collections if needed
        if (!ctx.collections.propertyAccesses) {
          ctx.collections.propertyAccesses = [];
        }
        if (!ctx.collections.propertyAccessCounterRef) {
          ctx.collections.propertyAccessCounterRef = { value: 0 };
        }

        PropertyAccessVisitor.extractPropertyAccesses(
          memberPath,
          memberPath.node,
          ctx.module,
          ctx.collections.propertyAccesses as PropertyAccessInfo[],
          ctx.collections.propertyAccessCounterRef as CounterRef,
          ctx.scopeTracker,
          ctx.currentFunctionId || ctx.getCurrentScopeId()
        );
      },
      // OptionalMemberExpression: obj?.prop (same logic as MemberExpression)
      OptionalMemberExpression: (memberPath: NodePath) => {
        // Initialize collections if needed
        if (!ctx.collections.propertyAccesses) {
          ctx.collections.propertyAccesses = [];
        }
        if (!ctx.collections.propertyAccessCounterRef) {
          ctx.collections.propertyAccessCounterRef = { value: 0 };
        }

        PropertyAccessVisitor.extractPropertyAccesses(
          memberPath,
          memberPath.node as t.MemberExpression,
          ctx.module,
          ctx.collections.propertyAccesses as PropertyAccessInfo[],
          ctx.collections.propertyAccessCounterRef as CounterRef,
          ctx.scopeTracker,
          ctx.currentFunctionId || ctx.getCurrentScopeId()
        );
      },
      // MetaProperty: new.target (REG-301)
      MetaProperty: (metaPath: NodePath<t.MetaProperty>) => {
        // Initialize collections if needed
        if (!ctx.collections.propertyAccesses) {
          ctx.collections.propertyAccesses = [];
        }
        if (!ctx.collections.propertyAccessCounterRef) {
          ctx.collections.propertyAccessCounterRef = { value: 0 };
        }

        PropertyAccessVisitor.extractMetaProperty(
          metaPath.node,
          ctx.module,
          ctx.collections.propertyAccesses as PropertyAccessInfo[],
          ctx.collections.propertyAccessCounterRef as CounterRef,
          ctx.scopeTracker,
          ctx.currentFunctionId || ctx.getCurrentScopeId()
        );
      },
    };
  }
}
