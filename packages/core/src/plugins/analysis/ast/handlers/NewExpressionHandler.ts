/**
 * NewExpressionHandler — handles NewExpression nodes (constructor calls).
 *
 * Mechanical extraction from analyzeFunctionBody() (REG-422).
 * Original source: JSASTAnalyzer.ts lines ~4679-4816.
 */
import type { Visitor, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import { ConstructorCallNode } from '../../../../core/nodes/ConstructorCallNode.js';
import { FunctionBodyHandler } from './FunctionBodyHandler.js';
import { ArgumentExtractor } from '../visitors/ArgumentExtractor.js';
import type { ArgumentInfo, LiteralInfo as ExtractorLiteralInfo } from '../visitors/call-expression-types.js';

export class NewExpressionHandler extends FunctionBodyHandler {
  getHandlers(): Visitor {
    const ctx = this.ctx;

    return {
      // NewExpression (constructor calls)
      NewExpression: (newPath: NodePath<t.NewExpression>) => {
        const newNode = newPath.node;
        const nodeKey = `new:${newNode.start}:${newNode.end}`;

        // Determine className from callee
        let className: string | null = null;
        if (newNode.callee.type === 'Identifier') {
          className = newNode.callee.name;
        } else if (newNode.callee.type === 'MemberExpression' && newNode.callee.property.type === 'Identifier') {
          className = newNode.callee.property.name;
        }

        // Create CONSTRUCTOR_CALL node (always, for all NewExpressions)
        if (className) {
          const constructorKey = `constructor:${nodeKey}`;
          if (!ctx.processedCallSites.has(constructorKey)) {
            ctx.processedCallSites.add(constructorKey);

            const line = getLine(newNode);
            const column = getColumn(newNode);
            const constructorCallId = ConstructorCallNode.generateId(className, ctx.module.file, line, column);
            const isBuiltin = ConstructorCallNode.isBuiltinConstructor(className);

            ctx.constructorCalls.push({
              id: constructorCallId,
              type: 'CONSTRUCTOR_CALL',
              className,
              isBuiltin,
              file: ctx.module.file,
              line,
              column,
              parentScopeId: ctx.getCurrentScopeId()
            });

            // REG-532: Extract constructor arguments for PASSES_ARGUMENT + DERIVES_FROM edges
            if (newNode.arguments.length > 0) {
              if (!ctx.collections.callArguments) {
                ctx.collections.callArguments = [];
              }
              ArgumentExtractor.extract(
                newNode.arguments, constructorCallId, ctx.module,
                ctx.collections.callArguments as unknown as ArgumentInfo[],
                ctx.literals as unknown as ExtractorLiteralInfo[], ctx.literalCounterRef,
                ctx.collections, ctx.scopeTracker
              );
            }

            // REG-334: If this is Promise constructor with executor callback,
            // register the context for resolve/reject detection
            if (className === 'Promise' && newNode.arguments.length > 0) {
              const executorArg = newNode.arguments[0];

              // Only handle inline function expressions (not variable references)
              if (t.isArrowFunctionExpression(executorArg) || t.isFunctionExpression(executorArg)) {
                // Extract resolve/reject parameter names
                let resolveName: string | undefined;
                let rejectName: string | undefined;

                if (executorArg.params.length > 0 && t.isIdentifier(executorArg.params[0])) {
                  resolveName = executorArg.params[0].name;
                }
                if (executorArg.params.length > 1 && t.isIdentifier(executorArg.params[1])) {
                  rejectName = executorArg.params[1].name;
                }

                if (resolveName) {
                  // Key by function node position to allow nested Promise detection
                  const funcKey = `${executorArg.start}:${executorArg.end}`;
                  ctx.promiseExecutorContexts.set(funcKey, {
                    constructorCallId,
                    resolveName,
                    rejectName,
                    file: ctx.module.file,
                    line,
                    // REG-311: Store the ID of the function that creates the Promise
                    creatorFunctionId: ctx.currentFunctionId || undefined
                  });
                }
              }
            }
          }
        }

      },
    };
  }
}
