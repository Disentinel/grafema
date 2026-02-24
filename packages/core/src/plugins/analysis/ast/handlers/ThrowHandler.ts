/**
 * ThrowHandler — handles ThrowStatement nodes.
 *
 * Mechanical extraction from analyzeFunctionBody() (REG-422).
 * Original source: JSASTAnalyzer.ts lines ~3908-3985.
 */
import type { Visitor, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import { microTraceToErrorClass } from '../extractors/MicroTraceToErrorClass.js';
import { FunctionBodyHandler } from './FunctionBodyHandler.js';

export class ThrowHandler extends FunctionBodyHandler {
  getHandlers(): Visitor {
    const ctx = this.ctx;

    return {
      // Phase 6 (REG-267): Track throw statements for control flow metadata
      // REG-311: Detect async_throw rejection patterns
      // REG-286: Detect sync_throw patterns for ALL functions (THROWS edges)
      ThrowStatement: (throwPath: NodePath<t.ThrowStatement>) => {
        // Skip if this throw is inside a nested function (not the function we're analyzing)
        let parent: NodePath | null = throwPath.parentPath;
        while (parent) {
          if (t.isFunction(parent.node) && parent.node !== ctx.funcNode) {
            // This throw is inside a nested function - skip it
            return;
          }
          parent = parent.parentPath;
        }

        ctx.controlFlowState.hasThrow = true;

        // REG-286: Track throw patterns for ALL functions (sync and async)
        // Async throws -> REJECTS edges, sync throws -> THROWS edges
        const isAsyncFunction = ctx.functionNode?.async === true;
        if (ctx.currentFunctionId && ctx.functionNode && ctx.functionPath) {
          const throwNode = throwPath.node;
          const arg = throwNode.argument;
          const throwLine = getLine(throwNode);
          const throwColumn = getColumn(throwNode);

          // Case 1: throw new Error() or throw new CustomError()
          if (arg && t.isNewExpression(arg) && t.isIdentifier(arg.callee)) {
            ctx.rejectionPatterns.push({
              functionId: ctx.currentFunctionId,
              errorClassName: arg.callee.name,
              rejectionType: isAsyncFunction ? 'async_throw' : 'sync_throw',
              isAsync: isAsyncFunction,
              file: ctx.module.file,
              line: throwLine,
              column: throwColumn
            });
          }
          // Case 2: throw identifier - needs micro-trace
          else if (arg && t.isIdentifier(arg)) {
            const varName = arg.name;

            // Check if it's a parameter
            const isParameter = ctx.functionNode.params.some(param =>
              t.isIdentifier(param) && param.name === varName
            );

            if (isParameter) {
              // Parameter forwarding - can't resolve statically
              ctx.rejectionPatterns.push({
                functionId: ctx.currentFunctionId,
                errorClassName: null,
                rejectionType: 'variable_parameter',
                isAsync: isAsyncFunction,
                file: ctx.module.file,
                line: throwLine,
                column: throwColumn,
                sourceVariableName: varName
              });
            } else {
              // Try micro-trace
              const { errorClassName, tracePath } = microTraceToErrorClass(
                varName,
                ctx.functionPath,
                ctx.variableDeclarations
              );

              ctx.rejectionPatterns.push({
                functionId: ctx.currentFunctionId,
                errorClassName,
                rejectionType: errorClassName ? 'variable_traced' : 'variable_unknown',
                isAsync: isAsyncFunction,
                file: ctx.module.file,
                line: throwLine,
                column: throwColumn,
                sourceVariableName: varName,
                tracePath
              });
            }
          }
        }
      },
    };
  }
}
