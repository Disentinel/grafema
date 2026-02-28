/** CallExpressionHandler — handles CallExpression nodes. (REG-422, lines ~4348-4677) */
import type { Visitor, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import { ExpressionEvaluator } from '../ExpressionEvaluator.js';
import type { CallArgumentInfo } from '../types.js';
import { microTraceToErrorClass } from '../extractors/MicroTraceToErrorClass.js';
import { handleCallExpression } from '../extractors/CallExpressionExtractor.js';
import { FunctionBodyHandler } from './FunctionBodyHandler.js';

export class CallExpressionHandler extends FunctionBodyHandler {
  getHandlers(): Visitor {
    const ctx = this.ctx;

    return {
      // Function call expressions
      CallExpression: (callPath: NodePath<t.CallExpression>) => {
        // REG-311: Detect isAwaited (parent is AwaitExpression)
        const parent = callPath.parentPath;
        const isAwaited = parent?.isAwaitExpression() ?? false;

        // REG-311: Detect isInsideTry (O(1) via depth counter)
        const isInsideTry = ctx.controlFlowState.tryBlockDepth > 0;

        // REG-298: Detect isInsideLoop (O(1) via depth counter)
        const isInsideLoop = ctx.controlFlowState.loopDepth > 0;

        handleCallExpression(
          callPath.node,
          ctx.processedCallSites,
          ctx.processedMethodCalls,
          ctx.callSites,
          ctx.methodCalls,
          ctx.module,
          ctx.callSiteCounterRef,
          ctx.scopeTracker,
          ctx.getCurrentScopeId(),
          ctx.collections,
          isAwaited,
          isInsideTry,
          isInsideLoop
        );

        // REG-401: Detect parameter invocation for user-defined HOF tracking
        // If callee is an Identifier matching a parameter name or alias (REG-416),
        // record the param index.
        // REG-417: Also detect rest param array access: fns[0]() via MemberExpression callee.
        // Nested functions are already skipped by FunctionDeclaration/FunctionExpression/ArrowFunction
        // handlers calling path.skip(), so shadowed names won't be falsely matched.
        const callNodeForParam = callPath.node;
        if (ctx.paramNameToIndex.size > 0 || ctx.aliasToParamIndex.size > 0) {
          if (t.isIdentifier(callNodeForParam.callee)) {
            const calleeName = callNodeForParam.callee.name;
            const paramIndex = ctx.paramNameToIndex.get(calleeName) ?? ctx.aliasToParamIndex.get(calleeName);
            if (paramIndex !== undefined) {
              ctx.invokedParamIndexes.add(paramIndex);
              // REG-417: Record property path for destructured param bindings
              const propertyPath = ctx.paramNameToPropertyPath.get(calleeName);
              if (propertyPath) {
                ctx.invokesParamBindings.push({ paramIndex, propertyPath });
              }
            }
          } else if (
            t.isMemberExpression(callNodeForParam.callee) &&
            t.isIdentifier(callNodeForParam.callee.object) &&
            ctx.restParamNames.has(callNodeForParam.callee.object.name)
          ) {
            // REG-417: Rest param invoked via array access, e.g. fns[0]()
            const paramIndex = ctx.paramNameToIndex.get(callNodeForParam.callee.object.name);
            if (paramIndex !== undefined) {
              ctx.invokedParamIndexes.add(paramIndex);
            }
          }
        }

        // REG-334: Check for resolve/reject calls inside Promise executors
        const callNode = callPath.node;
        if (t.isIdentifier(callNode.callee)) {
          const calleeName = callNode.callee.name;

          // Walk up function parents to find Promise executor context
          // This handles nested callbacks like: new Promise((resolve) => { db.query((err, data) => { resolve(data); }); });
          let funcParent = callPath.getFunctionParent();
          while (funcParent) {
            const funcNode = funcParent.node;
            const funcKey = `${funcNode.start}:${funcNode.end}`;
            const context = ctx.promiseExecutorContexts.get(funcKey);

            if (context) {
              const isResolve = calleeName === context.resolveName;
              const isReject = calleeName === context.rejectName;

              if (isResolve || isReject) {
                // Find the CALL node ID for this resolve/reject call
                // It was just added by handleCallExpression
                const callLine = getLine(callNode);
                const callColumn = getColumn(callNode);

                // Find matching call site that was just added
                const resolveCall = ctx.callSites.find(cs =>
                  cs.name === calleeName &&
                  cs.file === ctx.module.file &&
                  cs.line === callLine &&
                  cs.column === callColumn
                );

                if (resolveCall) {
                  ctx.promiseResolutions.push({
                    callId: resolveCall.id,
                    constructorCallId: context.constructorCallId,
                    isReject,
                    file: ctx.module.file,
                    line: callLine
                  });

                  // REG-334: Collect arguments for resolve/reject calls
                  // This enables traceValues to follow PASSES_ARGUMENT edges
                  if (!ctx.collections.callArguments) {
                    ctx.collections.callArguments = [];
                  }
                  const callArgumentsArr = ctx.collections.callArguments as CallArgumentInfo[];

                  // Process arguments (typically just one: resolve(value))
                  callNode.arguments.forEach((arg, argIndex) => {
                    const argInfo: CallArgumentInfo = {
                      callId: resolveCall.id,
                      argIndex,
                      file: ctx.module.file,
                      line: getLine(arg),
                      column: getColumn(arg)
                    };

                    // Handle different argument types
                    if (t.isIdentifier(arg)) {
                      argInfo.targetType = 'VARIABLE';
                      argInfo.targetName = arg.name;
                    } else if (t.isLiteral(arg) && !t.isTemplateLiteral(arg)) {
                      // Create LITERAL node for the argument value
                      const literalValue = ExpressionEvaluator.extractLiteralValue(arg as t.Literal);
                      if (literalValue !== null || arg.type === 'NullLiteral') {
                        const argLine = getLine(arg);
                        const argColumn = getColumn(arg);
                        const literalId = `LITERAL#arg${argIndex}#${ctx.module.file}#${argLine}:${argColumn}:${ctx.literalCounterRef.value++}`;
                        ctx.literals.push({
                          id: literalId,
                          type: 'LITERAL',
                          value: literalValue,
                          valueType: typeof literalValue,
                          file: ctx.module.file,
                          line: argLine,
                          column: argColumn,
                          parentCallId: resolveCall.id,
                          argIndex
                        });
                        argInfo.targetType = 'LITERAL';
                        argInfo.targetId = literalId;
                        argInfo.literalValue = literalValue;
                      }
                    } else if (t.isCallExpression(arg)) {
                      argInfo.targetType = 'CALL';
                      argInfo.nestedCallLine = getLine(arg);
                      argInfo.nestedCallColumn = getColumn(arg);
                    } else {
                      argInfo.targetType = 'EXPRESSION';
                      argInfo.expressionType = arg.type;
                    }

                    callArgumentsArr.push(argInfo);
                  });
                }

                break; // Found context, stop searching
              }
            }

            funcParent = funcParent.getFunctionParent();
          }

          // REG-311: Detect executor_reject pattern - reject(new Error()) inside Promise executor
          // Walk up to find Promise executor context and check if this is reject call with NewExpression arg
          funcParent = callPath.getFunctionParent();
          while (funcParent && ctx.currentFunctionId) {
            const funcNode = funcParent.node;
            const funcKey = `${funcNode.start}:${funcNode.end}`;
            const context = ctx.promiseExecutorContexts.get(funcKey);

            if (context && calleeName === context.rejectName && callNode.arguments.length > 0) {
              // REG-311: Use the creator function's ID (the function that created the Promise),
              // not the executor's ID
              const targetFunctionId = context.creatorFunctionId || ctx.currentFunctionId;
              const arg = callNode.arguments[0];
              const callLine = getLine(callNode);
              const callColumn = getColumn(callNode);

              // Case 1: reject(new Error())
              if (t.isNewExpression(arg) && t.isIdentifier(arg.callee)) {
                ctx.rejectionPatterns.push({
                  functionId: targetFunctionId,
                  errorClassName: arg.callee.name,
                  rejectionType: 'executor_reject',
                  isAsync: true,
                  file: ctx.module.file,
                  line: callLine,
                  column: callColumn
                });
              }
              // Case 2: reject(err) where err is variable
              else if (t.isIdentifier(arg)) {
                const varName = arg.name;
                // Check if it's a parameter of ANY containing function (executor, outer, etc.)
                // Walk up the function chain to find if varName is a parameter
                let isParameter = false;
                let checkParent: NodePath<t.Node> | null = funcParent;
                while (checkParent) {
                  if (t.isFunction(checkParent.node)) {
                    if (checkParent.node.params.some(p =>
                      t.isIdentifier(p) && p.name === varName
                    )) {
                      isParameter = true;
                      break;
                    }
                  }
                  checkParent = checkParent.getFunctionParent();
                }

                if (isParameter) {
                  ctx.rejectionPatterns.push({
                    functionId: targetFunctionId,
                    errorClassName: null,
                    rejectionType: 'variable_parameter',
                    isAsync: true,
                    file: ctx.module.file,
                    line: callLine,
                    column: callColumn,
                    sourceVariableName: varName
                  });
                } else {
                  // Try micro-trace
                  const { errorClassName, tracePath } = microTraceToErrorClass(
                    varName,
                    funcParent as NodePath<t.Function>,
                    ctx.variableDeclarations
                  );

                  ctx.rejectionPatterns.push({
                    functionId: targetFunctionId,
                    errorClassName,
                    rejectionType: errorClassName ? 'variable_traced' : 'variable_unknown',
                    isAsync: true,
                    file: ctx.module.file,
                    line: callLine,
                    column: callColumn,
                    sourceVariableName: varName,
                    tracePath
                  });
                }
              }
              break;
            }
            funcParent = funcParent.getFunctionParent();
          }
        }

        // REG-311: Detect Promise.reject(new Error()) pattern
        if (t.isMemberExpression(callNode.callee) && ctx.currentFunctionId) {
          const memberCallee = callNode.callee;
          if (t.isIdentifier(memberCallee.object) &&
              memberCallee.object.name === 'Promise' &&
              t.isIdentifier(memberCallee.property) &&
              memberCallee.property.name === 'reject' &&
              callNode.arguments.length > 0) {
            const arg = callNode.arguments[0];
            const callLine = getLine(callNode);
            const callColumn = getColumn(callNode);

            // Case 1: Promise.reject(new Error())
            if (t.isNewExpression(arg) && t.isIdentifier(arg.callee)) {
              ctx.rejectionPatterns.push({
                functionId: ctx.currentFunctionId,
                errorClassName: arg.callee.name,
                rejectionType: 'promise_reject',
                isAsync: true,
                file: ctx.module.file,
                line: callLine,
                column: callColumn
              });
            }
            // Case 2: Promise.reject(err) where err is variable
            else if (t.isIdentifier(arg)) {
              const varName = arg.name;
              // Check if it's a parameter of containing function
              const isParameter = ctx.functionNode
                ? ctx.functionNode.params.some(param => t.isIdentifier(param) && param.name === varName)
                : false;

              if (isParameter) {
                ctx.rejectionPatterns.push({
                  functionId: ctx.currentFunctionId,
                  errorClassName: null,
                  rejectionType: 'variable_parameter',
                  isAsync: true,
                  file: ctx.module.file,
                  line: callLine,
                  column: callColumn,
                  sourceVariableName: varName
                });
              } else {
                // Try micro-trace
                if (!ctx.functionPath) {
                  ctx.rejectionPatterns.push({
                    functionId: ctx.currentFunctionId,
                    errorClassName: null,
                    rejectionType: 'variable_unknown',
                    isAsync: true,
                    file: ctx.module.file,
                    line: callLine,
                    column: callColumn,
                    sourceVariableName: varName,
                    tracePath: [varName]
                  });
                  return;
                }

                const { errorClassName, tracePath } = microTraceToErrorClass(
                  varName,
                  ctx.functionPath,
                  ctx.variableDeclarations
                );

                ctx.rejectionPatterns.push({
                  functionId: ctx.currentFunctionId,
                  errorClassName,
                  rejectionType: errorClassName ? 'variable_traced' : 'variable_unknown',
                  isAsync: true,
                  file: ctx.module.file,
                  line: callLine,
                  column: callColumn,
                  sourceVariableName: varName,
                  tracePath
                });
              }
            }
          }
        }
      },
    };
  }
}
