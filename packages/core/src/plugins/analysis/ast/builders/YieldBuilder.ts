/**
 * YieldBuilder - buffers YIELDS and DELEGATES_TO edges connecting yield expressions
 * to their generator functions.
 *
 * Extracted from GraphBuilder.bufferYieldEdges (REG-422).
 */

import { NodeFactory } from '../../../../core/NodeFactory.js';
import type {
  ModuleNode,
  ASTCollections,
  YieldExpressionInfo,
  CallSiteInfo,
  MethodCallInfo,
  VariableDeclarationInfo,
  ParameterInfo,
} from '../types.js';
import type { BuilderContext, DomainBuilder } from './types.js';

export class YieldBuilder implements DomainBuilder {
  constructor(private ctx: BuilderContext) {}

  buffer(module: ModuleNode, data: ASTCollections): void {
    const {
      yieldExpressions = [],
      callSites = [],
      methodCalls = [],
      variableDeclarations = [],
      parameters = [],
    } = data;
    this.bufferYieldEdges(yieldExpressions, callSites, methodCalls, variableDeclarations, parameters);
  }

  /**
   * Buffer YIELDS and DELEGATES_TO edges connecting yield expressions to their generator functions.
   *
   * Edge direction:
   * - For yield:  yieldedExpression --YIELDS--> generatorFunction
   * - For yield*: delegatedCall --DELEGATES_TO--> generatorFunction
   *
   * This enables tracing data flow through generator functions:
   * - Query: "What does this generator yield?"
   * - Answer: Follow YIELDS edges from function to see all possible yielded values
   * - Query: "What generators does this delegate to?"
   * - Answer: Follow DELEGATES_TO edges from function
   *
   * REG-270: Generator yield tracking
   */
  private bufferYieldEdges(
    yieldExpressions: YieldExpressionInfo[],
    callSites: CallSiteInfo[],
    methodCalls: MethodCallInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[]
  ): void {
    for (const yld of yieldExpressions) {
      const { parentFunctionId, yieldValueType, file, isDelegate } = yld;

      // Skip if no value yielded (bare yield;)
      if (yieldValueType === 'NONE') {
        continue;
      }

      let sourceNodeId: string | null = null;

      switch (yieldValueType) {
        case 'LITERAL':
          // Direct reference to literal node
          sourceNodeId = yld.yieldValueId ?? null;
          break;

        case 'VARIABLE': {
          // Find variable declaration by name in same file
          const varName = yld.yieldValueName;
          if (varName) {
            const sourceVar = variableDeclarations.find(v =>
              v.name === varName && v.file === file
            );
            if (sourceVar) {
              sourceNodeId = sourceVar.id;
            } else {
              // Check parameters
              const sourceParam = parameters.find(p =>
                p.name === varName && p.file === file
              );
              if (sourceParam) {
                sourceNodeId = sourceParam.id;
              }
            }
          }
          break;
        }

        case 'CALL_SITE': {
          // Find call site by coordinates
          const { yieldValueLine, yieldValueColumn, yieldValueCallName } = yld;
          if (yieldValueLine && yieldValueColumn) {
            const callSite = callSites.find(cs =>
              cs.line === yieldValueLine &&
              cs.column === yieldValueColumn &&
              (yieldValueCallName ? cs.name === yieldValueCallName : true)
            );
            if (callSite) {
              sourceNodeId = callSite.id;
            }
          }
          break;
        }

        case 'METHOD_CALL': {
          // Find method call by coordinates and method name
          const { yieldValueLine, yieldValueColumn, yieldValueCallName } = yld;
          if (yieldValueLine && yieldValueColumn) {
            const methodCall = methodCalls.find(mc =>
              mc.line === yieldValueLine &&
              mc.column === yieldValueColumn &&
              mc.file === file &&
              (yieldValueCallName ? mc.method === yieldValueCallName : true)
            );
            if (methodCall) {
              sourceNodeId = methodCall.id;
            }
          }
          break;
        }

        case 'EXPRESSION': {
          // Create EXPRESSION node and DERIVES_FROM edges for yield expressions
          const {
            expressionType,
            yieldValueId,
            yieldValueLine,
            yieldValueColumn,
            operator,
            object,
            property,
            computed,
            objectSourceName,
            leftSourceName,
            rightSourceName,
            consequentSourceName,
            alternateSourceName,
            expressionSourceNames,
            unaryArgSourceName
          } = yld;

          // Skip if no expression ID was generated
          if (!yieldValueId) {
            break;
          }

          // Create EXPRESSION node using NodeFactory
          const expressionNode = NodeFactory.createExpressionFromMetadata(
            expressionType || 'Unknown',
            file,
            yieldValueLine || yld.line,
            yieldValueColumn || yld.column,
            {
              id: yieldValueId,
              object,
              property,
              computed,
              operator
            }
          );

          this.ctx.bufferNode(expressionNode);
          sourceNodeId = yieldValueId;

          // Buffer DERIVES_FROM edges based on expression type
          // Helper function to find source variable or parameter
          const findSource = (name: string): string | null => {
            const variable = variableDeclarations.find(v =>
              v.name === name && v.file === file
            );
            if (variable) return variable.id;

            const param = parameters.find(p =>
              p.name === name && p.file === file
            );
            if (param) return param.id;

            return null;
          };

          // MemberExpression: derives from the object
          if (expressionType === 'MemberExpression' && objectSourceName) {
            const srcId = findSource(objectSourceName);
            if (srcId) {
              this.ctx.bufferEdge({
                type: 'DERIVES_FROM',
                src: yieldValueId,
                dst: srcId
              });
            }
          }

          // BinaryExpression / LogicalExpression: derives from left and right operands
          if (expressionType === 'BinaryExpression' || expressionType === 'LogicalExpression') {
            if (leftSourceName) {
              const srcId = findSource(leftSourceName);
              if (srcId) {
                this.ctx.bufferEdge({
                  type: 'DERIVES_FROM',
                  src: yieldValueId,
                  dst: srcId
                });
              }
            }
            if (rightSourceName) {
              const srcId = findSource(rightSourceName);
              if (srcId) {
                this.ctx.bufferEdge({
                  type: 'DERIVES_FROM',
                  src: yieldValueId,
                  dst: srcId
                });
              }
            }
          }

          // ConditionalExpression: derives from consequent and alternate
          if (expressionType === 'ConditionalExpression') {
            if (consequentSourceName) {
              const srcId = findSource(consequentSourceName);
              if (srcId) {
                this.ctx.bufferEdge({
                  type: 'DERIVES_FROM',
                  src: yieldValueId,
                  dst: srcId
                });
              }
            }
            if (alternateSourceName) {
              const srcId = findSource(alternateSourceName);
              if (srcId) {
                this.ctx.bufferEdge({
                  type: 'DERIVES_FROM',
                  src: yieldValueId,
                  dst: srcId
                });
              }
            }
          }

          // UnaryExpression: derives from the argument
          if (expressionType === 'UnaryExpression' && unaryArgSourceName) {
            const srcId = findSource(unaryArgSourceName);
            if (srcId) {
              this.ctx.bufferEdge({
                type: 'DERIVES_FROM',
                src: yieldValueId,
                dst: srcId
              });
            }
          }

          // TemplateLiteral: derives from all embedded expressions
          if (expressionType === 'TemplateLiteral' && expressionSourceNames && expressionSourceNames.length > 0) {
            for (const sourceName of expressionSourceNames) {
              const srcId = findSource(sourceName);
              if (srcId) {
                this.ctx.bufferEdge({
                  type: 'DERIVES_FROM',
                  src: yieldValueId,
                  dst: srcId
                });
              }
            }
          }

          break;
        }
      }

      // Create YIELDS or DELEGATES_TO edge if we found a source node
      if (sourceNodeId && parentFunctionId) {
        const edgeType = isDelegate ? 'DELEGATES_TO' : 'YIELDS';
        this.ctx.bufferEdge({
          type: edgeType,
          src: sourceNodeId,
          dst: parentFunctionId
        });
      }
    }
  }
}
